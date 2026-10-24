// Volatility measures and volatility-based stops.
import type { Bar } from "../../providers/types.js";
import { atr, ema, sma, trueRange } from "../indicators.js";
import { type Rows, type Series, blank, chain, closesOf, highsOf, lowsOf } from "./shared.js";
import { rollingMax, rollingMin, rollingStdev, rollingSum } from "./stats.js";

/**
 * E.W. Dreiss' Choppiness Index: 100·log10(ΣTR(n) / (HH(n) − LL(n))) / log10(n).
 * Near 100 = choppy, near 0 = trending (61.8 / 38.2 are the usual lines).
 * Starts at bar n (each TR needs the previous close); undefined for a flat window.
 */
export function choppinessIndex(bars: readonly Bar[], n = 14): Series {
  const tr = trueRange(bars);
  const sumTr = rollingSum(tr, n);
  const hh = rollingMax(highsOf(bars), n);
  const ll = rollingMin(lowsOf(bars), n);
  const lg = Math.log10(n);
  return bars.map((_, i) => {
    if (i < n || lg === 0) return undefined;
    const range = hh[i]! - ll[i]!;
    return range === 0 ? undefined : (100 * Math.log10(sumTr[i]! / range)) / lg;
  });
}

/**
 * Dorsey's Mass Index (1992): Σ over 25 bars of EMA9(H − L) / EMA9(EMA9(H − L)).
 * A "reversal bulge" is a rise above 27 then a fall below 26.5.
 */
export function massIndex(bars: readonly Bar[], emaPeriod = 9, sumPeriod = 25): Series {
  const range = bars.map((b) => b.high - b.low);
  const single = ema(range, emaPeriod);
  const double = chain(single, (xs) => ema(xs, emaPeriod));
  const ratio: Series = single.map((s, i) => {
    const d = double[i];
    return s === undefined || d === undefined ? undefined : d === 0 ? 1 : s / d;
  });
  return chain(ratio, (xs) => rollingSum(xs, sumPeriod));
}

export interface TrailingStopPoint {
  stop: number;
  /** +1 long (stop below), −1 short (stop above). */
  trend: number;
}

/**
 * ATR trailing stop on closes: long stop = max(prior stop, C − m·ATR) until a
 * close falls below it, then a short stop C + m·ATR ratcheting down, and so
 * on. Starts long on the first bar with an ATR (Wilder, n).
 */
export function atrTrailingStop(bars: readonly Bar[], n = 14, multiplier = 3): Rows<TrailingStopPoint> {
  const a = atr(bars, n);
  const out: Rows<TrailingStopPoint> = blank(bars.length);
  let prev: TrailingStopPoint | undefined;
  for (let i = 0; i < bars.length; i++) {
    const av = a[i];
    if (av === undefined) continue;
    const c = bars[i]!.close;
    const band = multiplier * av;
    let next: TrailingStopPoint;
    if (!prev) next = { stop: c - band, trend: 1 };
    else if (prev.trend === 1) {
      const trailed = Math.max(prev.stop, c - band);
      next = c < trailed ? { stop: c + band, trend: -1 } : { stop: trailed, trend: 1 };
    } else {
      const trailed = Math.min(prev.stop, c + band);
      next = c > trailed ? { stop: c - band, trend: 1 } : { stop: trailed, trend: -1 };
    }
    out[i] = next;
    prev = next;
  }
  return out;
}

export interface ChandelierPoint {
  /** Stop for longs: highest high(n) − m·ATR(n). */
  exitLong: number;
  /** Stop for shorts: lowest low(n) + m·ATR(n). */
  exitShort: number;
}

/** Chuck LeBeau's Chandelier exit (22, 3): ATR multiples hung from the n-bar extreme. */
export function chandelierExit(bars: readonly Bar[], n = 22, multiplier = 3): Rows<ChandelierPoint> {
  const a = atr(bars, n);
  const hh = rollingMax(highsOf(bars), n);
  const ll = rollingMin(lowsOf(bars), n);
  return bars.map((_, i) => {
    const av = a[i];
    if (av === undefined || hh[i] === undefined) return undefined;
    return { exitLong: hh[i]! - multiplier * av, exitShort: ll[i]! + multiplier * av };
  });
}

export interface VixFixPoint {
  /** Williams VIX Fix: 100·(highest close(22) − low)/highest close(22). */
  wvf: number;
  /** SMA(wvf, 20) + 2·stdev(wvf, 20). */
  upperBand: number;
  /** Highest wvf(50) × 0.85. */
  rangeHigh: number;
  /** Lowest wvf(50) × 1.01. */
  rangeLow: number;
  /** 1 when wvf ≥ upperBand or ≥ rangeHigh (fear spike: a potential bottom), else 0. */
  buyZone: number;
}

/** Larry Williams' VIX Fix, a synthetic VIX for any instrument, with the usual band/percentile thresholds (ChrisMoody's). */
export function williamsVixFix(
  bars: readonly Bar[],
  lookback = 22,
  bbLength = 20,
  bbMultiplier = 2,
  percentileLookback = 50,
  highPercentile = 0.85,
  lowPercentile = 1.01,
): Rows<VixFixPoint> {
  const hc = rollingMax(closesOf(bars), lookback);
  const wvf: Series = bars.map((b, i) => {
    const h = hc[i];
    return h === undefined || h === 0 ? undefined : (100 * (h - b.low)) / h;
  });
  const mid = chain(wvf, (xs) => sma(xs, bbLength));
  const sd = chain(wvf, (xs) => rollingStdev(xs, bbLength));
  const hi = chain(wvf, (xs) => rollingMax(xs, percentileLookback));
  const lo = chain(wvf, (xs) => rollingMin(xs, percentileLookback));
  return bars.map((_, i) => {
    const w = wvf[i];
    if (w === undefined || mid[i] === undefined || sd[i] === undefined || hi[i] === undefined || lo[i] === undefined) return undefined;
    const upperBand = mid[i]! + bbMultiplier * sd[i]!;
    const rangeHigh = hi[i]! * highPercentile;
    return { wvf: w, upperBand, rangeHigh, rangeLow: lo[i]! * lowPercentile, buyZone: w >= upperBand || w >= rangeHigh ? 1 : 0 };
  });
}
