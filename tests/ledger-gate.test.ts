import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultProfile } from "../src/core/profile.js";
import { appendTransactions, buildBook, readLedger, type Transaction, transactionId, valueBook, xirr } from "../src/portfolio/ledger.js";
import { breakerState, closedTradeResults } from "../src/trading/breaker.js";
import { type GateContext, killSwitchPath, type Order, orderFingerprint, riskGate } from "../src/trading/riskgate.js";

const tx = (t: Omit<Transaction, "id" | "origin" | "currency"> & { currency?: string }): Transaction =>
  ({ origin: "manual", currency: "EUR", ...t, id: transactionId({ origin: "manual", currency: "EUR", ...t }) }) as Transaction;

describe("ledger", () => {
  it("recomputes positions with PMP and FIFO, splits, dividends and cash", () => {
    const b = buildBook([
      tx({ date: "2026-01-02", type: "deposit", account: "cto", amount: 10_000 }),
      tx({ date: "2026-01-05", type: "buy", account: "cto", symbol: "MC.PA", quantity: 10, price: 500, fee: 5 }),
      tx({ date: "2026-02-05", type: "buy", account: "cto", symbol: "MC.PA", quantity: 10, price: 400, fee: 5 }),
      tx({ date: "2026-03-05", type: "sell", account: "cto", symbol: "MC.PA", quantity: 5, price: 450, fee: 5 }),
      tx({ date: "2026-04-01", type: "dividend", account: "cto", symbol: "MC.PA", amount: 60 }),
    ]);
    const p = b.positions.find((x) => x.symbol === "MC.PA")!;
    expect(p.quantity).toBe(15);
    expect(p.averageCost).toBeCloseTo(9010 / 20, 10);
    expect(p.realizedPmp).toBeCloseTo(((5 * 450 - 5) / 5) * 5 - (9010 / 20) * 5, 8);
    expect(p.realizedFifo).toBeCloseTo(5 * 450 - 5 - 5 * 500.5, 8);
    expect(p.lots[0]).toMatchObject({ quantity: 5 });
    expect(b.cash[0]!.amount).toBeCloseTo(10_000 - 5005 - 4005 + 2245 + 60, 8);
    const s = buildBook([
      tx({ date: "2026-01-05", type: "buy", account: "x", symbol: "NVDA", quantity: 1, price: 1000, currency: "USD" }),
      tx({ date: "2026-02-01", type: "split", account: "x", symbol: "NVDA", quantity: 10, currency: "USD" }),
    ]);
    expect(s.positions[0]).toMatchObject({ quantity: 10, averageCost: 100 });
    expect(() => buildBook([tx({ date: "2026-01-05", type: "sell", account: "x", symbol: "A", quantity: 1, price: 1 })])).toThrow(/missing a buy/);
  });
  it("appends under a lock, skips duplicates, and refuses malformed transactions", async () => {
    const t = { date: "2026-01-05", type: "buy" as const, account: "pea", symbol: "CW8.PA", quantity: 2, price: 500, currency: "EUR", origin: "import:test" };
    expect((await appendTransactions([t])).added).toHaveLength(1);
    expect((await appendTransactions([t])).duplicates).toBe(1);
    expect(readLedger()).toHaveLength(1);
    await expect(appendTransactions([{ ...t, quantity: -1 }])).rejects.toThrow(/positive quantity/);
    await expect(appendTransactions([{ ...t, currency: "euro" }])).rejects.toThrow(/currency/);
  });
  it("values the book in the base currency and computes XIRR", () => {
    const b = buildBook([
      tx({ date: "2026-01-02", type: "deposit", account: "ib", amount: 1000, currency: "USD" }),
      tx({ date: "2026-01-05", type: "buy", account: "ib", symbol: "NVDA", quantity: 5, price: 100, currency: "USD" }),
    ]);
    const v = valueBook(b, { NVDA: 120 }, { USD: 0.9 }, "EUR");
    expect(v.totalBase).toBeCloseTo((600 + 500) * 0.9, 8);
    expect(v.positions[0]!.unrealizedPct).toBeCloseTo(20, 8);
    expect(valueBook(b, {}, {}, "EUR").missing).toEqual(["price of NVDA", "USD→EUR rate", "USD→EUR rate (cash)"]);
    expect(
      xirr([
        { date: "2025-01-01", amount: -1000 },
        { date: "2026-01-01", amount: 1100 },
      ]),
    ).toBeCloseTo(0.1, 3);
    expect(xirr([{ date: "2025-01-01", amount: -1 }])).toBeUndefined();
  });
});

