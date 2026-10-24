// Kalshi — a CFTC-regulated US event-contract exchange — read from its public
// trade API, keyless (official for its own venue):
//
//   /trade-api/v2/markets?status=open&limit=…&series_ticker=…&event_ticker=…&mve_filter=exclude
//   /trade-api/v2/markets/<ticker>              one market
//   /trade-api/v2/markets/<ticker>/orderbook     resting bids on both sides
//   /trade-api/v2/events?status=open&limit=…&series_ticker=…
//
// Each binary contract pays 1 USD if YES resolves. Prices come as dollar
// strings (`yes_bid_dollars: "0.5600"`) and sizes as fixed-point strings
// (`volume_fp: "1694.00"`): the older integer-cent fields are gone. The book
// holds BIDS only on each side — a NO bid at p is a YES offer at 1 − p — so
// the YES ask side is derived. An unknown ticker answers its orderbook with an
// empty 200, so an empty book is refused rather than reported as "no
// liquidity". Titles, subtitles and rules are external text (untrusted). The
// basic tier allows ~20 reads per second; calls are paced well under it.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { type BookLevel, bookPoints, num, type OrderBook, sortBook } from "./common.js";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
export const SOURCE = "kalshi";
const PACE = { hostIntervalMs: 120 };
const NOTE_UNITS = "prices in USD per contract paying 1 USD on YES (price × 100 = implied probability %); volume and open interest in contracts";

/** The fields of a Kalshi market this tool reads. */
export interface KalshiMarketRaw {
  ticker: string;
  event_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  rules_primary?: string;
  status?: string;
  close_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  volume_24h_fp?: string;
  open_interest_fp?: string;
}

export interface KalshiMarket {
  ticker: string;
  eventTicker?: string;
  title?: string;
  subtitle?: string;
  rules?: string;
  status?: string;
  closeTime?: string;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  last?: number;
  volume?: number;
  volume24h?: number;
  openInterest?: number;
}

export function parseKalshiMarket(r: KalshiMarketRaw): KalshiMarket {
  return {
    ticker: r.ticker,
    eventTicker: r.event_ticker,
    title: r.title || undefined,
    subtitle: r.yes_sub_title || r.subtitle || undefined,
    rules: r.rules_primary || undefined,
    status: r.status,
    closeTime: r.close_time,
    yesBid: num(r.yes_bid_dollars),
    yesAsk: num(r.yes_ask_dollars),
    noBid: num(r.no_bid_dollars),
    noAsk: num(r.no_ask_dollars),
    last: num(r.last_price_dollars),
    volume: num(r.volume_fp),
    volume24h: num(r.volume_24h_fp),
    openInterest: num(r.open_interest_fp),
  };
}

/** One market as points under `KALSHI.<ticker>.…`; the title, subtitle and rules are untrusted. */
export function kalshiMarketPoints(m: KalshiMarket): Point[] {
  const p = `KALSHI.${m.ticker}`;
  const s = `Kalshi ${m.ticker}`;
  const out: Point[] = [];
  if (m.title) out.push({ key: `${p}.title`, label: `${s} question`, value: m.title, untrusted: true });
  if (m.subtitle) out.push({ key: `${p}.subtitle`, label: `${s} YES outcome`, value: m.subtitle, untrusted: true });
  const price = (key: string, what: string, v: number | undefined) => {
    if (v !== undefined) out.push({ key: `${p}.${key}`, label: `${s} ${what}`, value: v, unit: "USD" });
  };
  price("yes.bid", "YES bid", m.yesBid);
  price("yes.ask", "YES ask", m.yesAsk);
  price("no.bid", "NO bid", m.noBid);
  price("no.ask", "NO ask", m.noAsk);
  price("last", "last trade price", m.last);
  // A side with no resting order shows 0 (bid) or 1 (ask): no two-sided quote, no mid.
  if (m.yesBid !== undefined && m.yesAsk !== undefined && m.yesBid > 0 && m.yesAsk < 1 && m.yesAsk >= m.yesBid)
    out.push({
      key: `${p}.prob.mid`,
      label: `${s} implied YES probability at mid`,
      value: ((m.yesBid + m.yesAsk) / 2) * 100,
      unit: "%",
      formula: "(yes bid + yes ask) / 2 × 100",
    });
  if (m.yesAsk !== undefined && m.noAsk !== undefined && m.yesAsk > 0 && m.noAsk > 0)
    out.push({
      key: `${p}.overround`,
      label: `${s} YES ask + NO ask − 1`,
      value: m.yesAsk + m.noAsk - 1,
      unit: "USD",
      formula: "yes ask + no ask − 1 (negative = a YES+NO pair costs under 1 USD)",
    });
  const count = (key: string, what: string, v: number | undefined) => {
    if (v !== undefined) out.push({ key: `${p}.${key}`, label: `${s} ${what}`, value: v, unit: "contracts" });
  };
  count("volume", "volume (lifetime)", m.volume);
  count("volume24h", "volume (24h)", m.volume24h);
  count("openInterest", "open interest", m.openInterest);
  if (m.closeTime) out.push({ key: `${p}.closeTime`, label: `${s} close time`, value: m.closeTime });
  if (m.status) out.push({ key: `${p}.status`, label: `${s} status`, value: m.status });
  if (m.rules) out.push({ key: `${p}.rules`, label: `${s} resolution rules`, value: m.rules, untrusted: true });
  return out;
}

