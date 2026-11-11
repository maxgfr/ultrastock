import { describe, expect, it } from "vitest";
import {
  americanBinomial,
  blackScholes,
  chainSentiment,
  type ChainOption,
  expectedMove,
  gammaExposure,
  impliedVol,
  ivRank,
  maxPain,
  payoffAtExpiry,
  pnlMatrix,
  strategyProfile,
  unusualActivity,
} from "../src/analytics/options.js";

// Hull, Options, Futures and Other Derivatives, example 15.6: S=42, K=40, r=10%, σ=20%, T=0.5 → c=4.76, p=0.81.
const hull = { spot: 42, strike: 40, t: 0.5, r: 0.1, vol: 0.2 };

describe("Black–Scholes", () => {
  it("matches Hull's textbook example and put–call parity", () => {
    const c = blackScholes("call", hull);
    const p = blackScholes("put", hull);
    expect(c.price).toBeCloseTo(4.76, 2);
    expect(p.price).toBeCloseTo(0.81, 2);
    expect(c.price - p.price).toBeCloseTo(42 - 40 * Math.exp(-0.05), 6);
    expect(c.delta - p.delta).toBeCloseTo(1, 6);
    expect(c.gamma).toBeCloseTo(p.gamma, 10);
  });
  it("Greeks agree with finite differences", () => {
    const h = 1e-4;
    const g = blackScholes("call", hull);
    const up = blackScholes("call", { ...hull, spot: 42 + h }).price;
    const dn = blackScholes("call", { ...hull, spot: 42 - h }).price;
    expect(g.delta).toBeCloseTo((up - dn) / (2 * h), 5);
    expect(g.gamma).toBeCloseTo((up - 2 * g.price + dn) / (h * h), 3);
    expect(g.vega).toBeCloseTo((blackScholes("call", { ...hull, vol: 0.2 + h }).price - blackScholes("call", { ...hull, vol: 0.2 - h }).price) / (2 * h), 3);
    expect(g.theta).toBeCloseTo(-(blackScholes("call", { ...hull, t: 0.5 + h }).price - blackScholes("call", { ...hull, t: 0.5 - h }).price) / (2 * h), 3);
  });
  it("expired and zero-vol options are worth their intrinsic value", () => {
    expect(blackScholes("call", { ...hull, t: 0 }).price).toBe(2);
    expect(blackScholes("put", { ...hull, t: 0 }).price).toBe(0);
  });
  it("at zero volatility before expiry, is worth the discounted forward intrinsic value — the limit of the formula", () => {
    // Nothing moves but the carry: the call pays 42·e^(−qt) − 40·e^(−rt) for sure, not 42 − 40 = 2.
    const c = blackScholes("call", { ...hull, vol: 0 });
    expect(c.price).toBeCloseTo(42 - 40 * Math.exp(-0.05), 10);
    expect(c.price).toBeCloseTo(blackScholes("call", { ...hull, vol: 1e-6 }).price, 8);
    expect(c.delta).toBe(1);
    expect(c.rho).toBeCloseTo(40 * 0.5 * Math.exp(-0.05), 10);
    expect(c.theta).toBeCloseTo(blackScholes("call", { ...hull, vol: 1e-6 }).theta, 6);
    // A put out of the money at the forward is worth nothing; in the money, the discounted strike less the spot.
    expect(blackScholes("put", { ...hull, vol: 0 }).price).toBe(0);
    const p = blackScholes("put", { ...hull, spot: 30, q: 0.02, vol: 0 });
    expect(p.price).toBeCloseTo(40 * Math.exp(-0.05) - 30 * Math.exp(-0.01), 10);
    expect(p.delta).toBeCloseTo(-Math.exp(-0.01), 10);
  });
});

describe("implied volatility", () => {
  it("inverts the price, and refuses arbitrage-violating prices", () => {
    for (const vol of [0.08, 0.2, 0.6, 1.5]) {
      for (const right of ["call", "put"] as const) {
        const price = blackScholes(right, { ...hull, vol }).price;
        expect(impliedVol(right, price, hull)).toBeCloseTo(vol, 6);
      }
    }
    expect(impliedVol("call", 50, hull)).toBeUndefined();
    expect(impliedVol("call", 0.5, hull)).toBeUndefined();
  });
});

