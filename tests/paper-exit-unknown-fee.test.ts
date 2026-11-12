// Getting out on paper: a sell of what the paper book holds is filled even when no fee is known for it, the fill marked
// as having an unknown fee — and left out of the paper record the live gate measures, which a fee-less fill would
// flatter. A buy (or a sell of what is not held) still needs its fee. Replays a recorded fixture: no network.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clockNow } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions, readLedger } from "../src/portfolio/ledger.js";
import { paperRecord, paperSubmit } from "../src/trading/paper.js";
import { type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { createTicket, type Ticket, loadTicket, recordCheck } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
});

const sell: Order = {
  account: "cto",
  symbol: "MC.PA",
  side: "sell",
  quantity: 1,
  price: 1,
  orderType: "limit",
  currency: "EUR",
  assetKind: "equity",
  venue: "paper",
};

async function checked(o: Order, riskReducing: boolean) {
  const t = createTicket(o);
  await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(o), riskReducing, notionalBase: o.quantity * o.price });
  return t.id;
}

describe("a paper exit with no fee known", () => {
  it("fills the sell of what is held, marks the fee unknown and books no fee", async () => {
    await appendTransactions(
      [{ date: "2026-10-01", type: "buy", account: "cto", symbol: "MC.PA", quantity: 2, price: 380, fee: 2, currency: "EUR", origin: "manual" }],
      "paper",
    );
    await withFixture("trading-paper-mcpa", async () => {
      const id = await checked(sell, true);
      const r = await paperSubmit(id, clockNow());
      if (r.outcome.kind !== "fill") throw new Error(r.outcome.reason);
      expect(r.outcome.fill.feeUnknown).toMatch(/no fee is known for account\.cto\.fees/);
      expect(r.outcome.fill.method).toMatch(/fee: unknown .* left out of the paper record/);
      expect(loadTicket(id).status).toBe("filled");
      const row = readLedger("paper").find((t) => t.origin === `ticket:${id}`)!;
      expect(row.fee).toBeUndefined();
    });
  });

  it("still refuses a sell the risk check did not find held", async () => {
    await withFixture("trading-paper-mcpa", async () => {
      const id = await checked(sell, false);
      await expect(paperSubmit(id, clockNow())).rejects.toThrow(/no paper fill: no fee is known/);
      expect(loadTicket(id).status).toBe("checked");
    });
  });
});

describe("the paper record", () => {
  it("leaves out a fill booked with an unknown fee, and says so", () => {
    const at = "2026-10-02T10:00:00.000Z";
    const ticket = (id: string, feeUnknown?: string): Ticket =>
      ({
        id,
        order: { ...sell, price: 400 },
        status: "filled",
        fills: [{ at, quantity: 1, price: 400, fee: 0, venue: "paper", method: "test", ...(feeUnknown ? { feeUnknown } : {}) }],
      }) as unknown as Ticket;
    const row = (id: string) => ({
      id: `r-${id}`,
      date: at,
      type: "sell" as const,
      account: "cto",
      symbol: "MC.PA",
      quantity: 1,
      price: 400,
      currency: "EUR",
      origin: `ticket:${id}`,
    });
    const rec = paperRecord([row("a"), row("b")], [ticket("a"), ticket("b", "no fee is known")]);
    expect(rec.txs.map((t) => t.origin)).toEqual(["ticket:a"]);
    expect(rec.excluded).toEqual([expect.stringMatching(/1 paper fill\(s\) booked with an unknown fee .* not part of the record/)]);
  });
});
