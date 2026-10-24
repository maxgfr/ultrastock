import { describe, expect, it } from "vitest";
import {
  atr,
  chain,
  dema,
  ema,
  highestHigh,
  hma,
  kama,
  linearRegressionSlope,
  lowestLow,
  MA_TYPES,
  mansfieldRs,
  mcginleyDynamic,
  movingAverage,
  percentRank,
  relativeStrength,
  rma,
  rollingMax,
  rollingMin,
  rollingStdev,
  rollingSum,
  sma,
  smma,
  tema,
  trueRange,
  vwma,
  wma,
  zScore,
} from "../src/analytics/indicators/index.js";
import { bar, constantBars, firstIndex, prng, randomWalk } from "./helpers/series.js";

const linear = (n: number, a = 3, b = 2) => Array.from({ length: n }, (_, i) => a * i + b);
const noisy = (n: number, seed = 5) => {
  const r = prng(seed);
  return Array.from({ length: n }, () => 100 + (r() - 0.5) * 20);
};

describe("moving averages", () => {
  it("WMA weights 1…n, newest heaviest", () => {
    expect(wma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 14 / 6, 20 / 6, 26 / 6]);
  });

  it("every average of a constant series is that constant", () => {
    const c = new Array(120).fill(42);
    for (const type of MA_TYPES) {
      const s = movingAverage(c, 10, type);
      expect(
        s.filter((x) => x !== undefined).every((x) => Math.abs(x! - 42) < 1e-9),
        type,
      ).toBe(true);
    }
    expect(mcginleyDynamic(c, 14).at(-1)).toBeCloseTo(42, 12);
    expect(vwma(constantBars(30, 42), 10).at(-1)).toBe(42);
  });

  it("EMA of a ramp lags by exactly (n − 1)/2, so DEMA and TEMA track a ramp exactly", () => {
    const x = linear(80, 1, 0);
    const e = ema(x, 10);
    expect(e[9]! - x[9]!).toBeCloseTo(-4.5, 10);
    expect(e[79]! - x[79]!).toBeCloseTo(-4.5, 10);
    const d = dema(x, 10);
    const t = tema(x, 10);
    expect(firstIndex(d)).toBe(18);
    expect(firstIndex(t)).toBe(27);
    expect(d[50]).toBeCloseTo(x[50]!, 9);
    expect(t[79]).toBeCloseTo(x[79]!, 9);
  });

  it("Hull MA is WMA(2·WMA(n/2) − WMA(n), √n) — cross-checked against wma, and its lag on a ramp", () => {
    const x = noisy(100);
    const n = 16;
    const raw = wma(x, 8).map((h, i) => (h === undefined || wma(x, n)[i] === undefined ? undefined : 2 * h - wma(x, n)[i]!));
    const expected = chain(raw, (xs) => wma(xs, 4));
    expect(hma(x, n)).toEqual(expected);
    expect(firstIndex(hma(x, n))).toBe(n + 4 - 2);
    // ramp: WMA lag is (n − 1)/3 → HMA(16) lag = 2·7/3 − 15/3 + 3/3 = 2/3
    const r = linear(60, 1, 0);
    expect(hma(r, 16)[59]).toBeCloseTo(59 - 2 / 3, 10);
    // odd period: ⌊9/2⌋ = 4 for the half window (not round(4.5) = 5)
    const raw9 = wma(x, 4).map((h, i) => (h === undefined || wma(x, 9)[i] === undefined ? undefined : 2 * h - wma(x, 9)[i]!));
    expect(hma(x, 9)).toEqual(chain(raw9, (xs) => wma(xs, 3)));
  });

  it("Wilder's RMA is the smoothing inside the core ATR", () => {
    const bars = randomWalk(60, 2);
    const r = rma(trueRange(bars).slice(1), 14);
    const a = atr(bars, 14);
    for (let i = 14; i < 60; i++) expect(a[i]).toBeCloseTo(r[i - 1]!, 10);
    expect(smma).toBe(rma);
    expect(rma([1, 2], 3)).toEqual([undefined, undefined]);
  });

  it("KAMA: a straight trend has ER = 1 (SC = (2/3)²), a round trip has ER = 0 (SC = (2/31)²)", () => {
    const x = linear(30, 1, 100);
    const k = kama(x, 10, 2, 30);
    expect(k[9]).toBeCloseTo(104.5, 12); // SMA seed of 100…109
    let prev = 104.5;
    for (let i = 10; i < 30; i++) {
      prev += (4 / 9) * (x[i]! - prev);
      expect(k[i]).toBeCloseTo(prev, 10);
    }
    const zig = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const kz = kama(zig, 10);
    const sc = (2 / 31) ** 2;
    expect(kz[10]).toBeCloseTo(kz[9]! + sc * (zig[10]! - kz[9]!), 12);
  });

  it("McGinley Dynamic follows MD += (x − MD)/(k·n·(x/MD)⁴)", () => {
    const x = [10, 10, 10, 12, 15];
    const md = mcginleyDynamic(x, 3, 1);
    expect(md[2]).toBe(10);
    const m3 = 10 + (12 - 10) / (3 * (12 / 10) ** 4);
    expect(md[3]).toBeCloseTo(m3, 12);
    expect(md[4]).toBeCloseTo(m3 + (15 - m3) / (3 * (15 / m3) ** 4), 12);
    expect(mcginleyDynamic(x, 3, 0.6)[3]).toBeCloseTo(10 + 2 / (0.6 * 3 * 1.2 ** 4), 12);
  });

  it("VWMA weights by volume and equals the SMA when volumes are equal", () => {
    const bars = [bar("a", 1, 1, 1, 10, 100), bar("b", 1, 1, 1, 20, 300)];
    expect(vwma(bars, 2)[1]).toBe((10 * 100 + 20 * 300) / 400);
    const rw = randomWalk(50, 3).map((b) => ({ ...b, volume: 7 }));
    const s = sma(
      rw.map((b) => b.close),
      10,
    );
    vwma(rw, 10).forEach((v, i) => (v === undefined ? expect(s[i]).toBeUndefined() : expect(v).toBeCloseTo(s[i]!, 9)));
    expect(vwma([bar("a", 1, 1, 1, 10, 0)], 1)).toEqual([undefined]);
  });

  it("movingAverage dispatches to each type", () => {
    const x = noisy(60);
    expect(movingAverage(x, 10, "sma")).toEqual(sma(x, 10));
    expect(movingAverage(x, 10, "wma")).toEqual(wma(x, 10));
    expect(movingAverage(x, 10, "rma")).toEqual(rma(x, 10));
    expect(movingAverage(x, 10, "dema")).toEqual(dema(x, 10));
    expect(movingAverage(x, 10, "tema")).toEqual(tema(x, 10));
    expect(movingAverage(x, 10, "hma")).toEqual(hma(x, 10));
    expect(movingAverage(x, 10, "kama")).toEqual(kama(x, 10));
    expect(movingAverage(x, 10)).toEqual(ema(x, 10));
  });
});

