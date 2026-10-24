import { describe, expect, it } from "vitest";
import {
  CANDLE_PATTERNS,
  candlePatterns,
  darkCloudCover,
  doji,
  engulfing,
  eveningStar,
  hammer,
  hangingMan,
  harami,
  heikinAshi,
  invertedHammer,
  marubozu,
  morningStar,
  piercingLine,
  priorTrend,
  shootingStar,
  spinningTop,
  star,
  threeSoldiersCrows,
  tweezer,
} from "../src/analytics/indicators/index.js";
import type { Bar } from "../src/providers/types.js";
import { bar, day, randomWalk } from "./helpers/series.js";

/** Six context bars falling (or rising) by 1 a bar around `level`, small bodies. */
function context(dir: -1 | 1, level = 50): Bar[] {
  return Array.from({ length: 6 }, (_, i) => {
    const c = level - dir * (6 - i);
    return bar(day(i), c + dir * 0.2, c + 0.5, c - 0.5, c);
  });
}
const at = (xs: Bar[], b: Omit<Bar, "date">): Bar[] => [...xs, { ...b, date: day(xs.length) }];
const last = (xs: number[]) => xs[xs.length - 1];

describe("single-candle patterns", () => {
  it("doji, spinning top and marubozu by body/shadow ratios", () => {
    const d = [bar("a", 10, 12, 8, 10.3)]; // body 0.3 ≤ 0.1·4
    expect(doji(d)).toEqual([1]);
    expect(doji([bar("a", 10, 12, 8, 10.5)])).toEqual([0]);
    expect(doji([bar("a", 10, 10, 10, 10)])).toEqual([0]);
    expect(spinningTop([bar("a", 10, 12, 8, 10.8)])).toEqual([1]); // body 0.8 (20 %), shadows 1.2 / 2
    expect(spinningTop([bar("a", 10, 12, 8, 10.2)])).toEqual([0]); // a doji, not a spinning top
    expect(marubozu([bar("a", 8, 12, 8, 12), bar("b", 12, 12.1, 8, 8), bar("c", 9, 12, 8, 11)])).toEqual([1, -1, 0]);
  });

  it("hammer vs hanging man: the same shape, told apart by the prior trend", () => {
    const shape = { open: 49.6, high: 50, low: 47, close: 49.9 }; // body 0.3, lower 2.6, upper 0.1 (≤ 0.3)
    expect(last(hammer(at(context(-1), shape)))).toBe(1);
    expect(last(hangingMan(at(context(-1), shape)))).toBe(0);
    expect(last(hangingMan(at(context(1), shape)))).toBe(-1);
    expect(last(hammer(at(context(1), shape)))).toBe(0);
    // color does not matter (the source required a white hammer)
    expect(last(hammer(at(context(-1), { open: 49.9, high: 50, low: 47, close: 49.6 })))).toBe(1);
  });

  it("inverted hammer vs shooting star; and the hanging man is no longer the shooting star", () => {
    const shape = { open: 50.1, high: 53, low: 50, close: 50.4 };
    expect(last(invertedHammer(at(context(-1), shape)))).toBe(1);
    expect(last(shootingStar(at(context(1), shape)))).toBe(-1);
    expect(last(shootingStar(at(context(-1), shape)))).toBe(0);
    const hammerShape = { open: 49.6, high: 50, low: 47, close: 49.9 };
    const up = at(context(1), hammerShape);
    expect(last(hangingMan(up))).toBe(-1);
    expect(last(shootingStar(up))).toBe(0);
  });

  it("no trend context → no hammer-family signal; priorTrend needs lookback + 1 bars", () => {
    const one = [bar("a", 49.6, 50, 47, 49.9)];
    expect(hammer(one)).toEqual([0]);
    const ctx = context(-1);
    expect(priorTrend(ctx, 5, 5)).toBe(0);
    expect(priorTrend(at(ctx, ctx[5]!), 6, 5)).toBe(-1);
  });
});

