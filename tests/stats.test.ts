import { describe, expect, it } from "vitest";
import {
  bootstrapVar,
  cagr,
  cornishFisherVar,
  deflatedSharpe,
  drawdowns,
  equityCurve,
  expectedMaxSharpe,
  historicalCvar,
  historicalVar,
  omega,
  parametricVar,
  performanceSummary,
  probabilisticSharpe,
  relativeTo,
  seededRandom,
  sharpe,
  sortino,
} from "../src/analytics/performance.js";
import {
  adfTest,
  correlation,
  cusumBreaks,
  engleGranger,
  excessKurtosis,
  garch11,
  garmanKlassVol,
  halfLife,
  hmm2,
  hurstExponent,
  lowerTailDependence,
  mean,
  nelderMead,
  normCdf,
  normInv,
  ols,
  parkinsonVol,
  percentileRank,
  quantile,
  skewness,
  spearman,
  stdev,
  variance,
  yangZhangVol,
} from "../src/analytics/stats.js";

/** Standard normal draws from a seeded generator (Box–Muller). */
function normals(n: number, seed = 7): number[] {
  const u = seededRandom(seed);
  const out: number[] = [];
  while (out.length < n) {
    const a = Math.max(u(), 1e-12);
    const b = u();
    out.push(Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b), Math.sqrt(-2 * Math.log(a)) * Math.sin(2 * Math.PI * b));
  }
  return out.slice(0, n);
}

describe("descriptive statistics", () => {
  it("moments, quantiles and ranks", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.571428571, 8);
    expect(stdev([1, 1, 1])).toBe(0);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([5], 0.9)).toBe(5);
    expect(percentileRank([1, 2, 3, 4], 2)).toBe(0.5);
    expect(skewness([1, 2, 3, 4, 5])).toBeCloseTo(0, 12);
    const z = normals(20000);
    expect(Math.abs(skewness(z))).toBeLessThan(0.05);
    expect(Math.abs(excessKurtosis(z))).toBeLessThan(0.1);
  });
  it("correlations", () => {
    expect(correlation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(correlation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1, 12);
  });
  it("normal distribution", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.959963985)).toBeCloseTo(0.975, 6);
    expect(normInv(0.975)).toBeCloseTo(1.959963985, 7);
    expect(normInv(0.05)).toBeCloseTo(-1.644853627, 7);
    for (const p of [0.001, 0.2, 0.5, 0.8, 0.999]) expect(normCdf(normInv(p))).toBeCloseTo(p, 6);
  });
});

describe("regression", () => {
  it("recovers an exact line", () => {
    const x = [1, 2, 3, 4, 5, 6];
    const r = ols(
      x.map((v) => 2 + 3 * v),
      [x],
    );
    expect(r.coef[0]).toBeCloseTo(2, 10);
    expect(r.coef[1]).toBeCloseTo(3, 10);
    expect(r.r2).toBeCloseTo(1, 10);
  });
  it("gives HAC standard errors wider than OLS under autocorrelated errors", () => {
    const e = normals(600, 3);
    const ar: number[] = [];
    e.forEach((v, i) => ar.push((i ? ar[i - 1]! * 0.8 : 0) + v));
    const x = normals(600, 11).map((v, i) => v + (i ? 0 : 0));
    const xs: number[] = [];
    x.forEach((v, i) => xs.push((i ? xs[i - 1]! * 0.8 : 0) + v));
    const r = ols(
      xs.map((v, i) => 1 + 0.5 * v + ar[i]!),
      [xs],
    );
    expect(r.coef[1]).toBeGreaterThan(0.3);
    expect(r.hacSe[1]!).toBeGreaterThan(r.se[1]!);
    expect(() => ols([1, 2], [[1, 2]])).toThrow(/more observations/);
  });
  it("minimises with Nelder–Mead", () => {
    const r = nelderMead(([a, b]) => (a! - 1) ** 2 + 100 * (b! - a! * a!) ** 2, [-1, 2], { maxIter: 5000 });
    expect(r.x[0]).toBeCloseTo(1, 3);
    expect(r.x[1]).toBeCloseTo(1, 3);
  });
});

describe("volatility", () => {
  it("range estimators agree on a constant-range series", () => {
    const bars = Array.from({ length: 50 }, () => ({ open: 100, high: 102, low: 98, close: 100 }));
    expect(parkinsonVol(bars)).toBeCloseTo(Math.log(102 / 98) / Math.sqrt(4 * Math.log(2)), 10);
    expect(garmanKlassVol(bars)).toBeGreaterThan(0);
    expect(yangZhangVol(bars)).toBeGreaterThan(0);
  });
  it("GARCH(1,1) recovers simulated parameters", () => {
    const z = normals(4000, 21);
    const [omega, alpha, beta] = [2e-6, 0.08, 0.9];
    let h = omega / (1 - alpha - beta);
    const r = z.map((v) => {
      const x = Math.sqrt(h) * v;
      h = omega + alpha * x * x + beta * h;
      return x;
    });
    const g = garch11(r, 5);
    expect(g.alpha).toBeGreaterThan(0.04);
    expect(g.alpha).toBeLessThan(0.14);
    expect(g.beta).toBeGreaterThan(0.82);
    expect(g.persistence).toBeLessThan(1);
    expect(g.longRunVol).toBeCloseTo(Math.sqrt(omega / (1 - alpha - beta)), 2);
    expect(g.forecast).toHaveLength(5);
  });
});

