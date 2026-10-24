import { afterEach, describe, expect, it, vi } from "vitest";
import { sma } from "../src/analytics/indicators.js";
import { benchmarkFor, closedBars, constituentSymbol } from "../src/analyze/screen/builtin.js";
import { cribleRowsToDataset, dslFields, looksLikePresetId } from "../src/analyze/screen/crible.js";
import { BUILTIN_PRESETS, describeFilter, TV_COLUMNS, TV_PRESETS, tvPresetRules } from "../src/analyze/screen/presets.js";
import { applyUniverseRanks, percentileRanks, TECHNICAL_IDS, technicalVerdict } from "../src/analyze/screen/technical.js";
import {
  dedupeByIsin,
  eurValue,
  magicFormulaRank,
  parseSort,
  ratesFromEcb,
  scanMatches,
  scannerMarkets,
  sortMatches,
} from "../src/analyze/screen/tradingview.js";
import { screenCommand } from "../src/commands/screen.js";
import type { Dataset } from "../src/core/datasets.js";
import { UsageError } from "../src/engine.js";
import { setNetMode } from "../src/core/net.js";
import { type TvRow, tvRowPoints } from "../src/providers/markets/tradingview.js";
import type { Bar } from "../src/providers/types.js";
import { withFixture } from "./helpers/fixtures.js";
import { day, fromCloses, ramp, randomWalk } from "./helpers/series.js";

afterEach(() => {
  setNetMode({ kind: "live" });
  vi.restoreAllMocks();
});

