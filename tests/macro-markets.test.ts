import { afterEach, describe, expect, it } from "vitest";
import { setNetMode } from "../src/core/net.js";
import {
  dividendsCalendar,
  earningsCalendar,
  forexFactoryCalendar,
  nasdaqEconomicCalendar,
  parseForexFactory,
  parseNasdaqDividends,
  parseNasdaqEarnings,
  parseNasdaqEconomic,
} from "../src/providers/macro/calendars.js";
import { cotAlias, cotIndex, cotReport, parseCotRows } from "../src/providers/macro/cftc.js";
import {
  cboeIndexHistory,
  cboePutCall,
  cnnFearGreed,
  cryptoFearGreed,
  parseAlternativeMe,
  parseCboeHistory,
  parseCboePutCall,
  parseCnnFearGreed,
  previousSession,
  vixTermStructure,
} from "../src/providers/macro/sentiment.js";
import { withFixture } from "./helpers/fixtures.js";

afterEach(() => setNetMode({ kind: "live" }));

const byKey = (ds: { points: Array<{ key: string; value: unknown }> }, key: string) => ds.points.find((p) => p.key === key)?.value;

describe("CFTC Commitments of Traders", () => {
  it("parses rows and computes the COT index", () => {
    const weeks = parseCotRows(
      [
        {
          report_date_as_yyyy_mm_dd: "2026-10-20T00:00:00.000",
          open_interest_all: "1000",
          noncomm_positions_long_all: "300",
          noncomm_positions_short_all: "500",
        },
        {
          report_date_as_yyyy_mm_dd: "2026-10-13T00:00:00.000",
          open_interest_all: "900",
          noncomm_positions_long_all: "400",
          noncomm_positions_short_all: "350",
        },
      ],
      "legacy",
    );
    expect(weeks.map((w) => [w.date, w.net.noncomm])).toEqual([
      ["2026-10-13", 50],
      ["2026-10-20", -200],
    ]);
    expect(cotIndex([0, 10, 5, 10, 0, 2, 4, 6, 8, 10], 10)).toBe(100);
    expect(cotIndex([0, 10, 5, 10, 0, 2, 4, 6, 8, 5], 10)).toBe(50);
    expect(cotIndex([1, 2], 26)).toBeUndefined();
    expect(cotAlias("gold")).toBe("GC");
    expect(cotAlias("E-MINI S&P 500")).toBe("ES");
  });
  it("replays E-mini S&P 500 legacy and TFF positioning, filtered by contract code", async () => {
    await withFixture("macro-cftc", async () => {
      const es = await cotReport("ES");
      expect(es.provenance).toMatchObject({ source: "cftc", official: true });
      expect(es.provenance.url).toContain("cftc_contract_market_code");
      expect(byKey(es, "ES.cot.noncomm.net")).toBeTypeOf("number");
      const idx = byKey(es, "ES.cot.noncomm.index156w") as number;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(100);
      expect(byKey(es, "ES.cot.noncomm.index26w")).toBeTypeOf("number");
      expect(es.points.find((p) => p.key === "ES.cot.market")).toMatchObject({ untrusted: true, value: expect.stringMatching(/^E-MINI S&P 500 -/) });
      const tff = await cotReport("ES", { kind: "tff", weeks: 30 });
      expect(byKey(tff, "ES.cot.levFunds.net")).toBeTypeOf("number");
      expect(byKey(tff, "ES.cot.assetMgr.index26w")).toBeTypeOf("number");
      const gold = await cotReport("GOLD", { weeks: 30 });
      expect(gold.subject).toBe("GC");
    });
  }, 60_000);
});

describe("calendars", () => {
  it("parses Nasdaq and ForexFactory rows", () => {
    const ev = parseNasdaqEconomic(
      [
        { gmt: "01:00", country: "Japan", eventName: "Leading Index", actual: "&nbsp;", consensus: "0.4%", previous: "1.5%" },
        { gmt: "24H", country: "Italy", eventName: "Car Registration", actual: "9.8%", consensus: "", previous: "3.2%" },
      ],
      "2026-10-27",
    );
    // New York times: EDT in October, EST after the first Sunday of November.
    expect(ev[0]).toMatchObject({ at: "2026-10-27T05:00:00Z", country: "Japan", forecast: "0.4%", previous: "1.5%" });
    expect(ev[0]!.actual).toBeUndefined();
    expect(ev[1]).toMatchObject({ at: "2026-10-27", actual: "9.8%" });
    expect(parseNasdaqEconomic([{ gmt: "08:30", country: "United States", eventName: "Durable Goods Orders" }], "2026-11-04")[0]!.at).toBe(
      "2026-11-04T13:30:00Z",
    );
    const ff = parseForexFactory([
      { title: "Trade Balance", country: "NZD", date: "2026-10-18T17:45:00-04:00", impact: "Low", forecast: "-775M", previous: "-1349M" },
    ]);
    expect(ff[0]).toMatchObject({ at: "2026-10-18T21:45:00Z", impact: "Low", forecast: "-775M" });
    const earn = parseNasdaqEarnings([
      { symbol: "KO", name: "Coca-Cola Company (The)", time: "time-pre-market", marketCap: "$410,205,061,000", epsForecast: "$0.87", noOfEsts: "8" },
      { symbol: "V", name: "Visa Inc.", time: "time-after-hours", marketCap: "$740,324,150,000", epsForecast: "$3.43", noOfEsts: "12" },
    ]);
    expect(earn.map((e) => e.symbol)).toEqual(["V", "KO"]);
    expect(earn[0]).toMatchObject({ time: "after-hours", marketCap: 740324150000, estimates: 12 });
    const div = parseNasdaqDividends([
      {
        symbol: "ASML",
        companyName: "ASML",
        dividend_Ex_Date: "10/27/2026",
        payment_Date: "11/04/2026",
        dividend_Rate: 2.107668,
        announcement_Date: "9/15/2026",
      },
    ]);
    expect(div[0]).toMatchObject({ exDate: "2026-10-27", payDate: "2026-11-04", announced: "2026-09-15", amount: 2.107668 });
  });
  it("replays the calendars as untrusted event points", async () => {
    await withFixture("macro-calendars", async () => {
      const econ = await nasdaqEconomicCalendar("2026-10-27");
      expect(econ.provenance.official).toBe(false);
      expect(byKey(econ, "CAL.econ.count")).toBeGreaterThan(5);
      const events = econ.points.filter((p) => p.untrusted);
      expect(events.length).toBe(byKey(econ, "CAL.econ.count"));
      for (const p of events) expect(p.label).toMatch(/^economic event \d+ \((\d{2}:\d{2} UTC|all day)\)$/);
      const ff = await forexFactoryCalendar({ minImpact: "high", includePast: true });
      expect(ff.points.filter((p) => p.untrusted).every((p) => String(p.value).includes("impact: High"))).toBe(true);
      const earn = await earningsCalendar("2026-10-27", 10);
      expect(earn.points.filter((p) => p.untrusted).length).toBe(10);
      expect(byKey(earn, "CAL.earnings.2026-10-27.count")).toBeGreaterThan(10);
      const div = await dividendsCalendar("2026-10-27");
      expect(byKey(div, "CAL.dividends.2026-10-27.count")).toBeGreaterThan(0);
    });
  }, 60_000);
});

