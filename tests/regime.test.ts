import { describe, expect, it } from "vitest";
import {
  type Bar,
  contrarianSentiment,
  cryptoRegime,
  distributionDays,
  exposureCoach,
  followThrough,
  ratioSignal,
  trendSignal,
  vixTermSignal,
  weightedScore,
} from "../src/analytics/regime.js";

const series = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
const bars = (closes: number[], volumes?: number[]): Bar[] =>
  closes.map((c, i) => ({ date: `d${String(i).padStart(4, "0")}`, close: c, volume: volumes?.[i] ?? 1000 }));

describe("signals", () => {
  it("a rising ratio is risk-on, a falling one risk-off", () => {
    const up = series(260, (i) => 100 + i);
    const flat = series(260, () => 100);
    expect(ratioSignal("x", "x", up, flat).value).toBeCloseTo(1, 10);
    expect(ratioSignal("x", "x", flat, up).value).toBeCloseTo(-1, 10);
    expect(ratioSignal("x", "x", up, flat, false).value).toBeCloseTo(-1, 10);
    expect(ratioSignal("x", "x", up.slice(0, 100), flat).value).toBeUndefined();
    expect(trendSignal("t", "t", up).value).toBeCloseTo(1, 10);
    expect(
      trendSignal(
        "t",
        "t",
        up.map((v) => -v + 1000),
      ).value,
    ).toBeCloseTo(-1, 10);
  });
  it("VIX term structure and contrarian sentiment", () => {
    expect(vixTermSignal(30, 25).value).toBe(-1);
    expect(vixTermSignal(14, 17).value).toBe(1);
    expect(contrarianSentiment(10)).toBe(0.8);
    expect(contrarianSentiment(90)).toBe(-0.8);
    expect(contrarianSentiment(50)).toBe(0);
  });
});

describe("O'Neil", () => {
  it("counts distribution days and voids one after a 5 % rally", () => {
    const closes = series(30, () => 100);
    const vols = series(30, () => 1000);
    for (const i of [22, 24, 26]) {
      closes[i] = 99;
      vols[i] = 2000;
    }
    const d = distributionDays(bars(closes, vols));
    expect(d.days.length).toBe(3);
    expect(d.level).toBe("caution");
    const rallied = [...closes, 106];
    expect(distributionDays(bars(rallied, [...vols, 1000])).days.length).toBe(0);
  });
  it("detects a follow-through day after a correction", () => {
    const closes = [...series(20, (i) => 100 + i), ...series(10, (i) => 119 - i * 2), 100, 101, 101.5, 102, 104];
    const vols = closes.map((_, i) => (i === closes.length - 1 ? 5000 : 1000));
    const r = followThrough(bars(closes, vols));
    expect(r.state).toBe("follow-through");
    expect(r.dayOfAttempt).toBe(4);
    const noVol = followThrough(bars(closes));
    expect(noVol.state).toBe("rally-attempt");
  });
});

describe("coaches", () => {
  it("renormalises weights over what is available", () => {
    const w = weightedScore([
      { id: "a", label: "a", score: 100, weight: 0.5, reason: "" },
      { id: "b", label: "b", score: undefined, weight: 0.5, reason: "" },
    ]);
    expect(w.score).toBe(100);
    expect(w.coverage).toBe(0.5);
  });
  it("maps regime to an exposure ceiling", () => {
    const bull = exposureCoach({ trend: 1, breadth: 1, credit: 1, distribution: "normal", followThrough: "uptrend", volatility: 1, sentiment: 0 });
    expect(bull.zone).toBe("risk-on");
    expect(bull.maxExposurePct).toBe(100);
    const bear = exposureCoach({ trend: -1, breadth: -1, credit: -1, distribution: "severe", followThrough: "correction", volatility: -1, sentiment: 0.8 });
    expect(bear.zone).toBe("risk-off");
    expect(bear.newEntries).toBe("avoid");
    expect(exposureCoach({ sentiment: 0 }).zone).toBe("unknown");
  });
  it("scores the crypto regime", () => {
    const r = cryptoRegime({ btcTrend: 1, altBreadthPct: 80, dominanceChange30d: -2, fundingAnnualizedPct: 10, btcDrawdownPct: -5, btcReturn30dPct: 12 });
    expect(r.label).toBe("risk-on");
    expect(cryptoRegime({}).label).toBe("unknown");
  });
});