describe("mean reversion and regimes", () => {
  const z = normals(1500, 5);
  const walk: number[] = [];
  z.forEach((v, i) => walk.push((i ? walk[i - 1]! : 100) + v));
  const ar: number[] = [];
  z.forEach((v, i) => ar.push((i ? ar[i - 1]! * 0.9 : 0) + v));
  it("ADF tells a random walk from a stationary AR(1)", () => {
    expect(adfTest(walk).stationary5).toBe(false);
    expect(adfTest(ar).stationary5).toBe(true);
    expect(halfLife(ar)).toBeGreaterThan(4);
    expect(halfLife(ar)).toBeLessThan(11);
  });
  it("Hurst of white noise is near one half", () => {
    const h = hurstExponent(z);
    expect(h).toBeGreaterThan(0.4);
    expect(h).toBeLessThan(0.65);
  });
  it("Engle–Granger finds a cointegrated pair and its hedge ratio", () => {
    const y = walk.map((v, i) => 1 + 2 * v + ar[i]! * 0.5);
    const r = engleGranger(y, walk);
    expect(r.beta).toBeCloseTo(2, 1);
    expect(r.cointegrated5).toBe(true);
    const other: number[] = [];
    normals(1500, 99).forEach((v, i) => other.push((i ? other[i - 1]! : 50) + v));
    expect(engleGranger(other, walk).cointegrated5).toBe(false);
  });
  it("a two-state HMM separates calm and turbulent blocks with filtered probabilities", () => {
    const calm = normals(300, 1).map((v) => v * 0.005);
    const wild = normals(300, 2).map((v) => v * 0.025);
    const r = [...calm, ...wild, ...calm.map((v) => v * 1.1)];
    const m = hmm2(r);
    expect(m.vols[0]).toBeLessThan(m.vols[1]);
    const p = m.turbulentProbability;
    expect(mean(p.slice(350, 590))).toBeGreaterThan(0.8);
    expect(mean(p.slice(20, 280))).toBeLessThan(0.2);
  });
  it("CUSUM flags a mean shift; tail dependence of a series with itself is 1", () => {
    const shifted = [...normals(200, 8), ...normals(200, 9).map((v) => v + 3)];
    expect(cusumBreaks(shifted).length).toBeGreaterThan(0);
    expect(lowerTailDependence(z, z)).toBe(1);
  });
});

describe("performance", () => {
  it("drawdowns, CAGR, Sharpe, Sortino, omega", () => {
    const dd = drawdowns([1, 2, 1, 3]);
    expect(dd.maxDrawdown).toBe(-0.5);
    expect([dd.peakIndex, dd.troughIndex, dd.recoveryIndex]).toEqual([1, 2, 3]);
    expect(cagr([100, 110, 121], 1)).toBeCloseTo(0.1, 12);
    expect(sharpe([0.01, 0.01], 252)).toBeNaN();
    const r = [0.01, -0.005, 0.02, -0.01, 0.015];
    expect(sharpe(r, 252)).toBeCloseTo((mean(r) / stdev(r)) * Math.sqrt(252), 10);
    expect(sortino(r, 252)).toBeGreaterThan(sharpe(r, 252));
    expect(omega([0.02, -0.01])).toBe(2);
    expect(equityCurve([0.1, -0.5])).toEqual([1, 1.1, 0.55]);
  });
  it("VaR family", () => {
    const r = normals(10000, 4).map((v) => v * 0.01);
    expect(historicalVar(r, 0.95)).toBeCloseTo(0.01645, 3);
    expect(parametricVar(r, 0.99)).toBeCloseTo(0.02326, 3);
    expect(historicalCvar(r, 0.95)).toBeGreaterThan(historicalVar(r, 0.95));
    expect(cornishFisherVar(r, 0.95)).toBeCloseTo(parametricVar(r, 0.95), 3);
    const b = bootstrapVar(r, 10, 0.95, 2000);
    expect(b.var).toBeGreaterThan(historicalVar(r, 0.95));
    expect(bootstrapVar(r, 10, 0.95, 2000)).toEqual(b);
  });
  it("probabilistic and deflated Sharpe", () => {
    expect(probabilisticSharpe(0.1, 252, 0, 0)).toBeCloseTo(normCdf((0.1 * Math.sqrt(251)) / Math.sqrt(1 + 0.005)), 10);
    expect(expectedMaxSharpe(1000, 0.01)).toBeGreaterThan(expectedMaxSharpe(10, 0.01));
    const d10 = deflatedSharpe(0.1, 252, 0, 0, 10, 0.003);
    const d1000 = deflatedSharpe(0.1, 252, 0, 0, 1000, 0.003);
    expect(d1000).toBeLessThan(d10);
  });
  it("relative statistics and the summary", () => {
    const b = normals(500, 12).map((v) => v * 0.01);
    const r = b.map((v) => 1.5 * v + 0.0002);
    const rel = relativeTo(r, b, 252);
    expect(rel.beta).toBeCloseTo(1.5, 10);
    expect(rel.alpha).toBeCloseTo(0.0002 * 252, 6);
    expect(rel.correlation).toBeCloseTo(1, 10);
    const s = performanceSummary(r, 252, { benchmark: b });
    expect(s.periods).toBe(500);
    expect(s.relative!.beta).toBeCloseTo(1.5, 10);
    expect(s.maxDrawdown).toBeLessThan(0);
  });
});
