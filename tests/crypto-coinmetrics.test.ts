import { describe, expect, it } from "vitest";
import { coinmetricsAssetMetrics, coinmetricsPoints, nvtRatio, parseCoinmetricsRows } from "../src/providers/crypto/coinmetrics.js";
import { ProviderError } from "../src/providers/types.js";
import { withFixture } from "./helpers/fixtures.js";

describe("Coin Metrics parsers", () => {
  it("reads string values into dated rows and the latest points", () => {
    const rows = parseCoinmetricsRows([
      { asset: "btc", time: "2026-10-22T00:00:00.000000000Z", PriceUSD: "80000", AdrActCnt: "600000", CapMVRVCur: "1.5" },
      { asset: "btc", time: "2026-10-21T00:00:00.000000000Z", PriceUSD: "84000", AdrActCnt: "630000" },
      { asset: "btc", time: "2026-10-23T00:00:00.000000000Z", PriceUSD: "88000", AdrActCnt: "660000", CapMVRVCur: "" },
    ]);
    expect(rows.map((r) => r.date)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
    const p = coinmetricsPoints("btc", rows);
    const mvrv = p.find((x) => x.key === "BTC.onchain.mvrv")!;
    expect(mvrv).toMatchObject({ value: 1.5, asOf: "2026-10-22", unit: "ratio" });
    const chg = p.find((x) => x.key === "BTC.market.price.change.window")!;
    expect(chg.value).toBeCloseTo((88000 / 84000 - 1) * 100);
    expect(chg.formula).toMatch(/PriceUSD/);
    expect(p.some((x) => x.key === "BTC.onchain.nvt")).toBe(false);
  });
  it("computes NVT only from a positive transfer value", () => {
    expect(nvtRatio(1.6e12, 8e9)).toBe(200);
    expect(nvtRatio(1.6e12, 0)).toBeUndefined();
    const rows = parseCoinmetricsRows([{ asset: "btc", time: "2026-10-23T00:00:00Z", CapMrktCurUSD: "1.6e12", TxTfrValAdjUSD: "8e9" }]);
    expect(coinmetricsPoints("btc", rows).find((x) => x.key === "BTC.onchain.nvt")).toMatchObject({ value: 200, formula: "CapMrktCurUSD / TxTfrValAdjUSD" });
  });
  it("refuses an asset with no verified community metrics", async () => {
    await expect(coinmetricsAssetMetrics("sol")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("Coin Metrics fixture", () => {
  it("replays BTC and ETH daily metrics", async () => {
    const [btc, eth] = await withFixture("crypto-coinmetrics", async () => [await coinmetricsAssetMetrics("btc", 7), await coinmetricsAssetMetrics("eth", 7)]);
    expect(btc!.points.find((p) => p.key === "BTC.onchain.mvrv")!.value).toBeGreaterThan(0);
    expect(btc!.points.find((p) => p.key === "BTC.onchain.hashrate")).toBeDefined();
    expect(eth!.points.find((p) => p.key === "ETH.onchain.activeAddresses")!.value).toBeGreaterThan(1000);
    expect(btc!.provenance).toMatchObject({ source: "coinmetrics", official: false, delay: "daily" });
  });
});
