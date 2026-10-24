// Moving averages beyond the core SMA/EMA. Each is seeded the way its author
// (or the reference platform) does and documented where conventions differ.
import type { Bar } from "../../providers/types.js";
import { ema, sma } from "../indicators.js";
import { type Series, blank, chain, closesOf, volumesOf } from "./shared.js";

/** Linearly weighted moving average: weights 1…n, the newest value weighted n. */
export function wma(values: readonly number[], n: number): Series {
  const out: Series = blank(values.length);
  const den = (n * (n + 1)) / 2;
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += values[i - n + 1 + j]! * (j + 1);
    out[i] = s / den;
  }
  return out;
}

/**
 * Wilder's smoothing (RMA / SMMA): seeded with the SMA of the first `n`
 * values, then avg = (avg·(n − 1) + x) / n — the smoothing of the core RSI and ATR.
 */
export function rma(values: readonly number[], n: number): Series {
  const out: Series = blank(values.length);
  if (values.length < n) return out;
  let prev = 0;
  for (let i = 0; i < n; i++) prev += values[i]!;
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = (prev * (n - 1) + values[i]!) / n;
    out[i] = prev;
  }
  return out;
}

/** Smoothed moving average — another name for Wilder's RMA. */
export const smma = rma;

/** Mulloy's double EMA: 2·EMA − EMA(EMA). */
export function dema(values: readonly number[], n: number): Series {
  const e1 = ema(values, n);
  const e2 = chain(e1, (xs) => ema(xs, n));
  return values.map((_, i) => (e2[i] === undefined ? undefined : 2 * e1[i]! - e2[i]!));
}

/** Mulloy's triple EMA: 3·EMA − 3·EMA(EMA) + EMA(EMA(EMA)). */
export function tema(values: readonly number[], n: number): Series {
  const e1 = ema(values, n);
  const e2 = chain(e1, (xs) => ema(xs, n));
  const e3 = chain(e2, (xs) => ema(xs, n));
  return values.map((_, i) => (e3[i] === undefined ? undefined : 3 * e1[i]! - 3 * e2[i]! + e3[i]!));
}

/**
 * Alan Hull's moving average: WMA(2·WMA(⌊n/2⌋) − WMA(n), round(√n)).
 * First value at bar n + round(√n) − 2.
 */
export function hma(values: readonly number[], n = 16): Series {
  const half = wma(values, Math.max(1, Math.floor(n / 2)));
  const full = wma(values, n);
  const raw: Series = values.map((_, i) => (full[i] === undefined ? undefined : 2 * half[i]! - full[i]!));
  return chain(raw, (xs) => wma(xs, Math.max(1, Math.round(Math.sqrt(n)))));
}

/**
 * Kaufman's adaptive moving average (Smarter Trading, 1995). Efficiency ratio
 * ER = |x_i − x_{i−n}| / Σ|x_j − x_{j−1}| over n bars; smoothing constant
 * SC = (ER·(2/(fast+1) − 2/(slow+1)) + 2/(slow+1))²; KAMA += SC·(x − KAMA).
 * Seeded with the SMA of the first n values at bar n − 1 (as the core EMA).
 */
export function kama(values: readonly number[], n = 10, fast = 2, slow = 30): Series {
  const out: Series = blank(values.length);
  if (values.length < n) return out;
  const fastSc = 2 / (fast + 1);
  const slowSc = 2 / (slow + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += values[i]!;
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    const change = Math.abs(values[i]! - values[i - n]!);
    let vol = 0;
    for (let j = i - n + 1; j <= i; j++) vol += Math.abs(values[j]! - values[j - 1]!);
    const er = vol === 0 ? 0 : change / vol;
    const sc = (er * (fastSc - slowSc) + slowSc) ** 2;
    prev += sc * (values[i]! - prev);
    out[i] = prev;
  }
  return out;
}

/**
 * McGinley Dynamic (J. McGinley, 1990): MD += (x − MD) / (k·n·(x/MD)⁴).
 * k = 1 matches the common charting implementations; McGinley suggested 0.6.
 * Seeded with the SMA of the first n values (TradingView seeds with an EMA, whose first value is that SMA).
 */
export function mcginleyDynamic(values: readonly number[], n = 14, k = 1): Series {
  const out: Series = blank(values.length);
  if (values.length < n) return out;
  let md = 0;
  for (let i = 0; i < n; i++) md += values[i]!;
  md /= n;
  out[n - 1] = md;
  for (let i = n; i < values.length; i++) {
    const x = values[i]!;
    md = md === 0 ? x : md + (x - md) / (k * n * (x / md) ** 4);
    out[i] = md;
  }
  return out;
}

/** Volume-weighted moving average Σ(close·volume) / Σvolume over `n` bars; undefined for a zero-volume window. */
export function vwma(bars: readonly Bar[], n = 20): Series {
  const c = closesOf(bars);
  const v = volumesOf(bars);
  const out: Series = blank(bars.length);
  let pv = 0;
  let vs = 0;
  for (let i = 0; i < bars.length; i++) {
    pv += c[i]! * v[i]!;
    vs += v[i]!;
    if (i >= n) {
      pv -= c[i - n]! * v[i - n]!;
      vs -= v[i - n]!;
    }
    if (i >= n - 1 && vs > 0) out[i] = pv / vs;
  }
  return out;
}

export type MaType = "sma" | "ema" | "wma" | "rma" | "dema" | "tema" | "hma" | "kama";
export const MA_TYPES: readonly MaType[] = ["sma", "ema", "wma", "rma", "dema", "tema", "hma", "kama"];

/** Any of the value-based moving averages by name. */
export function movingAverage(values: readonly number[], n = 20, type: MaType = "ema"): Series {
  switch (type) {
    case "sma":
      return sma(values, n);
    case "ema":
      return ema(values, n);
    case "wma":
      return wma(values, n);
    case "rma":
      return rma(values, n);
    case "dema":
      return dema(values, n);
    case "tema":
      return tema(values, n);
    case "hma":
      return hma(values, n);
    case "kama":
      return kama(values, n);
  }
}
