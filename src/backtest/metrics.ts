// What a simulation is worth: the return series' performance and risk
// (src/analytics/performance.ts), trade statistics, buy-and-hold of the same
// asset, and the residual alpha against a benchmark by OLS with Newey–West
// standard errors. Pure functions over a SimResult.
import { deflatedSharpe, performanceSummary } from "../analytics/performance.js";
import { excessKurtosis, mean, ols, skewness, stdev, variance } from "../analytics/stats.js";
import type { Bar } from "../providers/types.js";
import type { Costs, SimResult, Trade } from "./simulate.js";

export interface TradeStats {
  trades: number;
  longs: number;
  shorts: number;
  /** % of closed trades with a positive net P&L. */
  winRate: number;
  /** Gross profit over gross loss (Infinity without a loss). */
  profitFactor: number;
  /** Mean net P&L per trade, money. */
  expectancy: number;
  /** Mean P&L in R (multiples of the initial risk), when every trade had a stop. */
  expectancyR?: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  avgHoldBars: number;
  /** % of bars with a position open. */
  exposurePct: number;
  avgMaePct: number;
  avgMfePct: number;
  worstMaePct: number;
  maxConsecutiveLosses: number;
  /** The largest winning trade as a % of the net profit (concentration). */
  largestWinSharePct?: number;
  fees: number;
  funding: number;
  byReason: Record<string, number>;
}

