import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setNetMode } from "../src/core/net.js";
import { parseBls, yoyFromIndex } from "../src/providers/macro/bls.js";
import { periodEnd, seriesPoints, usSlashDate } from "../src/providers/macro/common.js";
import { ecbFx, ecbPolicyRates, ecbPreset, ecbYieldCurve, parseSdmxCsv } from "../src/providers/macro/ecb.js";
import { eurostatIndicator, parseJsonStat } from "../src/providers/macro/eurostat.js";
import { frankfurterHistory, frankfurterLatest, parseFrankfurterRange } from "../src/providers/macro/frankfurter.js";
import { fredSeries, parseFredCsv, parseFredJson } from "../src/providers/macro/fred.js";
import { inseeSeries, parseInseeSdmx } from "../src/providers/macro/insee.js";
import { parseTreasuryCsv, tenorOf, treasuryCurve, treasuryHistory } from "../src/providers/macro/treasury.js";
import { parseWorldBank, worldBankIndicators } from "../src/providers/macro/worldbank.js";
import { ProviderError } from "../src/providers/types.js";
import { withFixture } from "./helpers/fixtures.js";

afterEach(() => setNetMode({ kind: "live" }));

const byKey = (ds: { points: Array<{ key: string; value: unknown }> }, key: string) => ds.points.find((p) => p.key === key)?.value;

describe("common", () => {
  it("dates and series points", () => {
    expect(usSlashDate("9/3/2026")).toBe("2026-09-03");
    expect(usSlashDate("2026-09-03")).toBeUndefined();
    expect(periodEnd("2026-02")).toBe("2026-02-28");
    expect(periodEnd("2026-Q2")).toBe("2026-06-30");
    const pts = seriesPoints("X.rate", "X rate", "%", [
      { date: "2026-09-01", value: 2.5 },
      { date: "2026-10-01", value: 2.25 },
    ]);
    expect(pts[0]).toMatchObject({ key: "X.rate", value: 2.25, asOf: "2026-10-01" });
    expect(pts[1]).toMatchObject({ key: "X.rate.chg", value: -25, unit: "bp" });
  });
});

describe("US Treasury", () => {
  it("parses the par yield CSV", () => {
    const csv = [
      'Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"',
      "10/23/2026,4.11,4.11,4.16,4.22,4.30,4.30,4.44,4.69,4.75,4.82,4.89,5.00,5.37,5.33",
      "10/22/2026,4.11,4.10,4.16,4.22,4.29,4.29,4.41,4.65,4.72,4.78,4.86,4.96,5.32,",
    ].join("\n");
    const rows = parseTreasuryCsv(csv);
    expect(rows.map((r) => r.date)).toEqual(["2026-10-22", "2026-10-23"]);
    expect(rows[1]!.yields).toMatchObject({ "1M": 4.11, "1.5M": 4.11, "3M": 4.22, "2Y": 4.69, "10Y": 5, "30Y": 5.33 });
    expect(rows[0]!.yields["30Y"]).toBeUndefined();
    expect(tenorOf("Date")).toBeUndefined();
  });
  it("replays the latest curve with its spreads", async () => {
    const [ds, hist] = await withFixture("macro-treasury", async () => [await treasuryCurve(), await treasuryHistory("10Y", 10)] as const);
    expect(ds.provenance).toMatchObject({ source: "us-treasury", official: true });
    const y10 = byKey(ds, "US.rates.ust.10Y") as number;
    const y2 = byKey(ds, "US.rates.ust.2Y") as number;
    expect(y10).toBeGreaterThan(0);
    expect(byKey(ds, "US.rates.ust.spread.2s10s")).toBeCloseTo((y10 - y2) * 100, 6);
    expect(byKey(ds, "US.rates.ust.spread.3m10y")).toBeTypeOf("number");
    expect(hist.points.filter((p) => /\d{4}-\d{2}-\d{2}$/.test(p.key)).length).toBeGreaterThanOrEqual(5);
  }, 60_000);
});

