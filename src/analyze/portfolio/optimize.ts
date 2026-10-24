// Target weights for a set of holdings by four methods side by side, the pure
// part. Covariance is Ledoit–Wolf shrunk (src/analytics/portfolio.ts); the only
// method that needs expected returns (max Sharpe) gets the historical mean
// shrunk halfway toward the cross-sectional average — a weak estimate, said
// wherever it is used. Weights are capped at the profile's maxPositionPct (raised
// to 1/n when n positions cannot otherwise sum to 100 %). Nothing is ordered.
import { hierarchicalRiskParity, ledoitWolf, maxSharpe, minVariance, portfolioVariance, riskParity } from "../../analytics/portfolio.js";
import { mean } from "../../analytics/stats.js";

/** How much of each asset's own mean survives the shrink toward the average (0.5 = halfway). */
export const MEAN_SHRINK = 0.5;

/** Annualised arithmetic means, shrunk toward their cross-sectional average: μᵢ' = s μᵢ + (1 − s) μ̄. */
export function shrunkMeans(returns: readonly (readonly number[])[], periodsPerYear = 252, keep = MEAN_SHRINK): number[] {
  const mu = returns.map((r) => mean(r) * periodsPerYear);
  const avg = mean(mu);
  return mu.map((m) => keep * m + (1 - keep) * avg);
}

/** Clip weights at `cap` and hand the excess to the uncapped ones pro rata, until none exceeds it (weights sum to 1). */
export function capWeights(w: readonly number[], cap: number): number[] {
  const out = [...w];
  if (cap * w.length < 1 - 1e-12) return out.map(() => 1 / w.length);
  for (let it = 0; it < 100; it++) {
    const over = out.map((x) => x > cap + 1e-12);
    if (!over.some(Boolean)) break;
    const excess = out.reduce((s, x, i) => s + (over[i] ? x - cap : 0), 0);
    const freeSum = out.reduce((s, x, i) => s + (over[i] || x >= cap - 1e-12 ? 0 : x), 0);
    for (let i = 0; i < out.length; i++) if (over[i]) out[i] = cap;
    const free = out.map((x, i) => !over[i] && x < cap - 1e-12);
    const nFree = free.filter(Boolean).length;
    if (!nFree) break;
    for (let i = 0; i < out.length; i++) if (free[i]) out[i]! += freeSum > 0 ? (excess * out[i]!) / freeSum : excess / nFree;
  }
  return out;
}

/** The effective cap: the profile's, or 1/n when the profile's would not let n positions reach 100 %. */
export function effectiveCap(maxPositionPct: number, n: number): { cap: number; raised: boolean } {
  const cap = maxPositionPct / 100;
  return cap * n < 1 ? { cap: 1 / n, raised: true } : { cap: Math.min(1, cap), raised: false };
}

export interface MethodResult {
  method: "current" | "minVariance" | "riskParity" | "hrp" | "maxSharpe";
  label: string;
  weights: number[];
  /** Annualised expected volatility under the shrunk covariance (fraction). */
  vol: number;
  /** Annualised expected return under the shrunk means (fraction) — weak. */
  ret: number;
}

/**
 * Every method on the same inputs. `current` (today's weights renormalised
 * over the universe) is included when given, for comparison.
 */
export function optimizeAll(
  returns: readonly (readonly number[])[],
  opts: { cap: number; current?: readonly number[]; periodsPerYear?: number },
): { results: MethodResult[]; shrinkage: number; mu: number[] } {
  const ppy = opts.periodsPerYear ?? 252;
  const { cov, shrinkage } = ledoitWolf(returns);
  const mu = shrunkMeans(returns, ppy);
  const stat = (w: number[]) => ({ vol: Math.sqrt(portfolioVariance(w, cov) * ppy), ret: w.reduce((s, x, i) => s + x * mu[i]!, 0) });
  const results: MethodResult[] = [];
  if (opts.current) {
    const s = opts.current.reduce((a, b) => a + b, 0);
    const w = opts.current.map((x) => (s > 0 ? x / s : 1 / opts.current!.length));
    results.push({ method: "current", label: "current weights", weights: w, ...stat(w) });
  }
  const mv = minVariance(cov, { maxWeight: opts.cap });
  results.push({ method: "minVariance", label: "minimum variance", weights: mv, ...stat(mv) });
  const rp = capWeights(riskParity(cov), opts.cap);
  results.push({ method: "riskParity", label: "risk parity (equal risk contribution)", weights: rp, ...stat(rp) });
  const hrp = capWeights(hierarchicalRiskParity(cov), opts.cap);
  results.push({ method: "hrp", label: "hierarchical risk parity", weights: hrp, ...stat(hrp) });
  const ms = maxSharpe(
    mu.map((m) => m / ppy),
    cov,
    { maxWeight: opts.cap },
  );
  results.push({ method: "maxSharpe", label: "maximum Sharpe (shrunk historical means — weak)", weights: ms, ...stat(ms) });
  return { results, shrinkage, mu };
}
