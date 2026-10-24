// Synthetic bar series for the indicator tests: a seeded random walk (the
// generic look-ahead checks), and exact shapes (ramps, constants) whose
// indicator values follow from the definitions.
import type { Bar } from "../../src/providers/types.js";

/** Mulberry32: a tiny deterministic PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Calendar date `i` days after 2020-01-01, as YYYY-MM-DD (UTC arithmetic). */
export function day(i: number): string {
  return new Date(Date.UTC(2020, 0, 1) + i * 86400_000).toISOString().slice(0, 10);
}

/** A seeded geometric random walk with plausible OHLCV bars. */
export function randomWalk(n: number, seed = 1, start = 100): Bar[] {
  const r = prng(seed);
  const bars: Bar[] = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    const open = close * (1 + (r() - 0.5) * 0.01);
    close = open * (1 + (r() - 0.5) * 0.04);
    const high = Math.max(open, close) * (1 + r() * 0.01);
    const low = Math.min(open, close) * (1 - r() * 0.01);
    bars.push({ date: day(i), open, high, low, close, volume: Math.round(1000 + r() * 9000) });
  }
  return bars;
}

/** Bars from closes: open = previous close, high/low = max/min(open, close) ± pad. */
export function fromCloses(closes: readonly number[], pad = 0.5, volume = 1000): Bar[] {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1]!;
    return { date: day(i), open, high: Math.max(open, c) + pad, low: Math.min(open, c) - pad, close: c, volume };
  });
}

/** A steady uptrend: H = 11 + i, L = 9 + i, C = O = 10 + i (true range 2, +DM 1, −DM 0). */
export function ramp(n: number, step = 1): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: day(i),
    open: 10 + i * step,
    high: 11 + i * step,
    low: 9 + i * step,
    close: 10 + i * step,
    volume: 1000,
  }));
}

export function constantBars(n: number, price = 50): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ date: day(i), open: price, high: price, low: price, close: price, volume: 1000 }));
}

export const bar = (date: string, open: number, high: number, low: number, close: number, volume = 1000): Bar => ({ date, open, high, low, close, volume });

/** Index of the first defined element (−1 if none). */
export function firstIndex<T>(xs: ReadonlyArray<T | undefined>): number {
  return xs.findIndex((x) => x !== undefined);
}