describe("ECB", () => {
  it("parses SDMX csvdata into series", () => {
    const csv = [
      "KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE",
      "FM.B.U2.EUR.4F.KR.DFR.LEV,B,U2,EUR,4F,KR,DFR,LEV,2026-09-16,2.5",
      "FM.B.U2.EUR.4F.KR.DFR.LEV,B,U2,EUR,4F,KR,DFR,LEV,2026-06-17,2.25",
      "FM.B.U2.EUR.4F.KR.MRR_FR.LEV,B,U2,EUR,4F,KR,MRR_FR,LEV,2026-09-16,2.65",
    ].join("\n");
    const s = parseSdmxCsv(csv);
    expect(s.map((x) => x.key)).toEqual(["FM.B.U2.EUR.4F.KR.DFR.LEV", "FM.B.U2.EUR.4F.KR.MRR_FR.LEV"]);
    expect(s[0]!.obs).toEqual([
      { date: "2026-06-17", value: 2.25 },
      { date: "2026-09-16", value: 2.5 },
    ]);
  });
  it("replays policy rates, €STR, HICP, the AAA curve and FX", async () => {
    await withFixture("macro-ecb", async () => {
      const rates = await ecbPolicyRates();
      expect(rates.points.map((p) => p.key)).toEqual(expect.arrayContaining(["EA.rates.dfr", "EA.rates.mro", "EA.rates.mlf"]));
      expect(rates.provenance.official).toBe(true);
      const estr = await ecbPreset("estr", 5);
      expect(byKey(estr, "EA.rates.estr")).toBeTypeOf("number");
      const hicp = await ecbPreset("hicp", 3);
      expect(hicp.points[0]).toMatchObject({ key: "EA.macro.hicp.yoy", unit: "%" });
      expect(hicp.points[0]!.asOf! >= "2026-01").toBe(true);
      const yc = await ecbYieldCurve(["2Y", "10Y"]);
      expect(byKey(yc, "EA.rates.aaa.spread.2s10s")).toBeCloseTo(
        ((byKey(yc, "EA.rates.aaa.10Y") as number) - (byKey(yc, "EA.rates.aaa.2Y") as number)) * 100,
        1,
      );
      const fx = await ecbFx(["USD", "GBP"], 2);
      expect(byKey(fx, "EUR.fx.USD")).toBeGreaterThan(0.5);
    });
  }, 60_000);
});

describe("Eurostat", () => {
  it("parses a sparse JSON-stat cube by dimension", () => {
    const js = {
      id: ["freq", "unit", "geo", "time"],
      size: [1, 1, 2, 3],
      value: { "0": 2.8, "1": 2.9, "3": 2.4, "5": 3.4 },
      dimension: {
        freq: { category: { index: { M: 0 } } },
        unit: { category: { index: { RCH_A: 0 } } },
        geo: { category: { index: { DE: 0, FR: 1 } } },
        time: { category: { index: { "2026-07": 0, "2026-08": 1, "2026-09": 2 } } },
      },
    };
    const s = parseJsonStat(js);
    expect(s.find((x) => x.dims.geo === "DE")!.obs).toEqual([
      { date: "2026-07", value: 2.8 },
      { date: "2026-08", value: 2.9 },
    ]);
    expect(s.find((x) => x.dims.geo === "FR")!.obs).toEqual([
      { date: "2026-07", value: 2.4 },
      { date: "2026-09", value: 3.4 },
    ]);
  });
  it("replays France's HICP, unemployment and GDP", async () => {
    await withFixture("macro-eurostat", async () => {
      const hicp = await eurostatIndicator("hicp", "FR", 3);
      expect(hicp.points[0]).toMatchObject({ key: "FR.macro.hicp.yoy", unit: "%" });
      expect(hicp.provenance).toMatchObject({ source: "eurostat", official: true });
      const une = await eurostatIndicator("unemployment", "FR", 3);
      expect(byKey(une, "FR.macro.unemployment")).toBeGreaterThan(0);
      const gdp = await eurostatIndicator("gdpQoq", "FR", 3);
      expect(gdp.points[0]!.asOf).toMatch(/^\d{4}-Q[1-4]$/);
    });
  }, 60_000);
});

describe("INSEE", () => {
  it("parses BDM SDMX XML, newest-first observations into oldest-first", () => {
    const xml =
      '<message:DataSet><Series IDBANK="011814632" FREQ="M" LAST_UPDATE="2026-10-15" UNIT_MEASURE="POURCENT"><Obs TIME_PERIOD="2026-09" OBS_VALUE="3.1" OBS_STATUS="A"/><Obs TIME_PERIOD="2026-08" OBS_VALUE="2.4" DATE_JO="2026-09-17"/><Obs TIME_PERIOD="2026-07" OBS_VALUE="NaN"/></Series></message:DataSet>';
    expect(parseInseeSdmx(xml)).toEqual([
      {
        idbank: "011814632",
        freq: "M",
        lastUpdate: "2026-10-15",
        obs: [
          { date: "2026-08", value: 2.4, published: "2026-09-17" },
          { date: "2026-09", value: 3.1 },
        ],
      },
    ]);
  });
  it("replays the CPI and unemployment presets, and refuses a bad idbank", async () => {
    await withFixture("macro-insee", async () => {
      const cpi = await inseeSeries("cpi", 3);
      expect(cpi.points[0]).toMatchObject({ key: "FR.macro.cpi.yoy", unit: "%" });
      expect(cpi.provenance.official).toBe(true);
      const idx = await inseeSeries("cpiIndex", 2);
      expect(idx.points.some((p) => p.key === "FR.macro.cpi.index.published")).toBe(true);
      const une = await inseeSeries("unemployment", 2);
      expect(une.points[0]!.asOf).toMatch(/^\d{4}-Q[1-4]$/);
    });
    await expect(inseeSeries("cpi-ish")).rejects.toBeInstanceOf(ProviderError);
  }, 60_000);
});

