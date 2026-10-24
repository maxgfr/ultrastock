import { describe, expect, it } from "vitest";
import {
  altmanZ,
  beneishM,
  capm,
  dcf,
  type FinancialPeriod,
  gordonValue,
  multiples,
  piotroski,
  qualityMetrics,
  residualIncome,
  reverseDcf,
  scenarioValue,
  wacc,
} from "../src/analytics/fundamentals.js";

const prev: FinancialPeriod = {
  end: "2024-12-31",
  revenue: 1000,
  costOfRevenue: 600,
  netIncome: 80,
  operatingCashFlow: 100,
  totalAssets: 1000,
  currentAssets: 400,
  currentLiabilities: 300,
  longTermDebt: 300,
  sharesOutstanding: 100,
  receivables: 100,
  ppe: 300,
  depreciation: 30,
  sga: 150,
  totalLiabilities: 600,
};
const cur: FinancialPeriod = {
  end: "2025-12-31",
  revenue: 1150,
  costOfRevenue: 650,
  netIncome: 110,
  operatingCashFlow: 150,
  capex: -40,
  totalAssets: 1050,
  currentAssets: 460,
  currentLiabilities: 300,
  longTermDebt: 280,
  sharesOutstanding: 99,
  receivables: 110,
  ppe: 310,
  depreciation: 32,
  sga: 160,
  totalLiabilities: 590,
  retainedEarnings: 300,
  equity: 460,
  ebit: 160,
  interestExpense: -15,
  pretaxIncome: 145,
  incomeTax: 35,
  cash: 60,
  totalDebt: 300,
  shareBasedComp: 10,
  dividendsPaid: -30,
  eps: 1.11,
};

describe("scores", () => {
  it("Piotroski: nine criteria with reasons, and incomplete data excluded rather than guessed", () => {
    const s = piotroski(cur, prev);
    expect(s.computed).toBe(9);
    expect(s.value).toBe(9);
    expect(s.verdict).toBe("strong");
    expect(s.components.find((c) => c.id === "dlever")!.reason).toMatch(/0\.300 → 0\.267/);
    const partial = piotroski({ end: "x", netIncome: 5 }, { end: "y" });
    expect(partial.computed).toBeLessThan(7);
    expect(partial.verdict).toMatch(/incomplete/);
  });
  it("Altman Z″ and Z, with zones", () => {
    const z = altmanZ(cur, 2000, "non-manufacturer");
    const expected = 6.56 * (160 / 1050) + 3.26 * (300 / 1050) + 6.72 * (160 / 1050) + 1.05 * (460 / 590);
    expect(z.value).toBeCloseTo(expected, 10);
    expect(z.verdict).toBe("safe zone");
    expect(altmanZ(cur, 2000, "manufacturer").components).toHaveLength(5);
    expect(altmanZ({ end: "x" }, 1).verdict).toBe("incomplete");
  });
  it("Beneish M: computes the eight indices", () => {
    const m = beneishM({ ...cur, grossProfit: 500 }, { ...prev, grossProfit: 400 });
    expect(m.computed).toBe(8);
    expect(Number.isFinite(m.value)).toBe(true);
    expect(m.components.find((c) => c.id === "sgi")!.value).toBeCloseTo(1.15, 10);
  });
});

describe("quality and multiples", () => {
  it("margins, FCF after SBC, ROIC, leverage, dividend cover", () => {
    const q = qualityMetrics(cur);
    expect(q.fcf).toBe(110);
    expect(q.fcfAfterSbc).toBe(100);
    expect(q.grossMargin).toBeCloseTo(500 / 1150, 10);
    expect(q.roic).toBeCloseTo((160 * (1 - 35 / 145)) / (300 + 460 - 60), 10);
    expect(q.netDebt).toBe(240);
    expect(q.interestCoverage).toBeCloseTo(160 / 15, 10);
    expect(q.dividendCover).toBeCloseTo(110 / 30, 10);
  });
  it("valuation multiples at a price", () => {
    const m = multiples(cur, 20, { epsGrowthPct: 12 })!;
    expect(m.marketCap).toBe(1980);
    expect(m.enterpriseValue).toBe(1980 + 300 - 60);
    expect(m.pe).toBeCloseTo(20 / 1.11, 10);
    expect(m.fcfYield).toBeCloseTo(110 / 1980, 10);
    expect(m.grahamNumber).toBeCloseTo(Math.sqrt(22.5 * 1.11 * (460 / 99)), 10);
    expect(m.peg).toBeCloseTo(20 / 1.11 / 12, 10);
    expect(multiples({ end: "x" }, 10)).toBeUndefined();
  });
});

describe("valuation", () => {
  it("DCF with a Gordon terminal value, and its terminal share", () => {
    const r = dcf({ baseCashFlow: 100, growth: [0.1, 0.1, 0.1], terminalGrowth: 0.02, discountRate: 0.09, netDebt: 200, shares: 10 });
    const cfs = [110, 121, 133.1];
    const pv = cfs.reduce((s, c, i) => s + c / 1.09 ** (i + 1), 0);
    const tv = (133.1 * 1.02) / 0.07;
    expect(r.enterpriseValue).toBeCloseTo(pv + tv / 1.09 ** 3, 8);
    expect(r.perShare).toBeCloseTo((r.enterpriseValue - 200) / 10, 8);
    expect(r.terminalShare).toBeGreaterThan(0.7);
    expect(() => dcf({ baseCashFlow: 1, growth: [0], terminalGrowth: 0.1, discountRate: 0.08, netDebt: 0, shares: 1 })).toThrow(/must exceed/);
  });
  it("reverse DCF recovers the growth a price implies", () => {
    const base = { baseCashFlow: 100, terminalGrowth: 0.02, discountRate: 0.09, netDebt: 200, shares: 10, years: 5 };
    const price = dcf({ ...base, growth: new Array(5).fill(0.07) }).perShare;
    expect(reverseDcf(price, base)).toBeCloseTo(0.07, 6);
  });
  it("Gordon, residual income, CAPM, WACC, scenarios", () => {
    expect(gordonValue(2, 0.08, 0.03)).toBeCloseTo(40, 10);
    expect(residualIncome(50, [0.08, 0.08], 0.08, 0.5)).toBeCloseTo(50, 10);
    expect(residualIncome(50, [0.12, 0.12], 0.08, 0.5)).toBeGreaterThan(50);
    expect(capm(0.03, 1.2, 0.05)).toBeCloseTo(0.09, 12);
    expect(wacc(600, 400, 0.09, 0.05, 0.25)).toBeCloseTo(0.6 * 0.09 + 0.4 * 0.05 * 0.75, 12);
    const s = scenarioValue(
      [
        { name: "bear", probability: 0.25, perShare: 60 },
        { name: "base", probability: 0.5, perShare: 100 },
        { name: "bull", probability: 0.25, perShare: 140 },
      ],
      80,
    );
    expect(s.expected).toBe(100);
    expect(s.marginOfSafety).toBeCloseTo(0.25, 12);
    expect(s.downside).toBeCloseTo(-0.25, 12);
    expect(() => scenarioValue([{ name: "x", probability: 0.5, perShare: 1 }], 1)).toThrow(/sum/);
  });
});