const order = (o: Partial<Order> = {}): Order => ({
  account: "cto",
  symbol: "MC.PA",
  side: "buy",
  quantity: 2,
  price: 380,
  orderType: "limit",
  currency: "EUR",
  stop: 365,
  assetKind: "equity",
  venue: "paper",
  ...o,
});
const ctx = (c: Partial<GateContext> = {}): GateContext => ({
  profile: defaultProfile("FR", "EUR"),
  equityBase: 50_000,
  cashBase: 20_000,
  fxToBase: 1,
  positionValueBase: 0,
  heldQuantity: 0,
  cryptoValueBase: 0,
  openSymbols: [],
  pendingBuysBase: {},
  ordersToday: 0,
  lastPrice: 381,
  quoteAt: "2026-10-24T10:00:00Z",
  now: new Date("2026-10-24T10:05:00Z"),
  maxQuoteAgeMs: 15 * 60_000,
  breaker: { tripped: false, sizeMultiplier: 1 },
  ...c,
});
const blocked = (r: ReturnType<typeof riskGate>) => r.checks.filter((c) => c.status === "block").map((c) => c.code);

describe("risk gate", () => {
  it("passes a sized order with a stop, and fingerprints it", () => {
    const r = riskGate(order(), ctx());
    expect(blocked(r)).toEqual([]);
    expect(r.verdict).toBe("pass");
    expect(r.fingerprint).toBe(orderFingerprint(order()));
    expect(orderFingerprint(order({ quantity: 3 }))).not.toBe(r.fingerprint);
  });
  it("blocks no stop, oversize risk, concentration, cash buffer and leverage", () => {
    expect(blocked(riskGate(order({ stop: undefined }), ctx()))).toContain("NO_STOP");
    expect(blocked(riskGate(order({ quantity: 100, stop: 300 }), ctx()))).toEqual(expect.arrayContaining(["RISK_PER_TRADE", "POSITION_PCT"]));
    expect(blocked(riskGate(order(), ctx({ positionValueBase: 2_400 })))).toContain("POSITION_PCT");
    expect(blocked(riskGate(order({ quantity: 6, stop: 376 }), ctx({ cashBase: 4_500 })))).toContain("CASH_BUFFER");
    expect(blocked(riskGate(order({ quantity: 6, stop: 376 }), ctx({ cashBase: 1_000 })))).toContain("NO_LEVERAGE");
    expect(blocked(riskGate(order({ stop: 390 }), ctx()))).toContain("STOP_SIDE");
  });
  it("blocks stale quotes, fat fingers, the breaker, frequency, exclusions, PRIIPs and shorts", () => {
    expect(blocked(riskGate(order(), ctx({ quoteAt: "2026-10-24T08:00:00Z" })))).toContain("STALE_QUOTE");
    expect(blocked(riskGate(order({ price: 450 }), ctx()))).toContain("PRICE_BAND");
    expect(blocked(riskGate(order(), ctx({ breaker: { tripped: true, reason: "x", sizeMultiplier: 1 } })))).toContain("BREAKER");
    expect(blocked(riskGate(order(), ctx({ ordersToday: 3 })))).toContain("FREQUENCY");
    const p = defaultProfile("FR");
    p.constraints.exclusions = ["mc.pa"];
    expect(blocked(riskGate(order(), ctx({ profile: p })))).toContain("EXCLUDED");
    expect(blocked(riskGate(order({ symbol: "SPY", assetKind: "etf", domicile: "US", currency: "USD" }), ctx()))).toContain("PRIIPS");
    expect(blocked(riskGate(order({ side: "sell", quantity: 5 }), ctx({ heldQuantity: 2 })))).toContain("NO_SHORT");
  });
  it("always lets a risk-reducing sell through the breaker and the kill switch", () => {
    const sell = order({ side: "sell", stop: undefined });
    const r = riskGate(sell, ctx({ heldQuantity: 10, breaker: { tripped: true, reason: "x", sizeMultiplier: 1 }, ordersToday: 9 }));
    expect(r.riskReducing).toBe(true);
    expect(r.verdict).toBe("pass");
    writeFileSync(killSwitchPath(), "");
    expect(riskGate(order(), ctx()).verdict).toBe("block");
    expect(riskGate(sell, ctx({ heldQuantity: 10 })).verdict).toBe("pass");
  });
  it("shrinks the allowed risk in a drawdown", () => {
    const r = riskGate(order({ quantity: 12, stop: 360 }), ctx({ breaker: { tripped: false, sizeMultiplier: 0.5 } }));
    expect(blocked(r)).toContain("RISK_PER_TRADE");
    expect(r.checks.map((c) => c.code)).toContain("DRAWDOWN_SIZING");
  });
});

