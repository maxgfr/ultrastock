// What a fill costs, from what is known about it — never from a built-in
// schedule. In order:
//
//   1. the user's own fees on that account, from the real ledger: Σ fee ÷ Σ
//      notional of their last fills there with a fee recorded (at least
//      MIN_OWN_FILLS of them, in the order's currency);
//   2. the venue's schedule as the agent researched it (venues facts,
//      trading/venue-facts.ts), for the product it was researched for: the
//      venue the account names (binance, kraken, coinbase: their crypto spot
//      schedule, for crypto only; ibkr: its stock and ETF schedule, never for
//      crypto), else the broker researched for that account
//      (`account.<id>.*`), else — crypto only, on an account that names no
//      venue — Binance's, whose book a paper crypto fill walks. A value of the
//      wrong shape (not a fraction, not an amount) reads as missing, never NaN;
//   3. nothing: the caller refuses (paper) or says the fee is unknown.
//
// Slippage on a fill at the last price (not a book walk) is a convention, not a
// fact of any venue: ASSUMED_SLIPPAGE_BP, named "an assumption" wherever used.
import { readLedger, type Transaction } from "../portfolio/ledger.js";
import { researchCommand } from "../core/researched.js";
import { accountKey, type FactRead, missingVenueFact, venueCountry, venueFact } from "./venue-facts.js";

export interface FeeModel {
  /** Share of the notional. */
  pct: number;
  /** Per unit (a per-share commission). */
  perUnit?: number;
  /** Minimum per order, in the order currency. */
  min: number;
}

export interface ResolvedFee {
  model: FeeModel;
  /** Where the figure came from, in words an output can show. */
  basis: string;
  source: "ledger" | "researched";
}

export type FeeLookup = ResolvedFee | { missing: string };

export function feeFor(m: FeeModel, quantity: number, price: number): number {
  return Math.max(m.min, m.pct * quantity * price + (m.perUnit ?? 0) * quantity);
}

/** Fewer own fills than this and the average says little about the account's schedule. */
export const MIN_OWN_FILLS = 3;
/** The most recent fills averaged. */
const OWN_FILLS_WINDOW = 50;

/**
 * Basis points of slippage a paper fill at the last price pays: an assumption (the
 * price impact of a small order on a liquid line), not any venue's figure — every
 * fill that uses it says so. A crypto fill walks the real book and uses none.
 */
export const ASSUMED_SLIPPAGE_BP: Readonly<Record<string, number>> = { euronext: 5, europe: 5, us: 3, crypto: 5 };
export const slippageBp = (market: string): number => ASSUMED_SLIPPAGE_BP[market] ?? 5;

/** The user's own average fee on an account (real ledger), or undefined with too few fills. */
export function ownFeeRate(account: string, currency: string, txs: readonly Transaction[]): ResolvedFee | undefined {
  const fills = txs
    .filter(
      (t) =>
        (t.type === "buy" || t.type === "sell") &&
        t.account === account &&
        t.currency === currency &&
        t.fee !== undefined &&
        t.fee >= 0 &&
        (t.quantity ?? 0) > 0 &&
        (t.price ?? 0) > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-OWN_FILLS_WINDOW);
  if (fills.length < MIN_OWN_FILLS) return undefined;
  const fees = fills.reduce((s, t) => s + t.fee!, 0);
  const notional = fills.reduce((s, t) => s + t.quantity! * t.price!, 0);
  const pct = fees / notional;
  return {
    model: { pct, min: 0 },
    source: "ledger",
    basis: `your own fees on ${account}: ${(pct * 100).toFixed(4)} % of the notional over your last ${fills.length} ${currency} fill(s) there (minimums and per-unit charges averaged in)`,
  };
}

const CRYPTO_VENUES: Record<string, string> = { binance: "binance.spot", kraken: "kraken.spot", coinbase: "coinbase.spot" };

/**
 * The researched schedule a fill on `account` is charged by, and the keys it needs. A venue's schedule covers the product
 * it was researched for: a crypto platform's spot fees a crypto fill, IBKR's stock and ETF commission anything but crypto.
 */
