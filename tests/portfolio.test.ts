import { describe, expect, it } from "vitest";
import { seededRandom } from "../src/analytics/performance.js";
import {
  blackLitterman,
  hierarchicalRiskParity,
  ledoitWolf,
  maxSharpe,
  minVariance,
  portfolioVariance,
  rebalance,
  riskContributions,
  riskParity,
  sampleCovariance,
} from "../src/analytics/portfolio.js";
import { atrStop, binaryKelly, expectancy, kellyFraction, rewardRisk, sizePosition, volTargetWeight } from "../src/analytics/sizing.js";

const diag = (vols: number[]) => vols.map((v, i) => vols.map((_, j) => (i === j ? v * v : 0)));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("covariance", () => {
  it("sample covariance and Ledoit–Wolf shrinkage between 0 and 1", () => {
    const u = seededRandom(3);
    const a = Array.from({ length: 300 }, () => u() - 0.5);
    const b = a.map((x) => x * 0.5 + (u() - 0.5) * 0.5);
    const c = Array.from({ length: 300 }, () => u() - 0.5);
    const s = sampleCovariance([a, b, c]);
    expect(s[0]![1]).toBeCloseTo(s[1]![0]!, 15);
    const lw = ledoitWolf([a, b, c]);
    expect(lw.shrinkage).toBeGreaterThanOrEqual(0);
    expect(lw.shrinkage).toBeLessThanOrEqual(1);
    expect(lw.cov[0]![0]).toBeGreaterThan(0);
  });
});

describe("allocation", () => {
  it("minimum variance on uncorrelated assets weights by inverse variance", () => {
    const w = minVariance(diag([0.1, 0.2]));
    expect(w[0]).toBeCloseTo(0.8, 3);
    expect(sum(w)).toBeCloseTo(1, 10);
    const capped = minVariance(diag([0.1, 0.2, 0.3]), { maxWeight: 0.5 });
    expect(Math.max(...capped)).toBeLessThanOrEqual(0.5 + 1e-9);
  });
  it("risk parity equalises risk contributions", () => {
    const cov = [
      [0.04, 0.006, 0.002],
      [0.006, 0.09, 0.01],
      [0.002, 0.01, 0.0225],
    ];
    const rc = riskContributions(riskParity(cov), cov);
    for (const x of rc) expect(x).toBeCloseTo(1 / 3, 4);
  });
  it("HRP gives positive weights summing to one and favours low-vol assets", () => {
    const w = hierarchicalRiskParity(diag([0.1, 0.2, 0.4]));
    expect(sum(w)).toBeCloseTo(1, 10);
    expect(w[0]).toBeGreaterThan(w[2]!);
  });
  it("max Sharpe beats equal weight and minimum variance on Sharpe", () => {
    const cov = diag([0.15, 0.2, 0.25]);
    const mu = [0.05, 0.1, 0.06];
    const s = (w: number[]) => sum(w.map((x, i) => x * mu[i]!)) / Math.sqrt(portfolioVariance(w, cov));
    const w = maxSharpe(mu, cov);
    expect(s(w)).toBeGreaterThanOrEqual(s([1 / 3, 1 / 3, 1 / 3]) - 1e-9);
    // Unconstrained tangency ∝ Σ⁻¹μ on a diagonal Σ: μ_i / σ_i².
    const t = mu.map((m, i) => m / cov[i]![i]!);
    const tn = t.map((x) => x / sum(t));
    for (let i = 0; i < 3; i++) expect(w[i]).toBeCloseTo(tn[i]!, 2);
  });
  it("Black–Litterman: no views → implied returns; a confident view moves them", () => {
    const cov = diag([0.15, 0.2]);
    const mkt = [0.6, 0.4];
    const none = blackLitterman(cov, mkt, []);
    expect(none.posterior).toEqual(none.implied);
    const v = blackLitterman(cov, mkt, [{ pick: [1, 0], expected: 0.2, confidence: 0.9 }]);
    expect(v.posterior[0]!).toBeGreaterThan(v.implied[0]!);
  });
});

describe("rebalancing", () => {
  it("trades only beyond the band, and steers new money to underweights first", () => {
    const r = rebalance({ A: 70, B: 30 }, { A: 60, B: 40 }, { bandPct: 5 });
    expect(r.trades.map((t) => [t.asset, Math.round(t.amount)])).toEqual([
      ["A", -10],
      ["B", 10],
    ]);
    expect(rebalance({ A: 62, B: 38 }, { A: 60, B: 40 }, { bandPct: 5, relBand: 1 }).trades).toEqual([]);
    const c = rebalance({ A: 70, B: 30 }, { A: 60, B: 40 }, { bandPct: 5, contribution: 20 });
    expect(c.trades.find((t) => t.asset === "B")!.amount).toBeCloseTo(18, 6);
    expect(c.trades.some((t) => t.amount < 0)).toBe(false);
  });
});

describe("sizing", () => {
  it("risk sizing is bound by the smallest constraint and rounds down to the lot", () => {
    const r = sizePosition({ equity: 100_000, entry: 50, stop: 48, riskPct: 1, maxPositionPct: 10 });
    expect(r.quantity).toBe(200);
    expect(r.binding).toBe("position cap");
    const s = sizePosition({ equity: 100_000, entry: 50, stop: 45, riskPct: 0.5, maxPositionPct: 20 });
    expect(s.quantity).toBe(100);
    expect(s.binding).toBe("risk per trade");
    expect(s.riskAmount).toBe(500);
    const crypto = sizePosition({ equity: 10_000, entry: 80_000, stop: 76_000, riskPct: 1, maxPositionPct: 10, fractional: true, lot: 0.0001 });
    expect(crypto.quantity).toBeCloseTo(0.0125, 10);
    expect(sizePosition({ equity: 1_000, entry: 500, stop: 490, riskPct: 0.1, maxPositionPct: 10 }).quantity).toBe(0);
    expect(() => sizePosition({ equity: 1, entry: 1, stop: 1, riskPct: 1, maxPositionPct: 1 })).toThrow(/stop equals/);
  });
  it("Kelly, binary Kelly, vol targeting, expectancy, R:R, ATR stop", () => {
    expect(kellyFraction(0.55, 1, { sampleSize: 100 }).full).toBeCloseTo(0.1, 12);
    expect(kellyFraction(0.55, 1, { sampleSize: 100 }).applied).toBeCloseTo(0.05, 12);
    expect(kellyFraction(0.55, 1, { sampleSize: 10 }).applied).toBeCloseTo(0.01, 12);
    expect(kellyFraction(0.4, 1).applied).toBe(0);
    expect(binaryKelly(0.6, 0.5, 1)).toBeCloseTo(0.2, 12);
    expect(volTargetWeight(0.4, 0.1)).toBe(0.25);
    const e = expectancy([2, -1, 3, -1]);
    expect(e.expectancyR).toBeCloseTo(0.75, 12);
    expect(e.profitFactor).toBeCloseTo(2.5, 12);
    expect(rewardRisk(100, 95, 115)).toBe(3);
    expect(atrStop(100, 2.5)).toBe(95);
  });
});
