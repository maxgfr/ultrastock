import { describe, expect, it } from "vitest";
import { breakouts, darvasBoxes, fiftyTwoWeek, gaps, minerviniTrendTemplate, supportResistance, swingPivots, vcp } from "../src/analytics/patterns.js";
import type { Bar } from "../src/providers/types.js";
import { bar, constantBars, day, fromCloses, randomWalk } from "./helpers/series.js";

/** Piecewise-linear closes through the given (index, price) knots. */
function path(knots: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < knots.length; k++) {
    const [i0, p0] = knots[k]!;
    const [i1, p1] = knots[k + 1]!;
    for (let i = i0; i < i1; i++) out.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
  }
  out.push(knots[knots.length - 1]![1]);
  return out;
}

describe("swing pivots", () => {
  it("finds fractal highs/lows and dates them at their confirmation, n bars later", () => {
    const closes = path([
      [0, 10],
      [5, 15],
      [10, 10],
      [15, 14],
    ]);
    const p = swingPivots(fromCloses(closes, 0.5), 2, 2);
    expect(p.map((x) => [x.type, x.index, x.confirmedIndex])).toEqual([
      ["high", 5, 7],
      ["low", 10, 12],
    ]);
    expect(p[0]!.price).toBe(15.5);
    expect(p[0]!.confirmedDate).toBe(day(7));
  });

  it("a flat top counts once, at its first bar", () => {
    const highs = [1, 2, 5, 5, 3, 2, 1];
    const bars = highs.map((h, i) => bar(day(i), h - 0.5, h, h - 1, h - 0.5));
    expect(
      swingPivots(bars, 2, 2)
        .filter((x) => x.type === "high")
        .map((x) => x.index),
    ).toEqual([2]);
  });

  it("never looks ahead: pivots from bars[0..k] are exactly the full-series pivots confirmed by k", () => {
    const rw = randomWalk(400, 5);
    const full = swingPivots(rw, 5, 5);
    for (const k of [10, 57, 120, 250, 399]) expect(swingPivots(rw.slice(0, k + 1), 5, 5)).toEqual(full.filter((p) => p.confirmedIndex <= k));
  });
});

describe("support and resistance", () => {
  it("clusters the repeated swing highs and lows of a range into resistance and support", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 105 + 5 * Math.sin((2 * Math.PI * i) / 20));
    const bars = fromCloses(closes, 0.3).slice(0, 195);
    const sr = supportResistance(bars, { left: 3, right: 3, tolerance: 0.5, minTouches: 3 })!;
    const res = sr.levels.find((l) => l.kind === "resistance")!;
    const sup = sr.levels.find((l) => l.kind === "support")!;
    expect(res.price).toBeGreaterThan(109.5);
    expect(res.price).toBeLessThan(110.6);
    expect(sup.price).toBeGreaterThan(99.4);
    expect(sup.price).toBeLessThan(100.5);
    expect(res.touches).toBeGreaterThanOrEqual(8);
    expect(res.pivotHighs).toBe(res.touches);
    expect(sup.pivotLows).toBe(sup.touches);
    expect(res.reasons[0]).toMatch(/touches/);
    expect(sr.tolerance).toBeCloseTo(0.5 * sr.atr, 12);
  });

  it("reports when no cluster is strong enough, and approximates ATR on a short series", () => {
    const sr = supportResistance(randomWalk(12, 3), { minTouches: 5 })!;
    expect(sr.levels).toEqual([]);
    expect(sr.reasons.join(" ")).toMatch(/ATR approximated/);
    expect(supportResistance([])).toBeUndefined();
  });
});

describe("52-week range", () => {
  it("measures the close against the window's intraday high and low", () => {
    const closes = [100, 120, 80, 110];
    const r = fiftyTwoWeek(fromCloses(closes, 0), { lookback: 4, nearPct: 10 })!;
    expect([r.high, r.low]).toEqual([120, 80]);
    expect(r.pctFromHigh).toBeCloseTo((110 / 120 - 1) * 100, 12);
    expect(r.pctAboveLow).toBeCloseTo(37.5, 12);
    expect(r.nearHigh).toBe(true);
    expect(r.newHigh).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/only 4 of 4|high/);
    expect(fiftyTwoWeek(fromCloses(closes, 0))!.reasons.at(-1)).toMatch(/only 4 of 252 bars/);
  });
});

