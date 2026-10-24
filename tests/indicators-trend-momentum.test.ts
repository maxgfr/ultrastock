import { describe, expect, it } from "vitest";
import {
  adx,
  aroon,
  atr,
  awesomeOscillator,
  cci,
  coppockCurve,
  dpo,
  elderRay,
  ema,
  fisherTransform,
  ichimoku,
  kdj,
  kst,
  macd,
  momentum,
  pmax,
  pmo,
  pringSpecialK,
  psar,
  ravi,
  roc,
  rsi,
  rvi,
  shinohara,
  sma,
  stochastic,
  stochasticSlow,
  stochRsi,
  supertrend,
  trix,
  ultimateOscillator,
  vortex,
  williamsR,
} from "../src/analytics/indicators/index.js";
import type { Bar } from "../src/providers/types.js";
import { bar, constantBars, day, firstIndex, fromCloses, ramp, randomWalk } from "./helpers/series.js";

const geometric = (n: number, g = 1.01, start = 100) => Array.from({ length: n }, (_, i) => start * g ** i);

/** Wilder's ADX straight from the book's worksheet: TR14/+DM14/−DM14 running sums, DX, ADX. */
function naiveAdx(bars: Bar[], n: number) {
  const tr: number[] = [];
  const pdm: number[] = [];
  const mdm: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const [h, l, ph, pl, pc] = [bars[i]!.high, bars[i]!.low, bars[i - 1]!.high, bars[i - 1]!.low, bars[i - 1]!.close];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    pdm.push(h - ph > pl - l ? Math.max(h - ph, 0) : 0);
    mdm.push(pl - l > h - ph ? Math.max(pl - l, 0) : 0);
  }
  const wilder = (xs: number[]) => {
    const out: number[] = [];
    let s = xs.slice(0, n).reduce((a, b) => a + b, 0);
    out.push(s);
    for (let i = n; i < xs.length; i++) {
      s = s - s / n + xs[i]!;
      out.push(s);
    }
    return out;
  };
  const [t, p, m] = [wilder(tr), wilder(pdm), wilder(mdm)];
  const dx = t.map((tv, i) => {
    const pdi = (100 * p[i]!) / tv;
    const mdi = (100 * m[i]!) / tv;
    return (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  });
  const res = new Map<number, { adx: number; plusDI: number; minusDI: number }>();
  let a = dx.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let j = n - 1; j < dx.length; j++) {
    if (j > n - 1) a = (a * (n - 1) + dx[j]!) / n;
    res.set(j + n, { adx: a, plusDI: (100 * p[j]!) / t[j]!, minusDI: (100 * m[j]!) / t[j]! });
  }
  return res;
}

describe("ADX / DMI", () => {
  it("matches an independent worksheet implementation of Wilder's ADX", () => {
    const bars = randomWalk(120, 21);
    const got = adx(bars, 14);
    const want = naiveAdx(bars, 14);
    expect(firstIndex(got)).toBe(27);
    for (const [i, w] of want) {
      expect(got[i]!.adx).toBeCloseTo(w.adx, 9);
      expect(got[i]!.plusDI).toBeCloseTo(w.plusDI, 9);
      expect(got[i]!.minusDI).toBeCloseTo(w.minusDI, 9);
    }
  });

  it("a one-way trend gives −DI = 0, ADX = 100; a flat market gives zeros", () => {
    const up = adx(ramp(60), 14).at(-1)!;
    expect(up.minusDI).toBe(0);
    expect(up.plusDI).toBeCloseTo(50, 10); // +DM 1 / TR 2
    expect(up.adx).toBeCloseTo(100, 10);
    expect(adx(constantBars(40), 14).at(-1)).toEqual({ adx: 0, plusDI: 0, minusDI: 0, dx: 0 });
    expect(adx(ramp(27), 14).every((x) => x === undefined)).toBe(true);
  });
});

