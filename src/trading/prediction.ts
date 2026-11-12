// Prediction-market contracts as orders. A contract is written
// "KALSHI:<TICKER>:YES" (or :NO): it pays 1 USD if the outcome happens, 0
// otherwise, and trades between 0 and 1. Paper fills walk Kalshi's live book —
// buying YES lifts the YES asks (the NO bids turned around), buying NO lifts
// the NO asks (the YES bids turned around) — and pay Kalshi's taker fee: the
// formula and its coefficient researched from Kalshi's fee schedule (venues
// facts, trading/venue-facts.ts), the series' fee_type and fee_multiplier read
// live. Without all of them there is no paper fill on Kalshi: a fill without
// its fee would make the paper record the live gate measures look better than
// trading would have been.
//
// Which venues a resident may use is the jurisdiction's call (core/
// jurisdiction.ts): a venue "blocked" there (Polymarket for France) is never
// traded, not even on paper; "unknown" or "restricted" is paper only; a live
// order needs "allowed".
import type { QuoteResult } from "../providers/types.js";
import { kalshiFee } from "../analyze/quant/predict.js";
import { kalshiOrderbook, kalshiSeriesFees, kalshiSeriesOfMarket } from "../providers/prediction/kalshi.js";
import { KALSHI_QUADRATIC, venueFact } from "./venue-facts.js";
import type { BookLevel, OrderBook } from "../providers/prediction/common.js";
import type { Fill } from "./tickets.js";

export interface PredictionSymbol {
  venue: "kalshi" | "polymarket" | "manifold";
  ticker: string;
  outcome: "YES" | "NO";
}

/** "KALSHI:FED-25DEC-T4.25:YES" → its parts; undefined for anything else. */
export function parsePredictionSymbol(symbol: string): PredictionSymbol | undefined {
  const m = /^(KALSHI|POLYMARKET|MANIFOLD):([A-Za-z0-9._-]+):(YES|NO)$/i.exec(symbol.trim());
  if (!m) return undefined;
  return { venue: m[1]!.toLowerCase() as PredictionSymbol["venue"], ticker: m[2]!.toUpperCase(), outcome: m[3]!.toUpperCase() as "YES" | "NO" };
}

/**
 * Kalshi's taker fee for one order by the formula the engine knows (KALSHI_QUADRATIC): the coefficient is a researched
 * fact, the multiplier the series' own (read live). No coefficient is written here.
 */
export function kalshiTakerFee(contracts: number, price: number, coefficient: number, multiplier: number): number {
  return kalshiFee(contracts, price, coefficient * multiplier);
}

export interface KalshiFeeTerms {
  coefficient: number;
  multiplier: number;
  feeType: string;
  series: string;
  /** Where each part came from, for the fill's method and the outputs. */
  basis: string;
}

/**
 * The taker fee terms of a Kalshi market: the formula and its coefficient as the agent researched them (venues facts),
 * the series' `fee_type` and `fee_multiplier` read live. Any part missing, or a formula the engine does not compute,
 * is said — never replaced by a guess.
 */
export async function kalshiTakerTerms(ticker: string, opts: { now?: Date; country?: string } = {}): Promise<KalshiFeeTerms | { missing: string }> {
  const formula = venueFact<string>("kalshi.feeFormula", opts);
  if ("missing" in formula) return formula;
  if (formula.value.trim() !== KALSHI_QUADRATIC)
    return {
      missing: `the researched Kalshi fee formula is "${formula.value}" (${formula.basis}): ultrastock computes only ${KALSHI_QUADRATIC} — no Kalshi fee is computed`,
    };
  const fees = venueFact<{ taker: number; maker: number }>("kalshi.fees", opts);
  if ("missing" in fees) return fees;
  let terms: Awaited<ReturnType<typeof kalshiSeriesFees>>;
  try {
    terms = await kalshiSeriesFees(await kalshiSeriesOfMarket(ticker));
  } catch (e) {
    return { missing: `Kalshi's fee_type and fee_multiplier for ${ticker} could not be read (${(e as Error).message}): its fee is unknown` };
  }
  if (terms.feeType !== "quadratic" && terms.feeType !== "quadratic_with_maker_fees")
    return {
      missing: `Kalshi series ${terms.series} charges fee_type "${terms.feeType}": ultrastock computes only the quadratic formula — its fee is unknown`,
    };
  return {
    coefficient: fees.value.taker,
    multiplier: terms.feeMultiplier,
    feeType: terms.feeType,
    series: terms.series,
    basis: `${KALSHI_QUADRATIC}, taker coefficient ${fees.value.taker} (${fees.basis}), fee_multiplier ${terms.feeMultiplier} and fee_type ${terms.feeType} of series ${terms.series} (${terms.url})`,
  };
}

