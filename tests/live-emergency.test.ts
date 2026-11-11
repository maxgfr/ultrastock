// The emergency paths of live trading: a cancel never waits on another ticket's operation, the kill switch is read again
// right before the one request, and a cancel whose fills could not be read is settled by a later reconcile.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { readLedger } from "../src/portfolio/ledger.js";
import type { BrokerAdapter, LiveOrder, OrderResult } from "../src/trading/brokers/types.js";
import { LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";
import { clientOrderIdFor, liveCancel, liveSubmit, orderBinding, reconcile } from "../src/trading/live.js";
import { type Channel, issueCode } from "../src/trading/otp.js";
import { killSwitchPath, type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, recordCheck } from "../src/trading/tickets.js";

function fakeVenue(over: Partial<BrokerAdapter> = {}) {
  const calls = { submit: 0, query: 0, cancel: 0 };
  const a: BrokerAdapter = {
    venue: "kraken",
    env: "test",
    bookTop: async () => ({ bid: 99.9, ask: 100, at: new Date().toISOString() }),
    permissions: async () => ({ canTrade: true, canWithdraw: false, source: "apiRestrictions" }),
    balances: async () => [{ asset: "SOL", free: 0, locked: 0 }],
    preview: async () => ({ ok: true }),
    submit: async (o: LiveOrder) => {
      calls.submit++;
      return { state: "accepted", clientOrderId: o.clientOrderId, venueOrderId: "V1" };
    },
    query: async () => {
      calls.query++;
      return undefined;
    },
    cancel: async (_s, id) => {
      calls.cancel++;
      return { state: "cancelled", clientOrderId: id };
    },
    openOrders: async () => [],
    ...over,
  };
  return { a, calls };
}

let captured: string[] = [];
const capture: Channel = (m) => {
  captured.push(m);
  return true;
};
const codeFrom = () => /^(\d{6})/.exec(captured.at(-1) ?? "")![1]!;

const order = (o: Partial<Order> = {}): Order => ({
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
  ...o,
});

async function checkedTicket(o: Order) {
  const t = createTicket(o);
  await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(o), riskReducing: false, notionalBase: o.quantity * o.price });
  return loadTicket(t.id);
}
const switchOn = () =>
  requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));

async function acceptedTicket(o: Order) {
  const t = await checkedTicket(o);
  await issueCode(t.id, orderBinding(t.order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
  const r = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: fakeVenue().a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
  expect(r.result?.state).toBe("accepted");
  return t;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
  captured = [];
});
afterEach(() => rmSync(killSwitchPath(), { force: true }));

describe("live emergency paths", () => {
  it("lets `broker panic` cancel a working order while another live operation waits on its venue", async () => {
    switchOn();
    const a = await acceptedTicket(order());
    const b = await acceptedTicket(order({ price: 99.95 }));
    // A reconcile of ticket A whose venue is slow: Kraken's lookup is two requests of up to 10 s each, then the open orders.
    const slow = fakeVenue({
      query: async () => {
        await sleep(11_500);
        return undefined;
      },
    });
    const inFlight = reconcile(a.id, slow.a);
    await sleep(200);
    // What `broker panic` does for every working order (commands/broker.ts:214), here for ticket B at a healthy venue.
    const v = fakeVenue();
    const outcome = await liveCancel(b.id, v.a).then(
      (r) => r?.state ?? "nothing to cancel",
      (e: Error) => `NOT CANCELLED: ${e.message}`,
    );
    await inFlight;
    expect(outcome).toBe("cancelled");
    expect(v.calls.cancel).toBe(1);
  }, 40_000);

  it("does not send an order when the kill switch is set while its preconditions are being read", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, orderBinding(t.order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
    // `broker panic` runs in another process while this submit is reading the venue (permissions, balances, book: up to 10 s each).
    const v = fakeVenue({
      bookTop: async () => {
        mkdirSync(dirname(killSwitchPath()), { recursive: true });
        writeFileSync(killSwitchPath(), "kill switch set by `broker panic`\n");
        return { bid: 99.9, ask: 100, at: new Date().toISOString() };
      },
    });
    const r = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: v.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
    // The panic listed the tickets "submitted" at that instant: this one was still "checked", so nothing will cancel it either.
    expect(v.calls.submit).toBe(0);
    expect(r.refusals.map((x) => x.code)).toContain("KILL_SWITCH");
  });

  it("does not close a cancelled order as unfilled when the read of what it filled failed", async () => {
    switchOn();
    const t = await acceptedTicket(order());
    const id = clientOrderIdFor(t.id, 1);
    // The venue cancels the order; it had filled 0.4 before. Its cancel answer says nothing of fills (Kraken: a count).
    const partly: OrderResult = {
      state: "cancelled",
      clientOrderId: id,
      venueOrderId: "V1",
      filledQuantity: 0.4,
      averagePrice: 100,
      fee: 0.1,
      feeCurrency: "EUR",
    };
    let reads = 0;
    const v = fakeVenue({
      query: async () => {
        // The follow-up read fails once (a timeout), then the venue answers.
        if (reads++ === 0) throw new Error("timeout after 10000 ms");
        return partly;
      },
    });
    await liveCancel(t.id, v.a);
    // Whatever the ticket says now, asking the venue again must end with the 0.4 bought in the book.
    await reconcile(t.id, v.a, new Date(Date.now() + 5000));
    expect(
      readLedger("live-test")
        .filter((x) => x.type === "buy")
        .map((x) => x.quantity),
    ).toEqual([0.4]);
  });
});
