// Rolling statistics and relative strength. Windows end at bar i and include
// it; percent rank compares bar i with the n bars *before* it.
import type { Bar } from "../../providers/types.js";
import { sma } from "../indicators.js";
import { type Series, blank, highsOf, lowsOf } from "./shared.js";

/** Rolling sum over `n` values. */
export function rollingSum(values: readonly number[], n: number): Series {
  const out: Series = blank(values.length);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i]!;
    if (i >= n) s -= values[i - n]!;
    if (i >= n - 1) out[i] = s;
  }
  return out;
}

function rollingExtreme(values: readonly number[], n: number, better: (a: number, b: number) => boolean): Series {
  // Monotonic deque of indices: O(len) whatever the window.
  const out: Series = blank(values.length);
  const dq: number[] = [];
  let head = 0;
  for (let i = 0; i < values.length; i++) {
    while (dq.length > head && !better(values[dq[dq.length - 1]!]!, values[i]!)) dq.pop();
    dq.push(i);
    if (dq[head]! <= i - n) head++;
    if (i >= n - 1) out[i] = values[dq[head]!]!;
  }
  return out;
}

/** Highest value of the last `n` (including bar i). */
export function rollingMax(values: readonly number[], n: number): Series {
  return rollingExtreme(values, n, (a, b) => a > b);
}

/** Lowest value of the last `n` (including bar i). */
export function rollingMin(values: readonly number[], n: number): Series {
  return rollingExtreme(values, n, (a, b) => a < b);
}

/** Highest high of the last `n` bars. */
export function highestHigh(bars: readonly Bar[], n = 14): Series {
  return rollingMax(highsOf(bars), n);
}

/** Lowest low of the last `n` bars. */
export function lowestLow(bars: readonly Bar[], n = 14): Series {
  return rollingMin(lowsOf(bars), n);
}

/** Rolling standard deviation over `n` values: population (÷ n, as in Bollinger) or sample (÷ n − 1). */
export function rollingStdev(values: readonly number[], n: number, sample = false): Series {
  const mean = sma(values, n);
  const out: Series = blank(values.length);
  const d = sample ? n - 1 : n;
  if (d <= 0) return out;
  for (let i = n - 1; i < values.length; i++) {
    const m = mean[i]!;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (values[j]! - m) ** 2;
    out[i] = Math.sqrt(v / d);
  }
  return out;
}

/** Z-score of bar i against its own `n`-value window: (x − SMA) / population stdev; 0 for a flat window. */
export function zScore(values: readonly number[], n = 20): Series {
  const mean = sma(values, n);
  const sd = rollingStdev(values, n);
  return values.map((x, i) => {
    const m = mean[i];
    const s = sd[i];
    if (m === undefined || s === undefined) return undefined;
    return s === 0 ? 0 : (x - m) / s;
  });
}

/** percentRank scans a window shorter than this: on 35 000 bars both ways take ~4 ms at 128. */
const SCAN_BELOW = 128;

/**
 * Percent rank: the share (0–100) of the `n` values before bar i that are ≤
 * the value at i (TradingView's `ta.percentrank` convention). Defined from i = n
 * (a positive integer). NaN is never ≤ anything: it counts for nothing, and
 * a NaN bar ranks 0.
 *
 * A window of SCAN_BELOW values or more is a Fenwick tree of counts over the
 * values' sorted ranks: O(len · log len) whatever `n`, and the same integer
 * count as a scan. A shorter one is scanned, which is faster there.
 */
