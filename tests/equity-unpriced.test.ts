// The breaker "reads the equity curve the book records (one snapshot per valuation)". A valuation in which a
// position could not be priced is recorded all the same, at a total that leaves the position out
// (commands/trading.ts:60-62, trading/context.ts:149-155). That point is then a reference like any other.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let price: number | undefined;
vi.mock("../src/providers/router.js", async (original) => ({
  ...(await original<typeof import("../src/providers/router.js")>()),
  resolveSymbol: async (symbol: string) => ({ instrument: { symbol, market: "euronext", kind: "equity", currency: "EUR", venueId: symbol } }),
  getQuote: async () => {
    if (price === undefined) throw new Error("quote provider: HTTP 503");
    return { price, at: new Date().toISOString(), provenance: { source: "test", delay: "realtime" } };
  },
}));

import { markBook } from "../src/commands/trading.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { breakerState, readEquity } from "../src/trading/breaker.js";

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

describe("the equity curve the breaker reads", () => {
  it("does not take a valuation that could not price a position as the book's value", async () => {
    const profile = defaultProfile("FR", "EUR"); // daily loss stop: 2 %
    saveProfile(profile);
    await appendTransactions(
      [
        { date: "2026-10-01", type: "deposit", account: "cto", amount: 10_000, currency: "EUR", origin: "manual" },
        { date: "2026-10-02", type: "buy", account: "cto", symbol: "AAA", quantity: 10, price: 500, currency: "EUR", origin: "manual" },
      ],
      "real",
    );
    vi.useFakeTimers({ toFake: ["Date"] });

    // Tuesday noon, `portfolio show`: 5 000 cash + 10 × 500 = 10 000.
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    price = 500;
    expect((await markBook("real")).valued.totalBase).toBe(10_000);

    // Tuesday evening, `portfolio show` again while the quote provider is down: the position has no price.
    vi.setSystemTime(new Date("2026-10-20T22:00:00Z"));
    price = undefined;
    const evening = await markBook("real");
    expect(evening.notes.join("\n")).toMatch(/could not price AAA/);

    // Wednesday: the share is down 6 % — the book lost 300, 3 % of it, past the 2 % daily stop (and under the 4 % weekly one).
    vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
    price = 470;
    expect((await markBook("real")).valued.totalBase).toBe(9_700);

    const curve = readEquity("real");
    // No point says the book was worth 5 000 on Tuesday evening: it never was.
    expect.soft(curve.map((p) => p.equity)).toEqual([10_000, 9_700]);
    const b = breakerState(curve, [], profile.limits, new Date());
    expect.soft(b.dailyPct).toBeCloseTo(-3, 6);
    expect.soft(b.tripped).toBe(true);
  });
});