describe("Minervini trend template", () => {
  const up = fromCloses(Array.from({ length: 300 }, (_, i) => 50 * 1.002 ** i));

  it("passes criteria 1–7 in a steady uptrend; criterion 8 needs an RS rating or a benchmark", () => {
    const t = minerviniTrendTemplate(up)!;
    expect(t.criteria.map((c) => c.pass)).toEqual([true, true, true, true, true, true, true, null]);
    expect(t.passed).toBe(7);
    expect(t.evaluated).toBe(7);
    expect(t.allPass).toBe(false);
    expect(minerviniTrendTemplate(up, { rsRating: 85 })!.allPass).toBe(true);
    expect(minerviniTrendTemplate(up, { rsRating: 60 })!.criteria[7]!.pass).toBe(false);
    const viaBench = minerviniTrendTemplate(up, { benchmark: constantBars(300, 10).map((b, i) => ({ ...b, date: up[i]!.date })) })!;
    expect(viaBench.criteria[7]!.pass).toBe(true);
    expect(viaBench.criteria[7]!.reason).toMatch(/proxy/);
  });

  it("fails a downtrend and marks what it cannot evaluate on a short history", () => {
    const down = fromCloses(Array.from({ length: 300 }, (_, i) => 100 * 0.998 ** i));
    const t = minerviniTrendTemplate(down, { rsRating: 10 })!;
    expect(t.passed).toBe(0);
    const short = minerviniTrendTemplate(up.slice(0, 120))!;
    expect(short.criteria.filter((c) => c.pass === null).map((c) => c.id)).toEqual([1, 2, 3, 4, 6, 7, 8]);
    expect(short.criteria[0]!.reason).toMatch(/needs 200 bars/);
  });
});

describe("VCP", () => {
  // Uptrend to 100, then pullbacks of ~25 %, ~13 %, ~5 % on falling volume.
  const closes = path([
    [0, 50],
    [40, 100],
    [55, 75],
    [70, 98],
    [78, 86],
    [88, 97],
    [92, 92.5],
    [100, 96],
  ]);
  const volumeAt = (i: number) => (i > 40 && i <= 55 ? 3000 : i > 70 && i <= 78 ? 2000 : i > 88 && i <= 92 ? 1000 : 1500);
  const base: Bar[] = fromCloses(closes, 0.3).map((b, i) => ({ ...b, volume: volumeAt(i) }));

  it("detects successively shallower contractions on drying volume, with the pivot at the last high", () => {
    const r = vcp(base)!;
    expect(r.contractions.map((c) => Number(c.depthPct.toFixed(1)))).toEqual([25.5, 12.8, 5.2]);
    expect(r.detected).toBe(true);
    expect(r.status).toBe("forming");
    expect(r.pivotPrice).toBeCloseTo(97.3, 10);
    expect(r.checks.every((c) => c.pass)).toBe(true);
    expect(r.reasons.join("\n")).toMatch(/pivot 97\.3/);
  });

  it("reports a breakout when price closes above the pivot", () => {
    const more = fromCloses([...closes, 97, 98, 99], 0.3).map((b, i) => ({ ...b, volume: i < base.length ? volumeAt(i) : 4000 }));
    expect(vcp(more)!.status).toBe("breakout");
  });

  it("rejects expanding pullbacks, explaining which check failed", () => {
    const widening = path([
      [0, 50],
      [40, 100],
      [48, 95],
      [60, 99],
      [75, 80],
      [90, 96],
    ]);
    const r = vcp(fromCloses(widening, 0.3))!;
    expect(r.detected).toBe(false);
    expect(r.status).toBe("none");
    expect(r.reasons[0]).toMatch(/^fail/);
  });

  it("counts a pullback still in progress as a provisional contraction", () => {
    // the swing high at bar 88 is confirmed at 91; the low at 92 is not confirmed until 95
    const forming = vcp(base.slice(0, 94))!;
    expect(forming.contractions.at(-1)!.provisional).toBe(true);
    expect(forming.contractions.at(-1)!.highIndex).toBe(88);
    // before bar 91 the high at 88 is not known at all
    expect(vcp(base.slice(0, 91))!.contractions.map((c) => c.highIndex)).not.toContain(88);
  });
});

