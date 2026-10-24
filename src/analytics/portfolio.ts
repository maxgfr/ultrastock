// Portfolio construction: covariance estimation and the allocation methods a
// careful investor actually uses. Long-only by default; weights sum to 1.
//
// Sample covariance is noisy and makes mean-variance optimisers chase it, so
// the default estimator is Ledoit–Wolf shrinkage toward a constant-correlation
// target, and the methods that need no expected returns (minimum variance,
// risk parity, hierarchical risk parity) come first. Expected returns enter
// only through Black–Litterman, anchored on the market's implied returns.
import { mean } from "./stats.js";

export type Matrix = number[][];

/** Sample covariance of aligned return series (columns = assets). */
export function sampleCovariance(returns: readonly (readonly number[])[]): Matrix {
  const k = returns.length;
  const n = Math.min(...returns.map((r) => r.length));
  const m = returns.map((r) => mean(r.slice(-n)));
  const cov: Matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let a = 0; a < k; a++)
    for (let b = a; b < k; b++) {
      let s = 0;
      const ra = returns[a]!.slice(-n);
      const rb = returns[b]!.slice(-n);
      for (let t = 0; t < n; t++) s += (ra[t]! - m[a]!) * (rb[t]! - m[b]!);
      cov[a]![b] = cov[b]![a] = s / (n - 1);
    }
  return cov;
}

/**
 * Ledoit–Wolf (2004) shrinkage toward the constant-correlation target, with
 * the optimal intensity estimated from the data. Returns the shrunk matrix and
 * the intensity (0 = sample, 1 = target).
 */
export function ledoitWolf(returns: readonly (readonly number[])[]): { cov: Matrix; shrinkage: number } {
  const k = returns.length;
  const n = Math.min(...returns.map((r) => r.length));
  const X = returns.map((r) => {
    const s = r.slice(-n);
    const m = mean(s);
    return s.map((v) => v - m);
  });
  const S = sampleCovariance(returns).map((row) => row.map((v) => (v * (n - 1)) / n));
  const sd = S.map((row, i) => Math.sqrt(row[i]!));
  let rbar = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) if (i !== j) rbar += S[i]![j]! / (sd[i]! * sd[j]!);
  rbar /= k * (k - 1);
  const F = S.map((row, i) => row.map((v, j) => (i === j ? v : rbar * sd[i]! * sd[j]!)));
  // pi: sum of asymptotic variances of the sample covariances.
  let pi = 0;
  const piMat: Matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += (X[i]![t]! * X[j]![t]! - S[i]![j]!) ** 2;
      piMat[i]![j] = s / n;
      pi += piMat[i]![j]!;
    }
  // rho: the part of pi explained by the target.
  let rho = 0;
  for (let i = 0; i < k; i++) rho += piMat[i]![i]!;
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      let thetaII = 0;
      let thetaJJ = 0;
      for (let t = 0; t < n; t++) {
        const xi = X[i]![t]!;
        const xj = X[j]![t]!;
        thetaII += (xi * xi - S[i]![i]!) * (xi * xj - S[i]![j]!);
        thetaJJ += (xj * xj - S[j]![j]!) * (xi * xj - S[i]![j]!);
      }
      rho += (rbar / 2) * ((sd[j]! / sd[i]!) * (thetaII / n) + (sd[i]! / sd[j]!) * (thetaJJ / n));
    }
  let gamma = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) gamma += (F[i]![j]! - S[i]![j]!) ** 2;
  const kappa = (pi - rho) / gamma;
  const shrinkage = Math.max(0, Math.min(1, kappa / n));
  return { cov: S.map((row, i) => row.map((v, j) => shrinkage * F[i]![j]! + (1 - shrinkage) * v)), shrinkage };
}

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
const mulMv = (M: Matrix, v: readonly number[]) => M.map((row) => dot(row, v));
export const portfolioVariance = (w: readonly number[], cov: Matrix) => dot(w, mulMv(cov, w));

/** Each asset's share of portfolio risk (sums to 1). */
export function riskContributions(w: readonly number[], cov: Matrix): number[] {
  const mv = mulMv(cov, w);
  const total = dot(w, mv);
  return w.map((wi, i) => (wi * mv[i]!) / total);
}

/** Project onto the capped simplex: 0 ≤ w ≤ cap, Σw = 1. */
function projectSimplex(v: readonly number[], cap = 1): number[] {
  let lo = Math.min(...v) - 1;
  let hi = Math.max(...v);
  for (let i = 0; i < 100; i++) {
    const tau = (lo + hi) / 2;
    const s = v.reduce((acc, x) => acc + Math.min(cap, Math.max(0, x - tau)), 0);
    if (s > 1) lo = tau;
    else hi = tau;
  }
  const tau = (lo + hi) / 2;
  return v.map((x) => Math.min(cap, Math.max(0, x - tau)));
}

