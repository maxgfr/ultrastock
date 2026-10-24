// Heikin-Ashi and candlestick patterns. A pattern at bar i uses bars i − 2 … i
// (and the trend before them), so it is flagged at the close of its last
// candle. Outputs are aligned arrays of +1 (bullish), −1 (bearish), 0 (none);
// neutral patterns (doji, spinning top) return +1 for "present".
//
// Thresholds, in fractions of the candle's range (high − low) unless stated:
//   doji            body ≤ 0.10·range
//   spinning top    0.10·range < body ≤ 0.30·range, both shadows ≥ body
//   marubozu        each shadow ≤ 0.05·range
//   hammer shape    lower shadow ≥ 2·body, upper shadow ≤ 0.10·range
//   inverted shape  upper shadow ≥ 2·body, lower shadow ≤ 0.10·range
//   long candle     body ≥ 0.50·range (first candle of piercing/dark cloud/stars, each soldier/crow)
//   star            body ≤ 0.30·the first candle's body, body beyond the first close
//   tweezer         extremes within 0.05·the larger of the two ranges
//   prior trend     sign of close[i−1] − close[i−1−lookback] (lookback 5): hammer, hanging man,
//                   inverted hammer, shooting star and tweezers need it; 0 when there is not enough history.
import type { Bar } from "../../providers/types.js";
import { type Rows, blank } from "./shared.js";

export interface HeikinAshiBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Heikin-Ashi candles: close = OHLC/4, open = (open₋₁ + close₋₁)/2 (first: (O + C)/2), high/low include them. */
export function heikinAshi(bars: readonly Bar[]): Rows<HeikinAshiBar> {
  const out: Rows<HeikinAshiBar> = blank(bars.length);
  let prev: HeikinAshiBar | undefined;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = prev ? (prev.open + prev.close) / 2 : (b.open + b.close) / 2;
    prev = { open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) };
    out[i] = prev;
  }
  return out;
}

const bodyOf = (b: Bar) => Math.abs(b.close - b.open);
const rangeOf = (b: Bar) => b.high - b.low;
const upperOf = (b: Bar) => b.high - Math.max(b.open, b.close);
const lowerOf = (b: Bar) => Math.min(b.open, b.close) - b.low;
const isBull = (b: Bar) => b.close > b.open;
const isBear = (b: Bar) => b.close < b.open;
const isLong = (b: Bar) => rangeOf(b) > 0 && bodyOf(b) >= 0.5 * rangeOf(b);
const bodyMid = (b: Bar) => (b.open + b.close) / 2;

/** Sign of the move into bar `i`: close[i−1] vs close[i−1−lookback]. */
export function priorTrend(bars: readonly Bar[], i: number, lookback = 5): number {
  if (i - 1 - lookback < 0) return 0;
  return Math.sign(bars[i - 1]!.close - bars[i - 1 - lookback]!.close);
}

function scan(bars: readonly Bar[], need: number, at: (i: number) => number): number[] {
  return bars.map((_, i) => (i < need ? 0 : at(i)));
}

const hammerShape = (b: Bar) => rangeOf(b) > 0 && lowerOf(b) >= 2 * bodyOf(b) && upperOf(b) <= 0.1 * rangeOf(b);
const invertedShape = (b: Bar) => rangeOf(b) > 0 && upperOf(b) >= 2 * bodyOf(b) && lowerOf(b) <= 0.1 * rangeOf(b);

/** Doji: body ≤ 10 % of the range (+1 when present). */
export function doji(bars: readonly Bar[]): number[] {
  return scan(bars, 0, (i) => {
    const b = bars[i]!;
    return rangeOf(b) > 0 && bodyOf(b) <= 0.1 * rangeOf(b) ? 1 : 0;
  });
}

/** Spinning top: small body (10–30 % of the range) with both shadows at least as long as the body (+1 when present). */
export function spinningTop(bars: readonly Bar[]): number[] {
  return scan(bars, 0, (i) => {
    const b = bars[i]!;
    const r = rangeOf(b);
    const body = bodyOf(b);
    return r > 0 && body > 0.1 * r && body <= 0.3 * r && upperOf(b) >= body && lowerOf(b) >= body ? 1 : 0;
  });
}

