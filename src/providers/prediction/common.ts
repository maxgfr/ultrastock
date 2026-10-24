// What every binary prediction market shares, whatever the venue: a YES
// contract and a NO contract that together pay exactly 1 unit (1 USD on Kalshi
// and Polymarket) at resolution. Two pure helpers read a quote or a book:
//
//   complementArbitrage — buying YES and NO together costs yesAsk + noAsk (+ fees);
//                         below 1 the pair locks in the difference, above 1 it is the
//                         venue's spread (the "overround").
//   orderbookImbalance  — resting size on the bid side against the ask side, the
//                         usual short-horizon pressure read.
//
// No network here: the venue modules (kalshi, polymarket) feed them.
import type { Point } from "../../core/datasets.js";

/** One price level: price per contract (0–1) and the number of contracts resting there. */
export interface BookLevel {
  price: number;
  size: number;
}

/** A YES-side book, best first: bids highest price first, asks lowest price first. */
export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface ComplementArbitrage {
  /** yesAsk + noAsk + fees, per pair of contracts. */
  cost: number;
  fees: number;
  /** 1 − cost: what a YES+NO pair locks in (negative: the venue's overround). */
  edge: number;
  /** edge / cost × 100. */
  edgePct: number;
  arbitrage: boolean;
  formula: string;
}

const inUnit = (p: number) => Number.isFinite(p) && p >= 0 && p <= 1;

/**
 * Buy one YES at `yesAsk` and one NO at `noAsk` (prices 0–1): exactly one pays 1
 * at resolution. Fees are modelled as `feeRate` × price on each leg (a flat
 * taker rate; Kalshi's real schedule is 0.07 × P × (1 − P) per contract, so
 * pass the effective rate for the price when that matters). Settlement risk,
 * gas and the time value of the locked capital are NOT counted.
 */
export function complementArbitrage(yesAsk: number, noAsk: number, feeRate = 0): ComplementArbitrage {
  if (!inUnit(yesAsk) || !inUnit(noAsk)) throw new RangeError(`prices must be between 0 and 1 (got ${yesAsk}, ${noAsk})`);
  if (!Number.isFinite(feeRate) || feeRate < 0) throw new RangeError(`feeRate must be ≥ 0 (got ${feeRate})`);
  const fees = feeRate * (yesAsk + noAsk);
  const cost = yesAsk + noAsk + fees;
  const edge = 1 - cost;
  return {
    cost,
    fees,
    edge,
    edgePct: cost > 0 ? (edge / cost) * 100 : 0,
    arbitrage: edge > 0,
    formula: "edge = 1 − (yesAsk + noAsk) × (1 + feeRate)",
  };
}

/**
 * (bid depth − ask depth) / (bid depth + ask depth) over the best `levels`
 * levels of each side, in contracts: +1 only bids, −1 only asks. Undefined
 * when both sides are empty.
 */
export function orderbookImbalance(book: OrderBook, levels = 10): number | undefined {
  const depth = (side: BookLevel[]) => side.slice(0, levels).reduce((s, l) => s + (Number.isFinite(l.size) ? l.size : 0), 0);
  const bid = depth(book.bids);
  const ask = depth(book.asks);
  return bid + ask > 0 ? (bid - ask) / (bid + ask) : undefined;
}

/** Sort levels best-first and drop the unusable ones: bids descending, asks ascending. */
export function sortBook(bids: BookLevel[], asks: BookLevel[]): OrderBook {
  const ok = (l: BookLevel) => inUnit(l.price) && Number.isFinite(l.size) && l.size > 0;
  return { bids: bids.filter(ok).sort((a, b) => b.price - a.price), asks: asks.filter(ok).sort((a, b) => a.price - b.price) };
}

/** A number from the string or number a venue sends, or undefined. */
export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Best bid/ask, spread, mid (as an implied probability), top-of-book depth and
 * imbalance of a YES book, under `prefix` (e.g. "KALSHI.KXFED-27APR-T6.00").
 */
export function bookPoints(prefix: string, subject: string, book: OrderBook, currency: string, levels = 10): Point[] {
  const out: Point[] = [];
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (bid) out.push({ key: `${prefix}.book.yes.bid`, label: `${subject} best YES bid`, value: bid.price, unit: currency });
  if (ask) out.push({ key: `${prefix}.book.yes.ask`, label: `${subject} best YES ask`, value: ask.price, unit: currency });
  if (bid && ask) {
    out.push({ key: `${prefix}.book.spread`, label: `${subject} YES bid-ask spread`, value: ask.price - bid.price, unit: currency, formula: "ask − bid" });
    out.push({
      key: `${prefix}.book.mid.prob`,
      label: `${subject} implied probability at mid`,
      value: ((bid.price + ask.price) / 2) * 100,
      unit: "%",
      formula: "(bid + ask) / 2 × 100",
    });
  }
  const depth = (side: BookLevel[]) => side.slice(0, levels).reduce((s, l) => s + l.size, 0);
  out.push({ key: `${prefix}.book.depth.bid`, label: `${subject} YES bid depth (top ${levels} levels)`, value: depth(book.bids), unit: "contracts" });
  out.push({ key: `${prefix}.book.depth.ask`, label: `${subject} YES ask depth (top ${levels} levels)`, value: depth(book.asks), unit: "contracts" });
  const imb = orderbookImbalance(book, levels);
  if (imb !== undefined)
    out.push({
      key: `${prefix}.book.imbalance`,
      label: `${subject} order book imbalance (top ${levels} levels)`,
      value: imb,
      unit: "ratio",
      formula: "(bid depth − ask depth) / (bid depth + ask depth)",
    });
  return out;
}
