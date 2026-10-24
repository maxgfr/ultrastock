// Paper trading: tickets filled against real prices, booked in the "paper"
// ledger, so a strategy is tried with the same gate, the same costs and the same
// bookkeeping as real money — without the money.
//
// Fills are honest rather than flattering:
//   crypto        walk Binance's order book level by level (the price you would really get)
//   other assets  the last price plus slippage (5 bp in Europe, 3 bp in the US), and the
//                 last official close when the market is closed (said so)
//   limit orders  fill only when the market trades through the limit; otherwise they
//                 stay working, and `paper sweep` fills them later from the bars that
//                 traded since — at the bar's open if it gapped through the limit
//   fees          a fee model per market (a parameter, defaults below)
import { fetchJson } from "../core/net.js";
import { appendTransactions, buildBook, readLedger } from "../portfolio/ledger.js";
import { getHistory, getQuote, resolveSymbol } from "../providers/router.js";
import { executionRefusal, type Fill, listTickets, loadTicket, type Ticket, transition } from "./tickets.js";
import type { Order } from "./riskgate.js";

export interface FeeModel {
  /** Share of the notional. */
  pct: number;
  /** Per unit (US brokers charge per share). */
  perUnit?: number;
  /** Minimum per order, in the order currency. */
  min: number;
}

/** Default paper fees by market (a parameter: real brokers differ — set yours). */
export const FEE_MODELS: Record<string, FeeModel> = {
  euronext: { pct: 0.001, min: 2 },
  europe: { pct: 0.001, min: 3 },
  us: { pct: 0, perUnit: 0.005, min: 1 },
  crypto: { pct: 0.001, min: 0 },
};

export function feeFor(market: string, quantity: number, price: number): number {
  const m = FEE_MODELS[market] ?? FEE_MODELS.europe!;
  return Math.max(m.min, m.pct * quantity * price + (m.perUnit ?? 0) * quantity);
}

const SLIPPAGE_BP: Record<string, number> = { euronext: 5, europe: 5, us: 3, crypto: 5 };

/** Volume-weighted price of walking `levels` (price, quantity) for `quantity`; undefined when the book is too thin. */
export function walkBook(levels: ReadonlyArray<readonly [number, number]>, quantity: number): { price: number; levels: number } | undefined {
  let left = quantity;
  let cost = 0;
  let used = 0;
  for (const [p, q] of levels) {
    if (left <= 0) break;
    const take = Math.min(left, q);
    cost += take * p;
    left -= take;
    used++;
  }
  return left > 1e-12 ? undefined : { price: cost / quantity, levels: used };
}

export type PaperOutcome = { kind: "fill"; fill: Fill; note?: string } | { kind: "working"; reason: string };

/** What filling this order now would give, without booking anything. */
export async function simulateFill(order: Order, now: Date): Promise<PaperOutcome> {
  const resolved = await resolveSymbol(order.symbol);
  const market = resolved.instrument.market;
  if (market === "crypto") {
    const res = await fetchJson<{ bids: [string, string][]; asks: [string, string][] }>(
      `https://api.binance.com/api/v3/depth?symbol=${resolved.instrument.venueId}&limit=100`,
    );
    if (res.ok && res.data) {
      const side = (order.side === "buy" ? res.data.asks : res.data.bids).map(([p, q]) => [Number(p), Number(q)] as const);
      const best = side[0]?.[0];
      if (best !== undefined && order.orderType === "limit" && (order.side === "buy" ? order.price < best : order.price > best))
        return { kind: "working", reason: `the limit ${order.price} is ${order.side === "buy" ? "below the best ask" : "above the best bid"} ${best}` };
      const levels = order.orderType === "limit" ? side.filter(([p]) => (order.side === "buy" ? p <= order.price : p >= order.price)) : side;
      const w = walkBook(levels, order.quantity);
      if (!w) return { kind: "working", reason: "not enough depth inside the limit for the whole quantity" };
      return {
        kind: "fill",
        fill: {
          at: now.toISOString(),
          quantity: order.quantity,
          price: w.price,
          fee: feeFor("crypto", order.quantity, w.price),
          venue: "paper",
          method: `Binance order-book walk (${w.levels} level(s))`,
        },
      };
    }
  }
  const q = await getQuote(resolved, now);
  const slip = (SLIPPAGE_BP[market] ?? 5) / 10_000;
  const px = order.side === "buy" ? q.price * (1 + slip) : q.price * (1 - slip);
  if (order.orderType === "limit" && (order.side === "buy" ? order.price < q.price : order.price > q.price))
    return { kind: "working", reason: `the limit ${order.price} has not been reached (last ${q.price})` };
  const price = order.orderType === "limit" ? (order.side === "buy" ? Math.min(px, order.price) : Math.max(px, order.price)) : px;
  const eod = q.provenance.delay === "eod";
  return {
    kind: "fill",
    fill: {
      at: now.toISOString(),
      quantity: order.quantity,
      price,
      fee: feeFor(market, order.quantity, price),
      venue: "paper",
      method: `last price ${q.price} ± ${SLIPPAGE_BP[market] ?? 5} bp`,
    },
    note: eod ? `filled at the last official close ${q.at}: end-of-day data, the real fill would be at the next session's price` : undefined,
  };
}