describe("two- and three-candle patterns", () => {
  it("engulfing needs the body to cover the previous body, not just be longer (source bug)", () => {
    const black = bar("a", 11, 11.2, 9.8, 10);
    expect(engulfing([black, bar("b", 9.8, 11.6, 9.7, 11.5)])).toEqual([0, 1]);
    expect(engulfing([bar("a", 10, 11.2, 9.8, 11), bar("b", 11.2, 11.3, 9.4, 9.5)])).toEqual([0, -1]);
    // longer white body that opens above the black close: not engulfing
    expect(engulfing([black, bar("b", 10.5, 12.5, 10.4, 12)])).toEqual([0, 0]);
  });

  it("harami: small body inside the previous long body", () => {
    const longBlack = bar("a", 12, 12.2, 9.8, 10);
    expect(harami([longBlack, bar("b", 10.5, 11.5, 10.4, 11.2)])).toEqual([0, 1]);
    const longWhite = bar("a", 10, 12.2, 9.8, 12);
    expect(harami([longWhite, bar("b", 11.5, 11.8, 10.6, 10.8)])).toEqual([0, -1]);
    expect(harami([longBlack, bar("b", 10.5, 12.5, 10.4, 12.3)])).toEqual([0, 0]); // body pokes out
  });

  it("piercing line and dark cloud cover", () => {
    const longBlack = bar("a", 12, 12.1, 9.9, 10);
    expect(piercingLine([longBlack, bar("b", 9.8, 11.6, 9.7, 11.5)])).toEqual([0, 1]);
    expect(piercingLine([longBlack, bar("b", 9.8, 11, 9.7, 10.8)])).toEqual([0, 0]); // below the midpoint 11
    const longWhite = bar("a", 10, 12.1, 9.9, 12);
    expect(darkCloudCover([longWhite, bar("b", 12.2, 12.3, 10.4, 10.5)])).toEqual([0, -1]);
  });

  it("morning and evening stars", () => {
    const ms = [bar("a", 12, 12.1, 9.9, 10), bar("b", 9.6, 9.9, 9.3, 9.7), bar("c", 9.8, 11.6, 9.7, 11.5)];
    expect(star(ms)).toEqual([0, 0, 1]);
    expect(morningStar(ms)).toEqual([0, 0, 1]);
    const es = [bar("a", 10, 12.1, 9.9, 12), bar("b", 12.3, 12.6, 12.1, 12.4), bar("c", 12.2, 12.3, 10.4, 10.5)];
    expect(eveningStar(es)).toEqual([0, 0, -1]);
    expect(morningStar(es)).toEqual([0, 0, 0]);
  });

  it("three white soldiers / three black crows", () => {
    const soldiers = [bar("a", 10, 11.1, 9.9, 11), bar("b", 10.5, 12.1, 10.4, 12), bar("c", 11.5, 13.1, 11.4, 13)];
    expect(threeSoldiersCrows(soldiers)).toEqual([0, 0, 1]);
    const crows = [bar("a", 13, 13.1, 11.9, 12), bar("b", 12.5, 12.6, 10.9, 11), bar("c", 11.5, 11.6, 9.9, 10)];
    expect(threeSoldiersCrows(crows)).toEqual([0, 0, -1]);
    const gappy = [soldiers[0]!, bar("b", 11.5, 12.6, 11.4, 12.5), soldiers[2]!]; // opens above the prior close
    expect(threeSoldiersCrows(gappy)[2]).toBe(0);
  });

  it("tweezer bottom after a decline, top after an advance", () => {
    const down = [...context(-1), bar(day(6), 44.5, 44.6, 43.5, 43.7), bar(day(7), 43.8, 44.8, 43.52, 44.6)];
    expect(last(tweezer(down))).toBe(1);
    const up = [...context(1), bar(day(6), 55.5, 56.5, 55.4, 56.3), bar(day(7), 56.2, 56.48, 55.3, 55.5)];
    expect(last(tweezer(up))).toBe(-1);
  });

  it("every pattern is aligned, in {−1, 0, 1}, and candlePatterns bundles them", () => {
    const rw = randomWalk(300, 77);
    for (const [name, fn] of Object.entries(CANDLE_PATTERNS)) {
      const xs = fn(rw);
      expect(xs, name).toHaveLength(300);
      expect(xs.every((x) => x === -1 || x === 0 || x === 1)).toBe(true);
    }
    const rows = candlePatterns(rw);
    expect(rows).toHaveLength(300);
    expect(Object.keys(rows[0]!).sort()).toEqual(Object.keys(CANDLE_PATTERNS).sort());
    expect(rows.map((r) => r.engulfing)).toEqual(engulfing(rw));
  });
});

describe("Heikin-Ashi", () => {
  it("close = OHLC/4, open = midpoint of the previous HA body, high/low include them", () => {
    const bars = [bar("a", 10, 12, 9, 11), bar("b", 11, 13, 10, 12)];
    const ha = heikinAshi(bars);
    expect(ha[0]).toEqual({ open: 10.5, close: 10.5, high: 12, low: 9 });
    expect(ha[1]).toEqual({ open: 10.5, close: 11.5, high: 13, low: 10 });
  });
});
