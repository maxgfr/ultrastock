import { describe, expect, it } from "vitest";
import { addSessions, calendarFor, isTradingDay } from "../src/core/calendar.js";
import { clockNow } from "../src/core/net.js";
import { parseYahooChart, YAHOO_VENUES, yahooFxRates, yahooUnpriced, yahooVenue } from "../src/providers/markets/yahoo.js";
import { toTradingViewTicker } from "../src/providers/markets/tradingview.js";
import { classifySymbol, getHistory, getQuote, resolveSymbol } from "../src/providers/router.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore } from "../src/core/evidence.js";
import { reportingCurrencyOf, valuationRun } from "../src/analyze/valuation.js";
import { withFixture } from "./helpers/fixtures.js";

const WORLD = [
  "SA",
  "MX",
  "TO",
  "V",
  "NE",
  "BA",
  "SN",
  "CL",
  "T",
  "HK",
  "KS",
  "KQ",
  "SS",
  "SZ",
  "TW",
  "TWO",
  "SI",
  "KL",
  "JK",
  "BK",
  "NS",
  "BO",
  "AX",
  "NZ",
  "JO",
  "TA",
  "IS",
  "SR",
  "QA",
];

describe("world venues", () => {
  it("name every suffix's venue, MIC, currency and time zone", () => {
    for (const s of WORLD) {
      const v = YAHOO_VENUES[s]!;
      expect(v, s).toMatchObject({ market: "world" });
      expect(v.mic, s).toMatch(/^[A-Z]{4}$/);
      expect(v.currency, s).toMatch(/^[A-Z]{2}[A-Za-z]$/);
      expect(() => new Intl.DateTimeFormat("en", { timeZone: v.timeZone }), s).not.toThrow();
    }
    expect(yahooVenue("petr4.sa")).toMatchObject({ mic: "BVMF", currency: "BRL", ticker: "PETR4", suffix: "SA" });
    expect(yahooVenue("6488.TWO")).toMatchObject({ mic: "ROCO", suffix: "TWO", ticker: "6488" });
    // Sub-units, converted by the parser: Johannesburg in cents, Tel Aviv in agorot.
    expect(YAHOO_VENUES.JO!.currency).toBe("ZAc");
    expect(YAHOO_VENUES.TA!.currency).toBe("ILA");
    expect(yahooVenue("SAP.DE")).toMatchObject({ market: "europe" });
  });

  it("route them through Yahoo as the world market; Lima is refused with the reason", () => {
    expect(classifySymbol("PETR4.SA")).toBe("world");
    expect(classifySymbol("7203.T")).toBe("world");
    expect(classifySymbol("TOI.V")).toBe("world");
    expect(classifySymbol("0700.HK")).toBe("world");
    expect(classifySymbol("SAP.DE")).toBe("europe");
    expect(classifySymbol("BRK.B")).toBe("us");
    const lima = classifySymbol("BAP.LM");
    expect(lima).toHaveProperty("unsupported");
    expect((lima as { unsupported: string }).unsupported).toMatch(/no currency and no last price/);
    expect(yahooUnpriced("BAP.LM")).toBeDefined();
    expect((classifySymbol("XYZ.ZZ") as { unsupported: string }).unsupported).toMatch(/\.SA .*\.T .*\.AX .*\.JO/);
  });

  it("map to TradingView tickers, Hong Kong without its leading zeros, Bursa Malaysia not at all", () => {
    expect(toTradingViewTicker("PETR4.SA")).toBe("BMFBOVESPA:PETR4");
    expect(toTradingViewTicker("0700.HK")).toBe("HKEX:700");
    expect(toTradingViewTicker("005930.KS")).toBe("KRX:005930");
    expect(toTradingViewTicker("6488.TWO")).toBe("TPEX:6488");
    expect(toTradingViewTicker("SQM-B.SN")).toBe("BCS:SQM_B");
    expect(toTradingViewTicker("2222.SR")).toBe("TADAWUL:2222");
    expect(toTradingViewTicker("1155.KL")).toBeUndefined();
  });

  it("have no exchange calendar: sessions are weekdays, no holiday is guessed", () => {
    expect(calendarFor({ market: "world", mic: "XTKS" })).toBeUndefined();
    expect(calendarFor({ market: "europe", mic: "XETR" })).toBeUndefined();
    expect(calendarFor({ market: "euronext", mic: "XPAR" })).toBe("XPAR");
    expect(calendarFor({ market: "us", mic: "XNAS" })).toBe("XNYS");
    expect(calendarFor({ market: "crypto" })).toBe("CRYPTO");
    // 2026-01-01 is a holiday in Paris, not a guess for Tokyo: a plain weekday there.
    expect(isTradingDay(undefined, "2026-01-01")).toBe(true);
    expect(isTradingDay("XPAR", "2026-01-01")).toBe(false);
    expect(isTradingDay(undefined, "2026-01-03")).toBe(false);
    expect(addSessions(undefined, "2026-10-23", 5)).toBe("2026-10-30");
  });

  it("convert Johannesburg cents and Tel Aviv agorot", () => {
    const body = (symbol: string, currency: string) => ({
      chart: {
        result: [
          {
            meta: { symbol, currency, instrumentType: "EQUITY", gmtoffset: 7200 },
            timestamp: [1792742400],
            indicators: { quote: [{ open: [67000], high: [68000], low: [66000], close: [67723], volume: [10] }] },
          },
        ],
      },
    });
    const jo = parseYahooChart(body("NPN.JO", "ZAc"))!;
    expect(jo.currency).toBe("ZAR");
    expect(jo.bars[0]!.close).toBeCloseTo(677.23, 6);
    expect(jo.notes[0]).toMatch(/cents/);
    const ta = parseYahooChart(body("TEVA.TA", "ILA"))!;
    expect(ta.currency).toBe("ILS");
    expect(ta.notes[0]).toMatch(/agorot/);
  });
});

