// Statistics for markets, written out rather than imported: the bundle has no
// dependencies, and every estimator here is one a decision may rest on, so each
// says what it assumes. Inputs are plain arrays of numbers (returns, prices);
// nothing reads the clock or the network.

/** Arithmetic mean; NaN for an empty input. */
export function mean(xs: readonly number[]): number {
  if (!xs.length) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (n − 1). */
export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

export function stdev(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

/** Sample skewness (adjusted Fisher–Pearson). */
export function skewness(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return Number.NaN;
  const m = mean(xs);
  const sd = stdev(xs);
  let s = 0;
  for (const x of xs) s += ((x - m) / sd) ** 3;
  return (n / ((n - 1) * (n - 2))) * s;
}

/** Excess kurtosis (sample, bias-corrected); 0 for a normal distribution. */
export function excessKurtosis(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 4) return Number.NaN;
  const m = mean(xs);
  const sd = stdev(xs);
  let s = 0;
  for (const x of xs) s += ((x - m) / sd) ** 4;
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * s - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}

/** Quantile by linear interpolation between order statistics (Hyndman–Fan type 7, as R and NumPy default). */
export function quantile(xs: readonly number[], p: number): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  return s[lo]! + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)] ?? s[lo]!) - s[lo]!);
}

/** Share of values ≤ x, in [0, 1]. */
export function percentileRank(xs: readonly number[], x: number): number {
  if (!xs.length) return Number.NaN;
  let k = 0;
  for (const v of xs) if (v <= x) k++;
  return k / xs.length;
}

export function covariance(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return Number.NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i]! - ma) * (b[i]! - mb);
  return s / (n - 1);
}

/** Pearson correlation. */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  return covariance(a.slice(0, n), b.slice(0, n)) / (stdev(a.slice(0, n)) * stdev(b.slice(0, n)));
}

function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation (ties get average ranks). */
export function spearman(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  return correlation(ranks(a.slice(0, n)), ranks(b.slice(0, n)));
}

/** Correlation matrix of several equal-length series. */
export function correlationMatrix(series: readonly (readonly number[])[]): number[][] {
  return series.map((a, i) => series.map((b, j) => (i === j ? 1 : correlation(a, b))));
}

// --- Normal distribution ----------------------------------------------------------

/** Standard normal CDF (Zelen & Severo, Abramowitz–Stegun 26.2.17: absolute error < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function normPdf(x: number): number {
  return 0.3989422804014327 * Math.exp((-x * x) / 2);
}

/** Inverse standard normal CDF (Acklam's algorithm, relative error < 1.15e-9). */
export function normInv(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

// --- Regression ---------------------------------------------------------------------

export interface OlsResult {
  /** Intercept first when `intercept` is true, then one per regressor. */
  coef: number[];
  se: number[];
  t: number[];
  r2: number;
  residuals: number[];
  n: number;
  /** Newey–West HAC standard errors (robust to autocorrelation and heteroskedasticity). */
  hacSe: number[];
  hacT: number[];
  hacLags: number;
}

/** Solve A x = b for a small symmetric positive-definite A (Gaussian elimination with partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const p = M[col]![col]!;
    if (Math.abs(p) < 1e-14) throw new Error("singular matrix: regressors are collinear");
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / p;
      for (let k = col; k <= n; k++) M[r]![k]! -= f * M[col]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Inverse of a small square matrix, column by column. */
function inverse(A: number[][]): number[][] {
  const n = A.length;
  const cols = Array.from({ length: n }, (_, j) =>
    solve(
      A,
      Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)),
    ),
  );
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => cols[j]![i]!));
}

