// Crypto market breadth from CoinGecko's public API — keyless (an optional free
// "demo" key raises the quota), an aggregator of exchange prices, so marked
// unofficial:
//
//   /global                       total market cap and volume, BTC/ETH dominance
//   /coins/markets?vs_currency=…  top coins by market cap: price, cap, volume, 24h/7d/30d change, ATH
//   /coins/<id>                   one coin: categories, links, supply (circulating/total/max), FDV, description
//   /search?query=…               coin ids for a name or ticker
//
// The keyless tier allows roughly 5–15 calls a minute and answers 429 beyond:
// calls are paced 2.5 s apart. With ULTRASTOCK_COINGECKO_API_KEY set, the key
// goes in the x-cg-demo-api-key header (never in a URL, a note or a fixture).
// Names, descriptions and categories are the projects' own words: untrusted.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";

const BASE = "https://api.coingecko.com/api/v3";
export const SOURCE = "coingecko";

function cgOptions() {
  const key = process.env.ULTRASTOCK_COINGECKO_API_KEY;
  return { hostIntervalMs: 2500, ...(key ? { headers: { "x-cg-demo-api-key": key } } : {}) };
}

function keyNote(): string[] {
  return process.env.ULTRASTOCK_COINGECKO_API_KEY ? ["read with a CoinGecko demo API key (ULTRASTOCK_COINGECKO_API_KEY)"] : [];
}

