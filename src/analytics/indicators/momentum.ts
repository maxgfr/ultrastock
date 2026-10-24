// Momentum oscillators. A flat window (high = low) has no position inside its
// range: range oscillators return their midpoint there (stochastic 50,
// Williams %R −50) rather than dividing by zero.
import type { Bar } from "../../providers/types.js";
import { ema, rsi, sma } from "../indicators.js";
import { wma } from "./averages.js";
import { type Rows, type Series, blank, chain, closesOf, medianPrices, rowsOf, typicalPrices, windowSum } from "./shared.js";
import { rollingMax, rollingMin } from "./stats.js";

/** Rate of change: 100·(x_i / x_{i−n} − 1); undefined when x_{i−n} = 0. */
export function roc(values: readonly number[], n = 12): Series {
  return values.map((x, i) => {
    if (i < n) return undefined;
    const p = values[i - n]!;
    return p === 0 ? undefined : 100 * (x / p - 1);
  });
}

/** Momentum: x_i − x_{i−n}. */
export function momentum(values: readonly number[], n = 10): Series {
  return values.map((x, i) => (i < n ? undefined : x - values[i - n]!));
}

function rangePosition(bars: readonly Bar[], n: number): Series {
  const hh = rollingMax(
    bars.map((b) => b.high),
    n,
  );
  const ll = rollingMin(
    bars.map((b) => b.low),
    n,
  );
  return bars.map((b, i) => {
    const h = hh[i];
    const l = ll[i];
    if (h === undefined || l === undefined) return undefined;
    return h === l ? 50 : (100 * (b.close - l)) / (h - l);
  });
}

/** Clamp to [0, 100]: rolling-sum SMAs can drift a few ulps outside a bounded input's range. */
const bounded = (s: Series): Series => s.map((x) => (x === undefined ? undefined : Math.min(100, Math.max(0, x))));

export interface StochPoint {
  k: number;
  d: number;
}

/**
 * Lane's stochastic oscillator: raw %K = 100·(C − LL)/(HH − LL) over
 * `kPeriod` bars, smoothed by an SMA of `smooth` (1 = fast stochastic, 3 =
 * slow), %D = SMA(%K, dPeriod).
 */
export function stochastic(bars: readonly Bar[], kPeriod = 14, dPeriod = 3, smooth = 1): Rows<StochPoint> {
  const raw = rangePosition(bars, kPeriod);
  const k = smooth > 1 ? bounded(chain(raw, (xs) => sma(xs, smooth))) : raw;
  const d = bounded(chain(k, (xs) => sma(xs, dPeriod)));
  return rowsOf({ k, d }, bars.length);
}

/** Lane's slow stochastic: %K smoothed by SMA(3) (the fast %D), %D = SMA(slow %K, 3). */
export function stochasticSlow(bars: readonly Bar[], kPeriod = 14, dPeriod = 3, smooth = 3): Rows<StochPoint> {
  return stochastic(bars, kPeriod, dPeriod, smooth);
}

/** Williams %R: −100·(HH − C)/(HH − LL) over n bars, in [−100, 0]. */
export function williamsR(bars: readonly Bar[], n = 14): Series {
  return rangePosition(bars, n).map((p) => (p === undefined ? undefined : p - 100));
}

/**
 * Lambert's Commodity Channel Index (1980): (TP − SMA(TP, n)) / (0.015 ×
 * mean absolute deviation of TP from that SMA); 0 for a flat window.
 */
export function cci(bars: readonly Bar[], n = 20, constant = 0.015): Series {
  const tp = typicalPrices(bars);
  const mean = sma(tp, n);
  return tp.map((x, i) => {
    const m = mean[i];
    if (m === undefined) return undefined;
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j]! - m);
    md /= n;
    return md === 0 ? 0 : (x - m) / (constant * md);
  });
}

export interface StochRsiPoint {
  stochRsi: number;
  k: number;
  d: number;
}

/**
 * Chande & Kroll's StochRSI: the stochastic formula applied to Wilder's RSI
 * (0–100 scale), %K = SMA(StochRSI, kSmooth), %D = SMA(%K, dSmooth). Defaults 14/14/3/3.
 */