/** Ordinary least squares of y on the columns of X, with classical and Newey–West standard errors. */
export function ols(y: readonly number[], X: readonly (readonly number[])[], opts: { intercept?: boolean; hacLags?: number } = {}): OlsResult {
  const n = y.length;
  const rows = Array.from({ length: n }, (_, i) => [...(opts.intercept === false ? [] : [1]), ...X.map((col) => col[i]!)]);
  const k = rows[0]!.length;
  if (n <= k) throw new Error(`ols needs more observations (${n}) than coefficients (${k})`);
  const XtX = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => rows.reduce((s, r) => s + r[a]! * r[b]!, 0)));
  const Xty = Array.from({ length: k }, (_, a) => rows.reduce((s, r, i) => s + r[a]! * y[i]!, 0));
  const coef = solve(XtX, Xty);
  const fitted = rows.map((r) => r.reduce((s, v, j) => s + v * coef[j]!, 0));
  const residuals = y.map((v, i) => v - fitted[i]!);
  const sse = residuals.reduce((s, e) => s + e * e, 0);
  const ym = mean(y);
  const sst = y.reduce((s, v) => s + (v - ym) ** 2, 0);
  const inv = inverse(XtX);
  const s2 = sse / (n - k);
  const se = inv.map((row, j) => Math.sqrt(s2 * row[j]!));
  // Newey–West: S = Σ_t e_t² x_t x_tᵀ + Σ_l w_l Σ_t e_t e_{t−l} (x_t x_{t−l}ᵀ + x_{t−l} x_tᵀ), w_l = 1 − l/(L+1).
  const L = opts.hacLags ?? Math.floor(4 * (n / 100) ** (2 / 9));
  const S = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let t = 0; t < n; t++) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) S[a]![b]! += residuals[t]! ** 2 * rows[t]![a]! * rows[t]![b]!;
  for (let l = 1; l <= L; l++) {
    const w = 1 - l / (L + 1);
    for (let t = l; t < n; t++) {
      const ee = residuals[t]! * residuals[t - l]!;
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) S[a]![b]! += w * ee * (rows[t]![a]! * rows[t - l]![b]! + rows[t - l]![a]! * rows[t]![b]!);
    }
  }
  const mul = (A: number[][], B: number[][]) => A.map((r) => B[0]!.map((_, j) => r.reduce((s, v, m) => s + v * B[m]![j]!, 0)));
  const V = mul(mul(inv, S), inv);
  const hacSe = V.map((row, j) => Math.sqrt(Math.max(0, row[j]!)));
  return {
    coef,
    se,
    t: coef.map((c, j) => c / se[j]!),
    r2: sst > 0 ? 1 - sse / sst : Number.NaN,
    residuals,
    n,
    hacSe,
    hacT: coef.map((c, j) => c / hacSe[j]!),
    hacLags: L,
  };
}

// --- Volatility estimators -------------------------------------------------------

export interface Ohlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** RiskMetrics EWMA volatility of returns (λ = 0.94 daily), per period. */
export function ewmaVol(returns: readonly number[], lambda = 0.94): number {
  if (!returns.length) return Number.NaN;
  let v = returns[0]! ** 2;
  for (let i = 1; i < returns.length; i++) v = lambda * v + (1 - lambda) * returns[i]! ** 2;
  return Math.sqrt(v);
}

/** Parkinson (1980) high–low volatility, per period. */
export function parkinsonVol(bars: readonly Ohlc[]): number {
  if (!bars.length) return Number.NaN;
  const s = bars.reduce((acc, b) => acc + Math.log(b.high / b.low) ** 2, 0);
  return Math.sqrt(s / (4 * Math.log(2) * bars.length));
}

/** Garman–Klass (1980) OHLC volatility, per period. */
export function garmanKlassVol(bars: readonly Ohlc[]): number {
  if (!bars.length) return Number.NaN;
  const s = bars.reduce((acc, b) => acc + 0.5 * Math.log(b.high / b.low) ** 2 - (2 * Math.log(2) - 1) * Math.log(b.close / b.open) ** 2, 0);
  return Math.sqrt(s / bars.length);
}

/** Yang–Zhang (2000) volatility: overnight + open-to-close + Rogers–Satchell, drift-independent. */
export function yangZhangVol(bars: readonly Ohlc[]): number {
  const n = bars.length - 1;
  if (n < 2) return Number.NaN;
  const o: number[] = [];
  const c: number[] = [];
  let rs = 0;
  for (let i = 1; i <= n; i++) {
    const b = bars[i]!;
    o.push(Math.log(b.open / bars[i - 1]!.close));
    c.push(Math.log(b.close / b.open));
    rs += Math.log(b.high / b.close) * Math.log(b.high / b.open) + Math.log(b.low / b.close) * Math.log(b.low / b.open);
  }
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  return Math.sqrt(variance(o) + k * variance(c) + (1 - k) * (rs / n));
}

