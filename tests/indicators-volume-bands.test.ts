import { describe, expect, it } from "vitest";
import {
  accumulationDistribution,
  atr,
  atrTrailingStop,
  bollinger,
  bollingerBandwidth,
  bollingerPercentB,
  chaikinOscillator,
  chandelierExit,
  choppinessIndex,
  cmf,
  donchian,
  ema,
  emv,
  forceIndex,
  highestHigh,
  keltner,
  lowestLow,
  massIndex,
  mfi,
  movingAverageEnvelope,
  obv,
  rollingVwap,
  sma,
  starcBands,
  twiggsMoneyFlow,
  volumeOscillator,
  vwap,
  williamsVixFix,
} from "../src/analytics/indicators/index.js";
import { bar, constantBars, day, firstIndex, ramp, randomWalk } from "./helpers/series.js";

const RW = randomWalk(150, 41);
const closes = RW.map((b) => b.close);

describe("volume", () => {
  it("OBV adds the volume on up closes, subtracts it on down closes, ignores flat closes", () => {
    const bars = [10, 11, 11, 10, 12].map((c, i) => bar(day(i), c, c, c, c, (i + 1) * 100));
    expect(obv(bars)).toEqual([0, 200, 200, -200, 300]);
  });

  it("A/D line: close at the high adds the volume, at the low subtracts it, mid-range adds 0", () => {
    const bars = [bar("a", 10, 12, 8, 12, 100), bar("b", 10, 12, 8, 8, 50), bar("c", 10, 12, 8, 10, 70), bar("d", 10, 10, 10, 10, 70)];
    expect(accumulationDistribution(bars)).toEqual([100, 50, 50, 50]);
  });

  it("Chaikin oscillator = EMA3(ADL) − EMA10(ADL); CMF is bounded and 1 when every close is the high", () => {
    const adl = accumulationDistribution(RW) as number[];
    const co = chaikinOscillator(RW);
    expect(firstIndex(co)).toBe(9);
    expect(co[60]).toBeCloseTo(ema(adl, 3)[60]! - ema(adl, 10)[60]!, 6);
    const c = cmf(RW, 20);
    expect(firstIndex(c)).toBe(19);
    for (const v of c) if (v !== undefined) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    const tops = Array.from({ length: 25 }, (_, i) => bar(day(i), 10, 12, 8, 12, 100 + i));
    expect(cmf(tops, 20).at(-1)).toBeCloseTo(1, 12);
    expect(
      cmf(
        constantBars(25).map((b) => ({ ...b, volume: 0 })),
        20,
      ).at(-1),
    ).toBeUndefined();
  });

  it("MFI: 100 with only rising typical prices, 50 with no change, hand-checked mixed case", () => {
    expect(mfi(ramp(20), 14).at(-1)).toBe(100);
    expect(mfi(constantBars(20), 14).at(-1)).toBe(50);
    expect(firstIndex(mfi(ramp(20), 14))).toBe(14);
    // TP 10 → 12 (+12·100) → 11 (−11·200): MFI = 100 − 100/(1 + 1200/2200)
    const bars = [10, 12, 11].map((tp, i) => bar(day(i), tp, tp, tp, tp, (i === 2 ? 200 : 100) as number));
    expect(mfi(bars, 2)[2]).toBeCloseTo(100 - 100 / (1 + 1200 / 2200), 12);
  });

  it("Force index = EMA13((C − C₋₁)·V)", () => {
    const raw = RW.slice(1).map((b, i) => (b.close - RW[i]!.close) * b.volume!);
    const f = forceIndex(RW, 13);
    expect(firstIndex(f)).toBe(13);
    expect(f[80]).toBeCloseTo(ema(raw, 13)[79]!, 6);
  });

  it("EMV: distance × range × scale / volume, averaged", () => {
    // hl2 rises by 1 each bar, range 2, volume 1e8 → each raw EMV = 1·2 = 2
    const bars = Array.from({ length: 20 }, (_, i) => bar(day(i), 10 + i, 11 + i, 9 + i, 10 + i, 100_000_000));
    const e = emv(bars, 14);
    expect(firstIndex(e)).toBe(14);
    expect(e.at(-1)).toBeCloseTo(2, 12);
  });

  it("Twiggs MF is 1 when every bar closes at its true high, and uses Wilder (1/n) smoothing", () => {
    const tops = Array.from({ length: 40 }, (_, i) => bar(day(i), 10 + i, 11 + i, 9 + i, 11 + i, 100 + 10 * i));
    expect(twiggsMoneyFlow(tops, 21).at(-1)).toBeCloseTo(1, 12);
    expect(firstIndex(twiggsMoneyFlow(tops, 21))).toBe(21);
    // Wilder vs EMA smoothing give different values on a random walk: pin the Wilder recursion.
    const t = twiggsMoneyFlow(RW, 5);
    const ad = RW.slice(1).map((b, i) => {
      const pc = RW[i]!.close;
      const h = Math.max(b.high, pc);
      const l = Math.min(b.low, pc);
      return ((b.close - l - (h - b.close)) / (h - l)) * b.volume!;
    });
    const vol = RW.slice(1).map((b) => b.volume!);
    let sa = ad.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    let sv = vol.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    for (let j = 5; j < 30; j++) {
      sa = (sa * 4 + ad[j]!) / 5;
      sv = (sv * 4 + vol[j]!) / 5;
    }
    expect(t[30]).toBeCloseTo(sa / sv, 12);
  });

  it("volume oscillator is 0 on constant volume", () => {
    expect(volumeOscillator(constantBars(40)).at(-1)).toBeCloseTo(0, 10);
    expect(firstIndex(volumeOscillator(RW))).toBe(27);
  });

  it("VWAP resets each session, can accumulate from the start or from an anchor date", () => {
    const intraday = [
      { ...bar("2026-03-02T14:30:00Z", 10, 10, 10, 10, 100) },
      { ...bar("2026-03-02T15:30:00Z", 12, 12, 12, 12, 300) },
      { ...bar("2026-03-03T14:30:00Z", 20, 20, 20, 20, 100) },
      { ...bar("2026-03-03T15:30:00Z", 22, 22, 22, 22, 100) },
    ];
    expect(vwap(intraday)).toEqual([10, 11.5, 20, 21]);
    expect(vwap(intraday, "start")).toEqual([10, 11.5, (10 * 100 + 12 * 300 + 20 * 100) / 500, (10 * 100 + 12 * 300 + 20 * 100 + 22 * 100) / 600]);
    expect(vwap(intraday, "2026-03-03")).toEqual([undefined, undefined, 20, 21]);
    const daily = randomWalk(5, 2);
    expect(vwap(daily)[3]).toBeCloseTo((daily[3]!.high + daily[3]!.low + daily[3]!.close) / 3, 12);
    expect(vwap([bar("2026-01-01", 1, 1, 1, 1, 0)])).toEqual([undefined]);
    const rv = rollingVwap(intraday, 2);
    expect(rv).toEqual([undefined, 11.5, (12 * 300 + 20 * 100) / 400, 21]);
  });
});

