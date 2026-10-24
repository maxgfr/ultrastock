// Polymarket — a crypto-settled prediction market (USDC) — read from its three
// public, keyless APIs (official for their own venue):
//
//   Gamma  https://gamma-api.polymarket.com/markets?limit=…&active=…&closed=…&slug=…&order=…
//          https://gamma-api.polymarket.com/events?limit=…&slug=…   (events nest their markets)
//   CLOB   https://clob.polymarket.com/book?token_id=<outcome token>
//   Data   https://data-api.polymarket.com/trades?market=<conditionId>&limit=…
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
const DATA = "https://data-api.polymarket.com";
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

export interface PolymarketTradeRaw {
  side?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number | string;
  outcome?: string;
  outcomeIndex?: number;
}

export interface TradeSummary {
  count: number;
  buyVolume: number;
  sellVolume: number;
  /** Size-weighted average price, per outcome index. */
  vwap: Record<number, number>;
  lastPrice?: number;
  lastOutcomeIndex?: number;
  lastAt?: string;
  firstAt?: string;
}

/** Count, buy/sell size, VWAP per outcome and the latest trade of a Data-API trade list. */
export function summarizeTrades(trades: readonly PolymarketTradeRaw[]): TradeSummary {
  const s: TradeSummary = { count: 0, buyVolume: 0, sellVolume: 0, vwap: {} };
  const notional: Record<number, number> = {};
  const size: Record<number, number> = {};
  let lastTs = -Infinity;
  let firstTs = Infinity;
  for (const t of trades) {
    const qty = num(t.size);
    const px = num(t.price);
    const ts = num(t.timestamp);
    if (qty === undefined || px === undefined) continue;
    s.count++;
    if ((t.side ?? "").toUpperCase() === "SELL") s.sellVolume += qty;
    else s.buyVolume += qty;
    const oi = t.outcomeIndex ?? 0;
    notional[oi] = (notional[oi] ?? 0) + qty * px;
    size[oi] = (size[oi] ?? 0) + qty;
    if (ts !== undefined) {
      // The Data API stamps trades in seconds; tolerate milliseconds.
      const ms = ts < 1e12 ? ts * 1000 : ts;
      if (ms > lastTs) {
        lastTs = ms;
        s.lastPrice = px;
        s.lastOutcomeIndex = oi;
      }
      firstTs = Math.min(firstTs, ms);
    }
  }
  for (const k of Object.keys(size)) {
    const i = Number(k);
    if (size[i]! > 0) s.vwap[i] = notional[i]! / size[i]!;
  }
  if (Number.isFinite(lastTs)) s.lastAt = new Date(lastTs).toISOString();
  if (Number.isFinite(firstTs)) s.firstAt = new Date(firstTs).toISOString();
  return s;
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

interface GammaEventRaw {
  id: string | number;
  title?: string;
  slug?: string;
  endDate?: string;
  volume?: number | string;
  volume24hr?: number | string;
  liquidity?: number | string;
  markets?: GammaMarketRaw[];
}

/** Event-level points (title untrusted, volume, liquidity, end date, market count) followed by each nested market's. */
export function polymarketEventPoints(e: GammaEventRaw): Point[] {
  const p = `POLYMARKET.event.${e.id}`;
  const s = `Polymarket event ${e.id}`;
  const out: Point[] = [];
  if (e.title) out.push({ key: `${p}.title`, label: `${s} title`, value: e.title, untrusted: true });
  for (const [key, what, v] of [
    ["volume", "volume (lifetime)", num(e.volume)],
    ["volume24h", "volume (24h)", num(e.volume24hr)],
    ["liquidity", "liquidity", num(e.liquidity)],
  ] as const)
    if (v !== undefined) out.push({ key: `${p}.${key}`, label: `${s} ${what}`, value: v, unit: "USDC" });
  if (e.endDate) out.push({ key: `${p}.endDate`, label: `${s} end date`, value: e.endDate.slice(0, 10) });
  const markets = (e.markets ?? []).map(parseGammaMarket);
  out.push({ key: `${p}.markets`, label: `${s} number of markets`, value: markets.length, unit: "count" });
  return [...out, ...markets.flatMap(polymarketMarketPoints)];
}

/** Events from Gamma (each with its markets), one dataset per event. */
export async function polymarketEvents(q: { limit?: number; slug?: string; closed?: boolean; order?: string } = {}): Promise<Dataset[]> {
  const res = await fetchJson<GammaEventRaw[]>(`${GAMMA}/events?${gammaParams(q)}`, PACE);
  if (!res.ok || !Array.isArray(res.data)) throw polymarketFailure(res, "event list");
  if (!res.data.length) throw new ProviderError(SOURCE, "no event matches the query", 404);
  return res.data.map((e) => ({
    kind: "prediction",
    title: `Polymarket event ${e.id}`,
    subject: `POLYMARKET.event.${e.id}`,
    points: polymarketEventPoints(e),
    provenance: prov(res),
    notes: [NOTE_UNITS],
  }));
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

/** Recent trades of a market (by conditionId) from the Data API, summarised: count, buy/sell size, VWAP, last trade. */
export async function polymarketTrades(conditionId: string, limit = 100): Promise<Dataset> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(conditionId)) throw new ProviderError(SOURCE, "a conditionId is a 0x-prefixed 32-byte hex string", 400);
  const n = Math.min(Math.max(limit, 1), 500);
  const res = await fetchJson<PolymarketTradeRaw[]>(`${DATA}/trades?market=${conditionId}&limit=${n}`, PACE);
  if (!res.ok || !Array.isArray(res.data)) throw polymarketFailure(res, "trades");
  const t = summarizeTrades(res.data);
  if (!t.count) throw new ProviderError(SOURCE, "no trades for this market", 404);
  const p = `POLYMARKET.${conditionId.slice(0, 10)}.trades`;
  const s = `Polymarket ${conditionId.slice(0, 10)}…`;
  const points: Point[] = [
    { key: `${p}.count`, label: `${s} trades read`, value: t.count, unit: "count" },
    { key: `${p}.buyVolume`, label: `${s} buy size`, value: t.buyVolume, unit: "shares" },
    { key: `${p}.sellVolume`, label: `${s} sell size`, value: t.sellVolume, unit: "shares" },
  ];
  for (const [i, v] of Object.entries(t.vwap))
    points.push({ key: `${p}.vwap.${i}`, label: `${s} VWAP of outcome ${i}`, value: v, unit: "USDC", formula: "Σ size × price / Σ size" });
  if (t.lastPrice !== undefined)
    points.push({
      key: `${p}.last.price`,
      label: `${s} last trade price (outcome ${t.lastOutcomeIndex ?? 0})`,
      value: t.lastPrice,
      unit: "USDC",
      asOf: t.lastAt?.slice(0, 10),
    });
  if (t.lastAt) points.push({ key: `${p}.last.at`, label: `${s} last trade time`, value: t.lastAt });
  const notes = [NOTE_UNITS, `the ${t.count} most recent trades only${t.firstAt ? `, since ${t.firstAt}` : ""}`];
  return { kind: "prediction-trades", title: `Polymarket recent trades ${s}`, subject: conditionId, points, provenance: prov(res), notes };
}