/** Marubozu: shadows ≤ 5 % of the range; +1 white, −1 black. */
export function marubozu(bars: readonly Bar[]): number[] {
  return scan(bars, 0, (i) => {
    const b = bars[i]!;
    const r = rangeOf(b);
    if (r === 0 || upperOf(b) > 0.05 * r || lowerOf(b) > 0.05 * r) return 0;
    return isBull(b) ? 1 : isBear(b) ? -1 : 0;
  });
}

/** Hammer: hammer shape after a decline (+1). */
export function hammer(bars: readonly Bar[], trendLookback = 5): number[] {
  return scan(bars, 1, (i) => (hammerShape(bars[i]!) && priorTrend(bars, i, trendLookback) < 0 ? 1 : 0));
}

/** Hanging man: hammer shape after an advance (−1). */
export function hangingMan(bars: readonly Bar[], trendLookback = 5): number[] {
  return scan(bars, 1, (i) => (hammerShape(bars[i]!) && priorTrend(bars, i, trendLookback) > 0 ? -1 : 0));
}

/** Inverted hammer: long upper shadow after a decline (+1). */
export function invertedHammer(bars: readonly Bar[], trendLookback = 5): number[] {
  return scan(bars, 1, (i) => (invertedShape(bars[i]!) && priorTrend(bars, i, trendLookback) < 0 ? 1 : 0));
}

/** Shooting star: long upper shadow after an advance (−1). */
export function shootingStar(bars: readonly Bar[], trendLookback = 5): number[] {
  return scan(bars, 1, (i) => (invertedShape(bars[i]!) && priorTrend(bars, i, trendLookback) > 0 ? -1 : 0));
}

/**
 * Engulfing: the second body opens beyond the first close and closes beyond
 * the first open, with a strictly larger body; +1 bullish (black then white), −1 bearish.
 */
export function engulfing(bars: readonly Bar[]): number[] {
  return scan(bars, 1, (i) => {
    const p = bars[i - 1]!;
    const c = bars[i]!;
    if (bodyOf(c) <= bodyOf(p)) return 0;
    if (isBear(p) && isBull(c) && c.open <= p.close && c.close >= p.open) return 1;
    if (isBull(p) && isBear(c) && c.open >= p.close && c.close <= p.open) return -1;
    return 0;
  });
}

/**
 * Harami: a smaller body contained in the previous long body; +1 after a black
 * candle (second candle white or doji), −1 after a white one (second black or doji).
 */
export function harami(bars: readonly Bar[]): number[] {
  return scan(bars, 1, (i) => {
    const p = bars[i - 1]!;
    const c = bars[i]!;
    if (!isLong(p) || bodyOf(c) >= bodyOf(p)) return 0;
    const inside = Math.max(c.open, c.close) <= Math.max(p.open, p.close) && Math.min(c.open, c.close) >= Math.min(p.open, p.close);
    if (!inside) return 0;
    if (isBear(p) && c.close >= c.open) return 1;
    if (isBull(p) && c.close <= c.open) return -1;
    return 0;
  });
}

/** Piercing line: long black candle, then a white one opening below its close and closing above its body midpoint but below its open (+1). */
export function piercingLine(bars: readonly Bar[]): number[] {
  return scan(bars, 1, (i) => {
    const p = bars[i - 1]!;
    const c = bars[i]!;
    return isBear(p) && isLong(p) && isBull(c) && c.open < p.close && c.close > bodyMid(p) && c.close < p.open ? 1 : 0;
  });
}

/** Dark cloud cover: long white candle, then a black one opening above its close and closing below its body midpoint but above its open (−1). */
export function darkCloudCover(bars: readonly Bar[]): number[] {
  return scan(bars, 1, (i) => {
    const p = bars[i - 1]!;
    const c = bars[i]!;
    return isBull(p) && isLong(p) && isBear(c) && c.open > p.close && c.close < bodyMid(p) && c.close > p.open ? -1 : 0;
  });
}