async function get<T>(path: string, what: string): Promise<{ data: T; url: string; fetchedAt: string }> {
  const res = await fetchJson<T>(`${BASE}${path}`, cgOptions());
  if (res.status === 404) throw new ProviderError(SOURCE, `${what}: not found`, 404);
  if (res.status === 429) throw new ProviderError(SOURCE, `${what}: rate limited (429) — the keyless tier allows a few calls a minute`, 429);
  if (!res.ok || res.data === undefined) throw new ProviderError(SOURCE, `${what} failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  return { data: res.data, url: res.url, fetchedAt: res.fetchedAt };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A key-safe subject for a coin: its ticker when it is a plain one, else its CoinGecko id. */
export function coinSubject(symbol: string | undefined, id: string): string {
  const s = (symbol ?? "").toUpperCase();
  return /^[A-Z0-9]{1,12}$/.test(s) ? s : id.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "COIN";
}

export interface CoinGeckoGlobal {
  active_cryptocurrencies?: number;
  total_market_cap?: Record<string, number>;
  total_volume?: Record<string, number>;
  market_cap_percentage?: Record<string, number>;
  market_cap_change_percentage_24h_usd?: number;
  updated_at?: number;
}

/** Total market cap, volume and dominance as points. */
export function globalPoints(g: CoinGeckoGlobal, vs = "usd"): Point[] {
  const asOf = g.updated_at ? isoDay(g.updated_at * 1000) : undefined;
  const cur = vs.toUpperCase();
  const out: Point[] = [];
  const push = (key: string, label: string, value: number | undefined, unit: string, formula?: string) => {
    if (finite(value)) out.push({ key, label, value, unit, ...(asOf ? { asOf } : {}), ...(formula ? { formula } : {}) });
  };
  push("CRYPTO.global.mcap", "Total crypto market cap", g.total_market_cap?.[vs], cur);
  push("CRYPTO.global.volume24h", "Total crypto 24h volume", g.total_volume?.[vs], cur);
  push("CRYPTO.global.mcap.change24h", "Total crypto market cap 24h change", g.market_cap_change_percentage_24h_usd, "%");
  push("CRYPTO.global.dominance.btc", "Bitcoin dominance (share of total market cap)", g.market_cap_percentage?.btc, "%");
  push("CRYPTO.global.dominance.eth", "Ether dominance (share of total market cap)", g.market_cap_percentage?.eth, "%");
  const stables = ["usdt", "usdc"].map((k) => g.market_cap_percentage?.[k]).filter(finite);
  if (stables.length === 2)
    push("CRYPTO.global.dominance.usdtusdc", "USDT + USDC share of total market cap", stables[0]! + stables[1]!, "%", "dominance(USDT) + dominance(USDC)");
  push("CRYPTO.global.coins", "Active cryptocurrencies tracked by CoinGecko", g.active_cryptocurrencies, "count");
  return out;
}

/** Total crypto market cap, volume and BTC/ETH dominance. */
export async function coingeckoGlobal(vs = "usd"): Promise<Dataset> {
  const r = await get<{ data: CoinGeckoGlobal }>("/global", "global market data");
  const g = r.data.data;
  const points = globalPoints(g, vs.toLowerCase());
  if (!points.length) throw new ProviderError(SOURCE, `no global figures in ${vs}`);
  return {
    kind: "crypto-market",
    title: "Crypto market totals and dominance",
    subject: "CRYPTO",
    points,
    provenance: { source: SOURCE, url: r.url, fetchedAt: r.fetchedAt, delay: "~1-5min", official: false, asOf: points[0]!.asOf },
    notes: ["CoinGecko aggregates many exchanges; totals depend on which coins it tracks", ...keyNote()],
  };
}

export interface CoinGeckoMarketRow {
  id: string;
  symbol?: string;
  name?: string;
  current_price?: number | null;
  market_cap?: number | null;
  market_cap_rank?: number | null;
  fully_diluted_valuation?: number | null;
  total_volume?: number | null;
  circulating_supply?: number | null;
  ath?: number | null;
  ath_change_percentage?: number | null;
  ath_date?: string | null;
  last_updated?: string | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  price_change_percentage_30d_in_currency?: number | null;
}

/** Points for a /coins/markets page; a ticker shared by two coins falls back to the id. */
export function marketPoints(rows: readonly CoinGeckoMarketRow[], vs = "usd"): Point[] {
  const cur = vs.toUpperCase();
  const used = new Set<string>();
  const out: Point[] = [];
  for (const r of rows) {
    let s = coinSubject(r.symbol, r.id);
    if (used.has(s)) s = coinSubject(undefined, r.id);
    used.add(s);
    const asOf = r.last_updated ? r.last_updated.slice(0, 10) : undefined;
    const at = asOf ? { asOf } : {};
    const push = (metric: string, what: string, value: number | null | undefined, unit: string) => {
      if (finite(value)) out.push({ key: `${s}.market.${metric}`, label: `${s} ${what}`, value, unit, ...at });
    };
    if (r.name) out.push({ key: `${s}.market.name`, label: `${s} name on CoinGecko`, value: r.name, untrusted: true });
    push("rank", "market cap rank", r.market_cap_rank, "count");
    push("price", "price", r.current_price, cur);
    push("mcap", "market cap", r.market_cap, cur);
    push("fdv", "fully diluted valuation", r.fully_diluted_valuation, cur);
    push("volume24h", "24h volume", r.total_volume, cur);
    push("change.24h", "24h price change", r.price_change_percentage_24h_in_currency, "%");
    push("change.7d", "7-day price change", r.price_change_percentage_7d_in_currency, "%");
    push("change.30d", "30-day price change", r.price_change_percentage_30d_in_currency, "%");
    push("ath", `all-time high${r.ath_date ? ` (${r.ath_date.slice(0, 10)})` : ""}`, r.ath, cur);
    push("ath.change", "distance from all-time high", r.ath_change_percentage, "%");
  }
  return out;
}

/** The top `limit` coins by market cap (max 250 per page). */
export async function coingeckoMarkets(opts: { limit?: number; vs?: string; page?: number } = {}): Promise<Dataset> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 250);
  const vs = (opts.vs ?? "usd").toLowerCase();
  const path = `/coins/markets?vs_currency=${encodeURIComponent(vs)}&order=market_cap_desc&per_page=${limit}&page=${opts.page ?? 1}&price_change_percentage=24h,7d,30d`;
  const r = await get<CoinGeckoMarketRow[]>(path, "coin markets");
  if (!Array.isArray(r.data) || !r.data.length) throw new ProviderError(SOURCE, `no coins returned in ${vs}`);
  return {
    kind: "crypto-market",
    title: `Top ${r.data.length} coins by market cap (${vs.toUpperCase()})`,
    subject: "CRYPTO",
    points: marketPoints(r.data, vs),
    provenance: { source: SOURCE, url: r.url, fetchedAt: r.fetchedAt, delay: "~1-5min", official: false, asOf: r.fetchedAt.slice(0, 10) },
    notes: ["market cap = price × circulating supply as CoinGecko counts it; FDV uses the max (or total) supply", ...keyNote()],
  };
}

export interface CoinGeckoCoin {
  id: string;
  symbol?: string;
  name?: string;
  categories?: Array<string | null>;
  description?: { en?: string };
  links?: { homepage?: string[]; whitepaper?: string; blockchain_site?: string[]; repos_url?: { github?: string[] } };
  genesis_date?: string | null;
  market_cap_rank?: number | null;
  market_data?: {
    current_price?: Record<string, number>;
    market_cap?: Record<string, number>;
    fully_diluted_valuation?: Record<string, number>;
    total_volume?: Record<string, number>;
    circulating_supply?: number | null;
    total_supply?: number | null;
    max_supply?: number | null;
    market_cap_fdv_ratio?: number | null;
    last_updated?: string;
  };
}

/** Supply, valuation and profile points for one coin; its own words are untrusted. */
export function coinPoints(c: CoinGeckoCoin, vs = "usd"): Point[] {
  const s = coinSubject(c.symbol, c.id);
  const md = c.market_data ?? {};
  const asOf = md.last_updated?.slice(0, 10);
  const at = asOf ? { asOf } : {};
  const cur = vs.toUpperCase();
  const out: Point[] = [];
  const push = (metric: string, what: string, value: number | null | undefined, unit: string, formula?: string) => {
    if (finite(value)) out.push({ key: `${s}.${metric}`, label: `${s} ${what}`, value, unit, ...at, ...(formula ? { formula } : {}) });
  };
  push("market.price", "price", md.current_price?.[vs], cur);
  push("market.mcap", "market cap", md.market_cap?.[vs], cur);
  push("market.fdv", "fully diluted valuation", md.fully_diluted_valuation?.[vs], cur);
  push("market.volume24h", "24h volume", md.total_volume?.[vs], cur);
  push("market.rank", "market cap rank", c.market_cap_rank, "count");
  push("supply.circulating", "circulating supply", md.circulating_supply, s);
  push("supply.total", "total supply", md.total_supply, s);
  push("supply.max", "max supply", md.max_supply, s);
  if (finite(md.circulating_supply) && finite(md.max_supply) && md.max_supply > 0)
    push(
      "supply.circulatingShare",
      "circulating share of max supply",
      (md.circulating_supply / md.max_supply) * 100,
      "%",
      "circulating_supply / max_supply × 100",
    );
  push("market.mcapToFdv", "market cap / FDV", md.market_cap_fdv_ratio, "ratio");
  if (c.name) out.push({ key: `${s}.profile.name`, label: `${s} name`, value: c.name, untrusted: true });
  const cats = (c.categories ?? []).filter((x): x is string => typeof x === "string" && x.length > 0);
  if (cats.length) out.push({ key: `${s}.profile.categories`, label: `${s} categories on CoinGecko`, value: cats.join("; "), untrusted: true });
  if (c.genesis_date) out.push({ key: `${s}.profile.genesis`, label: `${s} genesis date`, value: c.genesis_date });
  const home = c.links?.homepage?.find((u) => /^https?:\/\//.test(u));
  if (home) out.push({ key: `${s}.profile.homepage`, label: `${s} homepage`, value: home, untrusted: true });
  if (c.links?.whitepaper && /^https?:\/\//.test(c.links.whitepaper))
    out.push({ key: `${s}.profile.whitepaper`, label: `${s} whitepaper`, value: c.links.whitepaper, untrusted: true });
  const repo = c.links?.repos_url?.github?.find((u) => /^https?:\/\//.test(u));
  if (repo) out.push({ key: `${s}.profile.repo`, label: `${s} source repository`, value: repo, untrusted: true });
  const desc = c.description?.en?.trim();
  if (desc) out.push({ key: `${s}.profile.description`, label: `${s} description (project's own words)`, value: desc, untrusted: true });
  return out;
}

/** One coin by CoinGecko id ("bitcoin", "solana"): supply, FDV, categories, links. */
export async function coingeckoCoin(id: string, vs = "usd"): Promise<Dataset> {
  if (!/^[a-z0-9-]{1,80}$/i.test(id)) throw new ProviderError(SOURCE, `"${id}" is not a CoinGecko coin id (use coingeckoSearch to find one)`, 400);
  const path = `/coins/${id.toLowerCase()}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
  const r = await get<CoinGeckoCoin>(path, `coin ${id}`);
  const points = coinPoints(r.data, vs.toLowerCase());
  const s = coinSubject(r.data.symbol, r.data.id);
  return {
    kind: "crypto-profile",
    title: `${s} supply, valuation and profile`,
    subject: s,
    points,
    provenance: { source: SOURCE, url: r.url, fetchedAt: r.fetchedAt, delay: "~1-5min", official: false, asOf: r.data.market_data?.last_updated?.slice(0, 10) },
    notes: [
      "supply figures are CoinGecko's count; unlocks and treasury holdings can move circulating supply",
      "description, categories and links are the project's own claims",
      ...keyNote(),
    ],
  };
}

export interface CoinSearchHit {
  id: string;
  name: string;
  symbol: string;
  rank?: number;
}

/** The coin hits of a /search answer (exchanges, categories and NFTs are dropped). */
export function parseCoinSearch(body: { coins?: Array<{ id?: string; name?: string; symbol?: string; market_cap_rank?: number | null }> }): CoinSearchHit[] {
  return (body.coins ?? [])
    .filter((c) => c.id)
    .map((c) => ({ id: c.id!, name: c.name ?? "", symbol: c.symbol ?? "", ...(finite(c.market_cap_rank) ? { rank: c.market_cap_rank } : {}) }));
}

/** Coin ids matching a name or ticker, best match first, as untrusted points (the ids feed coingeckoCoin). */
export async function coingeckoSearch(query: string, limit = 10): Promise<Dataset> {
  const r = await get<Parameters<typeof parseCoinSearch>[0]>(`/search?query=${encodeURIComponent(query)}`, "coin search");
  const hits = parseCoinSearch(r.data).slice(0, limit);
  if (!hits.length) throw new ProviderError(SOURCE, "no coin matches the query", 404);
  const points: Point[] = [];
  hits.forEach((h, i) => {
    const n = i + 1;
    points.push({ key: `CG.search.${n}.id`, label: `CoinGecko search hit ${n} id`, value: h.id, untrusted: true });
    points.push({ key: `CG.search.${n}.name`, label: `CoinGecko search hit ${n} name and ticker`, value: `${h.name} (${h.symbol})`, untrusted: true });
    if (h.rank !== undefined) points.push({ key: `CG.search.${n}.rank`, label: `CoinGecko search hit ${n} market cap rank`, value: h.rank, unit: "count" });
  });
  return {
    kind: "crypto-search",
    title: "CoinGecko coin search",
    points,
    provenance: { source: SOURCE, url: r.url, fetchedAt: r.fetchedAt, official: false },
    notes: ["a ticker is not unique: check the id and rank before using a hit", ...keyNote()],
  };
}
