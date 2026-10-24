import { describe, expect, it } from "vitest";
import { toTradingViewTicker, tradingviewScan, tradingviewSnapshot, tvRowPoints } from "../src/providers/markets/tradingview.js";
import { withFixture } from "./helpers/fixtures.js";

describe("tradingview parsers", () => {
  it("maps user symbols to TradingView tickers", () => {
    expect(toTradingViewTicker("SAP.DE")).toBe("XETR:SAP");
    expect(toTradingViewTicker("volv-b.st")).toBe("OMXSTO:VOLV_B");
    expect(toTradingViewTicker("MC.PA")).toBe("EURONEXT:MC");
    expect(toTradingViewTicker("ISP.MI")).toBe("MIL:ISP");
    expect(toTradingViewTicker("NASDAQ:AAPL")).toBe("NASDAQ:AAPL");
    expect(toTradingViewTicker("AAPL")).toBeUndefined();
  });
  it("turns a row into points: units, pence conversion, nulls dropped, prose untrusted", () => {
    const cols = ["description", "close", "change", "currency", "market_cap_basic", "dividend_yield_recent", "isin"];
    const pts = tvRowPoints({ s: "LSE:VOD", d: ["Vodafone Group", 118.2, -1.5, "GBX", 3e10, null, "GB00BH4HKS39"] }, cols, "2026-10-24");
    expect(pts.find((p) => p.key === "LSE:VOD.tv.close")).toMatchObject({ value: 1.182, unit: "GBP" });
    expect(pts.find((p) => p.key === "LSE:VOD.tv.change")).toMatchObject({ value: -1.5, unit: "%" });
    expect(pts.find((p) => p.key === "LSE:VOD.tv.currency")!.value).toBe("GBP");
    expect(pts.find((p) => p.key === "LSE:VOD.tv.description")!.untrusted).toBe(true);
    expect(pts.find((p) => p.key === "LSE:VOD.tv.isin")!.untrusted).toBeUndefined();
    expect(pts.some((p) => p.key.endsWith("dividend_yield_recent"))).toBe(false);
  });
});

describe("tradingview fixtures", () => {
  it("replays a Xetra snapshot", async () => {
    const ds = await withFixture("markets-tradingview-sap", () => tradingviewSnapshot("SAP.DE"));
    expect(ds.provenance).toMatchObject({ source: "tradingview", official: false });
    expect(ds.points.find((p) => p.key === "XETR:SAP.tv.close")).toMatchObject({ unit: "EUR" });
    expect(ds.points.find((p) => p.key === "XETR:SAP.tv.isin")!.value).toBe("DE0007164600");
    expect(ds.notes[0]).toMatch(/unofficial endpoint/);
  });
  it("replays an ETF screener on market france", async () => {
    const ds = await withFixture("markets-tradingview-etf-fr", () =>
      tradingviewScan("france", {
        filter: [{ left: "typespecs", operation: "has", right: ["etf"] }],
        columns: ["description", "close", "currency", "expense_ratio", "aum", "isin"],
        sort: { sortBy: "aum", sortOrder: "desc" },
        range: [0, 5],
      }),
    );
    expect(ds.points[0]!.value as number).toBeGreaterThan(100);
    expect(ds.points.filter((p) => p.key.endsWith(".tv.expense_ratio"))).toHaveLength(5);
  });
});
