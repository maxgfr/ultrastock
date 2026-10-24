import { describe, expect, it } from "vitest";
import {
  chainPoints,
  feesPoints,
  filterPools,
  filterProtocols,
  llamaChains,
  llamaId,
  llamaProtocol,
  llamaTvl,
  poolPoints,
  protocolListPoints,
  protocolSummaryPoints,
  rewardShare,
  stablecoinPoints,
} from "../src/providers/crypto/defillama.js";
import { withFixture } from "./helpers/fixtures.js";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

describe("DefiLlama parsers", () => {
  it("ranks chains and sums them", () => {
    const p = chainPoints(
      [
        { name: "Solana", tvl: 10 },
        { name: "Ethereum", tvl: 60 },
        { name: "OP Mainnet", tvl: 5 },
      ],
      2,
    );
    expect(p.map((x) => x.key)).toEqual(["DEFI.Ethereum.tvl", "DEFI.Solana.tvl", "DEFI.chains.tvl.sum"]);
    expect(p[2]!.value).toBe(75);
    expect(llamaId("OP Mainnet")).toBe("OP_Mainnet");
  });
  it("filters protocols by category and chain", () => {
    const rows = [
      { slug: "aave-v3", name: "Aave V3", category: "Lending", chains: ["Ethereum", "Base"], tvl: 30, change_7d: 1, mcap: 60 },
      { slug: "binance-cex", category: "CEX", chains: ["Ethereum"], tvl: 170 },
      { slug: "kamino", category: "Lending", chains: ["Solana"], tvl: 3 },
    ];
    const lend = filterProtocols(rows, { category: "lending", chain: "ethereum" });
    expect(lend.map((r) => r.slug)).toEqual(["aave-v3"]);
    const pts = protocolListPoints(lend);
    expect(pts.find((x) => x.key === "aave-v3.defi.mcapToTvl")).toMatchObject({ value: 2, formula: "mcap / tvl" });
    expect(pts.find((x) => x.key === "aave-v3.defi.name")!.untrusted).toBe(true);
  });
  it("summarises a TVL history: changes, peak, chain split", () => {
    const p = protocolSummaryPoints("demo", {
      name: "Demo",
      tvl: [
        { date: day("2026-01-01"), totalLiquidityUSD: 100 },
        { date: day("2026-08-01"), totalLiquidityUSD: 400 },
        { date: day("2026-09-20"), totalLiquidityUSD: 200 },
        { date: day("2026-10-23"), totalLiquidityUSD: 300 },
      ],
      currentChainTvls: { Ethereum: 225, Base: 75, "Ethereum-borrowed": 999, borrowed: 999 },
    });
    const v = Object.fromEntries(p.map((x) => [x.key, x.value]));
    expect(v["demo.defi.tvl"]).toBe(300);
    expect(v["demo.defi.tvl.change30d"]).toBeCloseTo(50);
    expect(v["demo.defi.tvl.peak"]).toBe(400);
    expect(v["demo.defi.tvl.fromPeak"]).toBeCloseTo(-25);
    expect(v["demo.defi.tvlShare.Ethereum"]).toBe(75);
    expect(v["demo.defi.tvlShare.Ethereum-borrowed"]).toBeUndefined();
  });
  it("totals USD stablecoins and their supply changes", () => {
    const p = stablecoinPoints([
      { id: "1", symbol: "USDT", name: "Tether", pegType: "peggedUSD", circulating: { peggedUSD: 150 }, circulatingPrevMonth: { peggedUSD: 100 }, price: 1 },
      { id: "2", symbol: "USDC", pegType: "peggedUSD", circulating: { peggedUSD: 50 } },
      { id: "3", symbol: "EURC", pegType: "peggedEUR", circulating: { peggedEUR: 10 } },
    ]);
    const v = Object.fromEntries(p.map((x) => [x.key, x.value]));
    expect(v["STABLE.total.supply"]).toBe(200);
    expect(v["USDT.stable.share"]).toBe(75);
    expect(v["USDT.stable.supply.change30d"]).toBeCloseTo(50);
    expect(v["EURC.stable.supply"]).toBe(10);
    expect(p.find((x) => x.key === "EURC.stable.supply")!.unit).toBe("EUR");
  });
  it("filters pools and splits base from reward APY", () => {
    const pools = [
      { pool: "aaaa1111-x", project: "lido", chain: "Ethereum", symbol: "STETH", tvlUsd: 2e10, apy: 2.8, apyBase: 2.8, apyReward: null },
      { pool: "bbbb2222-x", project: "farm", chain: "Base", symbol: "USDC-WETH", tvlUsd: 5e6, apy: 40, apyBase: 10, apyReward: 30, ilRisk: "yes" },
      { pool: "cccc3333-x", project: "farm", chain: "Base", symbol: "USDCX", tvlUsd: 9e6, apy: 5, apyBase: 5 },
    ];
    expect(filterPools(pools, { symbol: "usdc" }).map((p) => p.pool)).toEqual(["bbbb2222-x"]);
    expect(rewardShare(10, 30)).toBe(75);
    expect(rewardShare(null, null)).toBeUndefined();
    const pts = poolPoints(filterPools(pools, { project: "farm" }));
    expect(pts.find((x) => x.key === "YIELD.bbbb2222.apy.rewardShare")).toMatchObject({ value: 75, unit: "%" });
    expect(pts.find((x) => x.key === "YIELD.bbbb2222.ilRisk")!.value).toBe(true);
  });
  it("reads a fees overview", () => {
    const p = feesPoints(
      {
        total24h: 7e7,
        change_7d: -8,
        protocols: [
          { slug: "tether", total24h: 2e7, total30d: 6e8 },
          { slug: "small", total24h: 1 },
        ],
      },
      "DeFi",
      1,
    );
    expect(p.map((x) => x.key)).toEqual(["DEFI.fees.24h", "DEFI.fees.change7d", "tether.defi.fees.24h", "tether.defi.fees.30d"]);
  });
});

describe("DefiLlama fixture", () => {
  it("replays chains, a TVL and a small protocol's history", async () => {
    const [chains, tvl, proto] = await withFixture("crypto-defillama", async () => [
      await llamaChains(5),
      await llamaTvl("aave"),
      await llamaProtocol("alpend"),
    ]);
    expect(chains!.points.find((p) => p.key === "DEFI.Ethereum.tvl")!.value).toBeGreaterThan(1e9);
    expect(tvl!.points[0]).toMatchObject({ key: "aave.defi.tvl", unit: "USD" });
    expect(proto!.points.find((p) => p.key === "alpend.defi.tvl")!.value).toBeGreaterThan(0);
    expect(proto!.provenance).toMatchObject({ source: "defillama", official: false });
  });
});
