import { describe, expect, it } from "vitest";
import { clockNow } from "../src/core/net.js";
import { parseYahooChart, resolveYahoo, yahooChart, yahooInstrument, yahooFailure, yahooQuote, yahooVenue } from "../src/providers/markets/yahoo.js";
import { withFixture } from "./helpers/fixtures.js";

describe("yahoo parsers", () => {
  it("maps European suffixes to their venue", () => {
    expect(yahooVenue("sap.de")).toMatchObject({ mic: "XETR", ticker: "SAP", suffix: "DE" });
    expect(yahooVenue("VOLV-B.ST")).toMatchObject({ mic: "XSTO", currency: "SEK" });
    expect(yahooVenue("MC.PA")).toBeUndefined();
    expect(yahooVenue("AAPL")).toBeUndefined();
  });
  it("converts pence to pounds, reads events and drops a session still open", () => {
    const body = {
      chart: {
        result: [
          {
            meta: {
              symbol: "VOD.L",
              currency: "GBp",
              instrumentType: "EQUITY",
              gmtoffset: 3600,
              currentTradingPeriod: { regular: { start: 1792828800, end: 1792859400 } },
            },
            timestamp: [1792742400, 1792828800],
            events: {
              dividends: { "1792742400": { amount: 2.5, date: 1792742400 } },
              splits: { "1792742400": { date: 1792742400, numerator: 4, denominator: 1 } },
            },
            indicators: { quote: [{ open: [120, 121], high: [122, 123], low: [119, 120], close: [121, 122], volume: [1000, 50] }] },
          },
        ],
      },
    };
    const open = parseYahooChart(body, "1d", 1792840000)!;
    expect(open.currency).toBe("GBP");
    expect(open.bars).toEqual([{ date: "2026-10-23", open: 1.2, high: 1.22, low: 1.19, close: 1.21, volume: 1000 }]);
    expect(open.dividends).toEqual([{ date: "2026-10-23", amount: 0.025 }]);
    expect(open.splits[0]).toMatchObject({ numerator: 4, denominator: 1 });
    expect(open.notes[0]).toMatch(/pence/);
    expect(parseYahooChart(body, "1d", 1792860000)!.bars).toHaveLength(2);
    expect(parseYahooChart({ chart: { result: null, error: { code: "Not Found" } } })).toBeUndefined();
  });
  it("builds an instrument from chart metadata", () => {
    expect(yahooInstrument("nesn.sw", { symbol: "NESN.SW", currency: "CHF", instrumentType: "EQUITY", longName: "Nestlé S.A." })).toMatchObject({
      symbol: "NESN.SW",
      market: "europe",
      mic: "XSWX",
      currency: "CHF",
      kind: "equity",
    });
    expect(yahooInstrument("SPY", { symbol: "SPY", currency: "USD", instrumentType: "ETF" })).toMatchObject({ market: "us", kind: "etf" });
  });
});

describe("yahoo fixtures", () => {
  it("replays Xetra history with corporate actions, and a quote", async () => {
    await withFixture("markets-yahoo-sap", async () => {
      const now = clockNow();
      const sap = await resolveYahoo("SAP.DE");
      expect(sap).toMatchObject({ market: "europe", mic: "XETR", currency: "EUR" });
      const { series, actions } = await yahooChart(sap, new Date(now.getTime() - 400 * 86400_000), now);
      expect(series.bars.length).toBeGreaterThan(200);
      expect(series.provenance).toMatchObject({ source: "yahoo", official: false });
      expect(actions.points.some((p) => p.key.startsWith("SAP.DE.action.dividend."))).toBe(true);
      const q = await yahooQuote(sap);
      expect(q.price).toBeGreaterThan(0);
      expect(q.previousClose).toBeGreaterThan(0);
    });
  });
  it("replays a London quote converted from pence", async () => {
    await withFixture("markets-yahoo-vod", async () => {
      const vod = await resolveYahoo("VOD.L");
      expect(vod.currency).toBe("GBP");
      const q = await yahooQuote(vod);
      expect(q.price).toBeLessThan(10);
      expect(q.notes.join(" ")).toMatch(/pence/);
    });
  });
  it("classifies a throttled answer as transient and an unknown symbol as definitive", () => {
    expect(yahooFailure(429, "SAP.DE").transient).toBe(true);
    expect(yahooFailure(0, "SAP.DE", undefined, "timeout").transient).toBe(true);
    const nf = yahooFailure(404, "ZZZZ", { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } });
    expect(nf.transient).toBe(false);
    expect(nf.message).toMatch(/no Yahoo listing for ZZZZ/);
  });
});