describe("Darvas boxes", () => {
  it("confirms the top and bottom after 3 bars each and ends the box on a breakout close", () => {
    const closes = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 49, 48, 47, 47.5, 48, 48.5, 49, 50, 51];
    const boxes = darvasBoxes(fromCloses(closes, 0.5));
    expect(boxes).toHaveLength(1);
    const b = boxes[0]!;
    expect([b.top, b.topIndex, b.bottom, b.bottomIndex, b.confirmedIndex]).toEqual([50.5, 10, 46.5, 13, 16]);
    expect([b.end, b.endIndex]).toEqual(["breakout", 19]);
    expect(b.reasons.join(" ")).toMatch(/breakout/);
    const open = darvasBoxes(fromCloses(closes.slice(0, 18), 0.5));
    expect(open[0]!.end).toBe("open");
  });

  it("restarts the top when a new high comes before the bottom is confirmed", () => {
    const closes = [40, 45, 50, 49, 48, 47, 51, 50, 49, 48, 48.5, 49, 49.5];
    const boxes = darvasBoxes(fromCloses(closes, 0.5));
    expect(boxes[0]!.topIndex).toBe(6);
  });
});

describe("gaps", () => {
  it("finds window gaps, sizes them in % and ATR, and tracks the fill", () => {
    const bars = [...randomWalk(20, 4).map((b) => ({ ...b, open: 100, high: 101, low: 99, close: 100 }))];
    bars.push(bar(day(20), 103, 104, 102.5, 103.5)); // up gap 101 → 102.5
    bars.push(bar(day(21), 103, 103.6, 102.8, 103));
    bars.push(bar(day(22), 102, 103, 100.8, 101)); // fills (low ≤ 101)
    bars.push(bar(day(23), 97, 98, 96, 97)); // down gap 100.8 → 98
    const g = gaps(bars);
    expect(g.map((x) => [x.direction, x.index, x.size])).toEqual([
      ["up", 20, 1.5],
      ["down", 23, 100.8 - 98],
    ]);
    expect(g[0]!.sizeAtr).toBeCloseTo(1.5 / 2, 10); // ATR of identical 2-point bars = 2
    expect([g[0]!.filled, g[0]!.filledIndex]).toEqual([true, 22]);
    expect(g[1]!.filled).toBe(false);
    expect(gaps(bars, { minSizeAtr: 1 }).map((x) => x.index)).toEqual([23]);
    expect(gaps(bars, { at: 21 })[0]!.filled).toBe(false); // status as of bar 21
  });
});

describe("breakouts", () => {
  it("flags closes above the prior N-day high, confirming with volume", () => {
    const flat = constantBars(25, 100).map((b) => ({ ...b, high: 100.5, low: 99.5 }));
    const bars = [...flat, bar(day(25), 100, 102.5, 100, 102, 2000), bar(day(26), 102, 103.5, 102, 103, 1000)];
    const b = breakouts(bars, { lookback: 20, volumeLookback: 20, volumeMultiple: 1.5 });
    expect(b.map((x) => [x.index, x.volumeConfirmed, x.fresh])).toEqual([
      [25, true, true],
      [26, false, false],
    ]);
    expect(b[0]!.priorHigh).toBe(100.5);
    expect(b[0]!.volumeRatio).toBe(2);
    expect(b[1]!.priorHigh).toBe(102.5);
    expect(b[0]!.reasons[1]).toMatch(/2\.00× its 20-bar average/);
    const noAvg = breakouts(bars, { lookback: 20, volumeLookback: 50 });
    expect(noAvg[0]!.volumeConfirmed).toBe(false);
    expect(noAvg[0]!.reasons[1]).toMatch(/unconfirmed/);
  });
});

describe("every detector answers 'as of bar k' from bars 0…k only", () => {
  const rw = randomWalk(420, 19);
  for (const k of [30, 150, 300, 419]) {
    it(`at = ${k} equals running on the prefix`, () => {
      const pre = rw.slice(0, k + 1);
      expect(supportResistance(rw, { at: k })).toEqual(supportResistance(pre));
      expect(fiftyTwoWeek(rw, { at: k })).toEqual(fiftyTwoWeek(pre));
      expect(minerviniTrendTemplate(rw, { at: k, benchmark: rw })).toEqual(minerviniTrendTemplate(pre, { benchmark: rw }));
      expect(vcp(rw, { at: k })).toEqual(vcp(pre));
      expect(darvasBoxes(rw, { at: k })).toEqual(darvasBoxes(pre));
      expect(gaps(rw, { at: k })).toEqual(gaps(pre));
      expect(breakouts(rw, { at: k })).toEqual(breakouts(pre));
      // and events the prefix knows are the full series' events (bar-level facts do not change)
      const full = breakouts(rw);
      expect(breakouts(pre)).toEqual(full.filter((x) => x.index <= k));
      const boxes = darvasBoxes(rw).filter((b) => b.confirmedIndex <= k);
      expect(darvasBoxes(pre).map((b) => [b.top, b.bottom, b.confirmedIndex])).toEqual(boxes.map((b) => [b.top, b.bottom, b.confirmedIndex]));
    });
  }
});
