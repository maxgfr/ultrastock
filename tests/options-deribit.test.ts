import { describe, expect, it } from "vitest";
import {
  deribitDvol,
  deribitIndexPrice,
  deribitOptions,
  dvolPoints,
  parseDeribitBook,
  parseDeribitInstrument,
  parseDvol,
} from "../src/providers/options/deribit.js";
import { withFixture } from "./helpers/fixtures.js";

describe("deribit parsers", () => {
  it("parses option names, inverse and linear", () => {
    expect(parseDeribitInstrument("BTC-27DEC26-100000-C")).toEqual({ root: "BTC", expiry: "2026-12-27", strike: 100000, right: "call" });
    expect(parseDeribitInstrument("XRP_USDC-3OCT26-1d35-P")).toEqual({ root: "XRP_USDC", expiry: "2026-10-03", strike: 1.35, right: "put" });
    expect(parseDeribitInstrument("BTC-PERPETUAL")).toBeUndefined();
  });
  it("reads book summaries and DVOL candles", () => {
    const [c] = parseDeribitBook([
      {
        instrument_name: "ETH-25OCT26-2340-P",
        bid_price: 0.0125,
        ask_price: 0.0145,
        mark_iv: 49.15,
        open_interest: 808,
        volume: 1257,
        underlying_price: 2321.85,
        last: null,
      },
    ]);
    expect(c).toMatchObject({ right: "put", strike: 2340, iv: 49.15, openInterest: 808, underlyingPrice: 2321.85, bid: 0.0125 });
    expect(c!.last).toBeUndefined();
    const candles = parseDvol([
      [1792800000000, 37.35, 38.9, 36.99, 38.9],
      [1792713600000, 37.99, 38.65, 36.86, 37.35],
    ]);
    expect(candles[0]!.date).toBe("2026-10-23");
    const pts = dvolPoints("BTC", candles);
    expect(pts.map((p) => [p.key, p.value])).toEqual([
      ["BTC.deriv.dvol", 38.9],
      ["BTC.deriv.dvol.change", 38.9 - 37.99],
      ["BTC.deriv.dvol.high", 38.9],
      ["BTC.deriv.dvol.low", 36.86],
    ]);
  });
});

describe("deribit fixture", () => {
  it("replays the ETH chain, BTC DVOL and the BTC index", async () => {
    await withFixture("options-deribit", async () => {
      const { dataset, chain } = await deribitOptions("ETH");
      expect(chain.premiumCurrency).toBe("ETH");
      expect(chain.contracts.length).toBeGreaterThan(100);
      expect(dataset.provenance).toMatchObject({ source: "deribit", official: true });
      expect(dataset.points.some((p) => /^ETH\.opt\.\d{4}-\d{2}-\d{2}\.atm_iv$/.test(p.key))).toBe(true);
      const dvol = await deribitDvol("BTC", 30);
      expect(dvol.candles.length).toBeGreaterThan(20);
      const idx = await deribitIndexPrice("btc_usd");
      expect(idx.points[0]).toMatchObject({ key: "BTC.deriv.index.deribit", unit: "USD" });
    });
  });
});
