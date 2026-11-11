// Two tickets carrying the same order, whose fills are booked in the same second, must each reach the ledger.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { clockNow } from "../src/core/net.js";
import { contentHash } from "../src/engine.js";
import { appendTransactions, buildBook, readLedger, transactionId } from "../src/portfolio/ledger.js";
import { paperSubmit } from "../src/trading/paper.js";
import { planTrade } from "../src/trading/plan.js";
import { withFixture } from "./helpers/fixtures.js";
import type { BrokerAdapter, LiveOrder } from "../src/trading/brokers/types.js";
import { LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";
import { liveCancel, liveSubmit, orderBinding } from "../src/trading/live.js";
import { type Channel, issueCode } from "../src/trading/otp.js";
import { killSwitchPath, type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, recordCheck } from "../src/trading/tickets.js";

let captured: string[] = [];
const capture: Channel = (m) => {
  captured.push(m);
  return true;
};
const codeFrom = () => /^(\d{6})/.exec(captured.at(-1) ?? "")![1]!;

const order: Order = {
  account: "kraken",
  symbol: "SOLEUR",
  side: "buy",
  quantity: 1,
  price: 100,
  orderType: "limit",
  currency: "EUR",
  stop: 90,
  assetKind: "crypto",
  venue: "kraken",
};

/** A venue where every order rests, then fills whole at its limit; a cancel then comes too late. */
function venue(): BrokerAdapter {
  return {
    venue: "kraken",
    env: "test",
    bookTop: async () => ({ bid: 99.9, ask: 100, at: new Date().toISOString() }),
    permissions: async () => ({ canTrade: true, canWithdraw: false, source: "apiRestrictions" }),
    balances: async () => [],
    preview: async () => ({ ok: true }),
    submit: async (o: LiveOrder) => ({ state: "accepted", clientOrderId: o.clientOrderId, venueOrderId: `V-${o.clientOrderId.slice(0, 6)}` }),
    query: async (_s, id) => ({ state: "filled", clientOrderId: id, venueOrderId: `V-${id.slice(0, 6)}`, filledQuantity: 1, averagePrice: 100, fee: 0.26 }),
    cancel: async (_s, id) => ({ state: "rejected", clientOrderId: id, message: "order already closed" }),
    openOrders: async () => [],
  };
}

async function sent(createdAt: Date, a: BrokerAdapter) {
  const t = createTicket(order, { now: createdAt });
  await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(order), riskReducing: false, notionalBase: 100 });
  await issueCode(t.id, orderBinding(order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
  const r = await liveSubmit({ ticket: loadTicket(t.id), venue: "kraken", env: "test", adapter: a, venueSym: "SOLEUR", code: codeFrom() });
  expect(r.refusals).toEqual([]);
  expect(r.ticket.status).toBe("submitted");
  return t.id;
}

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
  requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
  captured = [];
});
afterEach(() => rmSync(killSwitchPath(), { force: true }));

describe("two tickets with the same order", () => {
  it("each have their fill in the ledger when one command (broker panic) learns of both", async () => {
    const a = venue();
    // The same buy, planned twice, a minute apart: two tickets, two orders resting at the venue.
    const first = await sent(new Date(Date.now() - 120_000), a);
    const second = await sent(new Date(Date.now() - 60_000), a);
    expect(first).not.toBe(second);

    // `broker panic` cancels every submitted ticket with the one `now` of its process (commands/broker.ts:238-242).
    // Both orders had filled at their limit meanwhile: the cancel is refused and the order read back says "filled".
    const now = new Date();
    await liveCancel(first, a, now);
    await liveCancel(second, a, now);

    // Both tickets say they bought 1 SOL…
    for (const id of [first, second]) {
      const t = loadTicket(id);
      expect(t.status).toBe("filled");
      expect(t.fills.reduce((s, f) => s + f.quantity, 0)).toBe(1);
    }
    // …so the book must hold 2 SOL, in two rows.
    const txs = readLedger("live-test");
    expect(txs.filter((x) => x.type === "buy").map((x) => x.origin)).toEqual([`ticket:${first}`, `ticket:${second}`]);
    expect(buildBook(txs).positions.find((p) => p.symbol === "SOLEUR")?.quantity).toBe(2);
  }, 60_000);

  it("each have their fill in the paper ledger when both fill at the same instant (one fixture clock, one swept bar)", async () => {
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "paper");
    await withFixture("trading-paper-mcpa", async () => {
      const p = await planTrade({ symbol: "MC.PA", account: "cto" });
      const ids: string[] = [];
      for (const createdAt of [new Date(Date.now() - 120_000), new Date(Date.now() - 60_000)]) {
        const t = createTicket(p.order, { now: createdAt });
        await recordCheck(t.id, p.gate);
        // `paper submit <ticket> --fixture …`: commands/trading.ts:444 passes clockNow(), the recording's time.
        expect((await paperSubmit(t.id, clockNow())).ticket.status).toBe("filled");
        ids.push(t.id);
      }
      const buys = readLedger("paper").filter((x) => x.type === "buy");
      expect(buys.map((x) => x.origin)).toEqual(ids.map((id) => `ticket:${id}`));
      expect(buildBook(readLedger("paper")).positions.find((x) => x.symbol === "MC.PA")?.quantity).toBe(2 * p.quantity);
    });
  }, 60_000);
});

describe("the id of a ledger row", () => {
  const row = { date: "2026-10-02T10:00:00", type: "buy" as const, account: "ibkr", symbol: "MC.PA", quantity: 10, price: 500, fee: 1.25, currency: "EUR" };

  it("holds the ticket of a ticket's fill", () => {
    expect(transactionId({ ...row, origin: "ticket:t-1" })).not.toBe(transactionId({ ...row, origin: "ticket:t-2" }));
    expect(transactionId({ ...row, origin: "ticket:t-1" })).toBe(transactionId({ ...row, origin: "ticket:t-1", note: "another note" }));
  });

  it("is unchanged for every other origin: a re-imported statement row is still a duplicate", () => {
    const before = contentHash(["2026-10-02T10:00:00", "buy", "ibkr", "MC.PA", 10, 500, "", 1.25, "EUR", "import"].join("|")).slice(0, 16);
    expect(transactionId({ ...row, origin: "import:ibkr" })).toBe(before);
    expect(transactionId({ ...row, origin: "import:ibkr-2026.csv" })).toBe(before);
  });
});