/** Run `screen` in-process: stdout, or the error it threw. */
async function screen(positional: string[], values: Record<string, string> = {}, bools: string[] = [], asJson = false) {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => ((out += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await screenCommand({ command: "screen", positional, values, bools: new Set(bools) }, asJson);
    return { out };
  } catch (e) {
    return { out, error: e as Error };
  } finally {
    vi.restoreAllMocks();
  }
}

const tvDataset = (columns: string[], rows: TvRow[], market = "france"): Dataset => ({
  kind: "screener",
  title: "t",
  points: [{ key: `TV.${market}.scan.matches`, label: "m", value: rows.length }, ...rows.flatMap((r) => tvRowPoints(r, columns, "2026-10-23"))],
  provenance: { source: "tradingview", fetchedAt: "2026-10-23T10:00:00Z", official: false },
  notes: [],
});

describe("screen presets", () => {
  it("every TradingView preset filters and shows only verified columns, with rules and a source", () => {
    for (const p of TV_PRESETS) {
      for (const f of p.filter) expect(TV_COLUMNS[f.left], `${p.id}: ${f.left}`).toBeDefined();
      for (const c of [...p.columns, p.sort.sortBy]) expect(TV_COLUMNS[c], `${p.id}: ${c}`).toBeDefined();
      expect(tvPresetRules(p).length).toBeGreaterThanOrEqual(p.filter.length);
      expect(p.source.length).toBeGreaterThan(20);
    }
    expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual([...TECHNICAL_IDS]);
  });
  it("prints filters in plain words", () => {
    expect(describeFilter({ left: "price_earnings_ttm", operation: "less", right: 15 })).toBe("P/E (trailing 12 months) < 15");
    expect(describeFilter({ left: "close", operation: "greater", right: "SMA50" })).toBe("last price > 50-day simple moving average");
    expect(describeFilter({ left: "RSI", operation: "in_range", right: [50, 70] })).toBe("RSI(14) between 50 and 70");
    expect(describeFilter({ left: "dividends_yield_current", operation: "greater", right: 3 })).toBe("dividend yield (current) > 3 %");
    expect(describeFilter({ left: "close", operation: "above%", right: ["price_52_week_high", 0.98] })).toMatch(/within 2 % of it/);
    expect(describeFilter({ left: "sector", operation: "not_in_range", right: ["Finance", "Utilities"] })).toBe("sector not Finance or Utilities");
  });
});

describe("tradingview screen helpers", () => {
  const cols = ["description", "close", "currency", "enterprise_value_to_ebit_ttm", "return_on_invested_capital", "market_cap_basic", "isin"];
  const rows: TvRow[] = [
    { s: "EURONEXT:A", d: ["Alpha", 10, "EUR", 10, 10, 5e9, "FR0000000001"] },
    { s: "EURONEXT:B", d: ["Beta", 20, "EUR", 5, 30, 2e9, "FR0000000002"] },
    { s: "XETR:C", d: ["Gamma", 30, "EUR", 20, 20, 9e9, "FR0000000001"] },
  ];
  const matches = scanMatches(tvDataset(cols, rows), "france");
  it("rebuilds rows from a scan dataset and sorts, nulls last", () => {
    expect(matches.map((m) => m.ticker)).toEqual(["EURONEXT:A", "EURONEXT:B", "XETR:C"]);
    expect(matches[0]!.points.get("description")!.untrusted).toBe(true);
    expect(sortMatches(matches, "market_cap_basic", "desc").map((m) => m.ticker)).toEqual(["XETR:C", "EURONEXT:A", "EURONEXT:B"]);
    expect(sortMatches(matches, "nope", "asc")).toHaveLength(3);
    expect(dedupeByIsin(matches).map((m) => m.ticker)).toEqual(["EURONEXT:A", "EURONEXT:B"]);
  });
  it("ranks the magic formula: earnings-yield rank + return-on-capital rank", () => {
    const ranked = magicFormulaRank(matches);
    // EY = 10 %, 20 %, 5 % → ranks 2, 1, 3; ROIC 10, 30, 20 → ranks 3, 1, 2; combined 5, 2, 5
    expect(ranked.map((m) => m.ticker)).toEqual(["EURONEXT:B", "EURONEXT:A", "XETR:C"]);
    const b = ranked[0]!.derived;
    expect(b.find((p) => p.key.endsWith(".earningsYield"))).toMatchObject({ value: 20, unit: "%", formula: "100 / enterprise_value_to_ebit_ttm" });
    expect(b.find((p) => p.key.endsWith(".combinedRank"))!.value).toBe(2);
  });
  it("converts a money column to euros at ECB rates", () => {
    const sek = scanMatches(tvDataset(["close", "currency", "market_cap_basic"], [{ s: "OMXSTO:X", d: [100, "SEK", 1.1e12] }]), "sweden")[0]!;
    const rates = ratesFromEcb({
      kind: "fx",
      title: "fx",
      points: [
        { key: "EUR.fx.SEK", label: "SEK per EUR", value: 11, asOf: "2026-10-23" },
        { key: "EUR.fx.SEK.chg", label: "chg", value: 0.1 },
      ],
      provenance: { source: "ecb", fetchedAt: "2026-10-23T15:00:00Z", official: true },
      notes: [],
    });
    expect(rates.get("SEK")).toEqual({ rate: 11, date: "2026-10-23" });
    expect(eurValue(sek, "market_cap_basic", rates)).toBeCloseTo(1e11);
    expect(eurValue(sek, "close", new Map())).toBeUndefined();
  });
  it("parses --sort and --market", () => {
    expect(parseSort("-aum", { sortBy: "x", sortOrder: "asc" })).toEqual({ sortBy: "aum", sortOrder: "desc" });
    expect(parseSort(undefined, { sortBy: "x", sortOrder: "asc" })).toEqual({ sortBy: "x", sortOrder: "asc" });
    expect(() => parseSort("a;b", { sortBy: "x", sortOrder: "asc" })).toThrow(/column name/);
    expect(scannerMarkets("europe")).toContain("germany");
    expect(scannerMarkets("crypto")).toEqual(["coin"]);
    expect(() => scannerMarkets("../x")).toThrow(/scanner market/);
  });
});

describe("crible screen mapping", () => {
  it("finds the fields a DSL filters on", () => {
    expect(dslFields("piotroski_f >= 7 AND country IN ('FR','DE') OR NOT altman_z < 1.8")).toEqual(["piotroski_f", "country", "altman_z"]);
    expect(looksLikePresetId("piotroski-strong")).toBe(true);
    expect(looksLikePresetId("piotroski_f >= 7")).toBe(false);
  });
  it("maps a synthetic row: identity untrusted, units, full-date asOf only", () => {
    const ds = cribleRowsToDataset(
      {
        total: 2,
        rows: [
          {
            symbol: "MC.PA",
            name: "LVMH",
            country: "FR",
            sector: "Consumer",
            currency: "EUR",
            period: "2025-12-31",
            piotroski_f: 8,
            market_cap: 3e11,
            return_on_equity: 0.2,
            junk: 1,
          },
          { symbol: "X.L", name: "X plc", country: "GB", currency: "GBP", period: "2025", price_asof: "2026-10-22", piotroski_f: 7, market_cap: null },
        ],
      },
      { query: "piotroski_f >= 7", fetchedAt: "2026-10-24T08:00:00Z" },
    );
    const at = (k: string) => ds.points.find((p) => p.key === k);
    expect(at("CRIBLE.screen.matches")!.value).toBe(2);
    expect(at("CRIBLE.screen.query")).toMatchObject({ value: "piotroski_f >= 7", untrusted: true });
    expect(at("MC.PA.crible.name")!.untrusted).toBe(true);
    expect(at("MC.PA.crible.country")!.untrusted).toBeUndefined();
    expect(at("MC.PA.crible.piotroski_f")).toMatchObject({ value: 8, unit: "score", asOf: "2025-12-31" });
    expect(at("MC.PA.crible.market_cap")).toMatchObject({ value: 3e11, unit: "EUR" });
    expect(at("MC.PA.crible.junk")).toBeUndefined();
    expect(at("X.L.crible.rank")).toMatchObject({ value: 2, asOf: "2026-10-22" });
    expect(at("X.L.crible.market_cap")).toBeUndefined();
    expect(ds.provenance).toMatchObject({ source: "crible", official: false, asOf: "2026-10-22" });
    expect(ds.notes.join(" ")).not.toMatch(/LVMH/);
  });
});

describe("builtin technical screens", () => {
  const flat = (n: number, price = 100) => fromCloses(Array.from({ length: n }, () => price));
  it("percentiles within the universe", () => {
    expect(percentileRanks([1, 2, 3, undefined])).toEqual([0, 50, 100, undefined]);
    expect(percentileRanks([5])).toEqual([100]);
  });
  it("momentum burst: +4 % on rising, above-average volume, no run-up before", () => {
    const bars = flat(30);
    bars.push({ date: day(30), open: 100, high: 106, low: 99.5, close: 105, volume: 3000 });
    const v = technicalVerdict("momentum-burst", bars);
    expect(v.pass).toBe(true);
    expect(v.metrics.find((m) => m.name === "dayGain")!.value).toBeCloseTo(5);
    const runup = fromCloses([...Array.from({ length: 27 }, () => 100), 104, 108, 112]);
    runup.push({ date: day(30), open: 112, high: 117, low: 112, close: 117, volume: 3000 });
    const w = technicalVerdict("momentum-burst", runup);
    expect(w.pass).toBe(false);
    expect(w.reasons.find((r) => r.startsWith("fail"))).toMatch(/3 sessions before/);
    expect(technicalVerdict("momentum-burst", flat(5)).pass).toBeNull();
  });
  it("exhaustion hammer after a 10-session pullback", () => {
    const bars = fromCloses(Array.from({ length: 15 }, (_, i) => 120 - i * 1.5));
    const prev = bars[bars.length - 1]!;
    bars.push({ date: day(15), open: prev.close - 0.4, high: prev.close, low: prev.close - 6, close: prev.close - 0.2, volume: 1000 });
    expect(technicalVerdict("exhaustion-hammer", bars).pass).toBe(true);
    const up = fromCloses(Array.from({ length: 15 }, (_, i) => 100 + i));
    const p2 = up[up.length - 1]!;
    up.push({ date: day(15), open: p2.close + 0.2, high: p2.close + 1, low: p2.close - 5, close: p2.close + 0.4, volume: 1000 });
    expect(technicalVerdict("exhaustion-hammer", up).reasons.some((r) => r.startsWith("fail") && /pullback|decline/.test(r))).toBe(true);
  });
  it("golden cross within the last 10 sessions only", () => {
    const closes = [...Array.from({ length: 230 }, (_, i) => 200 - i * 0.4), ...Array.from({ length: 120 }, (_, i) => 108 + i * 1.5)];
    const s50 = sma(closes, 50);
    const s200 = sma(closes, 200);
    const cross = s50.findIndex((v, i) => i > 200 && v! > s200[i]! && s50[i - 1]! <= s200[i - 1]!);
    expect(cross).toBeGreaterThan(230);
    const bars = fromCloses(closes);
    const fresh = technicalVerdict("golden-cross", bars.slice(0, cross + 4));
    expect(fresh.pass).toBe(true);
    expect(fresh.metrics.find((m) => m.name === "crossDate")!.value).toBe(day(cross));
    expect(technicalVerdict("golden-cross", bars.slice(0, cross + 15)).pass).toBe(false);
    expect(technicalVerdict("golden-cross", bars.slice(0, 150)).pass).toBeNull();
  });
  it("pullback to the 50-day: every pass sits within 2 % of SMA50 with RSI 40–50", () => {
    const closes = Array.from({ length: 420 }, (_, i) => 100 + 0.25 * i + 6 * Math.sin(i / 6));
    const bars = fromCloses(closes);
    let passes = 0;
    for (let k = 210; k < 420; k++) {
      const v = technicalVerdict("pullback-to-50", bars.slice(0, k));
      if (!v.pass) continue;
      passes++;
      expect(Math.abs(v.metrics.find((m) => m.name === "vsSma50")!.value as number)).toBeLessThanOrEqual(2);
      const r = v.metrics.find((m) => m.name === "rsi14")!.value as number;
      expect(r).toBeGreaterThanOrEqual(40);
      expect(r).toBeLessThanOrEqual(50);
    }
    expect(passes).toBeGreaterThan(0);
  });
  it("minervini: a steady uptrend beating a flat benchmark passes all 8; no benchmark leaves criterion 8 open", () => {
    const up = ramp(300);
    const bench = flat(300);
    const v = technicalVerdict("minervini", up, { benchmark: bench });
    expect(v.pass).toBe(true);
    expect(v.metrics.find((m) => m.name === "criteriaPassed")!.value).toBe(8);
    expect(technicalVerdict("minervini", up).pass).toBeNull();
    const down = fromCloses(Array.from({ length: 300 }, (_, i) => 400 - i));
    expect(technicalVerdict("minervini", down, { benchmark: bench }).pass).toBe(false);
  });
  it("CAN SLIM N + L and RS leaders rank across the universe", () => {
    const bench = flat(300);
    const strong = ramp(300, 2);
    const weak = ramp(300, 0.2).map((b) => ({ ...b, close: b.close, high: b.high }));
    const verdicts = applyUniverseRanks([strong, weak].map((b) => technicalVerdict("canslim-technical", b, { benchmark: bench })));
    expect(verdicts.map((v) => v.pass)).toEqual([true, false]);
    expect(verdicts[0]!.metrics.find((m) => m.name === "percentile")!.value).toBe(100);
    const walks: Bar[][] = [0.002, 0.001, 0, -0.001, -0.002].map((drift, i) =>
      randomWalk(200, i + 1).map((b, j) => ({ ...b, close: b.close * (1 + drift) ** j, high: b.high * (1 + drift) ** j, low: b.low * (1 + drift) ** j })),
    );
    const rs = applyUniverseRanks(walks.map((b) => technicalVerdict("rs-leaders", b, { benchmark: flat(200) })));
    expect(rs.filter((v) => v.pass).length).toBe(1);
    expect(rs.every((v) => v.reasons.some((r) => /percentile/.test(r)))).toBe(true);
    expect(technicalVerdict("rs-leaders", ramp(300)).pass).toBeNull();
  });
  it("VCP returns a verdict with its status", () => {
    const v = technicalVerdict("vcp", randomWalk(300, 7));
    expect(typeof v.pass).toBe("boolean");
    expect(v.metrics.find((m) => m.name === "status")).toBeDefined();
  });
  it("closed bars, benchmarks and constituent symbols", () => {
    expect(closedBars(fromCloses([1, 2, 3]), day(2)).map((b) => b.date)).toEqual([day(0), day(1)]);
    expect(benchmarkFor("SPX", []).symbol).toBe("SPY");
    expect(benchmarkFor(undefined, ["AAPL", "BRK.B"]).symbol).toBe("SPY");
    expect(benchmarkFor("CAC40", []).symbol).toBe("FR0003500008");
    expect(benchmarkFor(undefined, ["MC.PA", "AI.PA"]).symbol).toBe("FR0003500008");
    expect(benchmarkFor("DAX", []).symbol).toBe("CW8.PA");
    expect(benchmarkFor(undefined, ["SAP.DE", "AAPL"]).symbol).toBe("CW8.PA");
    expect(constituentSymbol("UKX", { ticker: "BT.A", name: "BT" })).toBe("BT-A.L");
    expect(constituentSymbol("DAX", { ticker: "ads.de", name: "Adidas" })).toBe("ADS.DE");
  });
});

describe("screen command", () => {
  it("lists every preset with its engine, rules and source", async () => {
    const { out } = await screen([], {}, ["list"]);
    for (const p of [...TV_PRESETS, ...BUILTIN_PRESETS]) expect(out).toContain(`- ${p.id} — `);
    expect(out).toMatch(/engine crible/);
    expect(out.match(/ {4}source: /g)!.length).toBe(TV_PRESETS.length + BUILTIN_PRESETS.length);
    expect(out).toMatch(/approximated: .*return on invested capital/);
    const json = JSON.parse((await screen([], { engine: "builtin" }, ["list"], true)).out);
    expect(json.tradingview).toBeUndefined();
    expect(json.builtin).toHaveLength(BUILTIN_PRESETS.length);
  });
  it("refuses bad invocations with usage errors", async () => {
    expect((await screen([])).error).toBeInstanceOf(UsageError);
    expect((await screen(["nonsense"])).error?.message).toMatch(/screen --list/);
    expect((await screen(["value"], { universe: "SPX" })).error?.message).toMatch(/--universe is for --engine builtin/);
    expect((await screen(["minervini"])).error?.message).toMatch(/needs --universe/);
    expect((await screen(["minervini"], { universe: "SPX", market: "france" })).error?.message).toMatch(/--market is for/);
    expect((await screen(["value"], {}, ["bootstrap"])).error?.message).toMatch(/--engine crible/);
    expect((await screen(["value"], { engine: "nope" })).error?.message).toMatch(/--engine is/);
    expect((await screen(["momentum"], { engine: "builtin", universe: "AAPL" })).error?.message).toMatch(/no builtin preset/);
  });
  it("replays a TradingView value screen on one market", async () => {
    const { out, error } = await withFixture("screen-tv-value-fr", () => screen(["value"], { market: "france", limit: "3" }, [], true));
    expect(error).toBeUndefined();
    const ds = JSON.parse(out).datasets as Dataset[];
    expect(ds).toHaveLength(1);
    const pts = ds[0]!.points;
    expect(pts[0]!.key).toBe("TV.france.screen.value.matches");
    const pe = pts.filter((p) => p.key.endsWith(".tv.price_earnings_ttm"));
    expect(pe.length).toBeGreaterThan(0);
    expect(pe.length).toBeLessThanOrEqual(3);
    for (const p of pe) expect(p.value as number).toBeLessThan(15);
    const values = pe.map((p) => p.value as number);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(pts.filter((p) => p.key.endsWith(".tv.description")).every((p) => p.untrusted)).toBe(true);
    expect(ds[0]!.provenance).toMatchObject({ source: "tradingview", official: false });
  }, 120_000);
  it("replays PEA candidates across Europe: merged, sorted in euros, ETF hints labelled", async () => {
    const { out, error } = await withFixture("screen-tv-pea-europe", () => screen(["pea-candidates"], { limit: "3" }, [], true));
    expect(error).toBeUndefined();
    const ds = JSON.parse(out).datasets as Dataset[];
    const main = ds[0]!;
    expect(main.notes.join(" ")).toMatch(/PEA eligibility must be confirmed with the broker/);
    expect(main.points.filter((p) => p.key.endsWith(".kind")).some((p) => /hint only/.test(String(p.value)))).toBe(true);
    const caps = main.points.filter((p) => p.key.endsWith(".tv.market_cap_basic"));
    expect(caps).toHaveLength(3);
    if (ds[1]) {
      expect(ds[1].provenance.source).toBe("ecb");
      expect(main.notes.join(" ")).toMatch(/compared in euros at ECB reference rates/);
    }
  }, 120_000);
  it("replays a builtin Minervini screen on two US symbols", async () => {
    const { out, error } = await withFixture("screen-builtin-minervini-us", () => screen(["minervini"], { universe: "AAPL,KO" }, [], true));
    expect(error).toBeUndefined();
    const ds = JSON.parse(out).datasets as Dataset[];
    const pts = ds.flatMap((d) => d.points);
    for (const s of ["AAPL", "KO"]) {
      expect(pts.find((p) => p.key === `${s}.screen.minervini.pass`)).toBeDefined();
      expect(pts.find((p) => p.key === `${s}.screen.minervini.reason`)!.value).toMatch(/criteri|\(\d\)/);
    }
    expect(ds[0]!.notes.join(" ")).toMatch(/benchmark SPY/);
  }, 120_000);
  it.skipIf(!process.env.ULTRASTOCK_CRIBLE_DATA_DIR)(
    "runs a crible preset (needs a bootstrapped ULTRASTOCK_CRIBLE_DATA_DIR)",
    async () => {
      const { out, error } = await screen(["quality"], { engine: "crible", limit: "2" }, [], true);
      expect(error).toBeUndefined();
      const ds = JSON.parse(out).datasets as Dataset[];
      expect(ds[0]!.points.find((p) => p.key === "CRIBLE.screen.query")!.value).toMatch(/return_on_equity/);
    },
    180_000,
  );
});