function scheduleKeys(account: string, market: string): { prefix: string; full: boolean }[] {
  const a = account.toLowerCase();
  const crypto = market === "crypto";
  if (CRYPTO_VENUES[a]) return crypto ? [{ prefix: CRYPTO_VENUES[a]!, full: false }] : [];
  if (a === "ibkr") return crypto ? [] : [{ prefix: "ibkr", full: true }];
  return [{ prefix: accountKey(account), full: true }, ...(crypto ? [{ prefix: "binance.spot", full: false }] : [])];
}

const fraction = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const amount = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/**
 * The researched fee of a fill on `account` (taker when it crosses the book, maker when a resting limit is reached),
 * from the first schedule that is fully researched; why none is, otherwise.
 */
export function researchedFee(account: string, market: string, side: "maker" | "taker", opts: { now?: Date } = {}): FeeLookup {
  const tried: string[] = [];
  const malformed: string[] = [];
  const schedules = scheduleKeys(account, market);
  for (const { prefix, full } of schedules) {
    const fees = venueFact<{ maker: number; taker: number }>(`${prefix}.fees`, opts);
    const keys = full ? [`${prefix}.fees`, `${prefix}.perUnit`, `${prefix}.minimum`] : [`${prefix}.fees`];
    tried.push(...keys);
    if ("missing" in fees) continue;
    const pct = (fees.value as unknown as Record<string, unknown> | null)?.[side];
    if (!fraction(pct)) {
      malformed.push(`${prefix}.fees is not {maker, taker} fractions of the notional`);
      continue;
    }
    let perUnit: FactRead<number> | undefined;
    let minimum: FactRead<number> | undefined;
    if (full) {
      const u = venueFact<number>(`${prefix}.perUnit`, opts);
      const m = venueFact<number>(`${prefix}.minimum`, opts);
      if ("missing" in u || "missing" in m) continue;
      if (!amount(u.value) || !amount(m.value)) {
        malformed.push(`${prefix}.perUnit and ${prefix}.minimum are amounts ≥ 0`);
        continue;
      }
      perUnit = u;
      minimum = m;
    }
    return {
      model: { pct, ...(perUnit ? { perUnit: perUnit.value } : {}), min: minimum?.value ?? 0 },
      source: "researched",
      basis: `${prefix} ${side} ${(pct * 100).toFixed(4)} %${perUnit ? ` + ${perUnit.value} per unit, minimum ${minimum!.value}` : ""} — ${fees.basis}`,
    };
  }
  if (!schedules.length)
    return {
      missing: `no fee is known for a ${market} fill on ${account}: the ${account} schedule ultrastock reads covers ${market === "crypto" ? "stocks and ETFs, not crypto-assets" : "crypto-assets only"} — research the broker behind this account (${accountKey(account)}.fees, .perUnit, .minimum): \`${researchCommand("venues", venueCountry() ?? "CC")}\``,
    };
  const why = missingVenueFact(venueCountry(), [...new Set(tried)]);
  return { missing: malformed.length ? `${[...new Set(malformed)].join("; ")}: read as unknown — ${why}` : why };
}

/** The fee of a fill on `account`: the user's own, else the researched schedule, else why neither is known. */
export function feeLookup(
  o: { account: string; currency: string },
  market: string,
  side: "maker" | "taker",
  opts: { now?: Date; ledger?: readonly Transaction[] } = {},
): FeeLookup {
  const own = ownFeeRate(o.account, o.currency, opts.ledger ?? readLedger("real"));
  if (own) return own;
  const r = researchedFee(o.account, market, side, opts);
  if ("missing" in r)
    return {
      missing: `${r.missing}; or import the ${o.account} account's statements (\`ultrastock portfolio import <file> --format <f> --account ${o.account}\`) so your own fees there can be read (${MIN_OWN_FILLS} fills with a fee at least)`,
    };
  return r;
}
