// The shapes every price provider returns, whatever it read.
import type { Provenance } from "../core/evidence.js";

/**
 * "europe": a European venue outside Euronext; "world": any other non-US venue Yahoo prices (São Paulo, Tokyo, Sydney…);
 * "fund": a fund that trades on no exchange (an assurance-vie's OPCVM), priced once a day at its NAV.
 */
export type Market = "euronext" | "us" | "europe" | "world" | "crypto" | "fund";
export type AssetKind = "equity" | "etf" | "index" | "crypto" | "fund";

export interface Instrument {
  /** What the user typed, normalised: MC.PA, NVDA, BTCUSDT. */
  symbol: string;
  market: Market;
  kind: AssetKind;
  name?: string;
  isin?: string;
  /** Market identifier code of the listing (XPAR, ETFP, XNAS…). */
  mic?: string;
  currency: string;
  /** The identifier the provider is queried with: an ISIN-MIC, a Nasdaq symbol, a Binance pair. */
  venueId: string;
}

/** One session (daily) or one period (intraday). Dates are ISO: YYYY-MM-DD, or a full timestamp intraday. */
export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  vwap?: number;
  trades?: number;
}

export type Interval = "1d" | "1w" | "1h" | "4h" | "15m";

export interface PriceSeries {
  instrument: Instrument;
  interval: Interval;
  /** Oldest first. */
  bars: Bar[];
  /** Split-adjusted at the source. */
  adjusted: boolean;
  provenance: Omit<Provenance, "asOf">;
  /** Anything the caller should know: a truncated window, a substituted quote currency. */
  notes: string[];
}

export interface QuoteResult {
  instrument: Instrument;
  price: number;
  /** Change from the previous close, absolute and in %. */
  change?: number;
  changePct?: number;
  previousClose?: number;
  /** When the price was true (ISO date or timestamp). */
  at: string;
  provenance: Omit<Provenance, "asOf">;
  notes: string[];
}

/**
 * A price's change against a reference (the previous close, the open) — or
 * nothing when there is no positive reference to divide by. A listing's first
 * session reports a previous close of 0: the change would be Infinity, which
 * the evidence register refuses, and the whole quote would be lost with it.
 */
export function changeAgainst(price: number, reference: number | undefined): Pick<QuoteResult, "previousClose" | "change" | "changePct"> {
  if (reference === undefined || !(reference > 0) || !Number.isFinite(reference) || !Number.isFinite(price)) return {};
  return { previousClose: reference, change: price - reference, changePct: ((price - reference) / reference) * 100 };
}

/**
 * A provider refused or failed: the reason is kept, never an empty success.
 * `status` 0 (no answer), 429 and 5xx are transient — another source may stand
 * in; a 4xx or "no such listing" is an answer, and must not be routed around.
 */
export class ProviderError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${source}: ${message}`);
  }

  get transient(): boolean {
    return this.status === undefined || this.status === 0 || this.status === 429 || this.status >= 500;
  }
}
