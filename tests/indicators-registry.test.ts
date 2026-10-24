import { describe, expect, it } from "vitest";
import { computeIndicator, indicatorField, type IndicatorParams, listIndicators } from "../src/analytics/indicators/index.js";
import { randomWalk } from "./helpers/series.js";

// 800 bars: Pring's Special K, the longest warm-up, first prints at bar 733.
const N = 800;
const BARS = randomWalk(N, 7);
const BENCH = randomWalk(N, 99, 3000);
const CUTS = [3, 20, 40, 60, 90, 130, 200, 260, 400, 560, 733, 760, 799];

const paramsFor = (name: string): IndicatorParams => (name === "relativeStrength" || name === "mansfieldRs" ? { benchmark: BENCH } : {});

describe("indicator registry", () => {
  const all = listIndicators();

  it("lists every indicator once, with defaults for every non-series parameter", () => {
    const names = all.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(90);
    for (const d of all) {
      expect(d.outputs.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(3);
      for (const p of d.params) if (p.kind !== "bars") expect(p.default, `${d.name}.${p.name}`).toBeDefined();
    }
    // the groups the brief asks for are all populated
    for (const g of ["averages", "trend", "momentum", "volatility", "bands", "volume", "stats", "candles"]) expect(all.some((d) => d.group === g)).toBe(true);
  });

  it("listIndicators returns copies the caller cannot corrupt", () => {
    const first = listIndicators();
    first[0]!.params.length = 0;
    first[0]!.outputs.push("bogus");
    const again = listIndicators();
    expect(again[0]!.outputs).not.toContain("bogus");
  });

  describe.each(all.map((d) => [d.name, d] as const))("%s", (name, info) => {
    const full = computeIndicator(name, BARS, paramsFor(name));

    it("is aligned with the input, rows carry exactly the declared outputs, and it is defined by the last bar", () => {
      expect(full.values).toHaveLength(N);
      expect(full.outputs).toEqual(info.outputs);
      const last = full.values[N - 1];
      expect(last, `${name} undefined at the last bar`).toBeDefined();
      for (const row of full.values) {
        if (!row) continue;
        expect(Object.keys(row).sort()).toEqual([...info.outputs].sort());
        for (const v of Object.values(row)) expect(Number.isFinite(v)).toBe(true);
      }
    });

    it("has a contiguous undefined prefix (once defined, stays defined on a random walk)", () => {
      const s = full.values.findIndex((x) => x !== undefined);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(full.values.slice(s).every((x) => x !== undefined)).toBe(true);
    });

    it("never looks ahead: the value at k computed on bars[0..k] equals the full-series value at k", () => {
      for (const k of CUTS) {
        const part = computeIndicator(name, BARS.slice(0, k + 1), paramsFor(name));
        expect(part.values[k], `${name} at ${k}`).toEqual(full.values[k]);
      }
    });
  });

  it("fills defaults, coerces numeric strings and reports the parameters used", () => {
    const r = computeIndicator("rsi", BARS, { period: "10" as unknown as number });
    expect(r.params).toEqual({ period: 10, source: "close" });
    expect(indicatorField(r)).toEqual(indicatorField(computeIndicator("rsi", BARS, { period: 10 })));
    const m = computeIndicator("mansfieldRs", BARS, { benchmark: BENCH });
    expect(m.params).toEqual({ benchmark: N, period: 252 });
  });

  it("rejects unknown names, unknown or invalid parameters and a missing benchmark", () => {
    expect(() => computeIndicator("nope", BARS)).toThrow(/Unknown indicator "nope"/);
    expect(() => computeIndicator("rsi", BARS, { length: 3 })).toThrow(/unknown parameter "length"/);
    expect(() => computeIndicator("rsi", BARS, { period: 2.5 })).toThrow(/integer/);
    expect(() => computeIndicator("rsi", BARS, { period: 0 })).toThrow(/≥ 1/);
    expect(() => computeIndicator("rsi", BARS, { period: Number.NaN })).toThrow(/finite/);
    expect(() => computeIndicator("sma", BARS, { source: "vwap" })).toThrow(/one of/);
    expect(() => computeIndicator("movingAverage", BARS, { type: 3 as unknown as string })).toThrow(/string/);
    expect(() => computeIndicator("relativeStrength", BARS)).toThrow(/required/);
    expect(() => computeIndicator("relativeStrength", BARS, { benchmark: "SPY" })).toThrow(/array of bars/);
    expect(() => indicatorField(computeIndicator("macd", BARS), "hist")).toThrow(/no output "hist"/);
  });

  it("price sources select the series an indicator reads", () => {
    const hl2 = indicatorField(computeIndicator("sma", BARS, { period: 1, source: "hl2" }));
    expect(hl2[5]).toBeCloseTo((BARS[5]!.high + BARS[5]!.low) / 2, 12);
    const vol = indicatorField(computeIndicator("sma", BARS, { period: 1, source: "volume" }));
    expect(vol[5]).toBe(BARS[5]!.volume);
    for (const source of ["open", "high", "low", "hlc3", "ohlc4"])
      expect(indicatorField(computeIndicator("sma", BARS, { period: 1, source }))[9]).toBeDefined();
  });

  it("works on an empty series and on one bar", () => {
    for (const d of all) {
      const p = paramsFor(d.name);
      expect(computeIndicator(d.name, [], p).values).toEqual([]);
      expect(computeIndicator(d.name, BARS.slice(0, 1), p).values).toHaveLength(1);
    }
  });
});
