import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fillGaps, growthOf, periodsFromCrible, periodsFromFilingEvidence } from "../src/analytics/statements.js";
import { bullishScore, defaultBenchmark, parseIndicatorSpec, technicalsRun } from "../src/analyze/technicals.js";
import { computeValuation } from "../src/analyze/valuation.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { setNetMode } from "../src/core/net.js";
import { FIXTURES } from "./helpers/fixtures.js";
import { fromCloses, ramp } from "./helpers/series.js";

afterEach(() => setNetMode({ kind: "live" }));
const base = { source: "sec-edgar", fetchedAt: "2026-10-01T00:00:00Z", official: true };

describe("technicals", () => {
  it("scores an uptrend above a downtrend, with reasons", () => {
    const up = bullishScore(ramp(120, 0.5))!;
    const down = bullishScore(fromCloses(Array.from({ length: 120 }, (_, i) => 200 - i)))!;
    expect(up.score).toBeGreaterThan(down.score);
    expect(up.components.every((c) => c.reason.length > 0)).toBe(true);
    expect(bullishScore(ramp(30))).toBeUndefined();
  });
  it("parses indicator specs and picks benchmarks", () => {
    expect(parseIndicatorSpec("rsi:period=7;source=hl2")).toEqual({ name: "rsi", params: { period: 7, source: "hl2" } });
    expect(parseIndicatorSpec("kama")).toEqual({ name: "kama", params: {} });
    expect(() => parseIndicatorSpec("rsi:period")).toThrow(/key=value/);
    expect(defaultBenchmark("us")).toBe("SPY");
    expect(defaultBenchmark("euronext", "XPAR")).toBe("FR0003500008");
    expect(defaultBenchmark("crypto")).toBeUndefined();
  });
  it("runs the panel on a recorded Euronext fixture", async () => {
    setNetMode({ kind: "fixture", dir: join(FIXTURES, "mc-pa") });
    const dir = mkdtempSync(join(tmpdir(), "us-ta-"));
    const r = await technicalsRun("MC.PA", dir);
    expect(r.evidence).toBeGreaterThan(40);
    const keys = EvidenceStore.load(dir)!.items.map((i) => i.key);
    for (const k of ["MC.PA.ta.rsi.14.value", "MC.PA.ta.adx.14.adx", "MC.PA.ta.trendTemplate.passed", "MC.PA.ta.bullishScore"]) expect(keys).toContain(k);
    expect(r.notes.join(" ")).toMatch(/benchmark/);
    expect(readFileSync(join(dir, "TECHNICALS.md"), "utf8")).toMatch(/\[E1\]/);
  });
});

describe("statements", () => {
  const store = () => {
    const s = EvidenceStore.open(mkdtempSync(join(tmpdir(), "us-st-")));
    const add = (metric: string, year: number, value: number) =>
      s.add({ ...base, key: `T.fund.${metric}.FY${year}`, label: metric, value, asOf: `${year}-12-31` });
    for (const [y, f] of [
      [2025, 1.1],
      [2024, 1],
      [2023, 0.9],
      [2022, 0.8],
    ] as const) {
      add("revenue", y, 1000 * f);
      add("netIncome", y, 100 * f);
      add("operatingCashFlow", y, 150 * f);
      add("capex", y, 40 * f);
      add("assets", y, 1000);
      add("liabilities", y, 500);
      add("equity", y, 500);
      add("cash", y, 100);
      add("debt", y, 200);
    }
    s.add({ ...base, key: "T.fund.sharesOutstanding.latest", label: "shares", value: 100 });
    return s;
  };
  it("maps filing evidence to periods, newest first, with the evidence id of each field", () => {
    const s = store();
    const p = periodsFromFilingEvidence(s.items, "T");
    expect(p.map((x) => x.period.end)).toEqual(["2025-12-31", "2024-12-31", "2023-12-31", "2022-12-31"]);
    expect(p[0]!.period.sharesOutstanding).toBe(100);
    expect(s.get(p[0]!.ids.revenue!)!.value).toBe(1100);
    expect(growthOf(p, "revenue", 3)).toBeCloseTo((1.1 / 0.8) ** (1 / 3) - 1, 10);
  });
  it("fills gaps from crible and prefers its newer years", () => {
    const filings = periodsFromFilingEvidence(store().items, "T");
    let n = 0;
    const crible = periodsFromCrible(
      [
        { period: "2026-12-31", revenue: 1300, current_assets: 9 },
        { period: "2025-12-31", revenue: 999, current_assets: 400, current_liabilities: 200 },
      ],
      () => `C${++n}`,
    );
    const merged = fillGaps(filings, crible);
    expect(merged[0]!.period.end).toBe("2026-12-31");
    expect(merged[1]!.period.revenue).toBe(1100); // the filing wins where it reports
    expect(merged[1]!.period.currentAssets).toBe(400);
    expect(merged[1]!.filled).toEqual(["currentAssets", "currentLiabilities"]);
  });
  it("computes a valuation whose every output is derived evidence", () => {
    const s = store();
    const periods = periodsFromFilingEvidence(s.items, "T");
    const priceId = s.add({ ...base, source: "nasdaq", official: false, key: "T.quote.price", label: "price", value: 12, unit: "USD" });
    const notes: string[] = [];
    const out = computeValuation(s, { sym: "T", ccy: "USD", price: 12, priceId, periods, rf: 0.04, beta: 1, erp: 0.05, g: 0.02, years: 5, notes });
    expect(out.fairValue).toBeGreaterThan(0);
    expect(out.impliedGrowth).toBeDefined();
    const dcfItem = s.byKey("T.dcf.expected")!;
    expect(dcfItem.source).toBe("ultrastock");
    expect(dcfItem.derivedFrom!.length).toBeGreaterThan(2);
    expect(s.byKey("T.coe")!.value).toBeCloseTo(9, 10);
    expect(s.byKey("T.mult.pe")!.value).toBeCloseTo(12 / (110 / 100), 8);
    expect(s.byKey("T.quality.fcf")!.value).toBeCloseTo(165 - 44, 8);
  });
});