export function stochRsi(values: readonly number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): Rows<StochRsiPoint> {
  const r = rsi(values, rsiPeriod);
  const st = chain(r, (xs) => {
    const hi = rollingMax(xs, stochPeriod);
    const lo = rollingMin(xs, stochPeriod);
    return xs.map((x, i) => {
      const h = hi[i];
      const l = lo[i];
      if (h === undefined || l === undefined) return undefined;
      return h === l ? 50 : (100 * (x - l)) / (h - l);
    });
  });
  const k = bounded(chain(st, (xs) => sma(xs, kSmooth)));
  const d = bounded(chain(k, (xs) => sma(xs, dSmooth)));
  return rowsOf({ stochRsi: st, k, d }, values.length);
}

export interface KdjPoint {
  k: number;
  d: number;
  j: number;
}

/**
 * KDJ (the stochastic as charted in Asian markets): RSV = raw %K over n bars,
 * K = ((m₁ − 1)·K₋₁ + RSV)/m₁ and D = ((m₂ − 1)·D₋₁ + K)/m₂ with K and D
 * seeded at 50, J = 3K − 2D. Defaults 9/3/3.
 */
export function kdj(bars: readonly Bar[], n = 9, kSmooth = 3, dSmooth = 3): Rows<KdjPoint> {
  const rsv = rangePosition(bars, n);
  const out: Rows<KdjPoint> = blank(bars.length);
  let k = 50;
  let d = 50;
  for (let i = 0; i < bars.length; i++) {
    const r = rsv[i];
    if (r === undefined) continue;
    k = ((kSmooth - 1) * k + r) / kSmooth;
    d = ((dSmooth - 1) * d + k) / dSmooth;
    out[i] = { k, d, j: 3 * k - 2 * d };
  }
  return out;
}

/**
 * Larry Williams' Ultimate Oscillator (1985): buying pressure BP = C −
 * min(L, C₋₁), TR = max(H, C₋₁) − min(L, C₋₁); averages ΣBP/ΣTR over 7, 14
 * and 28 bars, weighted 4/2/1: UO = 100·(4A₇ + 2A₁₄ + A₂₈)/7. A zero-range window counts as 0.5.
 */
export function ultimateOscillator(bars: readonly Bar[], short = 7, medium = 14, long = 28): Series {
  const out: Series = blank(bars.length);
  const bp: number[] = [0];
  const tr: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const pc = bars[i - 1]!.close;
    const lo = Math.min(b.low, pc);
    bp.push(b.close - lo);
    tr.push(Math.max(b.high, pc) - lo);
  }
  const avg = (i: number, n: number) => {
    const t = windowSum(tr, i, n);
    return t === 0 ? 0.5 : windowSum(bp, i, n) / t;
  };
  const start = Math.max(short, medium, long);
  for (let i = start; i < bars.length; i++) out[i] = (100 * (4 * avg(i, short) + 2 * avg(i, medium) + avg(i, long))) / 7;
  return out;
}

/** Bill Williams' Awesome Oscillator: SMA(hl2, 5) − SMA(hl2, 34). */
export function awesomeOscillator(bars: readonly Bar[], fast = 5, slow = 34): Series {
  const mp = medianPrices(bars);
  const f = sma(mp, fast);
  const s = sma(mp, slow);
  return mp.map((_, i) => (f[i] === undefined || s[i] === undefined ? undefined : f[i]! - s[i]!));
}

/** Hutson's TRIX: 1-bar % change of a triple-smoothed EMA(n). First value at bar 3(n − 1) + 1. */
export function trix(values: readonly number[], n = 14): Series {
  const e3 = chain(
    chain(ema(values, n), (xs) => ema(xs, n)),
    (xs) => ema(xs, n),
  );
  return e3.map((x, i) => {
    const p = i > 0 ? e3[i - 1] : undefined;
    if (x === undefined || p === undefined || p === 0) return undefined;
    return 100 * (x / p - 1);
  });
}

/** DecisionPoint's custom smoothing: an EMA with multiplier 2/n (not 2/(n + 1)), seeded with the SMA of the first n values. */
function customSmooth(values: readonly number[], n: number): Series {
  const out: Series = blank(values.length);
  if (values.length < n) return out;
  const k = 2 / n;
  let prev = 0;
  for (let i = 0; i < n; i++) prev += values[i]!;
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev += k * (values[i]! - prev);
    out[i] = prev;
  }
  return out;
}

