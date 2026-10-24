import { describe, expect, it } from "vitest";
import { blackScholes } from "../src/analytics/options.js";
import { PointList } from "../src/analyze/quant/common.js";
import { leverageHeat, poolsFromPoints, realisedPoints, yieldSustainability } from "../src/analyze/quant/crypto.js";
import {
  buildStrategy,
  constantMaturityIv,
  expiryPoints,
  isMonthlyExpiry,
  ivRankPoints,
  parseStrategySpec,
  pickExpiries,
  recordIv,
  strategyPoints,
  termStructure,
  toQuantChain,
} from "../src/analyze/quant/options.js";
import { discountedKelly, kalshiFee, kalshiQuotesFromPoints, kalshiReadingPoints, manifoldQuotesFromPoints } from "../src/analyze/quant/predict.js";
import { alignCloses, multiStatsPoints, singleStatsPoints } from "../src/analyze/quant/stats.js";
import { closedBars } from "../src/commands/quant.js";
import type { OptionChain, OptionContract } from "../src/providers/options/chain.js";
import { day, prng, randomWalk } from "./helpers/series.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const val = (pl: PointList, key: string) => pl.points.find((p) => p.key === key)?.value;

/** A synthetic chain priced by Black–Scholes at a flat 30 % vol (IV stored in percent, as providers do). */
function syntheticChain(premiumInCoin = false): OptionChain {
  const spot = 100;
  const contracts: OptionContract[] = [];
  for (const expiry of ["2026-10-30", "2026-11-20", "2026-12-18", "2027-01-15"]) {
    const t = (Date.parse(`${expiry}T20:00:00Z`) - NOW.getTime()) / (365 * 86_400_000);
    for (let k = 70; k <= 130; k += 5)
      for (const right of ["call", "put"] as const) {
        const g = blackScholes(right, { spot, strike: k, t, r: 0.04, vol: 0.3 });
        const f = premiumInCoin ? 1 / spot : 1;
        contracts.push({
          contract: `XYZ-${expiry}-${k}-${right}`,
          root: "XYZ",
          expiry,
          right,
          strike: k,
          bid: g.price * 0.98 * f,
          ask: g.price * 1.02 * f,
          iv: 30,
          ...(premiumInCoin ? {} : { delta: g.delta, gamma: g.gamma }),
          openInterest: right === "put" ? 200 + k : 300 - k,
          volume: k === 120 && right === "call" && expiry === "2026-11-20" ? 50_000 : 10 + (k % 7),
        });
      }
  }
  return {
    underlying: "XYZ",
    underlyingPrice: spot,
    strikeCurrency: "USD",
    premiumCurrency: premiumInCoin ? "XYZ" : "USD",
    asOf: "2026-10-24",
    contracts,
    provenance: { source: "test", fetchedAt: NOW.toISOString(), official: true },
    notes: [],
  };
}

