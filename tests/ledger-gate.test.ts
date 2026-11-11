import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bookPerformance } from "../src/commands/trading.js";
import { defaultProfile } from "../src/core/profile.js";
import { appendTransactions, buildBook, readLedger, type Transaction, transactionId, valueBook, xirr } from "../src/portfolio/ledger.js";
import { chronological } from "../src/tax/regime.js";
import { breakerState, closedTradeResults, netContributed } from "../src/trading/breaker.js";
import { pendingBuys } from "../src/trading/context.js";
import type { Ticket } from "../src/trading/tickets.js";
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
  it("replays an IBKR split, posted the evening before it takes effect, after that day's trades", () => {
    const ib = (t: Omit<Transaction, "id" | "origin" | "currency">): Transaction => {
      const raw = { origin: "import:ibkr-flex", currency: "USD", ...t };
      return { ...raw, id: transactionId(raw) } as Transaction;
    };
    // IBKR books the 2-for-1 on the evening of 2026-04-01 (dated that day, without a time); the shares trade split
    // from the 2nd.
    const split = ib({ date: "2026-04-01", type: "split", account: "ibkr", symbol: "AAPL", quantity: 2 });
    const rows = [
      split,
      ib({ date: "2026-04-01T15:30:00", type: "buy", account: "ibkr", symbol: "AAPL", quantity: 10, price: 200 }),
      ib({ date: "2026-04-02T15:30:00", type: "sell", account: "ibkr", symbol: "AAPL", quantity: 15, price: 101 }),
    ];
    const b = buildBook(rows);
    expect(b.positions[0]).toMatchObject({ quantity: 5, averageCost: 100 });
    expect(b.transactions.map((t) => t.type)).toEqual(["buy", "split", "sell"]);
    // The tax engines replay in the same order.
    expect(chronological(rows).map((t) => t.type)).toEqual(["buy", "split", "sell"]);
    // The stored row is unchanged: same date, same id.
    expect(b.transactions[1]).toBe(split);
    // A split typed by hand is dated the day it takes effect: still before that day's trades.
    const manual = tx({ date: "2026-04-02", type: "split", account: "x", symbol: "NVDA", quantity: 2, currency: "USD" });
    const buy = tx({ date: "2026-04-02T10:00:00", type: "buy", account: "x", symbol: "NVDA", quantity: 1, price: 50, currency: "USD" });
    expect(buildBook([buy, manual]).transactions).toEqual([manual, buy]);
  });
  it("a transfer-in without a price carries the average cost of the transfer-out it matches", () => {
    const rows = [
      tx({ date: "2026-01-05", type: "buy", account: "cto", symbol: "MC.PA", quantity: 10, price: 500, fee: 10 }),
      tx({ date: "2026-03-02", type: "transfer-out", account: "cto", symbol: "MC.PA", quantity: 10 }),
      tx({ date: "2026-03-02", type: "transfer-in", account: "pea", symbol: "MC.PA", quantity: 10 }),
    ];
    const moved = (b: ReturnType<typeof buildBook>) => b.positions.find((p) => p.account === "pea")!;
    expect(moved(buildBook(rows))).toMatchObject({ quantity: 10, averageCost: 501, lots: [{ quantity: 10, costPerUnit: 501 }] });
    // The statement lists the day's arrival first: the same.
    expect(moved(buildBook([rows[0]!, rows[2]!, rows[1]!])).averageCost).toBe(501);
    // A price given wins; no transfer-out to match: as before, the position's own running cost (0 for a new one).
    expect(moved(buildBook([rows[0]!, rows[1]!, { ...rows[2]!, price: 520 }])).averageCost).toBe(520);
    expect(moved(buildBook([rows[2]!])).averageCost).toBe(0);
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

describe("book performance", () => {
  const limits = defaultProfile("FR", "EUR").limits;
  const NOW = new Date("2026-11-11T12:00:00Z");
  const funded = [
    tx({ date: "2026-09-01", type: "deposit", account: "pea", amount: 10_000 }),
    tx({ date: "2026-09-01", type: "deposit", account: "cto", amount: 5000, currency: "USD" }),
  ];
  // A dollar worth 0.86 EUR on the day of the deposit; the lookup knows no other date.
  const usd = { base: "EUR", rate: (c: string, d: string) => (c === "USD" && d === "2026-09-01" ? 0.86 : undefined), notes: [] };

  it("converts each deposit and withdrawal to the base currency at the rate of its own date", () => {
    const p = bookPerformance(funded, buildBook(funded), 14_231, [], limits, NOW, usd);
    const expected = xirr([
      { date: "2026-09-01", amount: -10_000 },
      { date: "2026-09-01", amount: -4300 },
      { date: "2026-11-11", amount: 14_231 },
    ])!;
    // The 5 000 USD read as 5 000 EUR gave −23.7 % a year.
    expect(expected).toBeCloseTo(-0.0246, 3);
    expect(p.xirr).toBeCloseTo(expected, 8);
    expect(p.xirrNotes).toEqual([]);
  });

  it("reports the XIRR as not computable, naming the currency and the date, when a flow has no rate", () => {
    const p = bookPerformance(funded, buildBook(funded), 14_231, [], limits, NOW, { base: "EUR", rate: () => undefined, notes: [] });
    expect(p.xirr).toBeUndefined();
    expect(p.xirrNotes.join("\n")).toMatch(/not computed: no EUR rate for USD on 2026-09-01/);
  });

  it("says a transfer is not counted as a contribution or a withdrawal", () => {
    const moved = [
      ...funded,
      tx({ date: "2026-09-05", type: "transfer-in", account: "cto", symbol: "NVDA", quantity: 2, price: 150, currency: "USD" }),
      tx({ date: "2026-10-05", type: "transfer-out", account: "cto", symbol: "NVDA", quantity: 1, currency: "USD" }),
    ];
    const notes = bookPerformance(moved, buildBook(moved), 14_400, [], limits, NOW, usd).xirrNotes.join("\n");
    expect(notes).toMatch(/transfers in are not counted as contributions.*overstates/);
    expect(notes).toMatch(/transfers out are not counted as withdrawals.*understates/);
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
  it("counts every buy still to be paid from the same book as pending, whatever the venue", () => {
    const ticket = (id: string, status: Ticket["status"], venue: string, extra: Record<string, unknown> = {}) =>
      ({ id, status, order: order({ venue }), ...extra }) as unknown as Ticket;
    const all = [
      ticket("checked-kraken", "checked", "kraken"),
      // Accepted by a venue and not filled yet: its cash is spoken for, at whichever venue the next order goes.
      ticket("sent-binance", "submitted", "binance", { live: { env: "live" } }),
      ticket("sent-testnet", "submitted", "binance", { live: { env: "test" } }),
      ticket("working-paper", "working", "paper"),
      ticket("filled-kraken", "filled", "kraken"),
      { ...ticket("sell-kraken", "checked", "kraken"), order: order({ venue: "kraken", side: "sell" }) } as Ticket,
    ];
    expect(pendingBuys(all, "real").map((t) => t.id)).toEqual(["checked-kraken", "sent-binance"]);
    expect(pendingBuys(all, "real", "checked-kraken").map((t) => t.id)).toEqual(["sent-binance"]);
    expect(pendingBuys(all, "paper").map((t) => t.id)).toEqual(["working-paper"]);
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
  it("measures a period's change net of the deposits and withdrawals booked in it", () => {
    const now = new Date("2026-10-24T13:00:00Z");
    // A withdrawal of 20 % is not a loss: neither the daily limit nor the drawdown trips on it.
    const withdrawn = [
      { at: "2026-10-23T20:00:00Z", equity: 100_000, contributed: 100_000 },
      { at: "2026-10-24T12:00:00Z", equity: 80_000, contributed: 80_000 },
    ];
    const w = breakerState(withdrawn, [], limits, now);
    expect(w.tripped).toBe(false);
    expect(w.dailyPct).toBeCloseTo(0, 10);
    expect(w.drawdownPct).toBeCloseTo(0, 10);
    expect(w.sizeMultiplier).toBe(1);
    // A deposit does not hide a loss: 600 lost on the 15 000 now at stake.
    const deposited = [
      { at: "2026-10-23T20:00:00Z", equity: 10_000, contributed: 10_000 },
      { at: "2026-10-24T12:00:00Z", equity: 14_400, contributed: 15_000 },
    ];
    const d = breakerState(deposited, [], limits, now);
    expect(d.dailyPct).toBeCloseTo(-4, 10);
    expect(d.tripped).toBe(true);
    expect(d.reason).toMatch(/daily limit/);
  });
  it("records with each equity point what the ledger's deposits and withdrawals add up to, in the base currency", () => {
    const txs = [
      tx({ date: "2026-01-02", type: "deposit", account: "a", amount: 1000 }),
      tx({ date: "2026-01-03", type: "deposit", account: "b", amount: 500, currency: "USD" }),
      tx({ date: "2026-01-04", type: "withdrawal", account: "a", amount: -200 }),
      tx({ date: "2026-01-05", type: "dividend", account: "a", symbol: "X", amount: 7 }),
    ];
    expect(netContributed(txs, { EUR: 1, USD: 0.9 }, "EUR")).toBeCloseTo(1250, 10);
    expect(netContributed(txs, { EUR: 1 }, "EUR")).toBeUndefined();
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
  it("times the cooling-off from a venue fill's UTC date, whatever the machine's time zone", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // A live fill is booked as UTC without its zone.
      const losses = [
        { date: "2026-10-24T10:00:00", pnl: -1 },
        { date: "2026-10-24T11:00:00", pnl: -2 },
      ];
      const during = breakerState([], losses, limits, new Date("2026-10-25T10:30:00Z"));
      expect(during.tripped).toBe(true);
      expect(during.until).toBe("2026-10-25T11:00:00.000Z");
      expect(breakerState([], losses, limits, new Date("2026-10-25T11:30:00Z")).tripped).toBe(false);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
  it("carries cost across own accounts and splits, and counts no result on units of unknown cost", () => {
    const r = closedTradeResults([
      tx({ date: "2026-01-02", type: "buy", account: "a", symbol: "X", quantity: 10, price: 100 }),
      // Moved to another account of the user's: the cost goes with the shares.
      tx({ date: "2026-02-01", type: "transfer-out", account: "a", symbol: "X", quantity: 10 }),
      tx({ date: "2026-02-01", type: "transfer-in", account: "b", symbol: "X", quantity: 10 }),
      // 2-for-1: 20 shares at 50.
      tx({ date: "2026-03-01", type: "split", account: "b", symbol: "X", quantity: 2 }),
      tx({ date: "2026-04-01", type: "sell", account: "b", symbol: "X", quantity: 20, price: 45 }),
      // Shares from outside with no price: selling them is no result at all, not a 1 000 profit.
      tx({ date: "2026-05-01", type: "transfer-in", account: "b", symbol: "Y", quantity: 10 }),
      tx({ date: "2026-06-01", type: "sell", account: "b", symbol: "Y", quantity: 10, price: 100 }),
      // A transfer in with a price takes that price.
      tx({ date: "2026-07-01", type: "transfer-in", account: "b", symbol: "Z", quantity: 5, price: 20 }),
      tx({ date: "2026-08-01", type: "sell", account: "b", symbol: "Z", quantity: 5, price: 18 }),
    ]);
    // Before: the sale after the transfer had no cost (+900, a win), the split went unseen.
    expect(r.map((x) => x.pnl)).toEqual([-100, -10]);
  });
  it("keeps realised results finite when a buy follows units sold without a recorded buy", () => {
    const results = closedTradeResults([
      tx({ date: "2026-10-01", type: "transfer-in", account: "a", symbol: "X", quantity: 10 }),
      tx({ date: "2026-10-02", type: "sell", account: "a", symbol: "X", quantity: 10, price: 12 }),
      tx({ date: "2026-10-03", type: "buy", account: "a", symbol: "X", quantity: 10, price: 10 }),
      tx({ date: "2026-10-04", type: "sell", account: "a", symbol: "X", quantity: 10, price: 9 }),
    ]);
    expect(results.at(-1)!.pnl).toBe(-10);
  });
});