/**
 * Morning (+1) / evening (−1) star: a long candle, a small-bodied star whose
 * body lies beyond the first close, then an opposite candle closing past the
 * first body's midpoint.
 */
export function star(bars: readonly Bar[]): number[] {
  return scan(bars, 2, (i) => {
    const a = bars[i - 2]!;
    const s = bars[i - 1]!;
    const c = bars[i]!;
    if (!isLong(a) || bodyOf(s) > 0.3 * bodyOf(a)) return 0;
    if (isBear(a) && Math.max(s.open, s.close) <= a.close && isBull(c) && c.close > bodyMid(a)) return 1;
    if (isBull(a) && Math.min(s.open, s.close) >= a.close && isBear(c) && c.close < bodyMid(a)) return -1;
    return 0;
  });
}

/** Morning star only (+1). */
export function morningStar(bars: readonly Bar[]): number[] {
  return star(bars).map((x) => (x > 0 ? 1 : 0));
}

/** Evening star only (−1). */
export function eveningStar(bars: readonly Bar[]): number[] {
  return star(bars).map((x) => (x < 0 ? -1 : 0));
}

/**
 * Three white soldiers (+1) / three black crows (−1): three long candles of
 * one colour, each closing beyond the previous close and opening inside the previous body.
 */
export function threeSoldiersCrows(bars: readonly Bar[]): number[] {
  return scan(bars, 2, (i) => {
    const xs = [bars[i - 2]!, bars[i - 1]!, bars[i]!];
    if (!xs.every(isLong)) return 0;
    const soldiers =
      xs.every(isBull) && [1, 2].every((k) => xs[k]!.close > xs[k - 1]!.close && xs[k]!.open >= xs[k - 1]!.open && xs[k]!.open <= xs[k - 1]!.close);
    if (soldiers) return 1;
    const crows = xs.every(isBear) && [1, 2].every((k) => xs[k]!.close < xs[k - 1]!.close && xs[k]!.open <= xs[k - 1]!.open && xs[k]!.open >= xs[k - 1]!.close);
    return crows ? -1 : 0;
  });
}

/**
 * Tweezer bottom (+1): after a decline, a black candle then a white one with
 * matching lows; tweezer top (−1): after an advance, white then black with matching highs.
 */
export function tweezer(bars: readonly Bar[], trendLookback = 5): number[] {
  return scan(bars, 1, (i) => {
    const p = bars[i - 1]!;
    const c = bars[i]!;
    const tol = 0.05 * Math.max(rangeOf(p), rangeOf(c));
    if (tol === 0) return 0;
    const trend = priorTrend(bars, i - 1, trendLookback);
    if (trend < 0 && isBear(p) && isBull(c) && Math.abs(c.low - p.low) <= tol) return 1;
    if (trend > 0 && isBull(p) && isBear(c) && Math.abs(c.high - p.high) <= tol) return -1;
    return 0;
  });
}

/** Every candlestick pattern by name, each an aligned +1/−1/0 array. */
export const CANDLE_PATTERNS = {
  doji,
  spinningTop,
  marubozu,
  hammer,
  hangingMan,
  invertedHammer,
  shootingStar,
  engulfing,
  harami,
  piercingLine,
  darkCloudCover,
  morningStar,
  eveningStar,
  threeSoldiersCrows,
  tweezer,
} as const satisfies Record<string, (bars: readonly Bar[]) => number[]>;

export type CandlePatternName = keyof typeof CANDLE_PATTERNS;

/** All patterns at once: one row per bar, pattern name → +1/−1/0. */
export function candlePatterns(bars: readonly Bar[]): Array<Record<CandlePatternName, number>> {
  const cols = Object.entries(CANDLE_PATTERNS).map(([k, fn]) => [k, fn(bars)] as const);
  return bars.map((_, i) => Object.fromEntries(cols.map(([k, xs]) => [k, xs[i]!])) as Record<CandlePatternName, number>);
}
