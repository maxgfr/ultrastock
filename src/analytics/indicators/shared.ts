// Plumbing shared by the indicator groups: price extractors and the
// `chain` combinator that runs an array-in/array-out function on the defined
// suffix of an aligned series and re-aligns the result. Every group keeps the
// core contract (src/analytics/indicators.ts): output index i is the value as
// known at the close of bar i, `undefined` until the window is full.
import type { Bar } from "../../providers/types.js";
import type { Series } from "../indicators.js";

export type { Series };

/** An aligned series of objects (multi-output indicators). */
export type Rows<T> = Array<T | undefined>;

export const closesOf = (bars: readonly Bar[]): number[] => bars.map((b) => b.close);
export const highsOf = (bars: readonly Bar[]): number[] => bars.map((b) => b.high);
export const lowsOf = (bars: readonly Bar[]): number[] => bars.map((b) => b.low);
/** Volumes, a missing volume counting as 0. */
export const volumesOf = (bars: readonly Bar[]): number[] => bars.map((b) => b.volume ?? 0);
/** Typical price (H + L + C) / 3. */
export const typicalPrices = (bars: readonly Bar[]): number[] => bars.map((b) => (b.high + b.low + b.close) / 3);
/** Median price (H + L) / 2. */
export const medianPrices = (bars: readonly Bar[]): number[] => bars.map((b) => (b.high + b.low) / 2);

export function blank<T>(n: number): Array<T | undefined> {
  return new Array<T | undefined>(n).fill(undefined);
}

/** Index of the first defined value, or −1. */
export function firstDefined<T>(xs: ReadonlyArray<T | undefined>): number {
  for (let i = 0; i < xs.length; i++) if (xs[i] !== undefined) return i;
  return -1;
}

/**
 * Apply `fn` (written for a dense number[]) to the defined suffix of an aligned
 * series and re-align its output. The suffix must be contiguous — which every
 * indicator in this library guarantees once its window is full; a hole after
 * the first defined value would be read as NaN, so the hole propagates instead
 * of being silently skipped.
 */
export function chain(series: Series, fn: (xs: number[]) => Series): Series {
  const out: Series = blank(series.length);
  const s = firstDefined(series);
  if (s < 0) return out;
  const tail = series.slice(s).map((x) => (x === undefined ? Number.NaN : x));
  const r = fn(tail);
  for (let j = 0; j < r.length; j++) {
    const v = r[j];
    out[s + j] = v === undefined || Number.isNaN(v) ? undefined : v;
  }
  return out;
}

/** Combine aligned series pointwise; undefined wherever any input is. */
export function zipWith(series: readonly Series[], fn: (...xs: number[]) => number | undefined): Series {
  const n = series[0]?.length ?? 0;
  const out: Series = blank(n);
  for (let i = 0; i < n; i++) {
    const xs: number[] = [];
    let ok = true;
    for (const s of series) {
      const v = s[i];
      if (v === undefined) {
        ok = false;
        break;
      }
      xs.push(v);
    }
    if (ok) out[i] = fn(...xs);
  }
  return out;
}

/** Build aligned rows from named aligned series; a row exists only where every field is defined. */
export function rowsOf<K extends string>(fields: Record<K, Series>, n: number): Rows<Record<K, number>> {
  const keys = Object.keys(fields) as K[];
  const out: Rows<Record<K, number>> = blank(n);
  for (let i = 0; i < n; i++) {
    const row = {} as Record<K, number>;
    let ok = true;
    for (const k of keys) {
      const v = fields[k][i];
      if (v === undefined) {
        ok = false;
        break;
      }
      row[k] = v;
    }
    if (ok) out[i] = row;
  }
  return out;
}

/** Sum of values[i − n + 1 … i]. */
export function windowSum(values: readonly number[], i: number, n: number): number {
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += values[j]!;
  return s;
}