describe("world venues, recorded", () => {
  // One liquid listing per region, each a quote and a year of daily bars; ULTRASTOCK_RECORD=1 re-records.
  const cases: Array<[symbol: string, mic: string, currency: string]> = [
    ["PETR4.SA", "BVMF", "BRL"],
    ["7203.T", "XTKS", "JPY"],
    ["0700.HK", "XHKG", "HKD"],
    ["005930.KS", "XKRX", "KRW"],
    ["600519.SS", "XSHG", "CNY"],
    ["BHP.AX", "XASX", "AUD"],
    ["RELIANCE.NS", "XNSE", "INR"],
    ["NPN.JO", "XJSE", "ZAR"],
  ];

  it("resolve, price and chart one listing per region", async () => {
    await withFixture("markets-yahoo-world", async () => {
      const now = clockNow();
      for (const [symbol, mic, currency] of cases) {
        const r = await resolveSymbol(symbol);
        expect(r.instrument, symbol).toMatchObject({ symbol, market: "world", mic, currency, kind: "equity" });
        const q = await getQuote(r, now);
        expect(q.price, symbol).toBeGreaterThan(0);
        expect(q.provenance, symbol).toMatchObject({ source: "yahoo", official: false });
        const h = await getHistory(r, { from: new Date(now.getTime() - 365 * 86_400_000), to: now });
        expect(h.bars.length, symbol).toBeGreaterThan(200);
        expect(h.bars[h.bars.length - 1]!.date <= now.toISOString().slice(0, 10)).toBe(true);
      }
      // Cents converted: Naspers trades around a few hundred rand, not tens of thousands.
      const npn = await getQuote(await resolveSymbol("NPN.JO"), now);
      expect(npn.price).toBeLessThan(5000);
      expect(npn.notes.join(" ")).toMatch(/cents/);
      // Cboe Canada: a quote, no daily history — refused with the reason.
      const ne = await resolveSymbol("AAPL.NE");
      expect((await getQuote(ne, now)).price).toBeGreaterThan(0);
      await expect(getHistory(ne, { from: new Date(now.getTime() - 365 * 86_400_000), to: now })).rejects.toThrow(/no daily history for Cboe Canada/);
      // Cross rates the ECB does not fix.
      const fx = await yahooFxRates("EUR", ["TWD", "SAR"]);
      expect(fx.points.map((p) => p.key)).toEqual(["EUR.fx.TWD", "EUR.fx.SAR"]);
      expect(fx.provenance.official).toBe(false);
      expect(fx.points.every((p) => typeof p.value === "number" && p.value > 0)).toBe(true);
    });
  }, 120_000);

  it("values a Hong Kong line reporting in CNY in CNY: the price converted at the ECB cross rate, as a derived figure", async () => {
    expect(reportingCurrencyOf({ reporting_currency: "cny" })).toBe("CNY");
    expect(reportingCurrencyOf({ reporting_currency: null })).toBeUndefined();
    // Recorded with ULTRASTOCK_CRIBLE_DATA_DIR pointing at a bootstrapped crible dataset; replayed without one.
    await withFixture("valuation-0700-hk", async () => {
      const dir = mkdtempSync(join(tmpdir(), "us-val-hk-"));
      const v = await valuationRun("0700.HK", dir);
      expect(v.currency).toBe("CNY");
      const store = EvidenceStore.load(dir)!;
      const hkd = store.byKey("0700.HK.quote.price")!;
      const cny = store.byKey("0700.HK.quote.price.CNY")!;
      expect(hkd.unit).toBe("HKD");
      expect(cny).toMatchObject({ unit: "CNY", source: "ultrastock" });
      expect(cny.derivedFrom).toEqual([hkd.id, store.byKey("EUR.fx.CNY")!.id, store.byKey("EUR.fx.HKD")!.id]);
      const rate = (store.byKey("EUR.fx.CNY")!.value as number) / (store.byKey("EUR.fx.HKD")!.value as number);
      expect(cny.value as number).toBeCloseTo((hkd.value as number) * rate, 4);
      expect(v.notes.join(" ")).toMatch(/reports in CNY and trades in HKD/);
      expect(v.notes.join(" ")).toMatch(/no CNY risk-free curve here/);
    });
  }, 180_000);
});