export function tradeStats(sim: SimResult): TradeStats {
  const t = sim.trades;
  const wins = t.filter((x) => x.pnl > 0);
  const losses = t.filter((x) => x.pnl < 0);
  const gp = wins.reduce((s, x) => s + x.pnl, 0);
  const gl = -losses.reduce((s, x) => s + x.pnl, 0);
  const net = gp - gl;
  let streak = 0;
  let worstStreak = 0;
  for (const x of t) {
    streak = x.pnl < 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  const rs = t.map((x) => x.r).filter((x): x is number => x !== undefined);
  const byReason: Record<string, number> = {};
  for (const x of t) byReason[x.exitReason] = (byReason[x.exitReason] ?? 0) + 1;
  return {
    trades: t.length,
    longs: t.filter((x) => x.side === "long").length,
    shorts: t.filter((x) => x.side === "short").length,
    winRate: t.length ? (wins.length / t.length) * 100 : Number.NaN,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Number.POSITIVE_INFINITY : Number.NaN,
    expectancy: t.length ? net / t.length : Number.NaN,
    expectancyR: rs.length && rs.length === t.length ? mean(rs) : undefined,
    grossProfit: gp,
    grossLoss: gl,
    netProfit: net,
    avgHoldBars: t.length ? mean(t.map((x) => x.bars)) : Number.NaN,
    exposurePct: sim.equity.length ? (sim.equity.filter((e) => e.exposure !== 0).length / sim.equity.length) * 100 : 0,
    avgMaePct: t.length ? mean(t.map((x) => x.maePct)) : Number.NaN,
    avgMfePct: t.length ? mean(t.map((x) => x.mfePct)) : Number.NaN,
    worstMaePct: t.length ? Math.min(...t.map((x) => x.maePct)) : Number.NaN,
    maxConsecutiveLosses: worstStreak,
    largestWinSharePct: net > 0 && wins.length ? (Math.max(...wins.map((x) => x.pnl)) / net) * 100 : undefined,
    fees: sim.fees,
    funding: sim.funding,
    byReason,
  };
}

/** Periods per year for an interval: 252 sessions for listed securities, 365 days × bars per day for crypto. */
export function periodsPerYear(bars: readonly Bar[], crypto: boolean): number {
  const t = (b: Bar) => Date.parse(b.date.length === 10 ? `${b.date}T00:00:00Z` : b.date);
  const ms = bars.length > 1 ? (t(bars[bars.length - 1]!) - t(bars[0]!)) / (bars.length - 1) : 86_400_000;
  if (crypto) return Math.round((365 * 86_400_000) / Math.max(ms, 60_000));
  if (ms >= 5 * 86_400_000) return 52;
  return 252;
}

export type Summary = ReturnType<typeof performanceSummary> & { finalEquity: number; totalReturn: number; years: number };

/** performanceSummary of a simulation's equity, plus the final equity and total return. */
export function summarize(sim: SimResult, ppy: number, capital: number): Summary {
  const s = performanceSummary(sim.returns, ppy);
  const last = sim.equity[sim.equity.length - 1]?.equity ?? capital;
  return { ...s, finalEquity: last, totalReturn: last / capital - 1, years: sim.returns.length / ppy };
}

/** Buy at the first simulated bar's open (taker + slippage), hold, sell at the last close: per-bar returns. */
export function buyAndHold(bars: readonly Bar[], costs: Costs, start = 0, end = bars.length): { returns: number[]; totalReturn: number } {
  const fee = costs.takerPct / 100;
  const slip = costs.slippagePct / 100;
  const entry = bars[start]!.open * (1 + slip);
  const qty = (1 - fee) / entry;
  const returns: number[] = [];
  let prev = 1;
  for (let t = start; t < end; t++) {
    let v = qty * bars[t]!.close;
    if (t === end - 1) v = qty * bars[t]!.close * (1 - slip) * (1 - fee);
    returns.push(v / prev - 1);
    prev = v;
  }
  return { returns, totalReturn: prev - 1 };
}

export interface AlphaResult {
  /** Annualised intercept, %. */
  alphaPct: number;
  /** Newey–West HAC t-statistic of the intercept. */
  alphaT: number;
  beta: number;
  r2: number;
  n: number;
  hacLags: number;
}

/** Regress the strategy's per-bar returns on the benchmark's (aligned by date): r = α + β·b + ε. */
export function residualAlpha(dates: readonly string[], returns: readonly number[], bench: readonly Bar[], ppy: number): AlphaResult | undefined {
  // Same interval on both sides: daily dates (YYYY-MM-DD) or intraday timestamps match as written.
  const closeByDate = new Map(bench.map((b) => [b.date, b.close]));
  const y: number[] = [];
  const x: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const a = closeByDate.get(dates[i - 1]!);
    const b = closeByDate.get(dates[i]!);
    if (a === undefined || b === undefined || a <= 0) continue;
    y.push(returns[i]!);
    x.push(b / a - 1);
  }
  if (y.length < 30 || variance(x) === 0) return undefined;
  const r = ols(y, [x]);
  return { alphaPct: r.coef[0]! * ppy * 100, alphaT: r.hacT[0]!, beta: r.coef[1]!, r2: r.r2, n: r.n, hacLags: r.hacLags };
}

/** Per-period Sharpe ratio of a return series (not annualised), 0 for a flat series. */
export function periodSharpe(returns: readonly number[]): number {
  const sd = stdev(returns);
  return sd > 0 ? mean(returns) / sd : 0;
}

/**
 * Deflated Sharpe of the chosen variant: its PSR against the Sharpe the best
 * of `nTrials` skill-less variants would show, with the variance of the
 * per-period Sharpe across the variants actually tried.
 */
export function deflatedSharpeOf(chosen: readonly number[], variantSharpes: readonly number[], nTrials: number): number {
  // A flat series (no trade) shows no skill at all.
  if (!(stdev(chosen) > 0)) return 0;
  const sr = periodSharpe(chosen);
  const finite = variantSharpes.filter(Number.isFinite);
  const v = finite.length > 1 ? variance(finite) : 0;
  return deflatedSharpe(sr, chosen.length, skewness(chosen), excessKurtosis(chosen), Math.max(1, nTrials), v);
}

/** The trades' net P&L share of the most profitable one (for the concentration check). */
export function topTradeShare(trades: readonly Trade[]): number | undefined {
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  if (net <= 0 || !trades.length) return undefined;
  return (Math.max(...trades.map((t) => t.pnl)) / net) * 100;
}
