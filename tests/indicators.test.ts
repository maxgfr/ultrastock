import { describe, expect, it } from "vitest";
import { annualizedVol, atr, bollinger, ema, lastValue, lookback, macd, maxDrawdown, rsi, sma, trueRange } from "../src/analytics/indicators.js";
import type { Bar } from "../src/providers/types.js";

// Reference series and values from StockCharts ChartSchool's RSI and EMA tables.
const RSI_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71,
  46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];
const RSI_EXPECTED = [70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34, 54.67, 50.39, 40.02, 41.49, 41.9, 45.5, 37.32, 33.09, 37.79];
const EMA_CLOSES = [
  22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39, 22.38, 22.61, 23.36, 24.05, 23.75, 23.83, 23.95, 23.63, 23.82, 23.87,
  23.65, 23.19, 23.1, 23.33, 22.68, 23.1, 22.4, 22.17,
];
const EMA10_EXPECTED = [
  22.22, 22.21, 22.24, 22.27, 22.33, 22.52, 22.8, 22.97, 23.13, 23.28, 23.34, 23.43, 23.51, 23.53, 23.47, 23.4, 23.39, 23.26, 23.23, 23.08, 22.92,
];

const bar = (date: string, open: number, high: number, low: number, close: number): Bar => ({ date, open, high, low, close });

describe("indicators", () => {
  it("RSI(14) matches Wilder's reference table", () => {
    const r = rsi(RSI_CLOSES, 14);
    expect(r.slice(0, 14).every((x) => x === undefined)).toBe(true);
    expect(r.slice(14).map((x) => Number(x!.toFixed(2)))).toEqual(RSI_EXPECTED);
  });
  it("EMA(10) is seeded with the SMA and matches the reference table", () => {
    const e = ema(EMA_CLOSES, 10);
    expect(e[8]).toBeUndefined();
    expect(e.slice(9).map((x) => Number(x!.toFixed(2)))).toEqual(EMA10_EXPECTED);
  });
  it("SMA is aligned: undefined until the window is full", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });
  it("MACD line is EMA(12) − EMA(26) and the histogram is line − signal", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.3);
    const m = macd(closes);
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    const i = 60;
    expect(m[i]!.macd).toBeCloseTo(e12[i]! - e26[i]!, 10);
    expect(m[i]!.histogram).toBeCloseTo(m[i]!.macd - m[i]!.signal, 10);
    expect(m.findIndex((x) => x !== undefined)).toBe(25 + 8);
  });
  it("true range accounts for gaps, and ATR of a constant range is that range", () => {
    const gap = [bar("d1", 10, 11, 9, 10), bar("d2", 13, 14, 12.5, 13.5)];
    expect(trueRange(gap)).toEqual([2, 4]);
    const flat = Array.from({ length: 30 }, (_, i) => bar(`d${i}`, 100, 101, 99, 100));
    expect(lastValue(atr(flat, 14))).toBeCloseTo(2, 10);
    expect(atr(flat, 14)[13]).toBeUndefined();
  });
  it("Bollinger bands collapse on a constant series and widen with dispersion", () => {
    expect(lastValue(bollinger(new Array(25).fill(50), 20, 2))).toEqual({ middle: 50, upper: 50, lower: 50 });
    const b = lastValue(bollinger([...new Array(19).fill(50), 70], 20, 2))!;
    expect(b.upper - b.middle).toBeCloseTo(b.middle - b.lower, 10);
    expect(b.middle).toBe(51);
    expect(b.upper).toBeCloseTo(51 + 2 * Math.sqrt(19), 10);
  });
  it("volatility and drawdown", () => {
    expect(annualizedVol([100, 100, 100], 252)).toBe(0);
    const v = annualizedVol([100, 101, 100, 101, 100], 252)!;
    expect(v).toBeGreaterThan(0.15);
    const dd = maxDrawdown([bar("a", 0, 0, 0, 100), bar("b", 0, 0, 0, 120), bar("c", 0, 0, 0, 90), bar("d", 0, 0, 0, 110)])!;
    expect(dd.drawdown).toBeCloseTo(-0.25, 10);
    expect([dd.peak, dd.trough]).toEqual(["b", "c"]);
    expect(lookback([1, 2, 3], 2)).toBe(1);
    expect(lookback([1, 2, 3], 3)).toBeUndefined();
  });
});
