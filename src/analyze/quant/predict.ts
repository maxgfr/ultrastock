// `predict-analysis`: what a binary prediction market prices, what it costs to
// trade, and how much a stated belief would justify staking — on Kalshi (real
// money, CFTC-regulated) and Manifold (play money). Polymarket is never read
// here: it is jurisdiction-gated in `predict`.
//
// Kalshi's taker fee: the schedule published at kalshi.com/docs/kalshi-fee-schedule.pdf
// is commonly quoted as ceil_to_cent(0.07 × C × P × (1 − P)) per order (C
// contracts at price P), with per-series multipliers. The PDF could not be read
// when this was written (HTTP 429), so the coefficient is a PARAMETER that
// defaults to 0 (no fee) — pass the published value (e.g. 0.07) once you have
// checked it. The series API exposes `fee_type` and `fee_multiplier` but no formula.
import { binaryKelly } from "../../analytics/sizing.js";
import type { Point } from "../../core/datasets.js";
import { complementArbitrage, type OrderBook, orderbookImbalance } from "../../providers/prediction/common.js";
import { fmt, type PointList } from "./common.js";

/** Kalshi's quadratic fee for one order: ceil to the cent of coefficient × C × P × (1 − P). */
export function kalshiFee(contracts: number, price: number, coefficient: number): number {
  if (coefficient <= 0 || contracts <= 0 || price <= 0 || price >= 1) return 0;
  const raw = coefficient * contracts * price * (1 - price);
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

/** A YES spread wider than this (USD per 1-USD contract) makes the mid unreliable. */
export const WIDE_SPREAD = 0.2;

export interface MarketQuote {
  ticker: string;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  last?: number;
  closeTime?: string;
}

/** Kalshi market points (`KALSHI.<ticker>.…`) grouped back into quotes. */
export function kalshiQuotesFromPoints(points: readonly Point[]): MarketQuote[] {
  const by = new Map<string, MarketQuote>();
  for (const p of points) {
    const m = /^KALSHI\.(.+)\.(yes\.bid|yes\.ask|no\.bid|no\.ask|last|closeTime)$/.exec(p.key);
    if (!m) continue;
    const q = by.get(m[1]!) ?? { ticker: m[1]! };
    const v = p.value;
    if (m[2] === "closeTime" && typeof v === "string") q.closeTime = v;
    else if (typeof v === "number") {
      if (m[2] === "yes.bid") q.yesBid = v;
      if (m[2] === "yes.ask") q.yesAsk = v;
      if (m[2] === "no.bid") q.noBid = v;
      if (m[2] === "no.ask") q.noAsk = v;
      if (m[2] === "last") q.last = v;
    }
    by.set(m[1]!, q);
  }
  return [...by.values()];
}

export interface PredictOptions {
  now: Date;
  /** The user's probability of YES (0–1). */
  myProbability?: number;
  /** Kalshi fee coefficient (0 = no fee modelled). */
  feeCoefficient: number;
  /** Order size the fee is rounded on. */
  contracts: number;
}

/** Days from `now` to an ISO time, or undefined. */
export function daysUntil(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(t) ? undefined : (t - now.getTime()) / 86_400_000;
}

/**
 * Half-Kelly on the side the belief favours, the edge discounted by half the
 * spread (the price you really get is worse than mid) and by the fee per
 * contract. Returns the fraction of bankroll (0 when there is no edge).
 */
export function discountedKelly(
  p: number,
  mid: number,
  spread: number,
  feePerContract: number,
): { side: "YES" | "NO"; fraction: number; pAdj: number; price: number } {
  const yes = p >= mid;
  const belief = yes ? p : 1 - p;
  const price = Math.min(0.999, (yes ? mid : 1 - mid) + feePerContract);
  const pAdj = belief - spread / 2;
  return { side: yes ? "YES" : "NO", fraction: binaryKelly(pAdj, price, 0.5), pAdj, price };
}

/** One Kalshi market: implied probability, spread, complement arbitrage, book imbalance, time to resolution, sizing. */
export function kalshiReadingPoints(q: MarketQuote, book: OrderBook | undefined, o: PredictOptions, out: PointList): string[] {
  const notes: string[] = [];
  const k = `KALSHI.${q.ticker}.quant`;
  const s = `Kalshi ${q.ticker}`;
  const twoSided = q.yesBid !== undefined && q.yesAsk !== undefined && q.yesBid > 0 && q.yesAsk < 1 && q.yesAsk >= q.yesBid;
  let mid: number | undefined;
  let spread: number | undefined;
  if (twoSided) {
    mid = (q.yesBid! + q.yesAsk!) / 2;
    spread = q.yesAsk! - q.yesBid!;
    out.num(`${k}.prob`, `${s} implied YES probability (mid)`, mid * 100, "%", "(yes bid + yes ask) / 2 × 100");
    out.num(`${k}.spread`, `${s} YES bid-ask spread`, spread, "USD", "yes ask − yes bid");
    out.num(`${k}.spreadPct`, `${s} spread as % of mid`, (spread / mid) * 100, "%", "spread / mid × 100");
    // A spread this wide means nobody is quoting near fair value: the mid is a midpoint, not a probability.
    if (spread > WIDE_SPREAD)
      notes.push(`${q.ticker}: spread ${fmt(spread, 2)} USD (> ${WIDE_SPREAD}) — the mid is not a reliable probability and sizing on it is fragile`);
  } else notes.push(`${q.ticker}: no two-sided YES quote — no implied probability or sizing`);
  if (q.yesAsk !== undefined && q.noAsk !== undefined && q.yesAsk > 0 && q.noAsk > 0 && q.yesAsk < 1 && q.noAsk < 1) {
    const C = o.contracts;
    const fees = kalshiFee(C, q.yesAsk, o.feeCoefficient) + kalshiFee(C, q.noAsk, o.feeCoefficient);
    const rate = fees / C / (q.yesAsk + q.noAsk);
    const arb = complementArbitrage(q.yesAsk, q.noAsk, rate);
    const fee =
      o.feeCoefficient > 0 ? `Kalshi fee ceil(${o.feeCoefficient} × ${C} × P × (1 − P)) per leg, per ${C}-contract order` : "no fee modelled (coefficient 0)";
    out.num(`${k}.pair.cost`, `${s} cost of one YES + one NO at the asks, with fees`, arb.cost, "USD", `yes ask + no ask + fees; ${fee}`);
    out.num(`${k}.pair.edge`, `${s} complement edge per pair (1 − cost)`, arb.edge, "USD", "1 − cost: > 0 locks in a profit, < 0 is the overround");
    out.text(`${k}.pair.arbitrage`, `${s} YES+NO pair locks in a profit`, arb.arbitrage, `${arb.formula}; settlement risk and capital lock-up not counted`);
  }
  if (book) {
    const imb = orderbookImbalance(book, 10);
    out.num(`${k}.imbalance`, `${s} order book imbalance (top 10 levels)`, imb, "ratio", "(bid depth − ask depth) / (bid depth + ask depth), +1 all bids");
  }
  const days = daysUntil(q.closeTime, o.now);
  out.num(`${k}.daysToClose`, `${s} days until the market closes`, days, "days", "close time − now");
  if (o.myProbability !== undefined && mid !== undefined && spread !== undefined) {
    const feePer = kalshiFee(o.contracts, mid, o.feeCoefficient) / o.contracts;
    const kk = discountedKelly(o.myProbability, mid, spread, feePer);
    out.text(`${k}.kelly.side`, `${s} side your probability favours`, kk.side, `your P(YES) ${o.myProbability} vs mid ${fmt(mid, 4)}`);
    out.num(`${k}.kelly.pAdj`, `${s} your probability of ${kk.side}, discounted by half the spread`, kk.pAdj * 100, "%", "belief − spread / 2");
    out.num(
      `${k}.kelly.half`,
      `${s} half-Kelly stake (share of bankroll) on ${kk.side}`,
      kk.fraction * 100,
      "%",
      `0.5 × (p − (1 − p) / b), b = (1 − price) / price, price ${fmt(kk.price, 4)} (mid${feePer ? " + fee" : ""})`,
    );
    if (kk.fraction === 0)
      notes.push(`${q.ticker}: after discounting half the spread${feePer ? " and fees" : ""}, your probability shows no edge — Kelly says do not bet`);
  }
  return notes;
}

export interface ManifoldQuote {
  id: string;
  probability?: number;
  closeDate?: string;
}

/** Manifold market points (`MANIFOLD.<id>.…`) grouped back into quotes. */
export function manifoldQuotesFromPoints(points: readonly Point[]): ManifoldQuote[] {
  const by = new Map<string, ManifoldQuote>();
  for (const p of points) {
    const m = /^MANIFOLD\.([^.]+)\.(probability|closeDate)$/.exec(p.key);
    if (!m) continue;
    const q = by.get(m[1]!) ?? { id: m[1]! };
    if (m[2] === "probability" && typeof p.value === "number") q.probability = p.value / 100;
    if (m[2] === "closeDate" && typeof p.value === "string") q.closeDate = p.value;
    by.set(m[1]!, q);
  }
  return [...by.values()];
}

/** One Manifold market: probability, time to close, and an illustrative half-Kelly (play money: no spread, no fee). */
export function manifoldReadingPoints(q: ManifoldQuote, o: PredictOptions, out: PointList): void {
  const k = `MANIFOLD.${q.id}.quant`;
  const s = `Manifold ${q.id}`;
  out.num(`${k}.daysToClose`, `${s} days until the market closes`, daysUntil(q.closeDate, o.now), "days", "close date − now");
  if (o.myProbability === undefined || q.probability === undefined || q.probability <= 0 || q.probability >= 1) return;
  const kk = discountedKelly(o.myProbability, q.probability, 0, 0);
  out.text(`${k}.kelly.side`, `${s} side your probability favours`, kk.side, `your P(YES) ${o.myProbability} vs market ${fmt(q.probability, 4)}`);
  out.num(
    `${k}.kelly.half`,
    `${s} half-Kelly stake on ${kk.side} (illustrative, play money)`,
    kk.fraction * 100,
    "%",
    `0.5 × (p − (1 − p) / b), b = (1 − price) / price, price = market probability ${fmt(kk.price, 4)}`,
  );
}