describe("sentiment", () => {
  it("parses CNN, alternative.me and Cboe answers", () => {
    const { points } = parseCnnFearGreed({
      fear_and_greed: { score: 20.98, rating: "extreme fear", timestamp: "2026-10-23T23:59:44+00:00", previous_close: 19.81, previous_1_week: 22.07 },
      put_call_options: { timestamp: 1792790456000, score: 21.2, rating: "extreme fear", data: [{ x: 1792790456000, y: 0.8032 }] },
    });
    expect(points.find((p) => p.key === "US.sentiment.feargreed")).toMatchObject({ value: 21, asOf: "2026-10-23" });
    expect(points.find((p) => p.key === "US.sentiment.feargreed.rating")?.untrusted).toBeUndefined();
    expect(points.find((p) => p.key === "US.sentiment.feargreed.prev.close")?.value).toBe(19.8);
    expect(points.find((p) => p.key === "US.sentiment.feargreed.put_call_options.value")).toMatchObject({ value: 0.8032, unit: "ratio" });
    expect(parseAlternativeMe({ data: [{ value: "51", value_classification: "Neutral", timestamp: "1792800000" }] })).toEqual([
      { date: "2026-10-24", value: 51, rating: "Neutral" },
    ]);
    expect(parseCboeHistory("DATE,OPEN,HIGH,LOW,CLOSE\n10/23/2026,19.18,20.66,18.87,19.45\n10/22/2026,18.29,20.31,17.71,19.03\n", "VIX")).toEqual([
      { date: "2026-10-22", value: 19.03 },
      { date: "2026-10-23", value: 19.45 },
    ]);
    expect(parseCboeHistory("DATE,VVIX\n10/23/2026,109.700000\n", "VVIX")).toEqual([{ date: "2026-10-23", value: 109.7 }]);
    const pc = parseCboePutCall(
      {
        ratios: [
          { name: "TOTAL PUT/CALL RATIO", value: "0.93" },
          { name: "EQUITY PUT/CALL RATIO", value: "0.67" },
        ],
      },
      "2026-10-23",
    );
    expect(pc.map((p) => [p.key, p.value])).toEqual([
      ["US.options.putcall.total", 0.93],
      ["US.options.putcall.equity", 0.67],
    ]);
    expect(previousSession("2026-10-26")).toBe("2026-10-23");
  });
  it("replays CNN, crypto Fear & Greed, the VIX term structure and put/call ratios", async () => {
    await withFixture("macro-sentiment", async () => {
      const cnn = await cnnFearGreed();
      const score = byKey(cnn, "US.sentiment.feargreed") as number;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      expect(cnn.points.filter((p) => p.key.endsWith(".score")).length).toBe(7);
      expect(cnn.provenance.official).toBe(false);
      const crypto = await cryptoFearGreed(3);
      expect(byKey(crypto, "CRYPTO.sentiment.feargreed")).toBeTypeOf("number");
      const vix = await vixTermStructure();
      const ratio = byKey(vix, "US.vol.ratio.vix_vix3m") as number;
      expect(ratio).toBeCloseTo((byKey(vix, "US.vol.vix") as number) / (byKey(vix, "US.vol.vix3m") as number), 3);
      const pc = await cboePutCall();
      expect(byKey(pc, "US.options.putcall.total")).toBeGreaterThan(0);
      expect(byKey(pc, "US.options.putcall.equity")).toBeGreaterThan(0);
      const vvix = await cboeIndexHistory("VVIX", 10);
      expect(vvix.provenance.official).toBe(true);
      expect(vvix.points.length).toBeGreaterThan(4);
    });
  }, 60_000);
});