describe("American options", () => {
  it("a binomial tree converges to Black–Scholes for a call without dividends, and values early exercise for a put", () => {
    const c = americanBinomial("call", hull, 800);
    expect(c.price).toBeCloseTo(blackScholes("call", hull).price, 2);
    expect(c.earlyExercisePremium).toBeCloseTo(0, 2);
    const p = americanBinomial("put", { ...hull, spot: 36, r: 0.1 }, 800);
    expect(p.earlyExercisePremium).toBeGreaterThan(0.05);
  });
  it("is worth its intrinsic value at expiry, not NaN", () => {
    expect(americanBinomial("call", { ...hull, t: 0 })).toEqual({ price: 2, delta: 1, earlyExercisePremium: 0 });
    expect(americanBinomial("put", { ...hull, t: 0 })).toEqual({ price: 0, delta: 0, earlyExercisePremium: 0 });
    expect(americanBinomial("put", { ...hull, spot: 36, t: 0 })).toEqual({ price: 4, delta: -1, earlyExercisePremium: 0 });
  });
  it("is worth its best deterministic exercise at zero volatility, not NaN", () => {
    // Deep in-the-money put, no dividend: exercise now (10) beats waiting (110·e^−0.05 − 100 ≈ 4.64, the European).
    const put = americanBinomial("put", { spot: 100, strike: 110, t: 1, r: 0.05, vol: 0 });
    expect(put.price).toBeCloseTo(10, 10);
    expect(put.delta).toBe(-1);
    expect(put.earlyExercisePremium).toBeCloseTo(10 - blackScholes("put", { spot: 100, strike: 110, t: 1, r: 0.05, vol: 0 }).price, 10);
    // A call without dividend is never exercised early: the European's discounted forward.
    const call = americanBinomial("call", { spot: 100, strike: 90, t: 1, r: 0.05, vol: 0 });
    expect(call.price).toBeCloseTo(100 - 90 * Math.exp(-0.05), 10);
    expect(call.earlyExercisePremium).toBeCloseTo(0, 10);
    // Out of the money all the way: worthless.
    expect(americanBinomial("call", { spot: 80, strike: 90, t: 1, r: 0.01, vol: -0.1 })).toEqual({ price: 0, delta: 0, earlyExercisePremium: 0 });
    // A dividend-paying call whose best exercise falls inside the life: S·e^−qτ − K·e^−rτ peaks at τ* = ln(rK / qS) / (r − q).
    const inside = { spot: 100, strike: 90, t: 20, r: 0.05, q: 0.04, vol: 0 };
    const tau = Math.log((0.05 * 90) / (0.04 * 100)) / 0.01;
    const best = 100 * Math.exp(-0.04 * tau) - 90 * Math.exp(-0.05 * tau);
    expect(americanBinomial("call", inside).price).toBeCloseTo(best, 10);
    expect(best).toBeGreaterThan(Math.max(10, blackScholes("call", inside).price));
    // The tree agrees once the volatility is small (yet above the carry per step, where its probabilities stay in [0, 1]).
    expect(americanBinomial("call", { ...inside, vol: 0.003 }, 2000).price).toBeCloseTo(best, 1);
  });
});

describe("strategies", () => {
  const bullCall = [
    { right: "call" as const, quantity: 1, strike: 100, price: 5, vol: 0.3, t: 0.25 },
    { right: "call" as const, quantity: -1, strike: 110, price: 2, vol: 0.3, t: 0.25 },
  ];
  it("profiles a bull call spread", () => {
    const p = strategyProfile(bullCall, 100);
    expect(p.maxProfit).toBeCloseTo(7, 6);
    expect(p.maxLoss).toBeCloseTo(-3, 6);
    expect(p.breakevens[0]).toBeCloseTo(103, 2);
    expect(p.netDebit).toBe(3);
    expect(p.unlimitedUpside).toBe(false);
  });
  it("sees a naked short call's unlimited risk and a covered call's capped upside", () => {
    expect(strategyProfile([{ right: "call", quantity: -1, strike: 100, price: 4 }], 100).unlimitedDownside).toBe(true);
    const cc = strategyProfile(
      [
        { right: "stock", quantity: 1, price: 100 },
        { right: "call", quantity: -1, strike: 110, price: 3 },
      ],
      100,
    );
    expect(cc.maxProfit).toBeCloseTo(13, 6);
    expect(payoffAtExpiry([{ right: "stock", quantity: 1, price: 100 }], 90)).toBe(-10);
  });
  it("builds a P&L matrix by move and date", () => {
    const m = pnlMatrix(bullCall, 100, 0.04, { moves: [-0.1, 0, 0.2], daysForward: [0, 90] });
    expect(m.pnl).toHaveLength(3);
    expect(m.pnl[2]![1]).toBeCloseTo(7, 1);
    expect(m.pnl[0]![1]).toBeCloseTo(-3, 1);
  });
});

describe("chain readings", () => {
  const exp = "2026-11-20";
  const chain: ChainOption[] = [90, 95, 100, 105, 110].flatMap((k) => [
    {
      right: "call" as const,
      strike: k,
      t: 0.07,
      expiry: exp,
      bid: Math.max(0.1, 100 - k + 2),
      ask: Math.max(0.2, 100 - k + 2.4),
      iv: 0.3,
      gamma: 0.03,
      openInterest: k === 110 ? 9000 : 1000,
      volume: 100,
      delta: 0.5 - (k - 100) / 40,
    },
    {
      right: "put" as const,
      strike: k,
      t: 0.07,
      expiry: exp,
      bid: Math.max(0.1, k - 100 + 2),
      ask: Math.max(0.2, k - 100 + 2.4),
      iv: 0.34,
      gamma: 0.03,
      openInterest: k === 90 ? 8000 : 1200,
      volume: 150,
      delta: -0.5 - (k - 100) / 40,
    },
  ]);
  it("expected move, max pain, GEX walls and sentiment", () => {
    const em = expectedMove(chain, 100.4, exp)!;
    expect(em.atmStrike).toBe(100);
    expect(em.straddle).toBeCloseTo(4.4, 6);
    expect(em.move1sd).toBeCloseTo(4.4 * Math.sqrt(Math.PI / 2), 6);
    expect(maxPain(chain, exp)!.strike).toBe(100);
    const g = gammaExposure(chain, 100);
    expect(g.callWall).toBe(110);
    expect(g.putWall).toBe(90);
    const s = chainSentiment(chain);
    expect(s.putCallVolume).toBeCloseTo(1.5, 6);
    expect(s.skew25d).toBeCloseTo(0.04, 6);
  });
  it("IV rank and unusual activity", () => {
    expect(
      ivRank(
        [...Array(19)].map((_, i) => 0.2 + i * 0.01),
        0.3,
      ),
    ).toBeUndefined();
    const r = ivRank(
      [...Array(30)].map((_, i) => 0.2 + i * 0.01),
      0.3,
    )!;
    expect(r.rank).toBeCloseTo((0.1 / 0.29) * 100, 6);
    const spiky = chain.map((o, i) => (i === 3 ? { ...o, volume: 50000 } : o));
    const u = unusualActivity(spiky);
    expect(u[0]?.strike).toBe(95);
  });
});