/**
 * The YES-side book from Kalshi's two bid ladders: YES bids as they are, NO bids
 * at p turned into YES asks at 1 − p. Levels come as [price, size] string pairs.
 */
export function parseKalshiOrderbook(raw: {
  orderbook_fp?: { yes_dollars?: Array<[string, string]> | null; no_dollars?: Array<[string, string]> | null };
}): OrderBook {
  const levels = (rows: Array<[string, string]> | null | undefined, flip: boolean): BookLevel[] =>
    (rows ?? []).flatMap(([pr, sz]) => {
      const price = num(pr);
      const size = num(sz);
      if (price === undefined || size === undefined) return [];
      return [{ price: flip ? Number((1 - price).toFixed(6)) : price, size }];
    });
  return sortBook(levels(raw.orderbook_fp?.yes_dollars, false), levels(raw.orderbook_fp?.no_dollars, true));
}

function failure(status: number, what: string, error?: string): ProviderError {
  if (status === 404) return new ProviderError(SOURCE, `${what}: not found`, 404);
  return new ProviderError(SOURCE, `${what} failed (${status}${error ? `, ${error}` : ""})`, status);
}

const prov = (res: { url: string; fetchedAt: string }) => ({
  source: SOURCE,
  url: res.url,
  fetchedAt: res.fetchedAt,
  delay: "realtime",
  official: true,
  asOf: res.fetchedAt.slice(0, 10),
});

export interface KalshiMarketsQuery {
  status?: "unopened" | "open" | "closed" | "settled";
  limit?: number;
  seriesTicker?: string;
  eventTicker?: string;
  /** Multivariate (parlay) markets flood the open list: excluded unless asked for. */
  includeMultivariate?: boolean;
}

/** Markets matching a query (one page, `limit` ≤ 1000), as one dataset. */
export async function kalshiMarkets(q: KalshiMarketsQuery = {}): Promise<Dataset> {
  const params = new URLSearchParams({ status: q.status ?? "open", limit: String(Math.min(Math.max(q.limit ?? 20, 1), 1000)) });
  if (q.seriesTicker) params.set("series_ticker", q.seriesTicker.toUpperCase());
  if (q.eventTicker) params.set("event_ticker", q.eventTicker.toUpperCase());
  if (!q.includeMultivariate) params.set("mve_filter", "exclude");
  const res = await fetchJson<{ markets?: KalshiMarketRaw[]; cursor?: string }>(`${BASE}/markets?${params}`, PACE);
  if (!res.ok || !Array.isArray(res.data?.markets)) throw failure(res.status, "market list", res.error);
  const markets = res.data.markets.map(parseKalshiMarket);
  const scope = q.eventTicker ?? q.seriesTicker;
  if (!markets.length) throw new ProviderError(SOURCE, `no ${q.status ?? "open"} markets${scope ? ` for ${scope.toUpperCase()}` : ""}`, 404);
  const notes = [NOTE_UNITS];
  if (res.data.cursor) notes.push(`first ${markets.length} markets only: more are available (raise the limit or narrow the series)`);
  return {
    kind: "prediction",
    title: `Kalshi ${q.status ?? "open"} markets${scope ? ` — ${scope.toUpperCase()}` : ""}`,
    subject: scope?.toUpperCase(),
    points: markets.flatMap(kalshiMarketPoints),
    provenance: prov(res),
    notes,
  };
}