export interface PmoPoint {
  pmo: number;
  signal: number;
}

/**
 * Carl Swenlin's DecisionPoint Price Momentum Oscillator: 1-bar ROC smoothed
 * by a 35-period custom smoothing (2/35), ×10, smoothed again over 20 (2/20);
 * signal = EMA(PMO, 10).
 */
export function pmo(values: readonly number[], smooth1 = 35, smooth2 = 20, signal = 10): Rows<PmoPoint> {
  const r1 = roc(values, 1);
  const s1 = chain(r1, (xs) => customSmooth(xs, smooth1));
  const line = chain(s1, (xs) =>
    customSmooth(
      xs.map((x) => 10 * x),
      smooth2,
    ),
  );
  const sig = chain(line, (xs) => ema(xs, signal));
  return rowsOf({ pmo: line, signal: sig }, values.length);
}

function weightedRocSum(values: readonly number[], rocs: readonly number[], smas: readonly number[], weights: readonly number[]): Series {
  const parts = rocs.map((r, k) => chain(roc(values, r), (xs) => sma(xs, smas[k]!)));
  return values.map((_, i) => {
    let s = 0;
    for (let k = 0; k < parts.length; k++) {
      const v = parts[k]![i];
      if (v === undefined) return undefined;
      s += weights[k]! * v;
    }
    return s;
  });
}

export interface KstPoint {
  kst: number;
  signal: number;
}

/**
 * Pring's Know Sure Thing (daily): ROC 10/15/20/30 smoothed by SMA 10/10/10/15,
 * weighted 1/2/3/4; signal = SMA(KST, 9).
 */
export function kst(values: readonly number[], signal = 9): Rows<KstPoint> {
  const line = weightedRocSum(values, [10, 15, 20, 30], [10, 10, 10, 15], [1, 2, 3, 4]);
  return rowsOf({ kst: line, signal: chain(line, (xs) => sma(xs, signal)) }, values.length);
}

export interface SpecialKPoint {
  specialK: number;
  signal: number;
}

/**
 * Pring's Special K (daily): Σ weight·SMA(ROC) for ROC 10/15/20/30/40/65/75/100/195/265/390/530
 * with SMA 10/10/10/15/50/65/75/100/130/130/130/195 and weights 1–4 repeated
 * three times; signal = SMA(Special K, signal). Needs ~724 bars before the first value.
 */
export function pringSpecialK(values: readonly number[], signal = 10): Rows<SpecialKPoint> {
  const line = weightedRocSum(
    values,
    [10, 15, 20, 30, 40, 65, 75, 100, 195, 265, 390, 530],
    [10, 10, 10, 15, 50, 65, 75, 100, 130, 130, 130, 195],
    [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4],
  );
  return rowsOf({ specialK: line, signal: chain(line, (xs) => sma(xs, signal)) }, values.length);
}

/** Edwin Coppock's curve (1962): WMA(ROC(14) + ROC(11), 10). */
export function coppockCurve(values: readonly number[], roc1 = 14, roc2 = 11, wmaPeriod = 10): Series {
  const a = roc(values, roc1);
  const b = roc(values, roc2);
  const sum: Series = values.map((_, i) => (a[i] === undefined || b[i] === undefined ? undefined : a[i]! + b[i]!));
  return chain(sum, (xs) => wma(xs, wmaPeriod));
}

/**
 * Detrended Price Oscillator: close[i − (⌊n/2⌋ + 1)] − SMA(n)[i]. Charting
 * packages often shift it back ⌊n/2⌋ + 1 bars to centre it, which needs future
 * bars; here it stays at the bar where it is known.
 */
export function dpo(values: readonly number[], n = 20): Series {
  const shift = Math.floor(n / 2) + 1;
  const m = sma(values, n);
  return values.map((_, i) => (m[i] === undefined || i < shift ? undefined : values[i - shift]! - m[i]!));
}

export interface FisherPoint {
  fisher: number;
  /** The previous bar's Fisher value. */
  signal: number;
}

