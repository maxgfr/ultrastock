import { describe, expect, it } from "vitest";
import { difficultyPoints, feePoints, hashratePoints, mempoolNetwork } from "../src/providers/crypto/mempool.js";
import { withFixture } from "./helpers/fixtures.js";

describe("mempool.space parsers", () => {
  it("turns fee tiers, hashrate and the epoch into points", () => {
    const fees = feePoints({ fastestFee: 5, halfHourFee: 3, hourFee: 2, economyFee: 1, minimumFee: 1 }, "2026-10-24");
    expect(fees[0]).toEqual({ key: "BTC.onchain.fee.fastest", label: "BTC recommended fee (next block)", value: 5, unit: "sat/vB", asOf: "2026-10-24" });
    const h = hashratePoints({ hashrates: [{ timestamp: 1792800000, avgHashrate: 1.2e21 }], currentHashrate: 1e21, currentDifficulty: 1.4e14 });
    expect(h.map((p) => [p.key, p.value])).toEqual([
      ["BTC.onchain.hashrate.daily", 1200],
      ["BTC.onchain.hashrate.current", 1000],
      ["BTC.onchain.difficulty", 1.4e14],
    ]);
    expect(h[0]!.asOf).toBe("2026-10-24");
    const d = difficultyPoints({
      progressPercent: 60.8,
      difficultyChange: 5.2,
      estimatedRetargetDate: 1793304837603,
      remainingBlocks: 789,
      previousRetarget: 5.9,
      nextRetargetHeight: 973728,
    });
    expect(d.find((p) => p.key === "BTC.onchain.epoch.retargetDate")!.value).toBe("2026-10-29");
  });
});

describe("mempool.space fixture", () => {
  it("replays fees, hashrate and the difficulty epoch", async () => {
    const ds = await withFixture("crypto-mempool", () => mempoolNetwork());
    expect(ds).toHaveLength(3);
    expect(ds[0]!.provenance).toMatchObject({ source: "mempool.space", official: false });
    expect(ds[0]!.points.find((p) => p.key === "BTC.onchain.fee.fastest")!.value).toBeGreaterThan(0);
    expect(ds[1]!.points.find((p) => p.key === "BTC.onchain.hashrate.daily")!.value).toBeGreaterThan(100);
    expect(ds[2]!.points.some((p) => p.key === "BTC.onchain.epoch.progress")).toBe(true);
  });
});
