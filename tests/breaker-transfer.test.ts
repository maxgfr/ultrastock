// 311c028 — "taking money out is not a loss, putting money in does not hide one". Shares brought in from another
// broker are money put in (2dbbc46 counts them as a contribution in the XIRR); shares moved out are money taken out.
import { describe, expect, it } from "vitest";
import { defaultProfile } from "../src/core/profile.js";
import type { Transaction } from "../src/portfolio/ledger.js";
import { breakerState, contributions, type EquityPoint, netContributed } from "../src/trading/breaker.js";

const limits = defaultProfile("FR", "EUR").limits; // 2 % a day, 4 % a week, 8 % a month
const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type">): Transaction => ({
  id: `${t.date}-${t.type}`,
  account: "cto",
  currency: "EUR",
  origin: "manual",
  ...t,
});

/** A point as context.ts:155 and commands/trading.ts:62 record it: the book's value, and `netContributed` of its ledger. */
const point = (at: string, equity: number, txs: Transaction[]): EquityPoint => ({ at, equity, contributed: netContributed(txs, { EUR: 1 }, "EUR") });

describe("the breaker, net of what comes in and goes out", () => {
  const funded = [tx({ date: "2026-10-01", type: "deposit", amount: 10_000 })];
  const now = new Date("2026-10-22T16:00:00Z"); // a Thursday

  it("still sees a 5 % loss on the day shares worth 1 000 arrive from another broker", () => {
    // Yesterday 10 000. Today the positions lost 500 (−5 %), and 10 shares at 100 were transferred in from outside.
    const today = [...funded, tx({ date: "2026-10-22", type: "transfer-in", symbol: "AAA", quantity: 10, price: 100 })];
    const curve = [point("2026-10-21T16:00:00.000Z", 10_000, funded), point("2026-10-22T15:00:00.000Z", 9_500 + 1_000, today)];
    const b = breakerState(curve, [], limits, now);
    expect(b.dailyPct).toBeLessThan(-2);
    expect(b.tripped).toBe(true);
  });

  it("does not read shares moved out to another broker as a 25 % drawdown", () => {
    // 10 000 → 2 500 of shares leave for another broker, nothing lost.
    const today = [...funded, tx({ date: "2026-10-22", type: "transfer-out", symbol: "AAA", quantity: 25, price: 100 })];
    const curve = [point("2026-10-21T16:00:00.000Z", 10_000, funded), point("2026-10-22T15:00:00.000Z", 7_500, today)];
    const b = breakerState(curve, [], limits, now);
    expect(b.tripped).toBe(false);
    expect(b.sizeMultiplier).toBe(1);
  });
});

describe("netContributed and transfers", () => {
  const funded = [tx({ date: "2026-10-01", type: "deposit", amount: 10_000 })];

  it("counts a move between two of the user's accounts as nothing, and one across at its price in base", () => {
    const internal = [
      tx({ date: "2026-10-22", type: "transfer-out", account: "cto", symbol: "AAA", quantity: 10, price: 100 }),
      tx({ date: "2026-10-22", type: "transfer-in", account: "pea", symbol: "AAA", quantity: 10, price: 100 }),
    ];
    expect(netContributed([...funded, ...internal], { EUR: 1 }, "EUR")).toBe(10_000);
    const usd = tx({ date: "2026-10-22", type: "transfer-in", symbol: "MSFT", quantity: 2, price: 400, currency: "USD" });
    expect(netContributed([...funded, usd], { EUR: 1, USD: 0.9 }, "EUR")).toBeCloseTo(10_720, 9);
    expect(netContributed([...funded, usd], { EUR: 1 }, "EUR")).toBeUndefined();
  });

  it("does not read the transfers a point recorded before they were counted predates as money put in since", () => {
    // Shares brought in last month; yesterday's point counted deposits only (an equity file written before this change).
    const txs = [...funded, tx({ date: "2026-09-15", type: "transfer-in", symbol: "AAA", quantity: 50, price: 100 })];
    const legacy: EquityPoint = { at: "2026-10-21T16:00:00.000Z", equity: 15_000, contributed: 10_000 };
    const today: EquityPoint = { at: "2026-10-22T15:00:00.000Z", equity: 15_000, ...contributions(txs, { EUR: 1 }, "EUR")! };
    expect(today).toMatchObject({ contributed: 15_000, transfers: 5_000 });
    const b = breakerState([legacy, today], [], limits, new Date("2026-10-22T16:00:00Z"));
    expect(b.dailyPct).toBeCloseTo(0, 9);
    expect(b.tripped).toBe(false);
  });

  it("leaves a transfer across without a price out, and says so", () => {
    const notes: string[] = [];
    const unpriced = tx({ date: "2026-10-22", type: "transfer-in", symbol: "AAA", quantity: 10 });
    expect(netContributed([...funded, unpriced], { EUR: 1 }, "EUR", (m) => notes.push(m))).toBe(10_000);
    expect(notes.join("\n")).toMatch(/1 transfer\(s\).*no price/);
  });
});