/** Long-only minimum variance by projected gradient descent, with an optional cap per asset. */
export function minVariance(cov: Matrix, opts: { maxWeight?: number; iterations?: number } = {}): number[] {
  const k = cov.length;
  let w = new Array<number>(k).fill(1 / k);
  const trace = cov.reduce((s, row, i) => s + row[i]!, 0);
  const step = 0.5 / trace;
  for (let it = 0; it < (opts.iterations ?? 5000); it++) {
    const g = mulMv(cov, w).map((x) => 2 * x);
    w = projectSimplex(
      w.map((wi, i) => wi - step * g[i]!),
      opts.maxWeight ?? 1,
    );
  }
  return w;
}

/** Long-only maximum Sharpe ratio for expected excess returns `mu`, by projected gradient ascent on the Sharpe ratio. */
export function maxSharpe(mu: readonly number[], cov: Matrix, opts: { maxWeight?: number; iterations?: number } = {}): number[] {
  const k = cov.length;
  let w = new Array<number>(k).fill(1 / k);
  const sharpeOf = (x: number[]) => dot(x, mu) / Math.sqrt(portfolioVariance(x, cov));
  let best = w;
  let bestS = sharpeOf(w);
  const scale = Math.sqrt(cov.reduce((s, row, i) => s + row[i]!, 0) / k);
  for (let it = 0; it < (opts.iterations ?? 4000); it++) {
    const v = portfolioVariance(w, cov);
    const sd = Math.sqrt(v);
    const r = dot(w, mu);
    const cw = mulMv(cov, w);
    const g = mu.map((m, i) => m / sd - (r * cw[i]!) / (sd * v));
    w = projectSimplex(
      w.map((wi, i) => wi + 0.05 * scale * g[i]!),
      opts.maxWeight ?? 1,
    );
    const s = sharpeOf(w);
    if (s > bestS) {
      bestS = s;
      best = w;
    }
  }
  return best;
}

/** Equal risk contribution (risk parity), long-only, by the Spinu fixed-point scheme. */
export function riskParity(cov: Matrix, budgets?: readonly number[], iterations = 2000): number[] {
  const k = cov.length;
  const b = budgets ?? new Array<number>(k).fill(1 / k);
  let w = cov.map((row, i) => 1 / Math.sqrt(row[i]!));
  const norm = (x: number[]) => {
    const s = x.reduce((a, c) => a + c, 0);
    return x.map((v) => v / s);
  };
  w = norm(w);
  for (let it = 0; it < iterations; it++) {
    const mv = mulMv(cov, w);
    const sigma = Math.sqrt(dot(w, mv));
    // Newton-style update per coordinate: w_i ← solve w_i (Σw)_i = b_i σ².
    w = norm(
      w.map((wi, i) => {
        const c = mv[i]! - cov[i]![i]! * wi;
        const a = cov[i]![i]!;
        const target = b[i]! * sigma * sigma;
        return (-c + Math.sqrt(c * c + 4 * a * target)) / (2 * a);
      }),
    );
  }
  return w;
}

/** Hierarchical risk parity (López de Prado, 2016): single-linkage clustering on correlation distance, quasi-diagonal order, recursive bisection. */
export function hierarchicalRiskParity(cov: Matrix): number[] {
  const k = cov.length;
  const sd = cov.map((row, i) => Math.sqrt(row[i]!));
  const dist = (i: number, j: number) => Math.sqrt(Math.max(0, 0.5 * (1 - cov[i]![j]! / (sd[i]! * sd[j]!))));
  // Single-linkage agglomerative clustering, recording the merge order to get the leaf ordering.
  let clusters: number[][] = Array.from({ length: k }, (_, i) => [i]);
  while (clusters.length > 1) {
    let best = [0, 1];
    let bestD = Number.POSITIVE_INFINITY;
    for (let a = 0; a < clusters.length; a++)
      for (let b = a + 1; b < clusters.length; b++) {
        let d = Number.POSITIVE_INFINITY;
        for (const i of clusters[a]!) for (const j of clusters[b]!) d = Math.min(d, dist(i, j));
        if (d < bestD) {
          bestD = d;
          best = [a, b];
        }
      }
    const merged = [...clusters[best[0]!]!, ...clusters[best[1]!]!];
    clusters = clusters.filter((_, i) => i !== best[0] && i !== best[1]);
    clusters.push(merged);
  }
  const order = clusters[0]!;
  const w = new Array<number>(k).fill(1);
  const clusterVar = (items: number[]) => {
    const iv = items.map((i) => 1 / cov[i]![i]!);
    const s = iv.reduce((a, b) => a + b, 0);
    const ww = iv.map((v) => v / s);
    let v = 0;
    items.forEach((i, a) => items.forEach((j, b) => (v += ww[a]! * ww[b]! * cov[i]![j]!)));
    return v;
  };
  const bisect = (items: number[]) => {
    if (items.length < 2) return;
    const half = Math.floor(items.length / 2);
    const left = items.slice(0, half);
    const right = items.slice(half);
    const vl = clusterVar(left);
    const vr = clusterVar(right);
    const alpha = 1 - vl / (vl + vr);
    for (const i of left) w[i]! *= alpha;
    for (const i of right) w[i]! *= 1 - alpha;
    bisect(left);
    bisect(right);
  };
  bisect(order);
  return w;
}

