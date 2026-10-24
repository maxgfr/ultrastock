// Core indicators, by their textbook definitions. Every function returns an
// array aligned with its input: `undefined` until the window is full, so index
// i always means "as known at the close of bar i" — never a value that needs
// bar i+1. That alignment is the look-ahead guard every caller relies on.
import type { Bar } from "../providers/types.js";

export type Series = Array<number | undefined>;

/** Simple moving average over `n` values. */
export function sma(values: readonly number[], n: number): Series {
  const out: Series = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `n` values (α = 2 / (n + 1)). */
export function ema(values: readonly number[], n: number): Series {
  const out: Series = new Array(values.length).fill(undefined);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI: average gain over average loss, smoothed with α = 1/n. */
export function rsi(closes: readonly number[], n = 14): Series {
  const out: Series = new Array(closes.length).fill(undefined);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = value();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value();
  }
  return out;
}

export interface MacdPoint {
  macd: number;
  signal: number;
  histogram: number;
}

/** MACD(fast, slow, signal): EMA(fast) − EMA(slow), its EMA(signal), and their difference. */
export function macd(closes: readonly number[], fast = 12, slow = 26, signalN = 9): Array<MacdPoint | undefined> {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line: number[] = [];
  const startAt = slow - 1;
  for (let i = startAt; i < closes.length; i++) line.push(f[i]! - s[i]!);
  const sig = ema(line, signalN);
  const out: Array<MacdPoint | undefined> = new Array(closes.length).fill(undefined);
  for (let j = 0; j < line.length; j++) {
    const sv = sig[j];
    if (sv === undefined) continue;
    out[j + startAt] = { macd: line[j]!, signal: sv, histogram: line[j]! - sv };
  }
  return out;
}

/** True range of each bar (the first bar's is its high − low). */
export function trueRange(bars: readonly Bar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** Wilder's Average True Range. */
export function atr(bars: readonly Bar[], n = 14): Series {
  const tr = trueRange(bars);
  const out: Series = new Array(bars.length).fill(undefined);
  if (bars.length <= n) return out;
  // Wilder seeds with the mean TR of bars 1..n (bar 0 has no previous close).
  let prev = tr.slice(1, n + 1).reduce((a, b) => a + b, 0) / n;
  out[n] = prev;
  for (let i = n + 1; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]!) / n;
    out[i] = prev;
  }
  return out;
}

export interface Band {
  middle: number;
  upper: number;
  lower: number;
}

/** Bollinger bands: SMA(n) ± k population standard deviations. */
export function bollinger(closes: readonly number[], n = 20, k = 2): Array<Band | undefined> {
  const mid = sma(closes, n);
  return closes.map((_, i) => {
    const m = mid[i];
    if (m === undefined) return undefined;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (closes[j]! - m) ** 2;
    const sd = Math.sqrt(v / n);
    return { middle: m, upper: m + k * sd, lower: m - k * sd };
  });
}

/** Log returns, one per bar after the first. */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i]! / closes[i - 1]!));
  return out;
}

/** Annualised volatility (sample standard deviation of log returns × √periodsPerYear), as a fraction. */
export function annualizedVol(closes: readonly number[], periodsPerYear: number): number | undefined {
  const r = logReturns(closes);
  if (r.length < 2) return undefined;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

/** Largest peak-to-trough fall, as a negative fraction (−0.25 = −25 %), with its dates. */
export function maxDrawdown(bars: readonly Bar[]): { drawdown: number; peak: string; trough: string } | undefined {
  if (bars.length < 2) return undefined;
  let peak = bars[0]!;
  let worst = { drawdown: 0, peak: bars[0]!.date, trough: bars[0]!.date };
  for (const b of bars) {
    if (b.close > peak.close) peak = b;
    const dd = b.close / peak.close - 1;
    if (dd < worst.drawdown) worst = { drawdown: dd, peak: peak.date, trough: b.date };
  }
  return worst;
}

/** The value `n` bars back from the last one, or undefined when the series is too short. */
export function lookback<T>(xs: readonly T[], n: number): T | undefined {
  return xs.length > n ? xs[xs.length - 1 - n] : undefined;
}

/** The last defined value of an aligned series. */
export function lastValue<T>(xs: ReadonlyArray<T | undefined>): T | undefined {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] !== undefined) return xs[i];
  return undefined;
}
