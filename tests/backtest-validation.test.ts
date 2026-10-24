import { describe, expect, it } from "vitest";
import { alignBars, allocationBacktest } from "../src/backtest/allocation.js";
import { loadStrategy } from "../src/backtest/catalog.js";
import { decisionQuality, tQuantile, wilsonInterval } from "../src/backtest/decisions.js";
import { buyAndHold, deflatedSharpeOf, periodsPerYear, residualAlpha, tradeStats } from "../src/backtest/metrics.js";
import { reviewScorecard } from "../src/backtest/review.js";
import { simulate } from "../src/backtest/simulate.js";
import {
  type Backtester,
  combinations,
  cpcv,
  defaultGrid,
  expandGrid,
  MAX_RUNS,
  monteCarlo,
  objectiveOfReturns,
  parseGrid,
  pbo,
  prepareVariant,
  runVariant,
  stressCosts,
  sweep,
  walkForward,
} from "../src/backtest/validation.js";
import type { Settlement } from "../src/journal/settle.js";
import type { Bar } from "../src/providers/types.js";
import { bar, day, prng, randomWalk } from "./helpers/series.js";

const COSTS = { makerPct: 0.1, takerPct: 0.1, slippagePct: 0.05 };
const bt = (bars: Bar[]): Backtester => ({ bars, interval: "1d", ppy: 252, base: { capital: 10_000, costs: COSTS } });

describe("grids", () => {
  it("parses lists and ranges, expands, and caps at 500 runs", () => {
    const g = parseGrid("fast.period=10,20,30; risk.stopLossPct=5:15:5");
    expect(g).toEqual([
      { path: "fast.period", values: [10, 20, 30] },
      { path: "risk.stopLossPct", values: [5, 10, 15] },
    ]);
    expect(expandGrid(g)).toHaveLength(9);
    expect(() => parseGrid("period=1,2")).toThrow(/alias\.param/);
    expect(() => parseGrid("a.b=x")).toThrow(/numbers/);
    expect(() =>
      expandGrid([
        { path: "a.b", values: Array.from({ length: 30 }, (_, i) => i) },
        { path: "c.d", values: Array.from({ length: 20 }, (_, i) => i) },
      ]),
    ).toThrow(new RegExp(`at most ${MAX_RUNS}`));
    const d = defaultGrid(loadStrategy("sma-cross").def);
    expect(d).toEqual([
      { path: "fast.period", values: [38, 50, 63] },
      { path: "slow.period", values: [150, 200, 250] },
    ]);
  });

  it("enumerates combinations", () => {
    expect(combinations(6, 2)).toHaveLength(15);
    expect(combinations(16, 8)).toHaveLength(12870);
    expect(combinations(4, 2)[0]).toEqual([0, 1]);
  });
});

