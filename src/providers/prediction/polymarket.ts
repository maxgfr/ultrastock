// Polymarket — a crypto-settled prediction market (USDC) — read from two of its
// public, keyless APIs (official for their own venue):
//
//   Gamma  https://gamma-api.polymarket.com/markets?limit=…&active=…&closed=…&slug=…&order=…
//   CLOB   https://clob.polymarket.com/book?token_id=<outcome token>
//
// Gamma sends `outcomes`, `outcomePrices` and `clobTokenIds` as JSON-ENCODED
// STRINGS ('["Yes","No"]'), and money fields as strings or numbers depending
// on the field; the CLOB book sends price/size strings in no guaranteed order,
// so it is sorted here. Each outcome token pays 1 USDC if it wins.
//
// JURISDICTION: Polymarket is an unauthorised gambling offer in France; the
// regulator (ANJ) had its domains DNS-blocked, and src/core/jurisdiction.ts
// refuses Polymarket for French residents before this module is called. When
// the host does not resolve, the call fails with a transient ProviderError
// (status 0) that says so: this module never retries through another resolver,
// a proxy or a mirror. The parsers were written against the documented
// response shapes and are tested on synthetic inputs, not recordings.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { type BookLevel, bookPoints, num, type OrderBook, sortBook } from "./common.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
export const SOURCE = "polymarket";
const PACE = { hostIntervalMs: 200 };
const NOTE_UNITS = "prices in USDC per outcome token paying 1 USDC (price × 100 = implied probability %); volume and liquidity in USDC";

export interface GammaMarketRaw {
  id: string | number;
  question?: string;
  slug?: string;
  conditionId?: string;
  description?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  outcomes?: string | string[];
  outcomePrices?: string | Array<string | number>;
  clobTokenIds?: string | string[];
  bestBid?: number | string;
  bestAsk?: number | string;
  lastTradePrice?: number | string;
  volume?: number | string;
  volumeNum?: number;
  volume24hr?: number | string;
  liquidity?: number | string;
  liquidityNum?: number;
}

export interface PolymarketOutcome {
  name: string;
  price?: number;
  tokenId?: string;
}

export interface PolymarketMarket {
  id: string;
  question?: string;
  slug?: string;
  conditionId?: string;
  description?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  outcomes: PolymarketOutcome[];
  bestBid?: number;
  bestAsk?: number;
  last?: number;
  volume?: number;
  volume24h?: number;
  liquidity?: number;
}

/** Gamma's list fields arrive as JSON text ('["Yes","No"]') or, sometimes, as arrays. */
export function gammaList(v: string | Array<string | number> | undefined): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseGammaMarket(r: GammaMarketRaw): PolymarketMarket {
  const names = gammaList(r.outcomes);
  const prices = gammaList(r.outcomePrices);
  const tokens = gammaList(r.clobTokenIds);
  return {
    id: String(r.id),
    question: r.question || undefined,
    slug: r.slug || undefined,
    conditionId: r.conditionId || undefined,
    description: r.description || undefined,
    endDate: r.endDate || undefined,
    active: r.active,
    closed: r.closed,
    outcomes: names.map((name, i) => ({ name, price: num(prices[i]), tokenId: tokens[i] })),
    bestBid: num(r.bestBid),
    bestAsk: num(r.bestAsk),
    last: num(r.lastTradePrice),
    volume: num(r.volumeNum) ?? num(r.volume),
    volume24h: num(r.volume24hr),
    liquidity: num(r.liquidityNum) ?? num(r.liquidity),
  };
}

/** "yes"/"no" for a binary market's sides, else "outcome.<i>": outcome names are external text, never keys. */
function outcomeKey(name: string, i: number): string {
  const n = name.trim().toLowerCase();
  return n === "yes" || n === "no" ? n : `outcome.${i}`;
}

/** One market as points under `POLYMARKET.<id>.…`; question, slug, outcome names and description are untrusted. */
export function polymarketMarketPoints(m: PolymarketMarket): Point[] {
  const p = `POLYMARKET.${m.id}`;
  const s = `Polymarket ${m.id}`;
  const out: Point[] = [];
  if (m.question) out.push({ key: `${p}.question`, label: `${s} question`, value: m.question, untrusted: true });
  if (m.slug) out.push({ key: `${p}.slug`, label: `${s} slug`, value: m.slug, untrusted: true });
  m.outcomes.forEach((o, i) => {
    const k = outcomeKey(o.name, i);
    if (k.startsWith("outcome.")) out.push({ key: `${p}.${k}.name`, label: `${s} outcome ${i}`, value: o.name, untrusted: true });
    if (o.price === undefined) return;
    out.push({ key: `${p}.${k}.price`, label: `${s} ${k} price`, value: o.price, unit: "USDC" });
    out.push({ key: `${p}.${k}.prob`, label: `${s} ${k} implied probability`, value: o.price * 100, unit: "%", formula: "price × 100" });
  });
  const money = (key: string, what: string, v: number | undefined, unit = "USDC") => {
    if (v !== undefined) out.push({ key: `${p}.${key}`, label: `${s} ${what}`, value: v, unit });
  };
  money("book.bestBid", "best bid (first outcome)", m.bestBid);
  money("book.bestAsk", "best ask (first outcome)", m.bestAsk);
  money("last", "last trade price (first outcome)", m.last);
  money("volume", "volume (lifetime)", m.volume);
  money("volume24h", "volume (24h)", m.volume24h);
  money("liquidity", "liquidity", m.liquidity);
  if (m.endDate) out.push({ key: `${p}.endDate`, label: `${s} end date`, value: m.endDate.slice(0, 10) });
  if (typeof m.closed === "boolean") out.push({ key: `${p}.closed`, label: `${s} closed`, value: m.closed });
  if (m.description) out.push({ key: `${p}.criteria`, label: `${s} description and resolution criteria`, value: m.description, untrusted: true });
  return out;
}