describe("bands and channels", () => {
  it("Keltner = EMA(20) ± 1.5·ATR(10)", () => {
    const k = keltner(RW);
    const e = ema(closes, 20);
    const a = atr(RW, 10);
    expect(firstIndex(k)).toBe(19);
    expect(k[90]).toEqual({ middle: e[90], upper: e[90]! + 1.5 * a[90]!, lower: e[90]! - 1.5 * a[90]! });
  });

  it("Donchian = highest high / lowest low over n including the bar", () => {
    const d = donchian(RW, 20);
    expect(d[50]!.upper).toBe(highestHigh(RW, 20)[50]);
    expect(d[50]!.lower).toBe(lowestLow(RW, 20)[50]);
    expect(d[50]!.middle).toBe((d[50]!.upper + d[50]!.lower) / 2);
  });

  it("STARC = SMA(6) ± 1.33·ATR(15); envelope = MA × (1 ± pct)", () => {
    const s = starcBands(RW);
    const m = sma(closes, 6);
    const a = atr(RW, 15);
    expect(firstIndex(s)).toBe(15);
    expect(s[70]!.upper).toBeCloseTo(m[70]! + 1.33 * a[70]!, 12);
    const env = movingAverageEnvelope(closes, 20, 2.5);
    expect(env[40]!.upper).toBeCloseTo(sma(closes, 20)[40]! * 1.025, 12);
    expect(movingAverageEnvelope(closes, 20, 2.5, "ema")[40]!.middle).toBe(ema(closes, 20)[40]);
  });

  it("Bollinger %B is 0.5 on collapsed bands and 1 at the upper band; bandwidth = width / middle", () => {
    expect(bollingerPercentB(new Array(25).fill(5), 20).at(-1)).toBe(0.5);
    const b = bollinger(closes, 20, 2)[80]!;
    expect(bollingerPercentB(closes, 20, 2)[80]).toBeCloseTo((closes[80]! - b.lower) / (b.upper - b.lower), 12);
    expect(bollingerBandwidth(closes, 20, 2)[80]).toBeCloseTo((b.upper - b.lower) / b.middle, 12);
    expect(bollingerBandwidth(new Array(25).fill(0), 20).at(-1)).toBeUndefined();
  });
});