describe("walk-forward, sweep, CPCV, PBO", () => {
  const bars = randomWalk(1000, 5);
  const def = loadStrategy("sma-cross").def;
  const combos = expandGrid(parseGrid("fast.period=10,20;slow.period=50,100"));

  it("chooses on train, judges on the window after, stitches the out-of-sample returns", () => {
    const wf = walkForward(bt(bars), def, combos, { train: 400, test: 100 });
    expect(wf.windows).toHaveLength(6);
    expect(wf.oosReturns).toHaveLength(600);
    expect(wf.windows[0]!.testFrom).toBe(bars[400]!.date);
    expect(wf.windows[1]!.trainFrom).toBe(bars[100]!.date);
    const anchored = walkForward(bt(bars), def, combos, { train: 400, test: 100, anchored: true });
    expect(anchored.windows[3]!.trainFrom).toBe(bars[0]!.date);
    expect(() => walkForward(bt(bars), def, combos, { train: 900, test: 200 })).toThrow(/needs 1100 bars/);
  });

  it("sweeps a grid; CPCV builds C(N−1, k−1) paths; PBO is near 0 for a dominant variant", () => {
    const { rows, sims } = sweep(bt(bars), def, combos, "sharpe");
    expect(rows).toHaveLength(4);
    const c = cpcv(
      sims.map((s) => s.returns),
      combos.map((x) => JSON.stringify(x)),
      252,
    );
    expect(c.splits).toBe(15);
    expect(c.pathSharpes).toHaveLength(5);
    expect(Object.values(c.chosenCounts).reduce((a, b) => a + b, 0)).toBe(15);
    const r = prng(9);
    const noise = (drift: number) => Array.from({ length: 800 }, () => (r() - 0.5) * 0.02 + drift);
    const good = pbo([noise(0.004), noise(0), noise(0), noise(0)])!;
    expect(good.pbo).toBeLessThan(0.05);
    const pure = pbo(Array.from({ length: 10 }, () => noise(0)))!;
    expect(pure.pbo).toBeGreaterThan(0.2);
    expect(pbo([noise(0)])).toBeUndefined();
  });

  it("deflates the Sharpe of the best of many trials below its PSR", () => {
    const r = prng(4);
    const series = Array.from({ length: 50 }, () => Array.from({ length: 500 }, () => (r() - 0.5) * 0.02));
    const sharpes = series.map((s) => s.reduce((a, b) => a + b, 0) / s.length / 0.0058);
    const best = series[sharpes.indexOf(Math.max(...sharpes))]!;
    expect(deflatedSharpeOf(best, sharpes, 50)).toBeLessThan(deflatedSharpeOf(best, sharpes, 1));
    expect(objectiveOfReturns([0.01], "sharpe", 252)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("Monte Carlo of trades", () => {
  it("is seeded and bounded", () => {
    const a = monteCarlo([5, -2, 3, -1, 4, -3, 2], 2000, 7)!;
    const b = monteCarlo([5, -2, 3, -1, 4, -3, 2], 2000, 7)!;
    expect(a).toEqual(b);
    expect(a.finalReturnPct.p5).toBeLessThan(a.finalReturnPct.p95);
    expect(a.maxDrawdownPct.p50).toBeLessThanOrEqual(0);
    const winners = monteCarlo([1, 2, 3], 500, 1)!;
    expect(winners.lossProbabilityPct).toBe(0);
    expect(winners.maxDrawdownPct.p5).toBe(0);
    expect(monteCarlo([], 10)).toBeUndefined();
  });
});

describe("metrics", () => {
  it("counts trades, win rate, profit factor, R and exposure", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(day(i), 100 + i, 101 + i, 99 + i, 100 + i));
    const n = bars.length;
    const s = {
      buy: Array.from({ length: n }, (_, i) => i === 1 || i === 10),
      sell: Array.from({ length: n }, (_, i) => i === 5 || i === 14),
      short: [],
      cover: [],
      params: {},
    };
    const sim = simulate(bars, s as never, { capital: 10_000, costs: { makerPct: 0, takerPct: 0, slippagePct: 0 }, risk: { stopLossPct: 10 } });
    const t = tradeStats(sim);
    expect(t.trades).toBe(2);
    expect(t.winRate).toBe(100);
    expect(t.profitFactor).toBe(Number.POSITIVE_INFINITY);
    expect(t.expectancyR).toBeGreaterThan(0);
    expect(t.exposurePct).toBeCloseTo((8 / 20) * 100, 6);
    expect(t.largestWinSharePct).toBeGreaterThan(50);
  });

  it("recovers a known alpha and beta with a Newey–West t-stat", () => {
    const r = prng(2);
    const bench: Bar[] = [];
    let p = 100;
    for (let i = 0; i < 600; i++) {
      p *= 1 + (r() - 0.5) * 0.02;
      bench.push(bar(day(i), p, p, p, p));
    }
    const dates = bench.map((b) => b.date);
    const returns = [0, ...bench.slice(1).map((b, i) => 0.0004 + 0.5 * (b.close / bench[i]!.close - 1) + (r() - 0.5) * 0.002)];
    const a = residualAlpha(dates, returns, bench, 252)!;
    expect(a.beta).toBeCloseTo(0.5, 1);
    expect(a.alphaPct).toBeGreaterThan(5);
    expect(a.alphaT).toBeGreaterThan(3);
  });

  it("buy-and-hold pays costs both ways; periods per year follow the market", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(day(i), 100, 100, 100, 100));
    expect(buyAndHold(bars, COSTS).totalReturn).toBeCloseTo((1 - 0.001) ** 2 / (1.0005 / 0.9995) - 1, 9);
    expect(periodsPerYear(randomWalk(10), true)).toBe(365);
    expect(periodsPerYear(randomWalk(10), false)).toBe(252);
    expect(stressCosts(COSTS)).toEqual({ makerPct: 0.2, takerPct: 0.2, slippagePct: 0.1 });
  });

  it("runs a variant with an ATR stop", () => {
    const bars = randomWalk(400, 8);
    const b = { ...bt(bars), riskOverride: { atrStop: { period: 14, multiplier: 2 } } };
    const v = prepareVariant(b, loadStrategy("sma-cross").def, { "fast.period": 10, "slow.period": 30 });
    expect(v.atr?.[20]).toBeGreaterThan(0);
    const sim = runVariant(b, v);
    expect(sim.trades.some((t) => t.exitReason === "atr-stop")).toBe(true);
  });
});

describe("allocations", () => {
  const up = (n: number, g: number, seed: number) => {
    const r = prng(seed);
    let p = 100;
    return Array.from({ length: n }, (_, i) => {
      const o = p;
      p *= 1 + g + (r() - 0.5) * 0.01;
      return bar(day(i), o, Math.max(o, p), Math.min(o, p), p);
    });
  };
  const a = up(800, 0.001, 1);
  const b = up(800, 0.0002, 2);
  const { dates, bars } = alignBars([a, b]);

  it("rebalances equal weight monthly at the open, paying costs on the traded value", () => {
    const r = allocationBacktest("equal-weight", bars, dates, { capital: 10_000, costs: COSTS });
    expect(r.rebalances.length).toBeGreaterThan(20);
    expect(r.rebalances[0]!.weights).toEqual([0.5, 0.5]);
    expect(r.costs).toBeGreaterThan(0);
    const q = allocationBacktest("equal-weight", bars, dates, { capital: 10_000, costs: COSTS, rebalance: "quarterly" });
    expect(q.rebalances.length).toBeLessThan(r.rebalances.length);
    const bh = allocationBacktest("buy-and-hold", bars, dates, { capital: 10_000, costs: COSTS });
    expect(bh.rebalances).toHaveLength(1);
    expect(() => allocationBacktest("60-40", [a, b, a], dates, { capital: 1, costs: COSTS })).toThrow(/exactly two/);
    expect(allocationBacktest("60-40", bars, dates, { capital: 10_000, costs: COSTS }).rebalances[0]!.weights).toEqual([0.6, 0.4]);
  });

  it("dual momentum holds the leader while it beats the hurdle, else the safe asset", () => {
    const r = allocationBacktest("dual-momentum", bars, dates, { capital: 10_000, costs: COSTS });
    expect(r.rebalances[0]!.date >= "2021-01-01").toBe(true); // needs 12 months of history
    expect(r.rebalances.at(-1)!.weights).toEqual([1, 0]);
    const high = allocationBacktest("dual-momentum", bars, dates, { capital: 10_000, costs: COSTS, cashRatePct: 500 });
    expect(high.rebalances.at(-1)!.weights).toEqual([0, 1]);
    expect(high.rebalances.at(-1)!.reason).toMatch(/absolute momentum/);
  });

  it("risk parity weights the calmer asset more, decided on the prior close", () => {
    const calm = up(800, 0.0003, 3).map((x) => ({ ...x }));
    const wild = up(800, 0.0003, 4).map((x, i) => ({ ...x, close: x.close * (1 + (i % 2 ? 0.03 : -0.03)) }));
    const al = alignBars([calm, wild]);
    const r = allocationBacktest("risk-parity", al.bars, al.dates, { capital: 10_000, costs: COSTS });
    expect(r.rebalances.at(-1)!.weights[0]!).toBeGreaterThan(0.7);
    // Changing the rebalance day's own close does not change the weights traded at its open.
    const t = al.dates.indexOf(r.rebalances[3]!.date);
    const bumped = al.bars.map((s) => s.map((x, i) => (i === t ? { ...x, close: x.close * 3 } : x)));
    const r2 = allocationBacktest("risk-parity", bumped, al.dates, { capital: 10_000, costs: COSTS });
    expect(r2.rebalances[3]!.weights).toEqual(r.rebalances[3]!.weights);
  });
});

describe("decision quality", () => {
  it("Wilson intervals and t quantiles", () => {
    const w = wilsonInterval(8, 10);
    expect(w.low).toBeCloseTo(0.4902, 3);
    expect(w.high).toBeCloseTo(0.9433, 3);
    expect(wilsonInterval(0, 0).low).toBeNaN();
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.228, 2);
    expect(tQuantile(0.975, 1000)).toBeCloseTo(1.962, 2);
  });

  it("groups by rating and horizon", () => {
    const s = (rating: Settlement["rating"], horizon: number, alphaPct: number, hit: boolean): Settlement => ({
      decisionId: "d",
      symbol: "X",
      rating,
      horizon,
      decidedAt: "2026-01-01",
      startClose: 1,
      endDate: "2026-02-01",
      endClose: 1,
      returnPct: alphaPct + 1,
      alphaPct,
      hit,
      settledAt: "2026-02-02",
    });
    const g = decisionQuality([s("buy", 20, 2, true), s("buy", 20, -1, false), s("buy", 20, 3, true), s("sell", 5, -2, true)]);
    expect(g.map((x) => `${x.rating}${x.horizon}:${x.n}`)).toEqual(["buy20:3", "sell5:1"]);
    expect(g[0]!.hitRate).toBeCloseTo(2 / 3, 9);
    expect(g[0]!.meanAlphaPct).toBeCloseTo(4 / 3, 9);
    expect(g[0]!.alphaLowPct!).toBeLessThan(g[0]!.meanAlphaPct!);
    expect(g[1]!.alphaLowPct).toBeUndefined();
  });
});

