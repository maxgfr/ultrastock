// Paper trading: tickets filled against real prices, booked in the "paper"
// ledger, so a strategy is tried with the same gate, the same costs and the same
// bookkeeping as real money — without the money.
//
// Fills are honest rather than flattering:
//   crypto        walk Binance's order book level by level (the price you would really get)
//   other assets  the last price plus an ASSUMED slippage (5 bp in Europe, 3 bp in the US —
//                 a convention, said as such on every fill), and the last official close
//                 when the market is closed (said so)
//   limit orders  fill only when the market trades through the limit; otherwise they
//                 stay working, and `paper sweep` fills them later from the bars that
//                 traded since — at the bar's open if it gapped through the limit
//   fees          the user's own fees on that account (real ledger), else the venue's schedule
//                 as the agent researched it (trading/fees.ts) — none built in. Without
//                 either there is no paper fill: a fill without its fee would flatter the
//                 record the live gate measures. Except getting out: a sell of what is
//                 held (risk-reducing at its check) is filled with its fee marked unknown,
//                 booked without one, and left out of the paper record — said on the fill. Crossing the book pays the taker rate; a
//                 resting limit reached later (`paper sweep`) the maker rate.
import { join } from "node:path";
import { withFileLock } from "../core/lock.js";
import { fetchJson, netMode } from "../core/net.js";
import { homeDir } from "../core/paths.js";
import { appendTransactions, buildBook, readLedger, type Transaction } from "../portfolio/ledger.js";
import { getHistory, getQuote, resolveSymbol } from "../providers/router.js";
import { type FeeLookup, feeFor, feeLookup, slippageBp } from "./fees.js";
import { executionRefusal, type Fill, listTickets, loadTicket, type Ticket, transition } from "./tickets.js";
import { simulatePredictionFill } from "./prediction.js";
import type { Order } from "./riskgate.js";

type PaperFee = Exclude<FeeLookup, { missing: string }> | { unknown: string };

/**
 * The fee a paper fill pays, or the refusal: no fill is made without a known fee — but an exit (a sell of what is held)
 * is never trapped by a fee nobody researched: it gets the fee marked unknown instead.
 */
function paperFee(order: Order, market: string, side: "maker" | "taker", now: Date, exit: boolean): PaperFee {
  const f = feeLookup(order, market, side, { now });
  if (!("missing" in f)) return f;
  if (exit) return { unknown: f.missing };
  throw new Error(`no paper fill: ${f.missing}`);
}

/** A fill's fee and the words its method ends with. */
function feeOf(fee: PaperFee, quantity: number, price: number): { fee: number; basis: string; feeUnknown?: string } {
  if ("unknown" in fee)
    return {
      fee: 0,
      basis: `unknown (${fee.unknown}) — an exit is filled anyway, booked without a fee and left out of the paper record`,
      feeUnknown: fee.unknown,
    };
  return { fee: feeFor(fee.model, quantity, price), basis: fee.basis };
}

/** Whether a paper ticket is getting out: a sell its risk check found risk-reducing (what the book holds). */
const isExit = (t: Ticket): boolean => t.order.side === "sell" && t.check?.riskReducing === true;

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
export async function simulateFill(order: Order, now: Date, opts: { exit?: boolean } = {}): Promise<PaperOutcome> {
  if (order.assetKind === "prediction") return simulatePredictionFill(order, now);
  const resolved = await resolveSymbol(order.symbol);
  const market = resolved.instrument.market;
  const fee = paperFee(order, market, "taker", now, opts.exit === true);
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
      const f = feeOf(fee, order.quantity, w.price);
      return {
        kind: "fill",
        fill: {
          at: now.toISOString(),
          quantity: order.quantity,
          price: w.price,
          fee: f.fee,
          venue: "paper",
          method: `Binance order-book walk (${w.levels} level(s)); fee: ${f.basis}`,
          ...(f.feeUnknown ? { feeUnknown: f.feeUnknown } : {}),
        },
      };
    }
  }
  const q = await getQuote(resolved, now);
  const slip = slippageBp(market) / 10_000;
  const px = order.side === "buy" ? q.price * (1 + slip) : q.price * (1 - slip);
  if (order.orderType === "limit" && (order.side === "buy" ? order.price < q.price : order.price > q.price))
    return { kind: "working", reason: `the limit ${order.price} has not been reached (last ${q.price})` };
  const price = order.orderType === "limit" ? (order.side === "buy" ? Math.min(px, order.price) : Math.max(px, order.price)) : px;
  const eod = q.provenance.delay === "eod";
  const f = feeOf(fee, order.quantity, price);
  return {
    kind: "fill",
    fill: {
      at: now.toISOString(),
      quantity: order.quantity,
      price,
      fee: f.fee,
      venue: "paper",
      method: `last price ${q.price} ± ${slippageBp(market)} bp slippage (an assumption, not measured); fee: ${f.basis}`,
      ...(f.feeUnknown ? { feeUnknown: f.feeUnknown } : {}),
    },
    note: eod ? `filled at the last official close ${q.at}: end-of-day data, the real fill would be at the next session's price` : undefined,
  };
}