describe("Aroon, Vortex, RAVI", () => {
  it("Aroon: a rising market is up 100 / down 0 from bar n", () => {
    const a = aroon(ramp(40), 25);
    expect(firstIndex(a)).toBe(25);
    expect(a[30]).toEqual({ up: 100, down: 0, oscillator: 100 });
  });

  it("Aroon counts bars since the extreme of the last n + 1 bars", () => {
    // high of the window 4 bars ago, low 2 bars ago, n = 5
    const highs = [1, 9, 3, 4, 5, 6];
    const lows = [0, 2, 3, -1, 4, 5];
    const bars = highs.map((h, i) => bar(day(i), 1, h, lows[i]!, 1));
    expect(aroon(bars, 5)[5]).toEqual({ up: (100 * (5 - 4)) / 5, down: (100 * (5 - 2)) / 5, oscillator: 20 - 60 });
  });

  it("Vortex of identical bars is 1 / 1", () => {
    const flat = Array.from({ length: 20 }, (_, i) => bar(day(i), 10, 11, 9, 10));
    expect(vortex(flat, 14).at(-1)).toEqual({ plusVI: 1, minusVI: 1 });
    expect(firstIndex(vortex(flat, 14))).toBe(14);
    const up = vortex(ramp(30), 14).at(-1)!;
    expect(up.plusVI).toBeGreaterThan(up.minusVI);
  });

  it("RAVI is |SMA7 − SMA65| / SMA65 in %", () => {
    const x = geometric(100);
    const r = ravi(x);
    const s = sma(x, 7);
    const l = sma(x, 65);
    expect(r[99]).toBeCloseTo((Math.abs(s[99]! - l[99]!) / l[99]!) * 100, 10);
    expect(ravi(new Array(70).fill(5)).at(-1)).toBe(0);
  });
});

describe("Parabolic SAR", () => {
  it("matches a hand-traced uptrend (AF 0.02 step)", () => {
    const s = psar(ramp(6), 0.02, 0.2);
    expect(s[0]).toBeUndefined();
    // i=1: 9 + .02·(11 − 9) = 9.04, clamped to low₀ = 9; i=2: 9 + .04·3 → clamp low₀ = 9;
    // i=3: 9 + .06·4 = 9.24; i=4: 9.24 + .08·(14 − 9.24) = 9.6208
    expect(s.slice(1, 5).map((x) => Number(x!.sar.toFixed(6)))).toEqual([9, 9, 9.24, 9.6208]);
    expect(s.slice(1).every((x) => x!.trend === 1)).toBe(true);
  });

  it("caps the acceleration factor at max and never puts the long SAR above the prior two lows", () => {
    const bars = ramp(80);
    const s = psar(bars);
    for (let i = 2; i < 80; i++) expect(s[i]!.sar).toBeLessThanOrEqual(Math.min(bars[i - 1]!.low, bars[i - 2]!.low));
    // with AF at 0.2 the gap to the EP shrinks by 0.8 a bar: SAR → EP − (step/AF)·… ; check the last step directly
    const ep = bars[78]!.high;
    expect(s[79]!.sar).toBeCloseTo(Math.min(s[78]!.sar + 0.2 * (ep - s[78]!.sar), bars[78]!.low, bars[77]!.low), 10);
  });

  it("reverses when price penetrates the SAR (the stop is the prior extreme)", () => {
    const up = ramp(20);
    const crash = bar(day(20), 25, 25, 5, 6);
    const s = psar([...up, crash]);
    expect(s[19]!.trend).toBe(1);
    expect(s[20]!.trend).toBe(-1);
    expect(s[20]!.sar).toBe(Math.max(up[19]!.high, crash.high)); // prior EP = 30
    // and a long decline keeps it short, SAR above the prior two highs
    const down = fromCloses(Array.from({ length: 40 }, (_, i) => 100 - i));
    const d = psar(down);
    expect(d.at(-1)!.trend).toBe(-1);
    expect(d.at(-1)!.sar).toBeGreaterThanOrEqual(Math.max(down[38]!.high, down[37]!.high));
  });
});