describe("review scorecard", () => {
  const good = {
    trades: 80,
    years: 6,
    fullCycle: true,
    netProfit: 5000,
    isSharpe: 1.2,
    oosSharpe: 0.9,
    dsr: 0.97,
    nTrials: 27,
    pbo: 0.2,
    stressedNetProfit: 3000,
    largestWinSharePct: 12,
    lookAheadMismatches: 0,
  };
  it("passes only when every check passes", () => {
    expect(reviewScorecard(good).verdict).toBe("PASS");
    expect(reviewScorecard({ ...good, dsr: 0.9 }).verdict).toBe("REVISE");
    expect(reviewScorecard({ ...good, trades: 20 }).verdict).toBe("REVISE");
    expect(reviewScorecard({ ...good, largestWinSharePct: 40 }).reasons.join()).toMatch(/one trade carries/);
    expect(reviewScorecard({ ...good, universe: "CAC40" }).verdict).toBe("REVISE");
    expect(reviewScorecard({ ...good, stressedNetProfit: -1 }).verdict).toBe("REVISE");
    expect(reviewScorecard({ ...good, oosSharpe: 0.4 }).verdict).toBe("REVISE");
    expect(reviewScorecard({ ...good, years: 2, fullCycle: false }).verdict).toBe("REVISE");
  });
  it("rejects a loss, no out-of-sample edge, a tiny sample or a look-ahead", () => {
    expect(reviewScorecard({ ...good, netProfit: -10 }).verdict).toBe("REJECT");
    expect(reviewScorecard({ ...good, oosSharpe: -0.1 }).verdict).toBe("REJECT");
    expect(reviewScorecard({ ...good, trades: 5 }).verdict).toBe("REJECT");
    const la = reviewScorecard({ ...good, lookAheadMismatches: 2 });
    expect(la.verdict).toBe("REJECT");
    expect(la.reasons.join()).toMatch(/reads the future/);
    expect(reviewScorecard({ ...good, oosSharpe: undefined, isSharpe: undefined }).checks.find((c) => c.id === "robust.oos")!.status).toBe("n/a");
  });
});