describe("BLS", () => {
  it("parses v1 answers and computes y/y from the index", () => {
    const answer = {
      status: "REQUEST_SUCCEEDED",
      Results: {
        series: [
          {
            seriesID: "CUUR0000SA0",
            data: [
              { year: "2026", period: "M09", value: "330.0" },
              { year: "2025", period: "M13", value: "320.0" },
              { year: "2025", period: "M09", value: "320.0" },
              { year: "2025", period: "M08", value: "-" },
            ],
          },
        ],
      },
    };
    const s = parseBls(answer).get("CUUR0000SA0")!;
    expect(s).toEqual([
      { date: "2025-09", value: 320 },
      { date: "2026-09", value: 330 },
    ]);
    expect(yoyFromIndex(s)).toEqual([{ date: "2026-09", value: 3.13 }]);
  });
});

describe("World Bank", () => {
  it("parses the indicator answer", () => {
    const m = parseWorldBank([
      { total: 2 },
      [
        { indicator: { id: "FP.CPI.TOTL.ZG" }, date: "2025", value: 0.94 },
        { indicator: { id: "FP.CPI.TOTL.ZG" }, date: "2024", value: 2.0 },
        { indicator: { id: "GC.DOD.TOTL.GD.ZS" }, date: "2024", value: null },
      ],
    ]);
    expect(m.get("FP.CPI.TOTL.ZG")).toEqual([
      { date: "2024", value: 2 },
      { date: "2025", value: 0.94 },
    ]);
    expect(m.has("GC.DOD.TOTL.GD.ZS")).toBe(false);
  });
  it("replays France's indicators and names the missing debt series", async () => {
    const ds = await withFixture("macro-worldbank", () => worldBankIndicators("FR", ["gdpGrowth", "inflation", "debt"], 2));
    expect(byKey(ds, "FR.macro.gdp.growth")).toBeTypeOf("number");
    expect(byKey(ds, "FR.macro.inflation")).toBeTypeOf("number");
    expect(ds.notes.join(" ")).toMatch(/GC\.DOD\.TOTL\.GD\.ZS/);
  }, 60_000);
});

describe("FRED", () => {
  const saved = { a: process.env.FRED_API_KEY, b: process.env.ULTRASTOCK_FRED_API_KEY };
  beforeEach(() => {
    delete process.env.FRED_API_KEY;
    delete process.env.ULTRASTOCK_FRED_API_KEY;
  });
  afterEach(() => {
    if (saved.a !== undefined) process.env.FRED_API_KEY = saved.a;
    if (saved.b !== undefined) process.env.ULTRASTOCK_FRED_API_KEY = saved.b;
  });
  it("parses the graph CSV and the API JSON", () => {
    expect(parseFredCsv("observation_date,DGS10\n2026-10-02,5.28\n2026-10-01,5.24\n2026-10-03,\n", "DGS10")).toEqual([
      { date: "2026-10-01", value: 5.24 },
      { date: "2026-10-02", value: 5.28 },
    ]);
    expect(
      parseFredJson({
        observations: [
          { date: "2026-10-01", value: "." },
          { date: "2026-10-02", value: "1.5" },
        ],
      }),
    ).toEqual([{ date: "2026-10-02", value: 1.5 }]);
  });
  it("replays keyless series (daily and monthly)", async () => {
    await withFixture("macro-fred", async () => {
      const dgs = await fredSeries("DGS10", { days: 14 });
      expect(dgs.points[0]).toMatchObject({ key: "US.fred.DGS10", unit: "%" });
      expect(dgs.notes.join(" ")).toMatch(/FRED_API_KEY/);
      const hy = await fredSeries("BAMLH0A0HYM2", { days: 14, history: false });
      expect(hy.points.length).toBeLessThanOrEqual(2);
      const cpi = await fredSeries("CPIAUCSL", { days: 100 });
      expect(cpi.points[0]!.asOf).toMatch(/-01$/);
    });
  }, 60_000);
});

describe("Frankfurter", () => {
  it("parses a range answer", () => {
    const m = parseFrankfurterRange({
      base: "EUR",
      start_date: "",
      end_date: "",
      rates: { "2026-10-02": { USD: 1.12 }, "2026-10-01": { USD: 1.13, GBP: 0.85 } },
    });
    expect(m.get("USD")).toEqual([
      { date: "2026-10-01", value: 1.13 },
      { date: "2026-10-02", value: 1.12 },
    ]);
  });
  it("replays latest and history", async () => {
    await withFixture("macro-frankfurter", async () => {
      const latest = await frankfurterLatest("EUR", ["USD", "JPY"]);
      expect(latest.points.map((p) => p.key).sort()).toEqual(["EUR.fx.JPY", "EUR.fx.USD"]);
      expect(latest.provenance.official).toBe(false);
      const hist = await frankfurterHistory(["USD"], 10);
      expect(hist.points.length).toBeGreaterThan(3);
    });
  }, 60_000);
});