/**
 * A fill as it is booked. Read from a fixture (replayed, or recorded into one), its price is the recording's and its
 * clock too: it is booked at the wall clock — never dated back to the recording — and marked replayed, so the paper
 * record the live gate measures leaves it out (as a replayed check opens no live order).
 */
function asBooked(fill: Fill): Fill {
  return netMode().kind === "live" ? fill : { ...fill, at: new Date().toISOString(), replayed: true };
}

async function book(t: Ticket, fill: Fill): Promise<void> {
  // A sell cannot exceed what the paper book holds: replaying the ledger proves it.
  if (t.order.side === "sell") {
    const held = buildBook(readLedger("paper")).positions.find((p) => p.account === t.order.account && p.symbol === t.order.symbol)?.quantity ?? 0;
    if (fill.quantity > held + 1e-9) throw new Error(`the paper book holds ${held} ${t.order.symbol} in ${t.order.account}: cannot sell ${fill.quantity}`);
  }
  const { duplicates } = await appendTransactions(
    [
      {
        date: fill.at,
        type: t.order.side,
        account: t.order.account,
        symbol: t.order.symbol,
        quantity: fill.quantity,
        price: fill.price,
        // An exit filled with no fee known books none: an unknown fee is not a fee of 0.
        ...(fill.feeUnknown ? {} : { fee: fill.fee }),
        currency: t.order.currency,
        origin: `ticket:${t.id}`,
        note: fill.method,
      },
    ],
    "paper",
  );
  // The fill was not recorded: the ticket must not say it was (the transition is abandoned, nothing changes).
  if (duplicates) throw new Error(`ticket ${t.id}: an identical fill of this ticket is already in the paper ledger — nothing booked`);
}

/**
 * One paper execution at a time: a ticket's state is read, its fill booked and
 * its state changed as one step, so two `paper submit`, or a submit and a
 * sweep, cannot both fill the same ticket.
 */
const paperLock = <T>(fn: () => Promise<T>): Promise<T> => withFileLock(join(homeDir(), "state", "paper.lock"), fn, 60_000);

/** Execute a checked ticket on paper: fill now, or leave it working. */
export async function paperSubmit(id: string, now = new Date()): Promise<{ ticket: Ticket; outcome: PaperOutcome }> {
  return paperLock(async () => {
    const t = loadTicket(id);
    if (t.order.venue !== "paper") throw new Error(`ticket ${id} is for ${t.order.venue}, not paper — live venues have their own, stricter path`);
    const refusal = executionRefusal(t, now);
    if (refusal) throw new Error(refusal);
    const simulated = await simulateFill(t.order, now, { exit: isExit(t) });
    const outcome: PaperOutcome = simulated.kind === "fill" ? { ...simulated, fill: asBooked(simulated.fill) } : simulated;
    // A user's cancel takes the ticket's lock only: the fill is booked under it, once the ticket is still checked.
    if (outcome.kind === "working") return { ticket: await transition(id, "working", outcome.reason, undefined, now, ["checked"]), outcome };
    const done = await transition(
      id,
      "filled",
      `${outcome.fill.method}${outcome.note ? `; ${outcome.note}` : ""}`,
      async (x) => {
        await book(x, outcome.fill);
        x.fills.push(outcome.fill);
      },
      now,
      ["checked"],
    );
    return { ticket: done, outcome };
  });
}

/** A sweep's move refused because the ticket left "working" meanwhile (filled, cancelled) is skipped; any other failure is not. */
const movedMeanwhile =
  (id: string) =>
  (e: unknown): false => {
    if (loadTicket(id).status === "working") throw e;
    return false;
  };

/**
 * Re-examine working limit orders against the bars traded since they were
 * placed: a buy fills on the first bar whose low reaches the limit, at the
 * limit — or at the bar's open if it opened through it. Expired ones lapse.
 */