/** Nelder–Mead minimiser, for small smooth problems (GARCH, curve fits). */
export function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  opts: { step?: number; maxIter?: number; tol?: number } = {},
): { x: number[]; fx: number; iterations: number } {
  const n = x0.length;
  const step = opts.step ?? 0.1;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + (v === 0 ? step : step * Math.abs(v)) : v)))];
  let values = simplex.map(f);
  let it = 0;
  for (; it < (opts.maxIter ?? 2000); it++) {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    simplex = order.map(([, i]) => simplex[i]!);
    values = order.map(([v]) => v);
    if (Math.abs(values[n]! - values[0]!) < (opts.tol ?? 1e-10)) break;
    const centroid = x0.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p[j]!, 0) / n);
    const along = (t: number) => centroid.map((c, j) => c + t * (simplex[n]![j]! - c));
    const xr = along(-1);
    const fr = f(xr);
    if (fr < values[0]!) {
      const xe = along(-2);
      const fe = f(xe);
      [simplex[n], values[n]] = fe < fr ? [xe, fe] : [xr, fr];
    } else if (fr < values[n - 1]!) [simplex[n], values[n]] = [xr, fr];
    else {
      const xc = along(fr < values[n]! ? -0.5 : 0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, values[n]!)) [simplex[n], values[n]] = [xc, fc];
      else {
        simplex = simplex.map((p, i) => (i === 0 ? p : p.map((v, j) => simplex[0]![j]! + 0.5 * (v - simplex[0]![j]!))));
        values = simplex.map(f);
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return { x: simplex[best]!, fx: values[best]!, iterations: it };
}

export interface Garch11 {
  omega: number;
  alpha: number;
  beta: number;
  /** α + β: how long a shock to volatility lasts. */
  persistence: number;
  /** Long-run per-period volatility √(ω / (1 − α − β)). */
  longRunVol: number;
  /** Conditional per-period volatility after the last observation. */
  currentVol: number;
  logLikelihood: number;
  /** Per-period volatility forecast h steps ahead, h = 1…horizon. */
  forecast: number[];
}

/** GARCH(1,1) by Gaussian quasi-maximum likelihood on demeaned returns. */
export function garch11(returns: readonly number[], horizon = 10): Garch11 {
  if (returns.length < 50) throw new Error("GARCH(1,1) needs at least 50 returns");
  const m = mean(returns);
  const e = returns.map((r) => r - m);
  const v0 = variance(e);
  // Unconstrained parameters → ω > 0, α, β ≥ 0, α + β < 1.
  const map = (p: number[]) => {
    const omega = Math.exp(p[0]!);
    const ea = Math.exp(p[1]!);
    const eb = Math.exp(p[2]!);
    const scale = 1 / (1 + ea + eb);
    return { omega, alpha: ea * scale, beta: eb * scale };
  };
  const nll = (p: number[]) => {
    const { omega, alpha, beta } = map(p);
    let h = v0;
    let ll = 0;
    for (const x of e) {
      ll += Math.log(h) + (x * x) / h;
      h = omega + alpha * x * x + beta * h;
      if (!(h > 0) || !Number.isFinite(h)) return 1e12;
    }
    return 0.5 * ll;
  };
  const start = [Math.log(v0 * 0.05), Math.log(0.08 / 0.04), Math.log(0.9 / 0.04)];
  const { x, fx } = nelderMead(nll, start, { step: 0.5, maxIter: 4000 });
  const { omega, alpha, beta } = map(x);
  let h = v0;
  for (const r of e) h = omega + alpha * r * r + beta * h;
  const persistence = alpha + beta;
  const longRun = omega / (1 - persistence);
  const forecast: number[] = [];
  for (let k = 1; k <= horizon; k++) forecast.push(Math.sqrt(longRun + persistence ** (k - 1) * (h - longRun)));
  return {
    omega,
    alpha,
    beta,
    persistence,
    longRunVol: Math.sqrt(longRun),
    currentVol: Math.sqrt(h),
    logLikelihood: -fx - 0.5 * e.length * Math.log(2 * Math.PI),
    forecast,
  };
}

// --- Mean reversion, persistence, stationarity ------------------------------------

/** Hurst exponent by rescaled range over doubling windows: ≈0.5 random walk, >0.5 trending, <0.5 mean-reverting. */
export function hurstExponent(series: readonly number[], minWindow = 8): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let w = minWindow; w <= Math.floor(series.length / 2); w *= 2) {
    const rs: number[] = [];
    for (let start = 0; start + w <= series.length; start += w) {
      const chunk = series.slice(start, start + w);
      const m = mean(chunk);
      let cum = 0;
      let lo = 0;
      let hi = 0;
      for (const v of chunk) {
        cum += v - m;
        lo = Math.min(lo, cum);
        hi = Math.max(hi, cum);
      }
      const sd = Math.sqrt(chunk.reduce((s, v) => s + (v - m) ** 2, 0) / w);
      if (sd > 0) rs.push((hi - lo) / sd);
    }
    if (rs.length) {
      xs.push(Math.log(w));
      ys.push(Math.log(mean(rs)));
    }
  }
  if (xs.length < 2) return Number.NaN;
  return ols(ys, [xs]).coef[1]!;
}

