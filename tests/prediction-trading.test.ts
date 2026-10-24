import { describe, expect, it } from "vitest";
import { defaultProfile } from "../src/core/profile.js";
import { kalshiTakerFee, outcomeBook, parsePredictionSymbol, walkOutcome } from "../src/trading/prediction.js";
import { type GateContext, type Order, riskGate } from "../src/trading/riskgate.js";

const contract = (o: Partial<Order> = {}): Order => ({
  account: "kalshi",
  symbol: "KALSHI:FED-26DEC-T4.25:YES",
  side: "buy",
  quantity: 10,
  price: 0.4,
  orderType: "limit",
  currency: "USD",
  assetKind: "prediction",
  venue: "paper",
  ...o,
});
const ctx = (jurisdiction = "FR", c: Partial<GateContext> = {}): GateContext => {
  const profile = defaultProfile(jurisdiction, "EUR");
  profile.constraints.allowPredictionMarkets = true;
  return {
    profile,
    equityBase: 10_000,
    cashBase: 5_000,
    fxToBase: 0.9,
    positionValueBase: 0,
    heldQuantity: 0,
    cryptoValueBase: 0,
    openSymbols: [],
    pendingBuysBase: {},
    ordersToday: 0,
    lastPrice: 0.4,
    quoteAt: "2026-10-24T10:00:00Z",
    now: new Date("2026-10-24T10:01:00Z"),
    maxQuoteAgeMs: 15 * 60_000,
    breaker: { tripped: false, sizeMultiplier: 1 },
    ...c,
  };
};
const codes = (r: ReturnType<typeof riskGate>, s: "block" | "warn") => r.checks.filter((c) => c.status === s).map((c) => c.code);

describe("prediction contracts", () => {
  it("parse, fee, the NO book, and a walk within the limit", () => {
    expect(parsePredictionSymbol("kalshi:fed-26dec-t4.25:no")).toEqual({ venue: "kalshi", ticker: "FED-26DEC-T4.25", outcome: "NO" });
    expect(parsePredictionSymbol("MC.PA")).toBeUndefined();
    // 0.07 × 10 × 0.4 × 0.6 = 0.168 → 0.17
    expect(kalshiTakerFee(10, 0.4)).toBe(0.17);
    expect(kalshiTakerFee(100, 0.5)).toBe(1.75);
    const yes = {
      bids: [{ price: 0.38, size: 50 }],
      asks: [
        { price: 0.41, size: 4 },
        { price: 0.42, size: 20 },
      ],
    };
    expect(outcomeBook(yes, "NO")).toEqual({
      bids: [
        { price: 0.59, size: 4 },
        { price: 0.58, size: 20 },
      ],
      asks: [{ price: 0.62, size: 50 }],
    });
    expect(walkOutcome(yes, "buy", 10, 0.42)).toEqual({ price: (4 * 0.41 + 6 * 0.42) / 10, levels: 2 });
    expect(walkOutcome(yes, "buy", 10, 0.41)).toBeUndefined();
    expect(walkOutcome(yes, "sell", 10, 0.38)).toMatchObject({ price: 0.38 });
  });

  it("the gate: blocked venues never (even paper), unverified ones paper only, the stake is the risk", () => {
    const paper = riskGate(contract(), ctx("FR"));
    expect(codes(paper, "block")).toEqual([]);
    expect(codes(paper, "warn")).toContain("JURISDICTION");
    expect(paper.checks.find((c) => c.code === "RISK_PER_TRADE")!.reason).toMatch(/whole stake 3\.60/);
    const live = riskGate(contract({ venue: "kalshi" }), ctx("FR"));
    expect(codes(live, "block")).toContain("JURISDICTION");
    const poly = riskGate(contract({ symbol: "POLYMARKET:SOME-MARKET:YES" }), ctx("FR"));
    expect(poly.checks.find((c) => c.code === "JURISDICTION")).toMatchObject({ status: "block", reason: expect.stringMatching(/not even on paper/) });
    const big = riskGate(contract({ quantity: 1000, price: 0.5 }), ctx("FR"));
    expect(codes(big, "block")).toContain("RISK_PER_TRADE");
    const off = ctx("FR");
    off.profile.constraints.allowPredictionMarkets = false;
    expect(codes(riskGate(contract(), off), "block")).toContain("NO_PREDICTION");
  });
});