describe("rolling statistics", () => {
  const x = noisy(200, 11);

  it("rolling max/min/sum match a naive window scan", () => {
    for (const n of [1, 3, 17, 50]) {
      const mx = rollingMax(x, n);
      const mn = rollingMin(x, n);
      const sm = rollingSum(x, n);
      for (let i = 0; i < x.length; i++) {
        if (i < n - 1) {
          expect(mx[i]).toBeUndefined();
          continue;
        }
        const w = x.slice(i - n + 1, i + 1);
        expect(mx[i]).toBe(Math.max(...w));
        expect(mn[i]).toBe(Math.min(...w));
        expect(sm[i]).toBeCloseTo(
          w.reduce((a, b) => a + b, 0),
          8,
        );
      }
    }
  });

  it("highest high / lowest low read the bars' highs and lows", () => {
    const bars = randomWalk(40, 4);
    expect(highestHigh(bars, 5)[10]).toBe(Math.max(...bars.slice(6, 11).map((b) => b.high)));
    expect(lowestLow(bars, 5)[10]).toBe(Math.min(...bars.slice(6, 11).map((b) => b.low)));
  });

  it("rolling stdev is the population stdev (sample on request)", () => {
    const w = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(rollingStdev(w, 8)[7]).toBeCloseTo(2, 12);
    expect(rollingStdev(w, 8, true)[7]).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(rollingStdev([1], 1, true)).toEqual([undefined]);
  });

  it("z-score: 0 on a flat window, (x − mean)/sd otherwise", () => {
    expect(zScore(new Array(10).fill(3), 5).at(-1)).toBe(0);
    const w = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(zScore(w, 8)[7]).toBeCloseTo((9 - 5) / 2, 12);
  });

  it("percent rank compares with the n previous values", () => {
    const up = linear(30);
    expect(percentRank(up, 10)[9]).toBeUndefined();
    expect(percentRank(up, 10)[10]).toBe(100);
    expect(percentRank([...up].reverse(), 10)[20]).toBe(0);
    expect(percentRank([5, 1, 9, 3, 7], 4)[4]).toBe(75);
  });

  it("linear-regression slope recovers the slope of a line, 0 on a constant", () => {
    expect(linearRegressionSlope(linear(30, 3, 2), 14)[29]).toBeCloseTo(3, 10);
    expect(linearRegressionSlope(new Array(20).fill(4), 14)[19]).toBeCloseTo(0, 12);
    expect(linearRegressionSlope(linear(5), 1)).toEqual(new Array(5).fill(undefined));
  });
});

describe("relative strength", () => {
  it("is close / benchmark close, joined as of each date (never a later benchmark close)", () => {
    const stock = [bar("2026-01-02", 0, 0, 0, 10), bar("2026-01-03", 0, 0, 0, 12), bar("2026-01-05", 0, 0, 0, 15)];
    const bench = [bar("2026-01-05", 0, 0, 0, 30), bar("2026-01-02", 0, 0, 0, 5), bar("2026-01-04", 0, 0, 0, 6)];
    // 01-03 has no benchmark bar: use 01-02's (5), not 01-04's (6)
    expect(relativeStrength(stock, bench)).toEqual([2, 12 / 5, 0.5]);
    expect(relativeStrength(stock, [bar("2026-02-01", 0, 0, 0, 1)])).toEqual([undefined, undefined, undefined]);
  });

  it("Mansfield RS is 0 for a stock that tracks its benchmark and positive when it outperforms", () => {
    const bench = randomWalk(300, 8);
    const twin = bench.map((b) => ({ ...b, close: 2 * b.close }));
    const m = mansfieldRs(twin, bench, 52);
    expect(firstIndex(m)).toBe(51);
    expect(m.at(-1)).toBeCloseTo(0, 10);
    const better = bench.map((b, i) => ({ ...b, close: b.close * 1.002 ** i }));
    expect(mansfieldRs(better, bench, 52).at(-1)!).toBeGreaterThan(0);
  });
});