describe("options-analysis helpers", () => {
  it("recognises monthly expiries and picks the next three at least 7 days out", () => {
    expect(isMonthlyExpiry("2026-11-20", "cboe")).toBe(true);
    expect(isMonthlyExpiry("2026-11-27", "cboe")).toBe(false);
    expect(isMonthlyExpiry("2026-11-27", "deribit")).toBe(true);
    const exp = ["2026-10-30", "2026-11-06", "2026-11-20", "2026-12-18", "2027-01-15", "2027-02-19"].map((e) => ({
      expiry: e,
      dte: Math.round((Date.parse(e) - NOW.getTime()) / 86_400_000),
    }));
    expect(pickExpiries(exp, "cboe")).toEqual(["2026-11-20", "2026-12-18", "2027-01-15"]);
    expect(pickExpiries(exp.slice(0, 3), "cboe")).toEqual(["2026-11-06", "2026-11-20"]);
  });

  it("converts IV to fractions, fills greeks and reads an expiry", () => {
    const q = toQuantChain(syntheticChain(), "cboe", NOW, 0.04);
    expect(q.options[0]!.iv).toBeCloseTo(0.3);
    expect(q.multiplier).toBe(100);
    const out = new PointList();
    expiryPoints(q, "2026-11-20", out);
    expect(val(out, "XYZ.quant.opt.2026-11-20.atmStrike")).toBe(100);
    expect(val(out, "XYZ.quant.opt.2026-11-20.atmIv") as number).toBeCloseTo(30, 5);
    // 1-sd move from IV: S σ √T.
    const t = (Date.parse("2026-11-20T20:00:00Z") - NOW.getTime()) / (365 * 86_400_000);
    expect(val(out, "XYZ.quant.opt.2026-11-20.move1sd.iv") as number).toBeCloseTo(100 * 0.3 * Math.sqrt(t), 6);
    // Straddle-implied 1-sd ≈ IV-implied for an ATM straddle at the money.
    expect(Math.abs((val(out, "XYZ.quant.opt.2026-11-20.move1sd.straddle") as number) / (100 * 0.3 * Math.sqrt(t)) - 1)).toBeLessThan(0.05);
    expect(val(out, "XYZ.quant.opt.2026-11-20.gex.sign")).toMatch(/^(positive|negative)/);
    expect(typeof val(out, "XYZ.quant.opt.2026-11-20.maxPain")).toBe("number");
    expect(out.points.every((p) => typeof p.value !== "number" || Number.isFinite(p.value))).toBe(true);
  });

  it("converts inverse (coin) premiums to USD and computes greeks Deribit does not send", () => {
    const q = toQuantChain(syntheticChain(true), "deribit", NOW, 0.04);
    expect(q.rate).toBe(0);
    expect(q.multiplier).toBe(1);
    const c = q.options.find((o) => o.strike === 100 && o.right === "call" && o.expiry === "2026-11-20")!;
    expect(c.bid! > 1).toBe(true);
    expect(c.delta).toBeGreaterThan(0.4);
    expect(c.gamma).toBeGreaterThan(0);
    expect(q.notes.join(" ")).toMatch(/Black–Scholes/);
  });

  it("builds the term structure and interpolates 30-day IV in total variance", () => {
    expect(
      constantMaturityIv(
        [
          { dte: 20, atmIv: 20 },
          { dte: 40, atmIv: 30 },
        ],
        30,
      ),
    ).toBeCloseTo(Math.sqrt((400 * 20 + ((900 * 40 - 400 * 20) * 10) / 20) / 30), 9);
    expect(constantMaturityIv([{ dte: 60, atmIv: 25 }], 30)).toBe(25);
    const term = termStructure(toQuantChain(syntheticChain(), "cboe", NOW, 0.04));
    expect(term.points.length).toBe(4);
    expect(term.iv30).toBeCloseTo(30, 5);
    // An expiry with no two-sided quote at the money is left out, not read at its model IV.
    const thin = syntheticChain();
    thin.contracts = thin.contracts.map((c) => (c.expiry === "2026-12-18" ? { ...c, bid: 0, iv: 400 } : c));
    const t2 = termStructure(toQuantChain(thin, "cboe", NOW, 0.04));
    expect(t2.skipped).toEqual(["2026-12-18"]);
    expect(t2.iv30).toBeCloseTo(30, 5);
  });

  it("stores IV per date and ranks it from 20 stored days", () => {
    let h = recordIv("TESTIV", "2026-01-01", 20);
    const few = new PointList();
    ivRankPoints("TESTIV", h, 20, few);
    expect(String(val(few, "TESTIV.quant.ivRank.status"))).toMatch(/at least 20 days/);
    for (let i = 1; i < 25; i++) h = recordIv("TESTIV", day(i), 10 + i);
    h = recordIv("TESTIV", day(24), 40); // the same date overwrites
    expect(Object.keys(h.series)).toHaveLength(25);
    const out = new PointList();
    ivRankPoints("TESTIV", h, 40, out);
    expect(val(out, "TESTIV.quant.ivRank")).toBe(100);
    expect(val(out, "TESTIV.quant.ivHistory.days")).toBe(25);
  });

  it("parses strategy specs and refuses bad ones", () => {
    expect(parseStrategySpec("iron-condor:90/95/110/105")).toEqual({ kind: "iron-condor", strikes: [90, 95, 105, 110] });
    expect(() => parseStrategySpec("bull-call:100")).toThrow(/2 strike/);
    expect(() => parseStrategySpec("butterfly:1/2/3")).toThrow(/unknown strategy/);
  });

  it("prices a bull call spread: max profit = width − debit, capped upside noted", () => {
    const q = toQuantChain(syntheticChain(), "cboe", NOW, 0.04);
    const spec = parseStrategySpec("bull-call:100/110");
    const legs = buildStrategy(q, "2026-11-20", spec);
    const out = new PointList();
    const notes = strategyPoints(q, "2026-11-20", spec, legs, out);
    const debit = val(out, "XYZ.quant.strategy.netDebit") as number;
    expect(debit).toBeGreaterThan(0);
    expect(val(out, "XYZ.quant.strategy.maxProfit") as number).toBeCloseTo(10 - debit, 2);
    expect(val(out, "XYZ.quant.strategy.maxLoss") as number).toBeCloseTo(-debit, 2);
    expect(val(out, "XYZ.quant.strategy.breakeven1") as number).toBeCloseTo(100 + debit, 1);
    expect(val(out, "XYZ.quant.strategy.upsideCapped")).toBe(true);
    expect(val(out, "XYZ.quant.strategy.capLevel") as number).toBeCloseTo(110, 0);
    expect(notes.join(" ")).toMatch(/strongly bullish/);
    // 10 moves × 3 dates × 3 vol shifts.
    expect(out.points.filter((p) => p.key.includes(".pnl.")).length).toBe(90);
    expect(() => buildStrategy(q, "2026-11-20", parseStrategySpec("long-call:101"))).toThrow(/nearest listed/);
  });

  it("covered call keeps stock downside and caps upside; a long call does not", () => {
    const q = toQuantChain(syntheticChain(), "cboe", NOW, 0.04);
    const cc = parseStrategySpec("covered-call:110");
    const out = new PointList();
    strategyPoints(q, "2026-12-18", cc, buildStrategy(q, "2026-12-18", cc), out);
    expect(val(out, "XYZ.quant.strategy.upsideCapped")).toBe(true);
    expect(val(out, "XYZ.quant.strategy.bullCase.pnl") as number).toBeLessThan(val(out, "XYZ.quant.strategy.bullCase.stockPnl") as number);
    const lc = parseStrategySpec("long-call:100");
    const out2 = new PointList();
    strategyPoints(q, "2026-12-18", lc, buildStrategy(q, "2026-12-18", lc), out2);
    expect(val(out2, "XYZ.quant.strategy.maxProfit")).toBe("unlimited");
    expect(val(out2, "XYZ.quant.strategy.upsideCapped")).toBeUndefined();
  });
});