describe("circuit breaker", () => {
  const limits = defaultProfile().limits;
  it("trips on the daily loss, and resets the next day", () => {
    const curve = [
      { at: "2026-10-22T20:00:00Z", equity: 100_000 },
      { at: "2026-10-23T20:00:00Z", equity: 100_000 },
      { at: "2026-10-24T12:00:00Z", equity: 97_500 },
    ];
    const s = breakerState(curve, [], limits, new Date("2026-10-24T13:00:00Z"));
    expect(s.tripped).toBe(true);
    expect(s.reason).toMatch(/daily limit/);
    expect(s.until).toBe("2026-10-25T00:00:00.000Z");
  });
  it("cuts sizes in a drawdown, stops new risk past 20 %, and cools off after two losses", () => {
    const curve = [
      { at: "2026-01-01T00:00:00Z", equity: 100_000 },
      { at: "2026-09-01T00:00:00Z", equity: 88_000 },
      { at: "2026-10-01T00:00:00Z", equity: 88_000 },
    ];
    expect(breakerState(curve, [], limits, new Date("2026-10-02T00:00:00Z")).sizeMultiplier).toBe(0.5);
    const deep = [...curve, { at: "2026-10-01T12:00:00Z", equity: 79_000 }];
    expect(
      breakerState(deep, [], { ...limits, maxDailyLossPct: 50, maxWeeklyLossPct: 50, maxMonthlyLossPct: 50 }, new Date("2026-10-02T00:00:00Z")).reason,
    ).toMatch(/drawdown/);
    const losses = closedTradeResults([
      tx({ date: "2026-10-24T09:00:00Z", type: "buy", account: "a", symbol: "X", quantity: 2, price: 10 }),
      tx({ date: "2026-10-24T10:00:00Z", type: "sell", account: "a", symbol: "X", quantity: 1, price: 9 }),
      tx({ date: "2026-10-24T11:00:00Z", type: "sell", account: "a", symbol: "X", quantity: 1, price: 8 }),
    ]);
    expect(losses.map((l) => l.pnl)).toEqual([-1, -2]);
    expect(breakerState([], losses, limits, new Date("2026-10-24T12:00:00Z")).reason).toMatch(/cooling-off/);
    expect(breakerState([], losses, limits, new Date("2026-10-26T12:00:00Z")).tripped).toBe(false);
  });
});
