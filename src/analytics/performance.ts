// Performance and risk of a return series — a holding, a portfolio, a
// backtest. Returns are SIMPLE per-period returns (0.01 = +1 %) unless a
// function says otherwise; `periodsPerYear` is 252 for exchange sessions, 365
// for crypto days, 52 for weeks, 12 for months.
import { excessKurtosis, mean, normCdf, normInv, quantile, skewness, stdev } from "./stats.js";

export function simpleReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) out.push(prices[i]! / prices[i - 1]! - 1);
  return out;
}

/** Equity curve from returns, starting at `start`. */
export function equityCurve(returns: readonly number[], start = 1): number[] {
  const out = [start];
  for (const r of returns) out.push(out[out.length - 1]! * (1 + r));
  return out;
}

/** Compound annual growth rate of an equity curve, as a fraction. */
export function cagr(equity: readonly number[], periodsPerYear: number): number {
  if (equity.length < 2 || equity[0]! <= 0) return Number.NaN;
  const years = (equity.length - 1) / periodsPerYear;
  return (equity[equity.length - 1]! / equity[0]!) ** (1 / years) - 1;
}

export function annualizedVolatility(returns: readonly number[], periodsPerYear: number): number {
  return stdev(returns) * Math.sqrt(periodsPerYear);
}

/** Annualised Sharpe ratio; `riskFree` is per period. */
export function sharpe(returns: readonly number[], periodsPerYear: number, riskFree = 0): number {
  const ex = returns.map((r) => r - riskFree);
  const sd = stdev(ex);
  return sd > 0 ? (mean(ex) / sd) * Math.sqrt(periodsPerYear) : Number.NaN;
}

/** Annualised Sortino ratio against a per-period target (downside deviation over all periods). */
export function sortino(returns: readonly number[], periodsPerYear: number, target = 0): number {
  const dd = Math.sqrt(mean(returns.map((r) => Math.min(0, r - target) ** 2)));
  return dd > 0 ? ((mean(returns) - target) / dd) * Math.sqrt(periodsPerYear) : Number.NaN;
}

export interface DrawdownStats {
  /** Worst peak-to-trough, negative fraction. */
  maxDrawdown: number;
  peakIndex: number;
  troughIndex: number;
  /** Index where the previous peak was regained, or undefined if never. */
  recoveryIndex?: number;
  /** Longest stretch below a previous peak, in periods. */
  longestUnderwater: number;
  /** Drawdown at each point, ≤ 0. */
  series: number[];
}

export function drawdowns(equity: readonly number[]): DrawdownStats {
  let peak = equity[0] ?? 0;
  let peakIdx = 0;
  let worst = 0;
  let worstPeak = 0;
  let worstTrough = 0;
  let under = 0;
  let longest = 0;
  const series = equity.map((v, i) => {
    if (v >= peak) {
      peak = v;
      peakIdx = i;
      under = 0;
    } else under++;
    longest = Math.max(longest, under);
    const dd = peak > 0 ? v / peak - 1 : 0;
    if (dd < worst) {
      worst = dd;
      worstPeak = peakIdx;
      worstTrough = i;
    }
    return dd;
  });
  let recoveryIndex: number | undefined;
  for (let i = worstTrough + 1; i < equity.length; i++) {
    if (equity[i]! >= equity[worstPeak]!) {
      recoveryIndex = i;
      break;
    }
  }
  return { maxDrawdown: worst, peakIndex: worstPeak, troughIndex: worstTrough, recoveryIndex, longestUnderwater: longest, series };
}

/** CAGR over the absolute maximum drawdown. */
export function calmar(equity: readonly number[], periodsPerYear: number): number {
  const dd = drawdowns(equity).maxDrawdown;
  return dd < 0 ? cagr(equity, periodsPerYear) / -dd : Number.NaN;
}

/** Ulcer index: root mean square of percentage drawdowns (Martin, 1987). */
export function ulcerIndex(equity: readonly number[]): number {
  const s = drawdowns(equity).series;
  return Math.sqrt(mean(s.map((d) => (d * 100) ** 2)));
}

/** Omega ratio at a per-period threshold: gains above it over losses below it. */
export function omega(returns: readonly number[], threshold = 0): number {
  let up = 0;
  let down = 0;
  for (const r of returns) {
    if (r > threshold) up += r - threshold;
    else down += threshold - r;
  }
  return down > 0 ? up / down : Number.POSITIVE_INFINITY;
}

export interface Relative {
  beta: number;
  /** Jensen's alpha, annualised, against the benchmark. */
  alpha: number;
  correlation: number;
  trackingError: number;
  informationRatio: number;
  /** Mean return in the benchmark's up periods over the benchmark's, as a fraction (1 = 100 %). */
  upCapture: number;
  downCapture: number;
}

export function relativeTo(returns: readonly number[], bench: readonly number[], periodsPerYear: number, riskFree = 0): Relative {
  const n = Math.min(returns.length, bench.length);
  const r = returns.slice(-n);
  const b = bench.slice(-n);
  const mr = mean(r);
  const mb = mean(b);
  let cov = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (r[i]! - mr) * (b[i]! - mb);
    vb += (b[i]! - mb) ** 2;
  }
  const beta = cov / vb;
  const alpha = (mr - riskFree - beta * (mb - riskFree)) * periodsPerYear;
  const active = r.map((v, i) => v - b[i]!);
  const te = stdev(active) * Math.sqrt(periodsPerYear);
  const capture = (pred: (x: number) => boolean) => {
    const idx = b.map((v, i) => (pred(v) ? i : -1)).filter((i) => i >= 0);
    return idx.length ? mean(idx.map((i) => r[i]!)) / mean(idx.map((i) => b[i]!)) : Number.NaN;
  };
  return {
    beta,
    alpha,
    correlation: cov / Math.sqrt(vb * r.reduce((s, v) => s + (v - mr) ** 2, 0)),
    trackingError: te,
    informationRatio: te > 0 ? (mean(active) * periodsPerYear) / te : Number.NaN,
    upCapture: capture((v) => v > 0),
    downCapture: capture((v) => v < 0),
  };
}