export interface AdfResult {
  stat: number;
  lags: number;
  /** MacKinnon asymptotic critical values for a regression with a constant. */
  critical: { "1%": number; "5%": number; "10%": number };
  /** Rejects a unit root at 5 %: the series looks stationary. */
  stationary5: boolean;
}

/** Augmented Dickey–Fuller test with a constant: Δy_t = a + γ y_{t−1} + Σ φ_i Δy_{t−i} + e_t. */
export function adfTest(series: readonly number[], lags?: number, critical = { "1%": -3.43, "5%": -2.86, "10%": -2.57 }): AdfResult {
  const p = lags ?? Math.min(12, Math.floor((series.length - 1) ** (1 / 3)));
  const dy = series.slice(1).map((v, i) => v - series[i]!);
  const y: number[] = [];
  const lag1: number[] = [];
  const lagged: number[][] = Array.from({ length: p }, () => []);
  for (let t = p; t < dy.length; t++) {
    y.push(dy[t]!);
    lag1.push(series[t]!);
    for (let i = 0; i < p; i++) lagged[i]!.push(dy[t - i - 1]!);
  }
  const r = ols(y, [lag1, ...lagged]);
  const stat = r.t[1]!;
  return { stat, lags: p, critical, stationary5: stat < critical["5%"] };
}

/** Half-life of mean reversion from an AR(1) fit of Δy on y_{t−1}: ln 2 / −λ (Infinity when not reverting). */
export function halfLife(series: readonly number[]): number {
  const dy = series.slice(1).map((v, i) => v - series[i]!);
  const lambda = ols(dy, [series.slice(0, -1)]).coef[1]!;
  return lambda < 0 ? Math.log(2) / -lambda : Number.POSITIVE_INFINITY;
}

export interface CointegrationResult {
  /** y ≈ alpha + beta · x */
  alpha: number;
  beta: number;
  spread: number[];
  adf: AdfResult;
  halfLife: number;
  /** z-score of the last spread value against the whole spread. */
  zScore: number;
  cointegrated5: boolean;
}

/** Engle–Granger two-step test; residual ADF against the two-variable critical values (MacKinnon 1990). */
export function engleGranger(y: readonly number[], x: readonly number[]): CointegrationResult {
  const n = Math.min(y.length, x.length);
  const r = ols(y.slice(0, n), [x.slice(0, n)]);
  const spread = r.residuals;
  const adf = adfTest(spread, undefined, { "1%": -3.9, "5%": -3.34, "10%": -3.04 });
  const sd = stdev(spread);
  return {
    alpha: r.coef[0]!,
    beta: r.coef[1]!,
    spread,
    adf,
    halfLife: halfLife(spread),
    zScore: (spread[spread.length - 1]! - mean(spread)) / sd,
    cointegrated5: adf.stationary5,
  };
}

/** Empirical lower-tail dependence: P(B in its worst q | A in its worst q). */
export function lowerTailDependence(a: readonly number[], b: readonly number[], q = 0.05): number {
  const n = Math.min(a.length, b.length);
  const qa = quantile(a.slice(0, n), q);
  const qb = quantile(b.slice(0, n), q);
  let both = 0;
  let inA = 0;
  for (let i = 0; i < n; i++) {
    if (a[i]! <= qa) {
      inA++;
      if (b[i]! <= qb) both++;
    }
  }
  return inA ? both / inA : Number.NaN;
}

// --- Regimes ----------------------------------------------------------------------

export interface HmmResult {
  /** State 0 is the calmer one (lower volatility). */
  means: [number, number];
  vols: [number, number];
  transition: [[number, number], [number, number]];
  /** P(state 1 | data up to t), filtered — no look-ahead. */
  turbulentProbability: number[];
  logLikelihood: number;
  iterations: number;
}

/**
 * Two-state Gaussian hidden Markov model fitted by Baum–Welch. The reported
 * probabilities are FILTERED (forward pass only): the value at t uses returns
 * up to t, never after, so it can drive a backtest.
 */