/**
 * Ehlers' Fisher transform (2002): hl2 normalised to [−1, 1] over n bars,
 * smoothed v = 0.33·raw + 0.67·v₋₁ (clamped to ±0.999), Fisher = ½·ln((1 + v)/(1 − v)) + ½·Fisher₋₁.
 */
export function fisherTransform(bars: readonly Bar[], n = 10): Rows<FisherPoint> {
  const mp = medianPrices(bars);
  const hh = rollingMax(
    bars.map((b) => b.high),
    n,
  );
  const ll = rollingMin(
    bars.map((b) => b.low),
    n,
  );
  const out: Rows<FisherPoint> = blank(bars.length);
  let v = 0;
  let fish = 0;
  for (let i = n - 1; i < bars.length; i++) {
    const h = hh[i]!;
    const l = ll[i]!;
    const raw = h === l ? 0 : 2 * ((mp[i]! - l) / (h - l) - 0.5);
    v = Math.max(-0.999, Math.min(0.999, 0.33 * raw + 0.67 * v));
    const prev = fish;
    fish = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * prev;
    if (i >= n) out[i] = { fisher: fish, signal: prev };
  }
  return out;
}

export interface RviPoint {
  rvi: number;
  signal: number;
}

/**
 * Dorsey/Ehlers Relative Vigor Index: (C − O) and (H − L) each smoothed by
 * the symmetric (1, 2, 2, 1)/6 filter, RVI = Σnum/Σden over n bars, signal =
 * (RVI + 2RVI₋₁ + 2RVI₋₂ + RVI₋₃)/6.
 */
export function rvi(bars: readonly Bar[], n = 10): Rows<RviPoint> {
  const sym = (xs: readonly number[], i: number) => (xs[i]! + 2 * xs[i - 1]! + 2 * xs[i - 2]! + xs[i - 3]!) / 6;
  const co = bars.map((b) => b.close - b.open);
  const hl = bars.map((b) => b.high - b.low);
  const num: number[] = new Array(bars.length).fill(0);
  const den: number[] = new Array(bars.length).fill(0);
  for (let i = 3; i < bars.length; i++) {
    num[i] = sym(co, i);
    den[i] = sym(hl, i);
  }
  const line: Series = blank(bars.length);
  for (let i = n + 2; i < bars.length; i++) {
    const d = windowSum(den, i, n);
    line[i] = d === 0 ? 0 : windowSum(num, i, n) / d;
  }
  const out: Rows<RviPoint> = blank(bars.length);
  for (let i = n + 5; i < bars.length; i++) {
    const l = line as number[];
    out[i] = { rvi: l[i]!, signal: sym(l, i) };
  }
  return out;
}

export interface ElderRayPoint {
  bullPower: number;
  bearPower: number;
}

/** Elder ray (A. Elder): bull power = high − EMA(close, 13), bear power = low − EMA. */
export function elderRay(bars: readonly Bar[], n = 13): Rows<ElderRayPoint> {
  const e = ema(closesOf(bars), n);
  return bars.map((b, i) => (e[i] === undefined ? undefined : { bullPower: b.high - e[i]!, bearPower: b.low - e[i]! }));
}

export interface ShinoharaPoint {
  /** A-ratio (強弱): 100·Σ(H − O)/Σ(O − L) — strength measured from the open. */
  aRatio: number;
  /** B-ratio (人気): 100·Σ(H − C₋₁)/Σ(C₋₁ − L) — sentiment measured from the prior close (terms floored at 0). */
  bRatio: number;
}

/** Shinohara intensity ratios over n bars (default 26); undefined while a denominator is 0. */
export function shinohara(bars: readonly Bar[], n = 26): Rows<ShinoharaPoint> {
  const out: Rows<ShinoharaPoint> = blank(bars.length);
  for (let i = n; i < bars.length; i++) {
    let ho = 0;
    let ol = 0;
    let hc = 0;
    let cl = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const b = bars[j]!;
      const pc = bars[j - 1]!.close;
      ho += Math.max(0, b.high - b.open);
      ol += Math.max(0, b.open - b.low);
      hc += Math.max(0, b.high - pc);
      cl += Math.max(0, pc - b.low);
    }
    if (ol > 0 && cl > 0) out[i] = { aRatio: (100 * ho) / ol, bRatio: (100 * hc) / cl };
  }
  return out;
}
