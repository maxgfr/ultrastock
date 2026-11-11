// The O(n log w) / O(n) percentRank and Aroon must give the very same numbers
// as the O(n·w) scans they replaced (kept here as the reference): their values
// are registered as evidence, so not one bit may move.
import { describe, expect, it } from "vitest";
import { percentRank } from "../src/analytics/indicators/stats.js";
import { aroon } from "../src/analytics/indicators/trend.js";
import type { Bar } from "../src/providers/types.js";
import { prng, randomWalk } from "./helpers/series.js";

function scanPercentRank(values: readonly number[], n = 252): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined);
  for (let i = n; i < values.length; i++) {
    const x = values[i]!;
    let le = 0;
    for (let j = i - n; j < i; j++) if (values[j]! <= x) le++;
    out[i] = (100 * le) / n;
  }
  return out;
}

function scanAroon(bars: readonly Bar[], n = 25) {
  const out: Array<{ up: number; down: number; oscillator: number } | undefined> = new Array(bars.length).fill(undefined);
  for (let i = n; i < bars.length; i++) {
    let hi = i - n;
    let lo = i - n;
    for (let j = i - n + 1; j <= i; j++) {
      if (bars[j]!.high >= bars[hi]!.high) hi = j;
      if (bars[j]!.low <= bars[lo]!.low) lo = j;
    }
    const up = (100 * (n - (i - hi))) / n;
    const down = (100 * (n - (i - lo))) / n;
    out[i] = { up, down, oscillator: up - down };
  }
  return out;
}

/** Random values with many ties (coarse rounding), signed zeros, infinities and NaN holes. */
function rough(len: number, seed: number): number[] {
  const r = prng(seed);
  return Array.from({ length: len }, () => {
    const u = r();
    if (u < 0.02) return Number.NaN;
    if (u < 0.03) return -0;
    if (u < 0.035) return Number.POSITIVE_INFINITY;
    if (u < 0.04) return Number.NEGATIVE_INFINITY;
    return u < 0.5 ? Math.round(r() * 20) - 10 : (r() - 0.5) * 1000;
  });
}

const roughBars = (len: number, seed: number): Bar[] => {
  const hs = rough(len, seed);
  const ls = rough(len, seed + 1);
  return hs.map((high, i) => ({ date: String(i), open: 0, high, low: ls[i]!, close: 0 }));
};

describe("rolling counts and positions", () => {
  it("percentRank is bit-identical to the window scan", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const walk = randomWalk(600, seed).map((b) => b.close);
      const r = rough(600, seed);
      for (const n of [1, 2, 3, 7, 20, 127, 128, 252, 599, 600, 700]) {
        expect(percentRank(walk, n)).toEqual(scanPercentRank(walk, n));
        expect(percentRank(r, n)).toEqual(scanPercentRank(r, n));
      }
    }
    expect(percentRank([], 5)).toEqual([]);
  });

  it("Aroon is bit-identical to the window scan", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const walk = randomWalk(600, seed);
      const r = roughBars(600, seed);
      for (const n of [1, 2, 3, 7, 25, 100, 599, 600, 700]) {
        expect(aroon(walk, n)).toEqual(scanAroon(walk, n));
        expect(aroon(r, n)).toEqual(scanAroon(r, n));
      }
    }
    expect(aroon([], 5)).toEqual([]);
  });
});