describe("Supertrend and PMAX", () => {
  it("Supertrend: up on a rising market with a ratcheting lower band, flips on a crash", () => {
    const bars = ramp(40);
    const s = supertrend(bars, 10, 3);
    const a = atr(bars, 10);
    expect(firstIndex(s)).toBe(10);
    expect(s[10]!.lower).toBeCloseTo(10 + 10 - 3 * a[10]!, 10); // hl2 − 3·ATR
    for (let i = 11; i < 40; i++) {
      expect(s[i]!.direction).toBe(1);
      expect(s[i]!.supertrend).toBe(s[i]!.lower);
      expect(s[i]!.lower).toBeGreaterThanOrEqual(s[i - 1]!.lower);
    }
    const crashed = supertrend([...bars, bar(day(40), 49, 49, 20, 21)], 10, 3);
    expect(crashed[40]!.direction).toBe(-1);
    expect(crashed[40]!.supertrend).toBe(crashed[40]!.upper);
  });

  it("PMAX trails the EMA of hl2: long stop ratchets up in a rally, flips when the MA crosses it", () => {
    const bars = ramp(60);
    const p = pmax(bars, 10, 10, 3);
    const ma = ema(
      bars.map((b) => (b.high + b.low) / 2),
      10,
    );
    expect(firstIndex(p)).toBe(10);
    expect(p[30]!.ma).toBeCloseTo(ma[30]!, 10);
    for (let i = 11; i < 60; i++) {
      expect(p[i]!.direction).toBe(1);
      expect(p[i]!.longStop).toBeGreaterThanOrEqual(p[i - 1]!.longStop);
    }
    const down = Array.from({ length: 40 }, (_, i) => bar(day(60 + i), 60 - 2 * i, 61 - 2 * i, 59 - 2 * i, 60 - 2 * i));
    expect(pmax([...bars, ...down], 10, 10, 3).at(-1)!.direction).toBe(-1);
  });
});

describe("Ichimoku", () => {
  const bars = randomWalk(140, 31);
  const mid = (i: number, n: number) =>
    (Math.max(...bars.slice(i - n + 1, i + 1).map((b) => b.high)) + Math.min(...bars.slice(i - n + 1, i + 1).map((b) => b.low))) / 2;

  it("shows at bar i the cloud computed 26 bars earlier, and the lead spans computed at i", () => {
    const ich = ichimoku(bars);
    expect(firstIndex(ich)).toBe(51 + 26);
    const i = 120;
    const r = ich[i]!;
    expect(r.tenkan).toBeCloseTo(mid(i, 9), 12);
    expect(r.kijun).toBeCloseTo(mid(i, 26), 12);
    expect(r.spanA).toBeCloseTo((mid(i - 26, 9) + mid(i - 26, 26)) / 2, 12);
    expect(r.spanB).toBeCloseTo(mid(i - 26, 52), 12);
    expect(r.leadA).toBeCloseTo((mid(i, 9) + mid(i, 26)) / 2, 12);
    expect(r.leadB).toBeCloseTo(mid(i, 52), 12);
    expect(r.cloudTop).toBe(Math.max(r.spanA, r.spanB));
    expect(ich[i + 4]!.spanA).toBeCloseTo(ich[i - 22]!.leadA, 12); // the lead span reaches the cloud 26 bars later
  });

  it("does not expose a chikou span", () => {
    expect(Object.keys(ichimoku(bars).at(-1)!)).not.toContain("chikou");
  });
});