async function book(t: Ticket, fill: Fill): Promise<void> {
  // A sell cannot exceed what the paper book holds: replaying the ledger proves it.
  if (t.order.side === "sell") {
    const held = buildBook(readLedger("paper")).positions.find((p) => p.account === t.order.account && p.symbol === t.order.symbol)?.quantity ?? 0;
    if (fill.quantity > held + 1e-9) throw new Error(`the paper book holds ${held} ${t.order.symbol} in ${t.order.account}: cannot sell ${fill.quantity}`);
  }
  await appendTransactions(
    [
      {
        date: fill.at,
        type: t.order.side,
        account: t.order.account,
        symbol: t.order.symbol,
        quantity: fill.quantity,
        price: fill.price,
        fee: fill.fee,
        currency: t.order.currency,
        origin: `ticket:${t.id}`,
        note: fill.method,
      },
    ],
    "paper",
  );
}

/** Execute a checked ticket on paper: fill now, or leave it working. */
export async function paperSubmit(id: string, now = new Date()): Promise<{ ticket: Ticket; outcome: PaperOutcome }> {
  const t = loadTicket(id);
  if (t.order.venue !== "paper") throw new Error(`ticket ${id} is for ${t.order.venue}, not paper — live venues have their own, stricter path`);
  const refusal = executionRefusal(t, now);
  if (refusal) throw new Error(refusal);
  const outcome = await simulateFill(t.order, now);
  if (outcome.kind === "working") return { ticket: await transition(id, "working", outcome.reason, undefined, now), outcome };
  await book(t, outcome.fill);
  const done = await transition(id, "filled", `${outcome.fill.method}${outcome.note ? `; ${outcome.note}` : ""}`, (x) => x.fills.push(outcome.fill), now);
  return { ticket: done, outcome };
}

/**
 * Re-examine working limit orders against the bars traded since they were
 * placed: a buy fills on the first bar whose low reaches the limit, at the
 * limit — or at the bar's open if it opened through it. Expired ones lapse.
 */
export async function paperSweep(now = new Date()): Promise<Array<{ id: string; result: string }>> {
  const out: Array<{ id: string; result: string }> = [];
  for (const t of listTickets((x) => x.status === "working" && x.order.venue === "paper")) {
    if (t.validUntil && now.getTime() > Date.parse(t.validUntil)) {
      await transition(t.id, "expired", "valid-until passed", undefined, now);
      out.push({ id: t.id, result: "expired" });
      continue;
    }
    const resolved = await resolveSymbol(t.order.symbol);
    const series = await getHistory(resolved, {
      from: new Date(Date.parse(t.createdAt)),
      to: now,
      interval: resolved.instrument.market === "crypto" ? "1h" : "1d",
    });
    const created = t.createdAt.slice(0, resolved.instrument.market === "crypto" ? 13 : 10);
    const bar = series.bars.find(
      (b) => b.date.slice(0, created.length) > created && (t.order.side === "buy" ? b.low <= t.order.price : b.high >= t.order.price),
    );
    if (!bar) {
      out.push({ id: t.id, result: "still working" });
      continue;
    }
    const gapped = t.order.side === "buy" ? bar.open <= t.order.price : bar.open >= t.order.price;
    const price = gapped ? bar.open : t.order.price;
    const market = resolved.instrument.market;
    const fill: Fill = {
      at: bar.date.length > 10 ? bar.date : `${bar.date}T00:00:00.000Z`,
      quantity: t.order.quantity,
      price,
      fee: feeFor(market, t.order.quantity, price),
      venue: "paper",
      method: gapped ? `opened through the limit on ${bar.date}: filled at the open` : `traded through the limit on ${bar.date}`,
    };
    await book(t, fill);
    await transition(t.id, "filled", fill.method, (x) => x.fills.push(fill), now);
    out.push({ id: t.id, result: `filled at ${price}` });
  }
  return out;
}

export interface Readiness {
  ready: boolean;
  criteria: Array<{ id: string; pass: boolean; value: number; threshold: number; reason: string }>;
}

/**
 * Is the paper record good enough to risk real money? At least 20 closed
 * trades over at least 30 days, a positive expectancy, a profit factor above
 * 1.2 and a maximum drawdown of the paper equity under 15 %. Passing is a
 * necessary condition, not a sufficient one.
 */
export function readiness(
  trades: ReadonlyArray<{ date: string; pnl: number }>,
  equity: ReadonlyArray<{ at: string; equity: number }>,
  firstTrade?: string,
  now = new Date(),
): Readiness {
  const wins = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const losses = -trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  const days = firstTrade ? (now.getTime() - Date.parse(firstTrade)) / 86_400_000 : 0;
  let peak = 0;
  let dd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) dd = Math.min(dd, p.equity / peak - 1);
  }
  const expectancy = trades.length ? (wins - losses) / trades.length : 0;
  const pf = losses > 0 ? wins / losses : wins > 0 ? Number.POSITIVE_INFINITY : 0;
  const criteria = [
    { id: "trades", pass: trades.length >= 20, value: trades.length, threshold: 20, reason: `${trades.length} closed paper trade(s) (20 needed)` },
    { id: "days", pass: days >= 30, value: Math.floor(days), threshold: 30, reason: `${Math.floor(days)} day(s) of paper trading (30 needed)` },
    { id: "expectancy", pass: expectancy > 0, value: expectancy, threshold: 0, reason: `average result per trade ${expectancy.toFixed(2)}` },
    {
      id: "profitFactor",
      pass: pf > 1.2,
      value: Number.isFinite(pf) ? pf : 999,
      threshold: 1.2,
      reason: `profit factor ${Number.isFinite(pf) ? pf.toFixed(2) : "∞"} (above 1.2 needed)`,
    },
    { id: "drawdown", pass: dd > -0.15, value: dd * 100, threshold: -15, reason: `largest paper drawdown ${(dd * 100).toFixed(1)} % (under 15 % needed)` },
  ];
  return { ready: criteria.every((c) => c.pass), criteria };
}