export function percentRank(values: readonly number[], n = 252): Series {
  const out: Series = blank(values.length);
  if (!Number.isInteger(n) || n < 1 || values.length <= n) return out;
  const len = values.length;
  if (n < SCAN_BELOW) {
    // A short window: scanning it beats sorting the whole series.
    for (let i = n; i < len; i++) {
      const x = values[i]!;
      let le = 0;
      for (let j = i - n; j < i; j++) if (values[j]! <= x) le++;
      out[i] = (100 * le) / n;
    }
    return out;
  }
  // The distinct values, ascending (a typed-array sort puts NaN last; -0 and 0 are one value).
  const sorted = Float64Array.from(values).sort();
  let m = 0;
  for (let k = 0; k < len && !Number.isNaN(sorted[k]); k++) if (m === 0 || sorted[k] !== sorted[m - 1]) sorted[m++] = sorted[k]!;
  // Each value's 1-based rank among them (equal values share one); 0 for NaN, which no count includes.
  const ranks = new Int32Array(len);
  for (let i = 0; i < len; i++) {
    const x = values[i]!;
    let lo = 0;
    let hi = Number.isNaN(x) ? 0 : m;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]! <= x) lo = mid + 1;
      else hi = mid;
    }
    ranks[i] = lo;
  }
  const tree = new Int32Array(m + 1);
  for (let i = 0; i < len; i++) {
    if (i >= n) {
      let le = 0;
      for (let r = ranks[i]!; r > 0; r -= r & -r) le += tree[r]!;
      out[i] = (100 * le) / n;
    }
    for (let r = ranks[i]!; r > 0 && r <= m; r += r & -r) tree[r]!++;
    if (i >= n) for (let r = ranks[i - n]!; r > 0 && r <= m; r += r & -r) tree[r]!--;
  }
  return out;
}

/** Least-squares slope (price units per bar) of the last `n` values against their bar index. */
export function linearRegressionSlope(values: readonly number[], n = 14): Series {
  const out: Series = blank(values.length);
  if (n < 2) return out;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const den = n * sumX2 - sumX * sumX;
  for (let i = n - 1; i < values.length; i++) {
    let sumY = 0;
    let sumXY = 0;
    for (let j = 0; j < n; j++) {
      const y = values[i - n + 1 + j]!;
      sumY += y;
      sumXY += j * y;
    }
    out[i] = (n * sumXY - sumX * sumY) / den;
  }
  return out;
}

/**
 * The benchmark close known at each of `bars`' dates: an as-of join (the last
 * benchmark bar dated on or before the bar), so a benchmark that trades on
 * different days never leaks a later close into an earlier bar.
 */
export function asOfCloses(bars: readonly Bar[], benchmark: readonly Bar[]): Series {
  const bench = [...benchmark].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: Series = blank(bars.length);
  let j = -1;
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i]!.date;
    // bars are chronological; tolerate unsorted input by restarting the scan
    if (j >= 0 && bench[j]!.date > d) j = -1;
    while (j + 1 < bench.length && bench[j + 1]!.date <= d) j++;
    if (j >= 0) out[i] = bench[j]!.close;
  }
  return out;
}

/** Relative-strength ratio line: close / benchmark close (as-of joined by date). */
export function relativeStrength(bars: readonly Bar[], benchmark: readonly Bar[]): Series {
  const b = asOfCloses(bars, benchmark);
  return bars.map((x, i) => {
    const v = b[i];
    return v === undefined || v === 0 ? undefined : x.close / v;
  });
}

/**
 * Mansfield relative strength: (RS / SMA(RS, n) − 1) × 100, where RS is the
 * ratio line. Mansfield used a 52-week average on weekly charts; n = 252 is
 * the daily equivalent (pass 52 for weekly bars). Positive = outperforming.
 */
export function mansfieldRs(bars: readonly Bar[], benchmark: readonly Bar[], n = 252): Series {
  const rs = relativeStrength(bars, benchmark);
  const out: Series = blank(bars.length);
  // The ratio line is undefined until the benchmark starts; average only over defined values.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < rs.length; i++) {
    const v = rs[i];
    const old = i >= n ? rs[i - n] : undefined;
    if (v !== undefined) {
      sum += v;
      count++;
    }
    if (old !== undefined) {
      sum -= old;
      count--;
    }
    if (v !== undefined && count === n) out[i] = (v / (sum / n) - 1) * 100;
  }
  return out;
}