/** A CLOB book (`bids`/`asks` of {price, size} strings, any order) sorted best-first. */
export function parseClobBook(raw: { bids?: Array<{ price: string; size: string }>; asks?: Array<{ price: string; size: string }> }): OrderBook {
  const levels = (rows: Array<{ price: string; size: string }> | undefined): BookLevel[] =>
    (rows ?? []).flatMap((l) => {
      const price = num(l.price);
      const size = num(l.size);
      return price === undefined || size === undefined ? [] : [{ price, size }];
    });
  return sortBook(levels(raw.bids), levels(raw.asks));
}

/**
 * The error for a failed Polymarket call. No answer at all (status 0: DNS
 * failure, refused connection, timeout) is transient and named for what it
 * usually is from a blocked jurisdiction; 403/451 is a refusal and definitive.
 */
export function polymarketFailure(res: { status: number; error?: string }, what: string): ProviderError {
  if (res.status === 0)
    return new ProviderError(
      SOURCE,
      `${what}: Polymarket unreachable (${res.error ?? "no answer"}) — its domains are DNS-blocked in some jurisdictions (e.g. France, by ANJ order); not circumvented`,
      0,
    );
  if (res.status === 403 || res.status === 451)
    return new ProviderError(SOURCE, `${what}: Polymarket refuses requests from this location (HTTP ${res.status}) — not circumvented`, res.status);
  if (res.status === 404) return new ProviderError(SOURCE, `${what}: not found`, 404);
  return new ProviderError(SOURCE, `${what} failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
}

const prov = (res: { url: string; fetchedAt: string }) => ({
  source: SOURCE,
  url: res.url,
  fetchedAt: res.fetchedAt,
  delay: "realtime",
  official: true,
  asOf: res.fetchedAt.slice(0, 10),
});

export interface PolymarketMarketsQuery {
  limit?: number;
  active?: boolean;
  closed?: boolean;
  slug?: string;
  /** A Gamma sort field, e.g. "volume24hr", "liquidity", "endDate". */
  order?: string;
  ascending?: boolean;
}

function gammaParams(q: PolymarketMarketsQuery): URLSearchParams {
  const params = new URLSearchParams({ limit: String(Math.min(Math.max(q.limit ?? 20, 1), 500)) });
  if (q.active !== undefined) params.set("active", String(q.active));
  params.set("closed", String(q.closed ?? false));
  if (q.slug) params.set("slug", q.slug);
  if (q.order) {
    params.set("order", q.order);
    params.set("ascending", String(q.ascending ?? false));
  }
  return params;
}

/** Markets from Gamma, parsed (typed) and as one dataset. */
export async function polymarketMarkets(q: PolymarketMarketsQuery = {}): Promise<{ markets: PolymarketMarket[]; dataset: Dataset }> {
  const res = await fetchJson<GammaMarketRaw[]>(`${GAMMA}/markets?${gammaParams(q)}`, PACE);
  if (!res.ok || !Array.isArray(res.data)) throw polymarketFailure(res, "market list");
  const markets = res.data.map(parseGammaMarket);
  if (!markets.length) throw new ProviderError(SOURCE, "no market matches the query", 404);
  return {
    markets,
    dataset: {
      kind: "prediction",
      title: "Polymarket markets",
      points: markets.flatMap(polymarketMarketPoints),
      provenance: prov(res),
      notes: [NOTE_UNITS, "outcome prices are Gamma's displayed prices (the midpoint, or the last trade when the spread is wide)"],
    },
  };
}

/** The CLOB book of one outcome token: best bid/ask, spread, mid, depth, imbalance. */
export async function polymarketBook(tokenId: string, levels = 10): Promise<{ book: OrderBook; dataset: Dataset }> {
  if (!/^\d+$/.test(tokenId)) throw new ProviderError(SOURCE, "a CLOB token id is a decimal number (see clobTokenIds on the market)", 400);
  const res = await fetchJson<Parameters<typeof parseClobBook>[0] & { timestamp?: string }>(`${CLOB}/book?token_id=${tokenId}`, PACE);
  if (!res.ok || !res.data) throw polymarketFailure(res, "order book");
  const book = parseClobBook(res.data);
  if (!book.bids.length && !book.asks.length) throw new ProviderError(SOURCE, "order book is empty", 404);
  const ts = num(res.data.timestamp);
  const short = `${tokenId.slice(0, 8)}…`;
  return {
    book,
    dataset: {
      kind: "prediction-book",
      title: `Polymarket order book (token ${short})`,
      subject: `POLYMARKET.token.${tokenId}`,
      points: bookPoints(`POLYMARKET.token.${tokenId}`, `Polymarket token ${short}`, book, "USDC", levels),
      provenance: { ...prov(res), ...(ts ? { asOf: new Date(ts).toISOString().slice(0, 10) } : {}) },
      notes: [NOTE_UNITS, "the book of ONE outcome token: its YES-side here is that outcome"],
    },
  };
}
