import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setNetMode } from "../src/core/net.js";
import { binanceFuturesPositioning, futuresFailure, meanFunding, perpSymbol, premiumPoints } from "../src/providers/crypto/binance-futures.js";
import { FIXTURES, withFixture } from "./helpers/fixtures.js";

describe("binance futures parsers", () => {
  it("names the perpetual and reads the premium index", () => {
    expect(perpSymbol("btc")).toBe("BTCUSDT");
    expect(perpSymbol("ETH-USD")).toBe("ETHUSDT");
    expect(perpSymbol("SOLUSDC")).toBe("SOLUSDC");
    const pts = premiumPoints({
      symbol: "BTCUSDT",
      markPrice: "100",
      indexPrice: "99",
      lastFundingRate: "0.0001",
      nextFundingTime: 1792857600000,
      time: 1792854454002,
    });
    const by = Object.fromEntries(pts.map((p) => [p.key, p.value]));
    expect(by["BTC.deriv.funding.binance"]).toBeCloseTo(0.01);
    expect(by["BTC.deriv.funding.binance.annualized"]).toBeCloseTo(10.95);
    expect(by["BTC.deriv.basis.binance"]).toBeCloseTo(1.0101, 3);
    expect(by["BTC.deriv.funding.binance.next"]).toBe("2026-10-24T16:00:00.000Z");
    expect(meanFunding([{ fundingRate: "0.0001" }, { fundingRate: "0.0003" }])).toBeCloseTo(0.02);
    expect(meanFunding([])).toBeUndefined();
  });
  it("reports a 451 as a definitive jurisdiction refusal", () => {
    const e = futuresFailure(451, "BTCUSDT", "/fapi/v1/premiumIndex");
    expect(e.transient).toBe(false);
    expect(e.message).toMatch(/HTTP 451.*not circumvented/);
    expect(futuresFailure(400, "NOPEUSDT", "/fapi/v1/premiumIndex").message).toMatch(/not a Binance USDT-M perpetual/);
    expect(futuresFailure(503, "BTCUSDT", "/fapi/v1/premiumIndex").transient).toBe(true);
  });
});

describe("binance futures fixture", () => {
  it("replays BTC positioning", async () => {
    const ds = await withFixture("crypto-binance-futures-btc", () => binanceFuturesPositioning("BTC", { days: 7, fundingLimit: 21 }));
    expect(ds).toHaveLength(3);
    const keys = ds.flatMap((d) => d.points.map((p) => p.key));
    for (const k of [
      "BTC.deriv.funding.binance",
      "BTC.deriv.funding.binance.mean",
      "BTC.deriv.oi.binance",
      "BTC.deriv.oi.binance.change",
      "BTC.deriv.ls.accounts.binance",
      "BTC.deriv.ls.top.binance",
      "BTC.deriv.taker.binance",
    ])
      expect(keys).toContain(k);
    expect(ds[0]!.provenance).toMatchObject({ source: "binance-futures", official: true });
    expect(ds[0]!.notes.join(" ")).not.toMatch(/unavailable/);
  });

  it("keeps the price and the funding when a statistics endpoint refuses, and names what is missing", async () => {
    // The recorded run, with the two throttled endpoints answering 429 as they do past 1000 requests in 5 minutes.
    const dir = mkdtempSync(join(tmpdir(), "us-futures-"));
    cpSync(join(FIXTURES, "crypto-binance-futures-btc"), dir, { recursive: true });
    for (const f of readdirSync(join(dir, "http"))) {
      const path = join(dir, "http", f);
      const rec = JSON.parse(readFileSync(path, "utf8")) as { request: { url: string }; response: Record<string, unknown> };
      if (!/openInterestHist|takerlongshortRatio/.test(rec.request.url)) continue;
      writeFileSync(path, JSON.stringify({ ...rec, response: { ...rec.response, ok: false, status: 429, body: "" } }));
    }
    setNetMode({ kind: "fixture", dir });
    try {
      const ds = await binanceFuturesPositioning("BTC", { days: 7, fundingLimit: 21 });
      const keys = ds.flatMap((d) => d.points.map((p) => p.key));
      expect(keys).toEqual(
        expect.arrayContaining(["BTC.deriv.funding.binance", "BTC.deriv.oi.binance", "BTC.deriv.ls.accounts.binance", "BTC.deriv.ls.top.binance"]),
      );
      expect(keys).not.toContain("BTC.deriv.oi.binance.change");
      expect(keys).not.toContain("BTC.deriv.taker.binance");
      expect(ds[0]!.notes.filter((n) => n.startsWith("unavailable — "))).toHaveLength(2);
      expect(ds[0]!.notes.join(" ")).toMatch(/unavailable — open interest history: .*429/);
    } finally {
      setNetMode({ kind: "live" });
    }
  });
});