/** The book of one outcome: NO is the YES book turned around (bids ↔ asks at 1 − p). */
export function outcomeBook(yes: OrderBook, outcome: "YES" | "NO"): OrderBook {
  if (outcome === "YES") return yes;
  const flip = (ls: BookLevel[]) => ls.map((l) => ({ price: Number((1 - l.price).toFixed(6)), size: l.size }));
  return { bids: flip(yes.asks), asks: flip(yes.bids) };
}

/** Walk the asks (a buy) or the bids (a sell) within the limit for `contracts`; undefined if the book is too thin. */
export function walkOutcome(book: OrderBook, side: "buy" | "sell", contracts: number, limit: number): { price: number; levels: number } | undefined {
  const ladder = side === "buy" ? book.asks.filter((l) => l.price <= limit + 1e-9) : book.bids.filter((l) => l.price >= limit - 1e-9);
  let left = contracts;
  let cost = 0;
  let levels = 0;
  for (const l of ladder) {
    if (left <= 0) break;
    const take = Math.min(left, l.size);
    cost += take * l.price;
    left -= take;
    levels++;
  }
  if (left > 1e-9) return undefined;
  return { price: cost / contracts, levels };
}

/** A quote for a contract symbol: the outcome's mid, with its bid and ask. */
export async function predictionQuote(symbol: string): Promise<QuoteResult & { bid?: number; ask?: number }> {
  const p = parsePredictionSymbol(symbol);
  if (!p) throw new Error(`"${symbol}" is not a contract symbol (KALSHI:<TICKER>:YES|NO)`);
  if (p.venue !== "kalshi") throw new Error(`${p.venue} contracts are not priced here: Kalshi only`);
  const { book, dataset } = await kalshiOrderbook(p.ticker);
  const b = outcomeBook(book, p.outcome);
  const bid = b.bids[0]?.price;
  const ask = b.asks[0]?.price;
  const price = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : (ask ?? bid);
  if (price === undefined) throw new Error(`${symbol}: the book is empty`);
  return {
    instrument: { symbol: symbol.toUpperCase(), market: "us", kind: "fund", name: `${p.ticker} ${p.outcome}`, currency: "USD", venueId: p.ticker },
    price,
    bid,
    ask,
    at: dataset.provenance.fetchedAt,
    provenance: { source: "kalshi", url: dataset.provenance.url, fetchedAt: dataset.provenance.fetchedAt, delay: "realtime", official: true },
    notes: [],
  };
}

/** A paper fill of a contract order against Kalshi's live book, or why it stays working. */
export async function simulatePredictionFill(
  o: { symbol: string; side: "buy" | "sell"; quantity: number; price: number; orderType: "limit" | "market" },
  now: Date,
): Promise<{ kind: "fill"; fill: Fill } | { kind: "working"; reason: string }> {
  const p = parsePredictionSymbol(o.symbol);
  if (p?.venue !== "kalshi") return { kind: "working", reason: `${o.symbol}: paper fills exist for Kalshi contracts only` };
  // A paper fill without its fee would flatter the record the live gate measures: none is made until the fee is known.
  const terms = await kalshiTakerTerms(p.ticker, { now });
  if ("missing" in terms) throw new Error(`no paper fill on Kalshi: ${terms.missing}`);
  const { book } = await kalshiOrderbook(p.ticker);
  const b = outcomeBook(book, p.outcome);
  const limit = o.orderType === "limit" ? o.price : o.side === "buy" ? 1 : 0;
  const w = walkOutcome(b, o.side, o.quantity, limit);
  if (!w) return { kind: "working", reason: `not enough ${p.outcome} ${o.side === "buy" ? "offers" : "bids"} within ${limit} for ${o.quantity} contract(s)` };
  return {
    kind: "fill",
    fill: {
      at: now.toISOString(),
      quantity: o.quantity,
      price: Number(w.price.toFixed(4)),
      fee: kalshiTakerFee(o.quantity, w.price, terms.coefficient, terms.multiplier),
      venue: "paper",
      method: `Kalshi ${p.outcome} book walk (${w.levels} level(s)), taker fee ${terms.basis}`,
    },
  };
}
