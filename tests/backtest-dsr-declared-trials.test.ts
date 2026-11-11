// `--trials N` declares trials run beyond the swept grid. Their spread is unknown, so a grid of near-identical variants
// must not price them at its own tiny cross-variance: one more variant swept cannot raise the deflated Sharpe of the
// search, and more declared trials never raise the deflated Sharpe of the same series.
import { describe, expect, it } from "vitest";
import { loadStrategy } from "../src/backtest/catalog.js";
import { deflatedSharpeOf, periodSharpe } from "../src/backtest/metrics.js";
import { defaultCosts, type Market, sweepReport } from "../src/backtest/run.js";
import { parseGrid } from "../src/backtest/validation.js";
import type { Instrument } from "../src/providers/types.js";
import { prng, randomWalk } from "./helpers/series.js";

describe("deflated Sharpe with trials declared beforehand", () => {
  it("backtest sweep --trials 1000: a two-variant grid is deflated no less than a single variant", () => {
    // A drifting random walk, 1500 daily bars.
    const bars = randomWalk(1500, 8, 100).map((b, i) => {
      const k = 1 + i * 0.0006;
      return { ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k };
    });
    const instrument: Instrument = { symbol: "TEST", market: "us", kind: "equity", currency: "USD", venueId: "TEST" };
    const m: Market = {
      symbol: "TEST",
      instrument,
      series: {
        instrument,
        interval: "1d",
        bars,
        adjusted: true,
        provenance: { source: "stub", fetchedAt: "2026-11-09T09:00:00.000Z", official: false },
        notes: [],
      },
      bars,
      interval: "1d",
      crypto: false,
      ppy: 252,
      capital: 10_000,
      costs: defaultCosts(false, false),
      leverage: 1,
      perp: false,
      notes: [],
    };
    const def = loadStrategy("sma-cross").def;
    const one = sweepReport(m, def, [], "sharpe", { trials: 1000 });
    const two = sweepReport(m, def, parseGrid("fast.period=10,11"), "sharpe", { trials: 1000 });
    const twoUndeclared = sweepReport(m, def, parseGrid("fast.period=10,11"), "sharpe", {});
    expect([one.nTrials, two.nTrials]).toEqual([1001, 1002]);
    // One variant, 1000 declared trials: deflated below the 0.95 bar (the commit's fix).
    expect(one.dsr).toBeLessThan(0.95);
    // The 1000 declared trials must cost the two-variant sweep more than the fifth decimal …
    expect(twoUndeclared.dsr - two.dsr).toBeGreaterThan(0.01);
    // … and one more trial cannot clear the bar the smaller search failed.
    expect(two.dsr).toBeLessThan(0.95);
  });

  it("deflatedSharpeOf: one more, near-identical variant does not raise the deflated Sharpe of the same series", () => {
    const r = prng(3);
    const chosen = Array.from({ length: 500 }, () => 0.001 + (r() - 0.5) * 0.02);
    const sr = periodSharpe(chosen);
    const one = deflatedSharpeOf(chosen, [sr], 1 + 1000);
    const two = deflatedSharpeOf(chosen, [sr, sr * 0.99], 2 + 1000);
    expect(one).toBeLessThan(0.95);
    expect(two).toBeLessThanOrEqual(one);
  });

  it("deflatedSharpeOf: more declared trials never raise the deflated Sharpe, whatever the variants' spread", () => {
    const r = prng(11);
    const chosen = Array.from({ length: 750 }, () => 0.0012 + (r() - 0.5) * 0.02);
    const sr = periodSharpe(chosen);
    for (const variants of [[sr], [sr, sr * 0.999], [sr, sr * 0.9, sr * 0.5], [sr, sr - 0.2, sr + 0.1]]) {
      let previous = Number.POSITIVE_INFINITY;
      for (const declared of [0, 1, 2, 5, 10, 50, 100, 1000, 10_000]) {
        const dsr = deflatedSharpeOf(chosen, variants, variants.length + declared);
        expect(dsr).toBeLessThanOrEqual(previous);
        previous = dsr;
      }
    }
  });
});