// --- Value at risk ----------------------------------------------------------------

/** One-period historical VaR at `confidence`, as a positive loss fraction. */
export function historicalVar(returns: readonly number[], confidence = 0.95): number {
  return -quantile(returns, 1 - confidence);
}

/** Expected shortfall (CVaR): the mean loss beyond the historical VaR, positive. */
export function historicalCvar(returns: readonly number[], confidence = 0.95): number {
  const cut = quantile(returns, 1 - confidence);
  const tail = returns.filter((r) => r <= cut);
  return tail.length ? -mean(tail) : Number.NaN;
}

/** Gaussian VaR, positive loss. */
export function parametricVar(returns: readonly number[], confidence = 0.95): number {
  return -(mean(returns) + normInv(1 - confidence) * stdev(returns));
}

/** Cornish–Fisher VaR: the Gaussian quantile corrected for skewness and excess kurtosis. */
export function cornishFisherVar(returns: readonly number[], confidence = 0.95): number {
  const z = normInv(1 - confidence);
  const s = skewness(returns);
  const k = excessKurtosis(returns);
  const zcf = z + ((z * z - 1) * s) / 6 + ((z ** 3 - 3 * z) * k) / 24 - ((2 * z ** 3 - 5 * z) * s * s) / 36;
  return -(mean(returns) + zcf * stdev(returns));
}

/**
 * Bootstrap VaR over `horizon` periods: resample historical returns with a
 * seeded generator (deterministic), compound them, take the loss quantile.
 */
export function bootstrapVar(returns: readonly number[], horizon: number, confidence = 0.95, paths = 5000, seed = 42): { var: number; cvar: number } {
  const rnd = seededRandom(seed);
  const outcomes: number[] = [];
  for (let p = 0; p < paths; p++) {
    let g = 1;
    for (let h = 0; h < horizon; h++) g *= 1 + returns[Math.floor(rnd() * returns.length)]!;
    outcomes.push(g - 1);
  }
  return { var: historicalVar(outcomes, confidence), cvar: historicalCvar(outcomes, confidence) };
}

/** A small deterministic PRNG (mulberry32): same seed, same paths, same report. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Is the Sharpe ratio real? ------------------------------------------------------

/**
 * Probabilistic Sharpe ratio (Bailey & López de Prado, 2012): the probability
 * that the true per-period Sharpe exceeds `benchmark`, given T observations
 * with this skewness and excess kurtosis. Use per-period (not annualised) SR.
 */
export function probabilisticSharpe(sr: number, T: number, skew: number, exKurt: number, benchmark = 0): number {
  const denom = Math.sqrt(1 - skew * sr + ((exKurt + 2) / 4) * sr * sr);
  return normCdf(((sr - benchmark) * Math.sqrt(T - 1)) / denom);
}

/** Expected maximum Sharpe among N independent trials with zero true skill (False Strategy Theorem). */
export function expectedMaxSharpe(nTrials: number, srVariance: number): number {
  const g = 0.5772156649015329;
  return Math.sqrt(srVariance) * ((1 - g) * normInv(1 - 1 / nTrials) + g * normInv(1 - 1 / (nTrials * Math.E)));
}

/**
 * Deflated Sharpe ratio (Bailey & López de Prado, 2014): the PSR against the
 * Sharpe ratio the best of `nTrials` worthless strategies would show. Below
 * 0.95, the backtest has not shown skill beyond the search that found it.
 */
export function deflatedSharpe(sr: number, T: number, skew: number, exKurt: number, nTrials: number, srVariance: number): number {
  return probabilisticSharpe(sr, T, skew, exKurt, nTrials > 1 ? expectedMaxSharpe(nTrials, srVariance) : 0);
}

/** Everything above for one return series, ready to register as evidence. */
export function performanceSummary(returns: readonly number[], periodsPerYear: number, opts: { riskFree?: number; benchmark?: readonly number[] } = {}) {
  const equity = equityCurve(returns);
  const dd = drawdowns(equity);
  const srPer = stdev(returns) > 0 ? (mean(returns) - (opts.riskFree ?? 0)) / stdev(returns) : Number.NaN;
  return {
    periods: returns.length,
    cagr: cagr(equity, periodsPerYear),
    volatility: annualizedVolatility(returns, periodsPerYear),
    sharpe: sharpe(returns, periodsPerYear, opts.riskFree),
    sortino: sortino(returns, periodsPerYear),
    maxDrawdown: dd.maxDrawdown,
    longestUnderwater: dd.longestUnderwater,
    calmar: calmar(equity, periodsPerYear),
    ulcer: ulcerIndex(equity),
    omega: omega(returns),
    skew: skewness(returns),
    excessKurtosis: excessKurtosis(returns),
    var95: historicalVar(returns, 0.95),
    cvar95: historicalCvar(returns, 0.95),
    cornishFisherVar95: cornishFisherVar(returns, 0.95),
    probabilisticSharpe: probabilisticSharpe(srPer, returns.length, skewness(returns), excessKurtosis(returns)),
    hitRate: returns.filter((r) => r > 0).length / returns.length,
    relative: opts.benchmark ? relativeTo(returns, opts.benchmark, periodsPerYear, opts.riskFree) : undefined,
  };
}