describe("volatility", () => {
  it("Choppiness of a steady trend: 100·log10(ΣTR / range)/log10(n)", () => {
    const c = choppinessIndex(ramp(30), 14);
    expect(firstIndex(c)).toBe(14);
    // TR = 2 each bar → Σ = 28; HH − LL over 14 bars = (11 + 29) − (9 + 16) = 15
    expect(c.at(-1)).toBeCloseTo((100 * Math.log10(28 / 15)) / Math.log10(14), 12);
    expect(choppinessIndex(constantBars(20), 14).at(-1)).toBeUndefined();
  });

  it("Mass index of a constant range is the sum period (25); warm-up 2·(9 − 1) + 24", () => {
    const m = massIndex(ramp(60));
    expect(firstIndex(m)).toBe(16 + 24);
    expect(m.at(-1)).toBeCloseTo(25, 12);
    expect(massIndex(constantBars(60)).at(-1)).toBe(25);
  });

  it("ATR trailing stop ratchets up in a rally and flips short on a close below it", () => {
    const up = ramp(40);
    const s = atrTrailingStop(up, 14, 3);
    expect(firstIndex(s)).toBe(14);
    for (let i = 15; i < 40; i++) {
      expect(s[i]!.trend).toBe(1);
      expect(s[i]!.stop).toBeGreaterThanOrEqual(s[i - 1]!.stop);
    }
    const crash = atrTrailingStop([...up, bar(day(40), 30, 30, 10, 12)], 14, 3);
    expect(crash[40]!.trend).toBe(-1);
    expect(crash[40]!.stop).toBeGreaterThan(12);
  });

  it("Chandelier exit (22, 3) hangs 3 ATR(22) from the 22-bar extremes", () => {
    const c = chandelierExit(RW);
    const a = atr(RW, 22);
    expect(firstIndex(c)).toBe(22);
    expect(c[100]!.exitLong).toBeCloseTo(highestHigh(RW, 22)[100]! - 3 * a[100]!, 12);
    expect(c[100]!.exitShort).toBeCloseTo(lowestLow(RW, 22)[100]! + 3 * a[100]!, 12);
  });

  it("Williams VIX Fix: wvf from the 22-bar highest close; range low uses the lowest wvf", () => {
    const v = williamsVixFix(RW);
    const i = 120;
    const hc = Math.max(...closes.slice(i - 21, i + 1));
    expect(v[i]!.wvf).toBeCloseTo((100 * (hc - RW[i]!.low)) / hc, 12);
    const raw = RW.map((b, j) => {
      if (j < 21) return undefined;
      const h = Math.max(...closes.slice(j - 21, j + 1));
      return (100 * (h - b.low)) / h;
    });
    const last50 = raw.slice(i - 49, i + 1) as number[];
    expect(v[i]!.rangeLow).toBeCloseTo(Math.min(...last50) * 1.01, 12);
    expect(v[i]!.rangeHigh).toBeCloseTo(Math.max(...last50) * 0.85, 12);
    expect(v[i]!.rangeLow).toBeLessThan(v[i]!.rangeHigh / 0.85);
    expect([0, 1]).toContain(v[i]!.buyZone);
  });
});