/** Solve a small linear system (Gaussian elimination with partial pivoting). */
function solveLinear(A: Matrix, b: readonly number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let j = c; j <= n; j++) M[r]![j]! -= f * M[c]![j]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

export interface View {
  /** Weights of the view portfolio over the assets (e.g. [1, 0, −1] for "A beats C"). */
  pick: number[];
  /** Expected return of that portfolio. */
  expected: number;
  /** Confidence 0–1 (Idzorek-style: scales the view's uncertainty). */
  confidence: number;
}

/**
 * Black–Litterman: the market's implied excess returns Π = δΣw_mkt, blended
 * with the investor's views. Returns posterior expected returns, to feed
 * maxSharpe. δ is the risk aversion (≈ 2.5), τ the prior's uncertainty scale.
 */
export function blackLitterman(
  cov: Matrix,
  marketWeights: readonly number[],
  views: readonly View[],
  opts: { delta?: number; tau?: number } = {},
): { implied: number[]; posterior: number[] } {
  const delta = opts.delta ?? 2.5;
  const tau = opts.tau ?? 0.05;
  const implied = mulMv(cov, marketWeights as number[]).map((v) => delta * v);
  if (!views.length) return { implied, posterior: implied };
  const k = cov.length;
  // Posterior: μ = Π + τΣPᵀ (PτΣPᵀ + Ω)⁻¹ (Q − PΠ), Ω diagonal from confidence.
  const tS = cov.map((row) => row.map((v) => v * tau));
  const P = views.map((v) => v.pick);
  const tSPt = tS.map((row) => P.map((p) => dot(row, p)));
  const PtSPt = P.map((p) =>
    P.map((_, j) =>
      dot(
        p,
        tSPt.map((r) => r[j]!),
      ),
    ),
  );
  const omega = views.map((v, i) => (PtSPt[i]![i]! * (1 - v.confidence)) / Math.max(1e-6, v.confidence));
  const A = PtSPt.map((row, i) => row.map((x, j) => x + (i === j ? omega[i]! : 0)));
  const diff = views.map((v, i) => v.expected - dot(P[i]!, implied));
  const x = solveLinear(A, diff);
  const posterior = Array.from({ length: k }, (_, a) => implied[a]! + tSPt[a]!.reduce((s, v, j) => s + v * x[j]!, 0));
  return { implied, posterior };
}

export interface RebalanceTrade {
  asset: string;
  /** Current and target weights, in %. */
  current: number;
  target: number;
  /** Money to buy (+) or sell (−), in the portfolio's currency. */
  amount: number;
}

/**
 * Bands, not calendars: trade only the assets whose weight drifted beyond
 * `bandPct` points (absolute) or `relBand` (relative) from target, and only
 * back to the target. Cash flows (`contribution`, + in / − out) are steered to
 * the underweights first, which often avoids selling at all.
 */
export function rebalance(
  holdings: Record<string, number>,
  targets: Record<string, number>,
  opts: { bandPct?: number; relBand?: number; contribution?: number; minTrade?: number } = {},
): { trades: RebalanceTrade[]; drift: Array<{ asset: string; drift: number }> } {
  const assets = [...new Set([...Object.keys(holdings), ...Object.keys(targets)])];
  const total = assets.reduce((s, a) => s + (holdings[a] ?? 0), 0) + (opts.contribution ?? 0);
  if (total <= 0) return { trades: [], drift: [] };
  const tsum = Object.values(targets).reduce((s, v) => s + v, 0);
  const band = opts.bandPct ?? 5;
  const rel = opts.relBand ?? 0.25;
  const drift = assets.map((a) => ({ asset: a, drift: ((holdings[a] ?? 0) / total) * 100 - ((targets[a] ?? 0) / tsum) * 100 }));
  const trades: RebalanceTrade[] = [];
  let cash = opts.contribution ?? 0;
  // New money first goes to underweights, largest gap first.
  for (const d of [...drift].sort((x, y) => x.drift - y.drift)) {
    if (cash <= 0 || d.drift >= 0) break;
    const need = (-d.drift / 100) * total;
    const amount = Math.min(need, cash);
    cash -= amount;
    trades.push({ asset: d.asset, current: d.drift + ((targets[d.asset] ?? 0) / tsum) * 100, target: ((targets[d.asset] ?? 0) / tsum) * 100, amount });
  }
  for (const d of drift) {
    const target = ((targets[d.asset] ?? 0) / tsum) * 100;
    const alreadyBought = trades.find((t) => t.asset === d.asset)?.amount ?? 0;
    const residual = d.drift + (alreadyBought / total) * 100;
    const outOfBand = Math.abs(residual) > band || (target > 0 && Math.abs(residual) / target > rel);
    if (!outOfBand) continue;
    const amount = (-residual / 100) * total;
    if (Math.abs(amount) < (opts.minTrade ?? 0)) continue;
    const existing = trades.find((t) => t.asset === d.asset);
    if (existing) existing.amount += amount;
    else trades.push({ asset: d.asset, current: target + d.drift, target, amount });
  }
  return { trades: trades.filter((t) => Math.abs(t.amount) > 1e-9), drift };
}