export async function paperSweep(now = new Date()): Promise<Array<{ id: string; result: string }>> {
  const out: Array<{ id: string; result: string }> = [];
  for (const t of listTickets((x) => x.status === "working" && x.order.venue === "paper")) {
    if (t.validUntil && now.getTime() > Date.parse(t.validUntil)) {
      const lapsed = await transition(t.id, "expired", "valid-until passed", undefined, now, ["working"]).then(() => true, movedMeanwhile(t.id));
      out.push({ id: t.id, result: lapsed ? "expired" : `no longer working (${loadTicket(t.id).status})` });
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
    // A resting limit reached by the market pays the maker rate; one the open gapped through, the taker rate.
    const looked = feeLookup(t.order, market, gapped ? "taker" : "maker", { now });
    if ("missing" in looked && !isExit(t)) {
      out.push({ id: t.id, result: `not filled: ${looked.missing}` });
      continue;
    }
    const f = feeOf("missing" in looked ? { unknown: looked.missing } : looked, t.order.quantity, price);
    const fill: Fill = asBooked({
      at: bar.date.length > 10 ? bar.date : `${bar.date}T00:00:00.000Z`,
      quantity: t.order.quantity,
      price,
      fee: f.fee,
      venue: "paper",
      method: `${gapped ? `opened through the limit on ${bar.date}: filled at the open` : `traded through the limit on ${bar.date}`}; fee: ${f.basis}`,
      ...(f.feeUnknown ? { feeUnknown: f.feeUnknown } : {}),
    });
    // The bars were read without the lock: the ticket may have been filled, swept or cancelled since.
    const booked = await paperLock(() =>
      transition(
        t.id,
        "filled",
        fill.method,
        async (x) => {
          await book(x, fill);
          x.fills.push(fill);
        },
        now,
        ["working"],
      ).then(() => true, movedMeanwhile(t.id)),
    );
    out.push({ id: t.id, result: booked ? `filled at ${price}` : `no longer working (${loadTicket(t.id).status})` });
  }
  return out;
}

export interface Readiness {
  ready: boolean;
  criteria: Array<{ id: string; pass: boolean; value: number; threshold: number; reason: string }>;
}

export interface PaperRecord {
  /** The paper ledger with only the trades of filled paper tickets (deposits, splits and the rest kept). */
  txs: Transaction[];
  /** The first counted paper buy. */
  first?: string;
  /** What was left out, and why: said with the readiness. */
  excluded: string[];
}

/**
 * The paper record the live gate measures: the trades paper tickets filled — a ticket checked by the gate, filled by
 * the paper engine on market data. A trade typed into the paper ledger (`portfolio add … --book paper`), imported, or
 * filled on a replayed fixture is not paper trading: it is left out, and `excluded` says how many.
 */
export function paperRecord(txs: readonly Transaction[], tickets: readonly Ticket[]): PaperRecord {
  const paper = tickets.filter((t) => t.order.venue === "paper" && t.status === "filled" && t.fills.length > 0);
  const replayed = new Set(paper.filter((t) => t.fills.some((f) => f.replayed)).map((t) => `ticket:${t.id}`));
  // An exit filled with no fee known: its result would be flattered by the fee it did not pay.
  const feeless = new Set(paper.filter((t) => t.fills.some((f) => f.feeUnknown) && !replayed.has(`ticket:${t.id}`)).map((t) => `ticket:${t.id}`));
  const counted = new Set(paper.map((t) => `ticket:${t.id}`).filter((o) => !replayed.has(o) && !feeless.has(o)));
  const trade = (t: Transaction) => t.type === "buy" || t.type === "sell" || t.type === "transfer-in" || t.type === "transfer-out";
  let typed = 0;
  let onReplay = 0;
  let unknownFee = 0;
  const kept = txs.filter((t) => {
    if (!trade(t) || counted.has(t.origin)) return true;
    if (replayed.has(t.origin)) onReplay++;
    else if (feeless.has(t.origin)) unknownFee++;
    else typed++;
    return false;
  });
  const excluded: string[] = [];
  if (typed)
    excluded.push(`${typed} paper ledger row(s) not filled by a paper ticket (typed with \`portfolio add\`, imported, transferred) are not part of the record`);
  if (onReplay) excluded.push(`${onReplay} paper fill(s) made on a replayed fixture are not part of the record: the market was not live`);
  if (unknownFee)
    excluded.push(
      `${unknownFee} paper fill(s) booked with an unknown fee (exits filled so a position is never trapped) are not part of the record: their result would be flattered by the fee they did not pay`,
    );
  const first = kept
    .filter((t) => t.type === "buy")
    .map((t) => t.date)
    .sort()[0];
  return { txs: kept, first, excluded };
}

/**
 * Is the paper record good enough to risk real money? At least 20 closed
 * trades over at least 30 days, a positive expectancy, a profit factor above
 * 1.2 and a maximum drawdown of the paper equity under 15 %. Passing is a
 * necessary condition, not a sufficient one. Feed it `paperRecord`: the
 * trades of paper tickets only.
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
