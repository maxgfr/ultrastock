// The journal: round trips paired by the ledger's own rules (transfers, splits, no invented short) and settlement
// written once per horizon, however many settles run at once.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Decision, journalDir, recordDecision } from "../src/analyze/decision.js";
import { digest, reviewTrip, roundTrips } from "../src/journal/journal.js";
import { hitRates, readSettlements, settleDecisions } from "../src/journal/settle.js";
import { buildBook, type Transaction } from "../src/portfolio/ledger.js";
import type { Bar } from "../src/providers/types.js";
import { bar } from "./helpers/series.js";

const histories = vi.hoisted(() => ({ bars: {} as Record<string, Bar[]> }));
vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: async (symbol: string) => ({ instrument: { symbol, market: "us", mic: "XNAS" }, notes: [] }),
  getHistory: async (r: { instrument: { symbol: string } }) => ({ bars: histories.bars[r.instrument.symbol] ?? [] }),
}));

let n = 0;
const tx = (t: Omit<Transaction, "id" | "account" | "currency" | "origin"> & { origin?: string; account?: string }): Transaction => ({
  id: `tx${++n}`,
  account: "ibkr",
  currency: "USD",
  origin: "import:ibkr-flex",
  ...t,
});

describe("journal: round trips", () => {
  beforeEach(() => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "journal-lots-"));
  });

  it("J1 — a sale of shares that came in by transfer is no short, and the next buy covers nothing", () => {
    // 100 NVDA arrive from another broker, are sold, and 50 are bought again later: one long position, still open.
    const txs = [
      tx({ date: "2026-01-05", type: "transfer-in", symbol: "NVDA", quantity: 100, price: 80 }),
      tx({ date: "2026-03-02", type: "sell", symbol: "NVDA", quantity: 100, price: 150 }),
      tx({ date: "2026-06-01", type: "buy", symbol: "NVDA", quantity: 50, price: 120 }),
    ];
    // The ledger agrees: it replays without a short, and holds 50 at the end.
    expect(buildBook(txs).positions.find((p) => p.symbol === "NVDA")?.quantity).toBe(50);
    const trips = roundTrips(txs);
    // No trade was ever sold short; a "short 150 → 120, +1500" is invented, and the 50 held now are shown as closed.
    expect(trips.filter((t) => t.side === "short")).toEqual([]);
  });

  it("J2 — a round trip across a split is paired on the units and prices after the split", () => {
    // 10 bought at 1000, split 10-for-1, the 100 sold at 110: +1000 on a cost of 10 000.
    const txs = [
      tx({ date: "2026-01-05", type: "buy", symbol: "NVDA", quantity: 10, price: 1000 }),
      tx({ date: "2026-02-02", type: "split", symbol: "NVDA", quantity: 10 }),
      tx({ date: "2026-03-02", type: "sell", symbol: "NVDA", quantity: 100, price: 110 }),
    ];
    const book = buildBook(txs).positions.find((p) => p.symbol === "NVDA")!;
    expect(book.realizedFifo).toBeCloseTo(1000, 6); // what the ledger itself computes
    const trips = roundTrips(txs);
    // Received: one trip of 10 units "1000 → 110", −8900 — and 90 units left open as a short the next buy will "cover".
    expect({ units: trips.reduce((a, t) => a + t.quantity, 0), pnl: trips.reduce((a, t) => a + t.pnl, 0) }).toEqual({ units: 100, pnl: 1000 });
  });

  it("keeps the entry of units moved between the user's own accounts, and flags units that came in with no price", () => {
    const txs = [
      tx({ date: "2026-01-05", type: "buy", symbol: "NVDA", quantity: 10, price: 100 }),
      tx({ date: "2026-02-02", type: "transfer-out", symbol: "NVDA", quantity: 10 }),
      tx({ date: "2026-02-02", type: "transfer-in", account: "pea", symbol: "NVDA", quantity: 10 }),
      tx({ date: "2026-03-02", type: "sell", account: "pea", symbol: "NVDA", quantity: 10, price: 120 }),
      // Units from a broker outside the ledger, with no price: their result is unknown.
      tx({ date: "2026-04-01", type: "transfer-in", symbol: "AMD", quantity: 5 }),
      tx({ date: "2026-05-01", type: "sell", symbol: "AMD", quantity: 5, price: 150 }),
    ];
    const trips = roundTrips(txs);
    expect(trips.map((t) => [t.account, t.symbol, t.side, t.entryDate, t.entryPrice, t.quantity, t.pnl, t.unpriced])).toEqual([
      ["pea", "NVDA", "long", "2026-01-05", 100, 10, 200, undefined],
      ["ibkr", "AMD", "long", "2026-04-01", Number.NaN, 5, Number.NaN, true],
    ]);
    const rv = reviewTrip(trips[1]!, []);
    expect(rv.rMultiple).toBeUndefined();
    expect(rv.findings.join(" ")).toMatch(/no price/);
    expect(digest([reviewTrip(trips[0]!, []), rv], []).totalPnl).toBe(200);
  });
});

/** A flat close on every weekday from `from` to `to`. */
const weekdays = (from: string, to: string, close: number): Bar[] => {
  const out: Bar[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() % 6) out.push(bar(d.toISOString().slice(0, 10), close, close, close, close));
  }
  return out;
};

describe("journal settle", () => {
  beforeEach(() => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "journal-lots-settle-"));
    rmSync(journalDir(), { recursive: true, force: true });
  });

  it("J3 — two `journal settle` at once settle each horizon once", async () => {
    // A buy decided on Monday 2 March 2026; the stock then goes from 100 to 120, SPY stays flat.
    histories.bars = {
      UP: [...weekdays("2026-02-16", "2026-03-02", 100), ...weekdays("2026-03-03", "2026-06-30", 120)],
      SPY: weekdays("2026-02-16", "2026-06-30", 500),
    };
    recordDecision(
      {
        schema: 1,
        symbol: "UP",
        run: "x",
        decidedAt: "2026-03-02T15:00:00.000Z",
        rating: "buy",
        horizon: "months",
        conviction: 3,
        thesis: "The order book is full and the guidance was raised.",
        evidence: ["E1"],
        falsifiers: ["a close below 90"],
        risks: [],
        portfolioContext: "flat",
      } satisfies Decision,
      mkdtempSync(join(tmpdir(), "journal-lots-run-")),
    );
    const now = new Date("2026-06-30T12:00:00Z");
    // A scheduled settle and one typed by hand overlap: each spans its price reads.
    await Promise.all([settleDecisions(now), settleDecisions(now)]);
    // "Never edited, never re-scored": three horizons, three settlements — and one call counted once per horizon.
    expect(
      readSettlements()
        .map((s) => s.horizon)
        .sort((a, b) => a - b),
    ).toEqual([5, 20, 60]);
    expect(hitRates(readSettlements()).map((h) => [h.horizon, h.n])).toEqual([
      [5, 1],
      [20, 1],
      [60, 1],
    ]);
  });
});