describe("oscillators", () => {
  it("ROC and momentum", () => {
    expect(roc([100, 110, 121], 1)).toEqual([undefined, 10.000000000000009, 10.000000000000009]);
    expect(roc([0, 5], 1)).toEqual([undefined, undefined]);
    expect(momentum([1, 4, 9, 16], 2)).toEqual([undefined, undefined, 8, 12]);
  });

  it("stochastic: close at the window high is 100, at the low 0, a flat window 50; %D = SMA(%K)", () => {
    const up = stochastic(ramp(30), 14, 3);
    expect(up[29]!.k).toBeCloseTo((100 * (39 - (9 + 16))) / (40 - (9 + 16)), 10);
    const tops = Array.from({ length: 20 }, (_, i) => bar(day(i), 10 + i, 11 + i, 9 + i, 11 + i));
    expect(stochastic(tops, 14, 3).at(-1)).toEqual({ k: 100, d: 100 });
    const bottoms = Array.from({ length: 20 }, (_, i) => bar(day(i), 30 - i, 31 - i, 29 - i, 29 - i));
    expect(stochastic(bottoms, 14, 3).at(-1)).toEqual({ k: 0, d: 0 });
    expect(stochastic(constantBars(20), 14, 3).at(-1)).toEqual({ k: 50, d: 50 });
    const rw = randomWalk(80, 9);
    const fast = stochastic(rw, 14, 3);
    const slow = stochasticSlow(rw, 14, 3);
    expect(firstIndex(fast)).toBe(15);
    expect(firstIndex(slow)).toBe(17);
    expect(slow[40]!.k).toBeCloseTo((fast[38]!.k + fast[39]!.k + fast[40]!.k) / 3, 10);
    expect(fast[40]!.d).toBeCloseTo((fast[38]!.k + fast[39]!.k + fast[40]!.k) / 3, 10);
  });

  it("Williams %R is the raw %K shifted to [−100, 0]", () => {
    const rw = randomWalk(60, 12);
    const w = williamsR(rw, 14);
    const k = stochastic(rw, 14, 1);
    expect(w[40]).toBeCloseTo(k[40]!.k - 100, 10);
    expect(williamsR(constantBars(20), 14).at(-1)).toBe(-50);
    for (const v of w) if (v !== undefined) expect(v >= -100 && v <= 0).toBe(true);
  });

  it("CCI uses the 0.015 constant and the mean (not standard) deviation", () => {
    // typical prices 1, 2, 3: SMA 2, mean deviation 2/3 → (3 − 2)/(0.015 · 2/3) = 100
    const bars = [1, 2, 3].map((tp, i) => bar(day(i), tp, tp, tp, tp));
    expect(cci(bars, 3)[2]).toBeCloseTo(100, 9);
    // typical prices 1, 1, 4: SMA 2, MD (1 + 1 + 2)/3 = 4/3 → 2/(0.015·4/3) = 100
    const b2 = [1, 1, 4].map((tp, i) => bar(day(i), tp, tp, tp, tp));
    expect(cci(b2, 3)[2]).toBeCloseTo(100, 9);
    expect(cci(constantBars(25), 20).at(-1)).toBe(0);
  });

  it("StochRSI 14/14/3/3 is bounded, with %K = SMA(StochRSI, 3)", () => {
    const c = randomWalk(120, 14).map((b) => b.close);
    const s = stochRsi(c);
    const r = rsi(c, 14);
    expect(firstIndex(s)).toBe(14 + 13 + 2 + 2);
    const i = 90;
    const w = r.slice(i - 13, i + 1) as number[];
    expect(s[i]!.stochRsi).toBeCloseTo((100 * (r[i]! - Math.min(...w))) / (Math.max(...w) - Math.min(...w)), 10);
    expect(s[i]!.k).toBeCloseTo((s[i]!.stochRsi + s[i - 1]!.stochRsi + s[i - 2]!.stochRsi) / 3, 10);
    for (const p of s) if (p) expect(p.k >= 0 && p.k <= 100 && p.d >= 0 && p.d <= 100).toBe(true);
  });

  it("KDJ smooths RSV with K = (2K₋₁ + RSV)/3 from K = D = 50", () => {
    const tops = Array.from({ length: 12 }, (_, i) => bar(day(i), 10 + i, 11 + i, 9 + i, 11 + i));
    const r = kdj(tops, 9, 3, 3);
    expect(firstIndex(r)).toBe(8);
    const k = (2 * 50 + 100) / 3;
    const d = (2 * 50 + k) / 3;
    expect(r[8]!.k).toBeCloseTo(k, 12);
    expect(r[8]!.d).toBeCloseTo(d, 12);
    expect(r[8]!.j).toBeCloseTo(3 * k - 2 * d, 12);
  });

  it("Ultimate Oscillator: 100 when every close is the true high, 0 at the true low, 50 on a flat market", () => {
    const tops = Array.from({ length: 40 }, (_, i) => bar(day(i), 10 + i, 11 + i, 9 + i, 11 + i));
    expect(ultimateOscillator(tops).at(-1)).toBeCloseTo(100, 10);
    const lows = Array.from({ length: 40 }, (_, i) => bar(day(i), 50 - i, 51 - i, 49 - i, 49 - i));
    expect(ultimateOscillator(lows).at(-1)).toBeCloseTo(0, 10);
    expect(ultimateOscillator(constantBars(40)).at(-1)).toBe(50);
    expect(firstIndex(ultimateOscillator(tops))).toBe(28);
  });

  it("Awesome Oscillator is SMA5 − SMA34 of the median price; Elder ray is high/low − EMA13", () => {
    const rw = randomWalk(60, 15);
    const mp = rw.map((b) => (b.high + b.low) / 2);
    expect(awesomeOscillator(rw)[50]).toBeCloseTo(sma(mp, 5)[50]! - sma(mp, 34)[50]!, 10);
    const e = ema(
      rw.map((b) => b.close),
      13,
    );
    expect(elderRay(rw)[30]).toEqual({ bullPower: rw[30]!.high - e[30]!, bearPower: rw[30]!.low - e[30]! });
  });

  it("MACD (Appel) equals EMA12 − EMA26 with an EMA9 signal", () => {
    const c = randomWalk(100, 16).map((b) => b.close);
    const m = macd(c);
    expect(m[60]!.macd).toBeCloseTo(ema(c, 12)[60]! - ema(c, 26)[60]!, 10);
  });

  it("TRIX is 0 on a constant series and positive on a rally; first value at 3(n − 1) + 1", () => {
    expect(trix(new Array(60).fill(7), 14).at(-1)).toBe(0);
    const t = trix(geometric(80), 14);
    expect(firstIndex(t)).toBe(40);
    expect(t.at(-1)!).toBeGreaterThan(0);
  });

  it("PMO: a constant 1 % daily gain gives PMO = 10 (the ×10 scale), and the warm-up is 1 + 34 + 19 (+9 for the signal)", () => {
    const p = pmo(geometric(120));
    expect(firstIndex(p)).toBe(63);
    expect(p.at(-1)!.pmo).toBeCloseTo(10, 6);
    expect(p.at(-1)!.signal).toBeCloseTo(10, 6);
    expect(pmo(new Array(100).fill(3)).at(-1)).toEqual({ pmo: 0, signal: 0 });
  });

  it("KST and Special K are the weighted sums of smoothed ROCs (constant ROCs pass straight through)", () => {
    const x = geometric(800, 1.001);
    const r = (n: number) => 100 * (1.001 ** n - 1);
    const k = kst(x).at(-1)!;
    expect(k.kst).toBeCloseTo(r(10) + 2 * r(15) + 3 * r(20) + 4 * r(30), 6);
    expect(k.signal).toBeCloseTo(k.kst, 6);
    const sk = pringSpecialK(x);
    expect(firstIndex(sk)).toBe(530 + 194 + 9);
    const rocs = [10, 15, 20, 30, 40, 65, 75, 100, 195, 265, 390, 530];
    expect(sk.at(-1)!.specialK).toBeCloseTo(
      rocs.reduce((s, n, j) => s + ((j % 4) + 1) * r(n), 0),
      5,
    );
  });

  it("Coppock = WMA10(ROC14 + ROC11); DPO of a ramp is −1.5 for n = 20", () => {
    const x = geometric(60);
    const c = coppockCurve(x);
    expect(firstIndex(c)).toBe(23);
    expect(c.at(-1)).toBeCloseTo(100 * (1.01 ** 14 - 1) + 100 * (1.01 ** 11 - 1), 8);
    const line = Array.from({ length: 40 }, (_, i) => i);
    const d = dpo(line, 20);
    expect(firstIndex(d)).toBe(19);
    expect(d[39]).toBeCloseTo(-1.5, 12); // close[i − 11] − (i − 9.5)
  });

  it("Fisher transform: signal is the previous Fisher value, positive on a rally", () => {
    const f = fisherTransform(ramp(40), 10);
    expect(firstIndex(f)).toBe(10);
    for (let i = 11; i < 40; i++) expect(f[i]!.signal).toBe(f[i - 1]!.fisher);
    expect(f.at(-1)!.fisher).toBeGreaterThan(0);
  });

  it("RVI is 1 when every bar opens at its low and closes at its high", () => {
    const full = Array.from({ length: 30 }, (_, i) => bar(day(i), 9 + i, 11 + i, 9 + i, 11 + i));
    const r = rvi(full, 10);
    expect(firstIndex(r)).toBe(15);
    expect(r.at(-1)).toEqual({ rvi: 1, signal: 1 });
  });

  it("Shinohara ratios are 100 when price is symmetric around the open and the prior close", () => {
    const sym = Array.from({ length: 30 }, (_, i) => bar(day(i), 10, 11, 9, 10));
    expect(shinohara(sym, 26).at(-1)).toEqual({ aRatio: 100, bRatio: 100 });
    expect(firstIndex(shinohara(sym, 26))).toBe(26);
    expect(shinohara(constantBars(30), 26).at(-1)).toBeUndefined();
  });
});
