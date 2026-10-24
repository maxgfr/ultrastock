// DEX pools from DEX Screener's public API — keyless, an aggregator indexing
// on-chain pools across chains (marked unofficial):
//
//   /latest/dex/search?q=<symbol|name|address>   up to 30 pairs, best match first
//   /tokens/v1/<chainId>/<tokenAddress>          every pair of one token (an empty array when none)
//
// Published limit: 300 requests a minute on these routes; calls are paced.
// Small tokens live and die on DEXes: the risk notes flag pools under $100k of
// liquidity (a modest order moves the price, an exit may not fill) and pools
// younger than 7 days (the typical window of a rug pull). Token names and
// symbols are chosen by whoever deployed the token: untrusted text, kept out
// of keys and labels (keys carry the chain and the pair address).
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow, fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";

const BASE = "https://api.dexscreener.com";
export const SOURCE = "dexscreener";
const PACE = { hostIntervalMs: 250 };
export const LOW_LIQUIDITY_USD = 100_000;
export const YOUNG_PAIR_DAYS = 7;

export interface DexPairRaw {
  chainId: string;
  dexId?: string;
  url?: string;
  pairAddress: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  txns?: { h24?: { buys?: number; sells?: number } };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url?: string;
  baseSymbol?: string;
  baseName?: string;
  baseAddress?: string;
  quoteSymbol?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange24h?: number;
  fdv?: number;
  marketCap?: number;
  buys24h?: number;
  sells24h?: number;
  createdAt?: string;
  ageDays?: number;
  lowLiquidity: boolean;
  young: boolean;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

/** Raw pairs into typed pairs, with age (days at `now`) and the two risk flags. Unknown liquidity counts as low. */
export function parseDexPairs(raw: readonly DexPairRaw[], now: Date): DexPair[] {
  return raw
    .filter((p) => p.chainId && p.pairAddress)
    .map((p) => {
      const liq = p.liquidity?.usd;
      const price = Number(p.priceUsd);
      const ageDays = finite(p.pairCreatedAt) ? (now.getTime() - p.pairCreatedAt) / 86_400_000 : undefined;
      return {
        chainId: safeId(p.chainId),
        dexId: safeId(p.dexId ?? "dex"),
        pairAddress: safeId(p.pairAddress),
        ...(p.url && /^https:\/\/dexscreener\.com\//.test(p.url) ? { url: p.url } : {}),
        baseSymbol: p.baseToken?.symbol,
        baseName: p.baseToken?.name,
        baseAddress: p.baseToken?.address,
        quoteSymbol: p.quoteToken?.symbol,
        ...(p.priceUsd !== undefined && Number.isFinite(price) ? { priceUsd: price } : {}),
        ...(finite(liq) ? { liquidityUsd: liq } : {}),
        ...(finite(p.volume?.h24) ? { volume24hUsd: p.volume!.h24 } : {}),
        ...(finite(p.priceChange?.h24) ? { priceChange24h: p.priceChange!.h24 } : {}),
        ...(finite(p.fdv) ? { fdv: p.fdv } : {}),
        ...(finite(p.marketCap) ? { marketCap: p.marketCap } : {}),
        ...(finite(p.txns?.h24?.buys) ? { buys24h: p.txns!.h24!.buys } : {}),
        ...(finite(p.txns?.h24?.sells) ? { sells24h: p.txns!.h24!.sells } : {}),
        ...(finite(p.pairCreatedAt) ? { createdAt: new Date(p.pairCreatedAt).toISOString().slice(0, 10) } : {}),
        ...(ageDays !== undefined ? { ageDays } : {}),
        lowLiquidity: !finite(liq) || liq < LOW_LIQUIDITY_USD,
        young: ageDays !== undefined && ageDays < YOUNG_PAIR_DAYS,
      };
    });
}

/** Points for pairs: price, liquidity, volume, valuation, age, flow, and the risk flags. */
export function dexPairPoints(pairs: readonly DexPair[], asOf: string): Point[] {
  const out: Point[] = [];
  for (const p of pairs) {
    const k = `DEX.${p.chainId}.${p.pairAddress.slice(0, 10)}`;
    const what = `DEX pair ${p.chainId}/${p.dexId} ${p.pairAddress.slice(0, 8)}…`;
    const url = p.url ? { url: p.url } : {};
    const push = (m: string, label: string, v: number | undefined, unit: string, formula?: string) => {
      if (finite(v)) out.push({ key: `${k}.${m}`, label: `${what} ${label}`, value: v, unit, asOf, ...url, ...(formula ? { formula } : {}) });
    };
    if (p.baseSymbol || p.quoteSymbol)
      out.push({ key: `${k}.pair`, label: `${what} tokens (base/quote)`, value: `${p.baseSymbol ?? "?"}/${p.quoteSymbol ?? "?"}`, untrusted: true, ...url });
    if (p.baseName) out.push({ key: `${k}.baseName`, label: `${what} base token name`, value: p.baseName, untrusted: true });
    if (p.baseAddress) out.push({ key: `${k}.baseAddress`, label: `${what} base token address`, value: p.baseAddress, untrusted: true });
    push("priceUsd", "price", p.priceUsd, "USD");
    push("liquidity", "liquidity", p.liquidityUsd, "USD");
    push("volume24h", "24h volume", p.volume24hUsd, "USD");
    push("change24h", "24h price change", p.priceChange24h, "%");
    push("fdv", "fully diluted valuation", p.fdv, "USD");
    push("mcap", "market cap", p.marketCap, "USD");
    push("buys24h", "24h buys", p.buys24h, "count");
    push("sells24h", "24h sells", p.sells24h, "count");
    if (finite(p.volume24hUsd) && finite(p.liquidityUsd) && p.liquidityUsd > 0)
      push("turnover", "24h volume / liquidity", p.volume24hUsd / p.liquidityUsd, "x", "volume24h / liquidity");
    push("ageDays", `age in days${p.createdAt ? ` (created ${p.createdAt})` : ""}`, p.ageDays, "days");
    out.push({ key: `${k}.risk.lowLiquidity`, label: `${what} liquidity under $100k`, value: p.lowLiquidity, asOf });
    out.push({ key: `${k}.risk.young`, label: `${what} younger than 7 days`, value: p.young, asOf });
  }
  return out;
}

/** Risk notes — identifiers and numbers only, never the token's own text. */
export function dexRiskNotes(pairs: readonly DexPair[]): string[] {
  const notes: string[] = [];
  for (const p of pairs) {
    const id = `${p.chainId}:${p.pairAddress}`;
    if (p.lowLiquidity)
      notes.push(
        `risk: pair ${id} has ${finite(p.liquidityUsd) ? `$${Math.round(p.liquidityUsd).toLocaleString("en-US")}` : "unknown"} of liquidity (< $100k) — a modest order moves the price and an exit may not fill`,
      );
    if (p.young) notes.push(`risk: pair ${id} is ${p.ageDays!.toFixed(1)} days old (< 7 days) — new pools are where rug pulls and honeypots happen`);
  }
  return notes;
}

function toDataset(pairs: DexPair[], title: string, res: { url: string; fetchedAt: string }, extra: string[]): Dataset {
  const asOf = res.fetchedAt.slice(0, 10);
  return {
    kind: "crypto-dex",
    title,
    points: dexPairPoints(pairs, asOf),
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "~1min", official: false, asOf },
    notes: [...extra, ...dexRiskNotes(pairs), "anyone can deploy a token with any name: match the contract address, not the symbol"],
  };
}

/** Pairs matching a symbol, name or address, the deepest `limit` by liquidity. */
export async function dexSearchPairs(query: string, opts: { limit?: number; now?: Date } = {}): Promise<Dataset> {
  const now = opts.now ?? clockNow();
  const res = await fetchJson<{ pairs?: DexPairRaw[] | null }>(`${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`, PACE);
  if (!res.ok || !res.data) throw new ProviderError(SOURCE, `search failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const pairs = parseDexPairs(res.data.pairs ?? [], now)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, opts.limit ?? 10);
  if (!pairs.length) throw new ProviderError(SOURCE, "no DEX pair matches the query", 404);
  return toDataset(pairs, `DEX pairs matching a search (top ${pairs.length} by liquidity)`, res, [
    "search results can mix unrelated tokens that share a ticker",
  ]);
}

/** Every pair of one token on one chain (chainId: solana, ethereum, base, bsc…), the deepest `limit`. */
export async function dexTokenPairs(chainId: string, address: string, opts: { limit?: number; now?: Date } = {}): Promise<Dataset> {
  const now = opts.now ?? clockNow();
  if (!/^[a-z0-9-]{2,30}$/.test(chainId) || !/^[A-Za-z0-9]{20,64}$/.test(address))
    throw new ProviderError(SOURCE, "expected a chain id (solana, ethereum…) and a token contract address", 400);
  const res = await fetchJson<DexPairRaw[]>(`${BASE}/tokens/v1/${chainId}/${address}`, PACE);
  if (!res.ok || !Array.isArray(res.data))
    throw new ProviderError(SOURCE, `token pairs failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const pairs = parseDexPairs(res.data, now)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .slice(0, opts.limit ?? 10);
  if (!pairs.length) throw new ProviderError(SOURCE, `no DEX pair for ${chainId}:${address}`, 404);
  const total = pairs.reduce((s, p) => s + (p.liquidityUsd ?? 0), 0);
  const ds = toDataset(pairs, `DEX pairs of token ${chainId}:${address.slice(0, 10)}…`, res, []);
  ds.subject = `${chainId}:${address}`;
  ds.points.unshift({
    key: `DEX.${chainId}.${safeId(address).slice(0, 10)}.liquidity.total`,
    label: `token ${chainId}:${address.slice(0, 8)}… liquidity over its ${pairs.length} deepest pairs`,
    value: total,
    unit: "USD",
    asOf: res.fetchedAt.slice(0, 10),
    formula: "Σ pair liquidity",
  });
  return ds;
}