describe("stats helpers", () => {
  it("portrays one random walk: every estimator finite, tails ordered", () => {
    const bars = randomWalk(400, 7);
    const out = new PointList();
    singleStatsPoints("RW", bars, 252, out);
    for (const k of ["vol.parkinson", "vol.garmanKlass", "vol.yangZhang", "vol.ewma", "garch.forecast10d", "hurst", "adf.stat", "hmm.turbulent", "ulcer"])
      expect(typeof val(out, `RW.stats.${k}`), k).toBe("number");
    expect(val(out, "RW.stats.var99") as number).toBeGreaterThan(val(out, "RW.stats.var95") as number);
    expect(val(out, "RW.stats.cvar95") as number).toBeGreaterThanOrEqual(val(out, "RW.stats.var95") as number);
    expect(val(out, "RW.stats.maxDrawdown") as number).toBeLessThanOrEqual(0);
    const p = val(out, "RW.stats.hmm.turbulent") as number;
    expect(p >= 0 && p <= 100).toBe(true);
  });

  it("aligns on shared dates and finds a cointegrated pair", () => {
    const r = prng(3);
    const n = 300;
    const x: number[] = [];
    let lx = Math.log(100);
    let e = 0;
    const xa = [];
    const ya = [];
    for (let i = 0; i < n; i++) {
      lx += (r() - 0.5) * 0.04;
      e = 0.5 * e + (r() - 0.5) * 0.02;
      x.push(lx);
      xa.push({ date: day(i), open: 1, high: 1, low: 1, close: Math.exp(lx), volume: 1 });
      ya.push({ date: day(i), open: 1, high: 1, low: 1, close: Math.exp(1.5 * lx + e), volume: 1 });
    }
    const aligned = alignCloses([ya.slice(5), xa]);
    expect(aligned.dates.length).toBe(n - 5);
    const out = new PointList();
    multiStatsPoints(["Y", "X"], aligned, out);
    expect(val(out, "Y~X.stats.coint.hedgeRatio") as number).toBeCloseTo(1.5, 1);
    expect(val(out, "Y~X.stats.coint.verdict")).toMatch(/^cointegrated/);
    expect(val(out, "Y~X.stats.pearson") as number).toBeGreaterThan(0.8);
    expect(typeof val(out, "Y~X.stats.tail5")).toBe("number");
  });

  it("drops a still-forming daily bar", () => {
    const bars = [
      { date: "2026-10-23", open: 1, high: 1, low: 1, close: 1 },
      { date: "2026-10-24", open: 1, high: 1, low: 1, close: 1 },
    ];
    expect(closedBars(bars, true, NOW)).toHaveLength(1);
    expect(closedBars(bars, false, NOW)).toHaveLength(1);
    expect(closedBars(bars, false, new Date("2026-10-24T22:00:00Z"))).toHaveLength(2);
  });
});