/** One market by ticker. */
export async function kalshiMarket(ticker: string): Promise<Dataset> {
  const t = ticker.toUpperCase();
  const res = await fetchJson<{ market?: KalshiMarketRaw }>(`${BASE}/markets/${encodeURIComponent(t)}`, PACE);
  if (!res.ok || !res.data?.market) throw failure(res.status, `market ${t}`, res.error);
  return {
    kind: "prediction",
    title: `Kalshi market ${t}`,
    subject: t,
    points: kalshiMarketPoints(parseKalshiMarket(res.data.market)),
    provenance: prov(res),
    notes: [NOTE_UNITS],
  };
}

/** The live book of one market: best YES bid/ask, spread, mid probability, depth and imbalance. */
export async function kalshiOrderbook(ticker: string, levels = 10): Promise<{ book: OrderBook; dataset: Dataset }> {
  const t = ticker.toUpperCase();
  const res = await fetchJson<Parameters<typeof parseKalshiOrderbook>[0]>(`${BASE}/markets/${encodeURIComponent(t)}/orderbook`, PACE);
  if (!res.ok || !res.data) throw failure(res.status, `orderbook ${t}`, res.error);
  const book = parseKalshiOrderbook(res.data);
  // Kalshi answers an unknown ticker with an empty book: not an answer to report.
  if (!book.bids.length && !book.asks.length) throw new ProviderError(SOURCE, `orderbook ${t} is empty (unknown ticker, or no resting orders)`, 404);
  return {
    book,
    dataset: {
      kind: "prediction-book",
      title: `Kalshi order book ${t}`,
      subject: t,
      points: bookPoints(`KALSHI.${t}`, `Kalshi ${t}`, book, "USD", levels),
      provenance: prov(res),
      notes: [NOTE_UNITS, "YES asks are derived from NO bids (ask = 1 − NO bid): Kalshi books hold bids only"],
    },
  };
}

export interface KalshiEventRaw {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  strike_date?: string;
  mutually_exclusive?: boolean;
}

/** Event points under `KALSHI.<event>.…`: title and subtitle untrusted, category, strike date. */
export function kalshiEventPoints(e: KalshiEventRaw): Point[] {
  const p = `KALSHI.${e.event_ticker}`;
  const s = `Kalshi event ${e.event_ticker}`;
  const out: Point[] = [];
  if (e.title) out.push({ key: `${p}.title`, label: `${s} title`, value: e.title, untrusted: true });
  if (e.sub_title) out.push({ key: `${p}.subtitle`, label: `${s} subtitle`, value: e.sub_title, untrusted: true });
  if (e.category) out.push({ key: `${p}.category`, label: `${s} category`, value: e.category });
  if (e.strike_date) out.push({ key: `${p}.strikeDate`, label: `${s} strike date`, value: e.strike_date });
  if (typeof e.mutually_exclusive === "boolean")
    out.push({ key: `${p}.mutuallyExclusive`, label: `${s} outcomes mutually exclusive`, value: e.mutually_exclusive });
  return out;
}

/** Events (groups of markets) matching a query, as one dataset. */
export async function kalshiEvents(q: { status?: "open" | "closed" | "settled"; limit?: number; seriesTicker?: string } = {}): Promise<Dataset> {
  const params = new URLSearchParams({ status: q.status ?? "open", limit: String(Math.min(Math.max(q.limit ?? 20, 1), 200)) });
  if (q.seriesTicker) params.set("series_ticker", q.seriesTicker.toUpperCase());
  const res = await fetchJson<{ events?: KalshiEventRaw[]; cursor?: string }>(`${BASE}/events?${params}`, PACE);
  if (!res.ok || !Array.isArray(res.data?.events)) throw failure(res.status, "event list", res.error);
  const events = res.data.events;
  if (!events.length) throw new ProviderError(SOURCE, `no ${q.status ?? "open"} events${q.seriesTicker ? ` for ${q.seriesTicker.toUpperCase()}` : ""}`, 404);
  const notes: string[] = [];
  if (res.data.cursor) notes.push(`first ${events.length} events only: more are available`);
  return {
    kind: "prediction",
    title: `Kalshi ${q.status ?? "open"} events${q.seriesTicker ? ` — ${q.seriesTicker.toUpperCase()}` : ""}`,
    subject: q.seriesTicker?.toUpperCase(),
    points: events.flatMap(kalshiEventPoints),
    provenance: prov(res),
    notes,
  };
}
