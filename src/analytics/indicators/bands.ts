// Price channels and envelopes. The core Bollinger bands live in
// ../indicators.ts; %B and bandwidth are derived from them here.
import type { Bar } from "../../providers/types.js";
import { atr, type Band, bollinger, ema, sma } from "../indicators.js";
import { type Rows, type Series, closesOf, highsOf, lowsOf } from "./shared.js";
import { rollingMax, rollingMin } from "./stats.js";

export type { Band };

/**
 * Keltner channels, modern form (Raschke; StockCharts): EMA(close, n) ±
 * m·ATR(atrPeriod). (Chester Keltner's 1960 original used a 10-day SMA of the
 * typical price ± the 10-day average high − low.) Defaults 20/10/1.5;
 * StockCharts charts m = 2.
 */
export function keltner(bars: readonly Bar[], n = 20, atrPeriod = 10, multiplier = 1.5): Rows<Band> {
  const mid = ema(closesOf(bars), n);
  const a = atr(bars, atrPeriod);
  return bars.map((_, i) => {
    const m = mid[i];
    const av = a[i];
    if (m === undefined || av === undefined) return undefined;
    return { middle: m, upper: m + multiplier * av, lower: m - multiplier * av };
  });
}

/**
 * Donchian channel: highest high and lowest low of the last n bars *including*
 * bar i, and their midpoint. A breakout test "close > upper" can never fire on
 * this definition — compare with the previous bar's upper instead.
 */
export function donchian(bars: readonly Bar[], n = 20): Rows<Band> {
  const hh = rollingMax(highsOf(bars), n);
  const ll = rollingMin(lowsOf(bars), n);
  return bars.map((_, i) => {
    const h = hh[i];
    const l = ll[i];
    return h === undefined || l === undefined ? undefined : { upper: h, lower: l, middle: (h + l) / 2 };
  });
}

/** Manning Stoller's STARC bands: SMA(close, 6) ± m·ATR(15). */
export function starcBands(bars: readonly Bar[], smaPeriod = 6, atrPeriod = 15, multiplier = 1.33): Rows<Band> {
  const mid = sma(closesOf(bars), smaPeriod);
  const a = atr(bars, atrPeriod);
  return bars.map((_, i) => {
    const m = mid[i];
    const av = a[i];
    if (m === undefined || av === undefined) return undefined;
    return { middle: m, upper: m + multiplier * av, lower: m - multiplier * av };
  });
}

/** Moving-average envelope: MA(n) × (1 ± pct/100), SMA or EMA. */
export function movingAverageEnvelope(values: readonly number[], n = 20, pct = 2.5, type: "sma" | "ema" = "sma"): Rows<Band> {
  const mid = type === "ema" ? ema(values, n) : sma(values, n);
  const f = pct / 100;
  return mid.map((m) => (m === undefined ? undefined : { middle: m, upper: m * (1 + f), lower: m * (1 - f) }));
}

/** Bollinger %B: (close − lower)/(upper − lower); 0.5 when the bands collapse. */
export function bollingerPercentB(values: readonly number[], n = 20, k = 2): Series {
  const b = bollinger(values, n, k);
  return values.map((x, i) => {
    const band = b[i];
    if (!band) return undefined;
    const w = band.upper - band.lower;
    return w === 0 ? 0.5 : (x - band.lower) / w;
  });
}

/** Bollinger bandwidth: (upper − lower)/middle; undefined for a zero middle. */
export function bollingerBandwidth(values: readonly number[], n = 20, k = 2): Series {
  return bollinger(values, n, k).map((band) => (!band || band.middle === 0 ? undefined : (band.upper - band.lower) / band.middle));
}