describe("crypto-analysis helpers", () => {
  it("reads leverage heat from funding and open interest", () => {
    expect(leverageHeat(35, 12).label).toBe("crowded");
    expect(leverageHeat(35, -3).label).toBe("warm");
    expect(leverageHeat(5, 2).label).toBe("neutral");
    expect(leverageHeat(-10, 5).label).toBe("short-crowded");
    expect(leverageHeat(undefined, 5).label).toBe("unknown");
    expect(leverageHeat(35, 12).reasons.join(" ")).toMatch(/> 20 %\/yr/);
  });

  it("judges yields fragile on emissions share or small TVL", () => {
    const pools = poolsFromPoints([
      { key: "YIELD.aaaa.tvl", label: "aave USDC on Ethereum pool TVL", value: 5e8 },
      { key: "YIELD.aaaa.apy.base", label: "aave USDC on Ethereum base APY (fees, interest)", value: 4 },
      { key: "YIELD.aaaa.apy.rewardShare", label: "x", value: 10 },
      { key: "YIELD.bbbb.tvl", label: "farm USDC on Base pool TVL", value: 2e8 },
      { key: "YIELD.bbbb.apy.rewardShare", label: "x", value: 80 },
      { key: "YIELD.cccc.tvl", label: "tiny USDC on Base pool TVL", value: 2e6 },
    ]);
    expect(pools.map((p) => p.label)).toEqual(["aave USDC on Ethereum", "farm USDC on Base", "tiny USDC on Base"]);
    expect(pools.map((p) => yieldSustainability(p).verdict)).toEqual(["sustainable-looking", "fragile", "fragile"]);
    expect(yieldSustainability(pools[2]!).reasons[0]).toMatch(/TVL 2.0 M USD/);
  });

  it("measures realised volatility over 30 days and the window", () => {
    const out = new PointList();
    realisedPoints("RW", randomWalk(120, 2), out);
    expect(val(out, "RW.quant.realised.vol30d") as number).toBeGreaterThan(0);
    expect(val(out, "RW.quant.realised.maxDrawdown") as number).toBeLessThanOrEqual(0);
  });
});