export function hmm2(returns: readonly number[], maxIter = 200): HmmResult {
  const n = returns.length;
  if (n < 30) throw new Error("a regime model needs at least 30 returns");
  const sd = stdev(returns);
  let mu: [number, number] = [mean(returns), mean(returns)];
  let sig: [number, number] = [sd * 0.6, sd * 1.6];
  let A: [[number, number], [number, number]] = [
    [0.95, 0.05],
    [0.1, 0.9],
  ];
  let pi: [number, number] = [0.5, 0.5];
  const pdf = (x: number, m: number, s: number) => Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI)) + 1e-300;
  let ll = Number.NEGATIVE_INFINITY;
  let it = 0;
  let alphaHat: number[][] = [];
  for (; it < maxIter; it++) {
    alphaHat = [];
    const c: number[] = [];
    for (let t = 0; t < n; t++) {
      const prev = t === 0 ? pi : [0, 1].map((j) => alphaHat[t - 1]![0]! * A[0][j]! + alphaHat[t - 1]![1]! * A[1][j]!);
      const a = [0, 1].map((j) => prev[j]! * pdf(returns[t]!, mu[j]!, sig[j]!));
      const s = a[0]! + a[1]!;
      c.push(s);
      alphaHat.push([a[0]! / s, a[1]! / s]);
    }
    const beta: number[][] = new Array(n);
    beta[n - 1] = [1, 1];
    for (let t = n - 2; t >= 0; t--) {
      const b = [0, 1].map((i) => [0, 1].reduce((s, j) => s + A[i]![j]! * pdf(returns[t + 1]!, mu[j]!, sig[j]!) * beta[t + 1]![j]!, 0));
      beta[t] = [b[0]! / c[t + 1]!, b[1]! / c[t + 1]!];
    }
    const gamma = alphaHat.map((a, t) => {
      const g = [a[0]! * beta[t]![0]!, a[1]! * beta[t]![1]!];
      const s = g[0]! + g[1]!;
      return [g[0]! / s, g[1]! / s];
    });
    const xi = [
      [0, 0],
      [0, 0],
    ];
    for (let t = 0; t < n - 1; t++) {
      let tot = 0;
      const m: number[][] = [
        [0, 0],
        [0, 0],
      ];
      for (let i = 0; i < 2; i++)
        for (let j = 0; j < 2; j++) {
          m[i]![j] = alphaHat[t]![i]! * A[i]![j]! * pdf(returns[t + 1]!, mu[j]!, sig[j]!) * beta[t + 1]![j]!;
          tot += m[i]![j]!;
        }
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) xi[i]![j]! += m[i]![j]! / tot;
    }
    const newLl = c.reduce((s, v) => s + Math.log(v), 0);
    pi = [gamma[0]![0]!, gamma[0]![1]!];
    A = [0, 1].map((i) => {
      const row = xi[i]!;
      const s = row[0]! + row[1]!;
      return [row[0]! / s, row[1]! / s];
    }) as [[number, number], [number, number]];
    for (let j = 0; j < 2; j++) {
      const w = gamma.reduce((s, g) => s + g[j]!, 0);
      mu[j] = gamma.reduce((s, g, t) => s + g[j]! * returns[t]!, 0) / w;
      sig[j] = Math.max(1e-8, Math.sqrt(gamma.reduce((s, g, t) => s + g[j]! * (returns[t]! - mu[j]!) ** 2, 0) / w));
    }
    if (Math.abs(newLl - ll) < 1e-8) {
      ll = newLl;
      break;
    }
    ll = newLl;
  }
  const swap = sig[0] > sig[1];
  if (swap) {
    mu = [mu[1], mu[0]];
    sig = [sig[1], sig[0]];
    A = [
      [A[1][1], A[1][0]],
      [A[0][1], A[0][0]],
    ];
  }
  return {
    means: mu,
    vols: sig,
    transition: A,
    turbulentProbability: alphaHat.map((a) => (swap ? a[0]! : a[1]!)),
    logLikelihood: ll,
    iterations: it,
  };
}

/** Two-sided CUSUM on standardised values: indices where a mean shift of `k` sd accumulates past `h` sd. */
export function cusumBreaks(xs: readonly number[], k = 0.5, h = 5): number[] {
  const m = mean(xs);
  const sd = stdev(xs);
  const out: number[] = [];
  let pos = 0;
  let neg = 0;
  xs.forEach((x, i) => {
    const z = (x - m) / sd;
    pos = Math.max(0, pos + z - k);
    neg = Math.min(0, neg + z + k);
    if (pos > h || neg < -h) {
      out.push(i);
      pos = 0;
      neg = 0;
    }
  });
  return out;
}