describe("predict-analysis helpers", () => {
  it("computes Kalshi's quadratic fee rounded up to the cent", () => {
    expect(kalshiFee(100, 0.5, 0.07)).toBeCloseTo(1.75, 9);
    expect(kalshiFee(1, 0.5, 0.07)).toBe(0.02);
    expect(kalshiFee(100, 0.5, 0)).toBe(0);
    expect(kalshiFee(10, 0.9, 0.07)).toBe(0.07);
  });

  it("discounts the Kelly edge by half the spread and bets the favoured side", () => {
    const yes = discountedKelly(0.62, 0.5, 0.04, 0);
    expect(yes.side).toBe("YES");
    expect(yes.pAdj).toBeCloseTo(0.6, 9);
    expect(yes.fraction).toBeCloseTo(0.5 * (0.6 - 0.4 / 1), 9);
    expect(discountedKelly(0.3, 0.5, 0.02, 0).side).toBe("NO");
    expect(discountedKelly(0.51, 0.5, 0.04, 0).fraction).toBe(0);
  });

  it("reads a Kalshi market back from its points and prices the YES+NO pair with fees", () => {
    const quotes = kalshiQuotesFromPoints([
      { key: "KALSHI.KXFED-27APR-T6.00.yes.bid", label: "", value: 0.4 },
      { key: "KALSHI.KXFED-27APR-T6.00.yes.ask", label: "", value: 0.44 },
      { key: "KALSHI.KXFED-27APR-T6.00.no.ask", label: "", value: 0.6 },
      { key: "KALSHI.KXFED-27APR-T6.00.closeTime", label: "", value: "2026-11-03T00:00:00Z" },
    ]);
    expect(quotes).toEqual([{ ticker: "KXFED-27APR-T6.00", yesBid: 0.4, yesAsk: 0.44, noAsk: 0.6, closeTime: "2026-11-03T00:00:00Z" }]);
    const out = new PointList();
    const notes = kalshiReadingPoints(
      quotes[0]!,
      { bids: [{ price: 0.4, size: 300 }], asks: [{ price: 0.44, size: 100 }] },
      { now: NOW, myProbability: 0.62, feeCoefficient: 0.07, contracts: 100 },
      out,
    );
    expect(val(out, "KALSHI.KXFED-27APR-T6.00.quant.prob") as number).toBeCloseTo(42, 9);
    expect(val(out, "KALSHI.KXFED-27APR-T6.00.quant.imbalance")).toBe(0.5);
    // 0.44 + 0.60 = 1.04, plus fees ceil(0.07·100·0.44·0.56) + ceil(0.07·100·0.6·0.4) = 1.73 + 1.68 per 100.
    expect(val(out, "KALSHI.KXFED-27APR-T6.00.quant.pair.cost") as number).toBeCloseTo(1.04 + 0.0341, 6);
    expect(val(out, "KALSHI.KXFED-27APR-T6.00.quant.pair.arbitrage")).toBe(false);
    expect(val(out, "KALSHI.KXFED-27APR-T6.00.quant.daysToClose") as number).toBeCloseTo(9.5, 6);
    expect(val(out, "KALSHI.KXFED-27APR-T6.00.quant.kelly.side")).toBe("YES");
    expect(val(out, "KALSHI.KXFED-27APR-T6.00.quant.kelly.half") as number).toBeGreaterThan(0);
    expect(notes).toEqual([]);
  });

  it("reads Manifold probabilities back from points", () => {
    expect(
      manifoldQuotesFromPoints([
        { key: "MANIFOLD.abc.probability", label: "", value: 37 },
        { key: "MANIFOLD.abc.closeDate", label: "", value: "2027-01-01" },
      ]),
    ).toEqual([{ id: "abc", probability: 0.37, closeDate: "2027-01-01" }]);
  });
});
