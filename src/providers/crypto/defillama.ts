// DeFi aggregates from DefiLlama's open API — keyless, built from open-source
// adapters that read each protocol's contracts. An aggregator, not the
// protocols themselves: marked unofficial.
//
//   api.llama.fi/v2/chains                    TVL per chain                               ~60 KB
//   api.llama.fi/tvl/<slug>                   one protocol's current TVL (a bare number)
//   api.llama.fi/protocols                    every protocol: TVL, 1d/7d change, category  ~9 MB
//   api.llama.fi/protocol/<slug>              one protocol's TVL history and chain split   1–35 MB
//   api.llama.fi/overview/fees[/<chain>]      fees by protocol (24h, 7d, 30d)              ~5 MB
//   stablecoins.llama.fi/stablecoins          circulating supply by stablecoin             ~0.5 MB
//   yields.llama.fi/pools                     every yield pool: TVL, base vs reward APY    ~10 MB
//
// The big answers are filtered and cut to the top N here, and the heaviest
// (protocols, pools) are cached for the day: never hand thousands of rows to
// the agent. Identifiers (slugs, chain names, pool symbols) are DefiLlama's
// own and are reduced to a safe character set before they reach a key or a
// label; protocol names and descriptions are untrusted text.
import { cachedJson, TTL } from "../../core/cache.js";
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";

export const SOURCE = "defillama";
const API = "https://api.llama.fi";
const BIG = { maxBytes: 96 * 1024 * 1024, timeoutMs: 60_000 };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/** An identifier safe for a key: letters, digits, dash and underscore. */
export function llamaId(raw: string): string {
  return (
    raw
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "unknown"
  );
}

/** An identifier safe for a label: the same, plus spaces, dots, slashes and plus signs. */
function llamaText(raw: string): string {
  return (
    raw
      .replace(/[^A-Za-z0-9 ._/+-]+/g, "")
      .trim()
      .slice(0, 60) || "?"
  );
}

async function get<T>(url: string, what: string, opts: { maxBytes?: number; timeoutMs?: number } = {}) {
  const res = await fetchJson<T>(url, opts);
  if (res.status === 400 || res.status === 404) throw new ProviderError(SOURCE, `${what}: not found`, 404);
  if (!res.ok || res.data === undefined) throw new ProviderError(SOURCE, `${what} failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  return { data: res.data, url: res.url, fetchedAt: res.fetchedAt };
}

const prov = (r: { url: string; fetchedAt: string }) => ({
  source: SOURCE,
  url: r.url,
  fetchedAt: r.fetchedAt,
  delay: "~1h",
  official: false,
  asOf: r.fetchedAt.slice(0, 10),
});

// ---------------------------------------------------------------- chains

export interface LlamaChain {
  name: string;
  tvl: number;
  tokenSymbol?: string | null;
}

/** The top chains by TVL, and their sum. */
export function chainPoints(rows: readonly LlamaChain[], limit = 20): Point[] {
  const sorted = rows.filter((c) => finite(c.tvl) && c.name).sort((a, b) => b.tvl - a.tvl);
  const out: Point[] = sorted
    .slice(0, limit)
    .map((c) => ({ key: `DEFI.${llamaId(c.name)}.tvl`, label: `${llamaText(c.name)} chain TVL`, value: c.tvl, unit: "USD" }));
  const sum = sorted.reduce((s, c) => s + c.tvl, 0);
  out.push({ key: "DEFI.chains.tvl.sum", label: `DeFi TVL summed over ${sorted.length} chains`, value: sum, unit: "USD", formula: "Σ chain TVL" });
  return out;
}

/** TVL by chain: the top `limit`, plus the total. */
export async function llamaChains(limit = 20): Promise<Dataset> {
  const r = await get<LlamaChain[]>(`${API}/v2/chains`, "chain TVL");
  if (!Array.isArray(r.data) || !r.data.length) throw new ProviderError(SOURCE, "no chains returned");
  return {
    kind: "defi",
    title: "DeFi TVL by chain",
    subject: "DEFI",
    points: chainPoints(r.data, limit),
    provenance: prov(r),
    notes: ["TVL as DefiLlama counts it (excludes borrowed and staked amounts by default)"],
  };
}

// ---------------------------------------------------------------- protocols

/** One protocol's current TVL (USD) — the cheap call. */
export async function llamaTvl(slug: string): Promise<Dataset> {
  const id = llamaId(slug.toLowerCase());
  const r = await get<number>(`${API}/tvl/${encodeURIComponent(slug.toLowerCase())}`, `protocol ${id}`);
  if (!finite(r.data)) throw new ProviderError(SOURCE, `no TVL for protocol ${id}`, 404);
  return {
    kind: "defi",
    title: `${id} TVL`,
    subject: id,
    points: [{ key: `${id}.defi.tvl`, label: `${id} total value locked`, value: r.data, unit: "USD" }],
    provenance: prov(r),
    notes: [],
  };
}

export interface LlamaProtocolRow {
  slug: string;
  name?: string;
  category?: string | null;
  chains?: string[];
  tvl?: number | null;
  change_1d?: number | null;
  change_7d?: number | null;
  mcap?: number | null;
}

/** Filter the protocol list by category and chain, then keep the top `limit` by TVL. */
export function filterProtocols(rows: readonly LlamaProtocolRow[], f: { category?: string; chain?: string; limit?: number } = {}): LlamaProtocolRow[] {
  const cat = f.category?.toLowerCase();
  const chain = f.chain?.toLowerCase();
  return rows
    .filter((p) => p.slug && finite(p.tvl) && p.tvl > 0)
    .filter((p) => !cat || (p.category ?? "").toLowerCase() === cat)
    .filter((p) => !chain || (p.chains ?? []).some((c) => c.toLowerCase() === chain))
    .sort((a, b) => b.tvl! - a.tvl!)
    .slice(0, f.limit ?? 20);
}

/** Points for a filtered protocol list: TVL, 1d/7d change, market cap / TVL. */
export function protocolListPoints(rows: readonly LlamaProtocolRow[]): Point[] {
  const out: Point[] = [];
  for (const p of rows) {
    const s = llamaId(p.slug);
    if (p.name) out.push({ key: `${s}.defi.name`, label: `${s} protocol name`, value: p.name, untrusted: true });
    out.push({ key: `${s}.defi.tvl`, label: `${s} TVL`, value: p.tvl!, unit: "USD" });
    if (p.category) out.push({ key: `${s}.defi.category`, label: `${s} category`, value: llamaText(p.category) });
    if (finite(p.change_1d)) out.push({ key: `${s}.defi.tvl.change1d`, label: `${s} TVL 1-day change`, value: p.change_1d, unit: "%" });
    if (finite(p.change_7d)) out.push({ key: `${s}.defi.tvl.change7d`, label: `${s} TVL 7-day change`, value: p.change_7d, unit: "%" });
    if (finite(p.mcap) && p.mcap > 0)
      out.push({ key: `${s}.defi.mcapToTvl`, label: `${s} market cap / TVL`, value: p.mcap / p.tvl!, unit: "x", formula: "mcap / tvl" });
  }
  return out;
}

/** The top protocols by TVL, optionally within one category ("Lending", "Dexs") or chain ("Ethereum"). */
export async function llamaProtocols(f: { category?: string; chain?: string; limit?: number } = {}): Promise<Dataset> {
  const list = await cachedJson(`defillama:protocols`, TTL.daily, async () => {
    const r = await get<LlamaProtocolRow[]>(`${API}/protocols`, "protocol list", BIG);
    if (!Array.isArray(r.data)) throw new ProviderError(SOURCE, "protocol list is not an array");
    const rows = r.data.map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl: p.tvl,
      change_1d: p.change_1d,
      change_7d: p.change_7d,
      mcap: p.mcap,
    }));
    return { rows, url: r.url, fetchedAt: r.fetchedAt };
  });
  if (!list) throw new ProviderError(SOURCE, "protocol list unavailable (offline, nothing cached)", 0);
  const rows = filterProtocols(list.rows, f);
  if (!rows.length) throw new ProviderError(SOURCE, "no protocol matches the filter", 404);
  const scope = [f.category ? llamaText(f.category) : undefined, f.chain ? `on ${llamaText(f.chain)}` : undefined].filter(Boolean).join(" ");
  return {
    kind: "defi",
    title: `Top ${rows.length} DeFi protocols by TVL${scope ? ` (${scope})` : ""}`,
    subject: "DEFI",
    points: protocolListPoints(rows),
    provenance: prov(list),
    notes: ["CEX reserves are listed by DefiLlama as protocols too (category CEX): filter by category to compare like with like"],
  };
}

export interface LlamaProtocolDetail {
  name?: string;
  description?: string | null;
  category?: string | null;
  tvl?: Array<{ date: number; totalLiquidityUSD: number }>;
  currentChainTvls?: Record<string, number>;
  mcap?: number | null;
}

/** A TVL history summary: now, 30/90/365 days back, the peak and the drawdown from it. */
export function protocolSummaryPoints(slug: string, d: LlamaProtocolDetail): Point[] {
  const s = llamaId(slug);
  const series = (d.tvl ?? []).filter((x) => finite(x.date) && finite(x.totalLiquidityUSD)).sort((a, b) => a.date - b.date);
  const out: Point[] = [];
  if (d.name) out.push({ key: `${s}.defi.name`, label: `${s} protocol name`, value: d.name, untrusted: true });
  if (d.description) out.push({ key: `${s}.defi.description`, label: `${s} description (DefiLlama listing)`, value: d.description, untrusted: true });
  if (d.category) out.push({ key: `${s}.defi.category`, label: `${s} category`, value: llamaText(d.category) });
  const last = series[series.length - 1];
  if (!last) return out;
  out.push({ key: `${s}.defi.tvl`, label: `${s} TVL`, value: last.totalLiquidityUSD, unit: "USD", asOf: isoDay(last.date) });
  const at = (days: number) => {
    const t = last.date - days * 86400;
    let pick: (typeof series)[number] | undefined;
    for (const x of series) if (x.date <= t) pick = x;
    return pick;
  };
  for (const days of [30, 90, 365]) {
    const p = at(days);
    if (!p || p.totalLiquidityUSD <= 0) continue;
    out.push({ key: `${s}.defi.tvl.${days}d`, label: `${s} TVL ${days} days earlier`, value: p.totalLiquidityUSD, unit: "USD", asOf: isoDay(p.date) });
    out.push({
      key: `${s}.defi.tvl.change${days}d`,
      label: `${s} TVL change over ${days} days`,
      value: (last.totalLiquidityUSD / p.totalLiquidityUSD - 1) * 100,
      unit: "%",
      asOf: isoDay(last.date),
      formula: `(tvl / tvl_${days}d_ago - 1) × 100`,
    });
  }
  const peak = series.reduce((m, x) => (x.totalLiquidityUSD > m.totalLiquidityUSD ? x : m), series[0]!);
  out.push({ key: `${s}.defi.tvl.peak`, label: `${s} peak TVL (${isoDay(peak.date)})`, value: peak.totalLiquidityUSD, unit: "USD", asOf: isoDay(peak.date) });
  if (peak.totalLiquidityUSD > 0)
    out.push({
      key: `${s}.defi.tvl.fromPeak`,
      label: `${s} TVL distance from peak`,
      value: (last.totalLiquidityUSD / peak.totalLiquidityUSD - 1) * 100,
      unit: "%",
      asOf: isoDay(last.date),
      formula: "(tvl / peak_tvl - 1) × 100",
    });
  // The chain split, without DefiLlama's borrowed/staking/pool2 side buckets.
  const chains = Object.entries(d.currentChainTvls ?? {})
    .filter(([k, v]) => finite(v) && v > 0 && !k.includes("-") && !["borrowed", "staking", "pool2", "vesting", "treasury", "offers"].includes(k))
    .sort((a, b) => b[1] - a[1]);
  const total = chains.reduce((a, [, v]) => a + v, 0);
  for (const [chain, v] of chains.slice(0, 5))
    out.push({
      key: `${s}.defi.tvlShare.${llamaId(chain)}`,
      label: `${s} TVL share on ${llamaText(chain)}`,
      value: (v / total) * 100,
      unit: "%",
      asOf: isoDay(last.date),
      formula: "chain_tvl / Σ chain_tvl × 100",
    });
  if (finite(d.mcap) && d.mcap > 0 && last.totalLiquidityUSD > 0)
    out.push({ key: `${s}.defi.mcapToTvl`, label: `${s} market cap / TVL`, value: d.mcap / last.totalLiquidityUSD, unit: "x", formula: "mcap / tvl" });
  return out;
}

/** One protocol's TVL history, summarised (the full history is never returned). */
export async function llamaProtocol(slug: string): Promise<Dataset> {
  const id = llamaId(slug.toLowerCase());
  const r = await get<LlamaProtocolDetail>(`${API}/protocol/${encodeURIComponent(slug.toLowerCase())}`, `protocol ${id}`, BIG);
  const points = protocolSummaryPoints(id, r.data);
  if (!points.some((p) => p.key === `${id}.defi.tvl`)) throw new ProviderError(SOURCE, `protocol ${id} has no TVL history`, 404);
  return {
    kind: "defi",
    title: `${id} TVL history summary`,
    subject: id,
    points,
    provenance: { ...prov(r), asOf: points.find((p) => p.key === `${id}.defi.tvl`)!.asOf },
    notes: ["TVL moves with token prices as much as with deposits: compare it with the tokens' own price change"],
  };
}

// ---------------------------------------------------------------- stablecoins

export interface LlamaStablecoin {
  id: string;
  name?: string;
  symbol?: string;
  pegType?: string;
  pegMechanism?: string;
  price?: number | null;
  circulating?: Record<string, number>;
  circulatingPrevWeek?: Record<string, number>;
  circulatingPrevMonth?: Record<string, number>;
}

/** Supply per stablecoin (top `limit`), its 7d/30d change and the USD-pegged total. */
export function stablecoinPoints(rows: readonly LlamaStablecoin[], limit = 15): Point[] {
  const supply = (c: LlamaStablecoin, k: "circulating" | "circulatingPrevWeek" | "circulatingPrevMonth") => c[k]?.[c.pegType ?? "peggedUSD"];
  const usd = rows.filter((c) => (c.pegType ?? "peggedUSD") === "peggedUSD" && finite(supply(c, "circulating")));
  const total = usd.reduce((s, c) => s + supply(c, "circulating")!, 0);
  const out: Point[] = [
    { key: "STABLE.total.supply", label: `USD stablecoin supply (${usd.length} coins)`, value: total, unit: "USD", formula: "Σ circulating (USD-pegged)" },
  ];
  const used = new Set<string>();
  const ranked = rows.filter((c) => finite(supply(c, "circulating"))).sort((a, b) => supply(b, "circulating")! - supply(a, "circulating")!);
  for (const c of ranked.slice(0, limit)) {
    let s = llamaId((c.symbol ?? "").toUpperCase());
    if (s === "unknown" || used.has(s)) s = `${s}_${llamaId(c.id)}`;
    used.add(s);
    const now = supply(c, "circulating")!;
    const peg = (c.pegType ?? "peggedUSD").replace(/^pegged/, "");
    if (c.name) out.push({ key: `${s}.stable.name`, label: `${s} stablecoin name`, value: c.name, untrusted: true });
    out.push({ key: `${s}.stable.supply`, label: `${s} circulating supply (${peg} peg)`, value: now, unit: peg });
    if ((c.pegType ?? "peggedUSD") === "peggedUSD" && total > 0)
      out.push({
        key: `${s}.stable.share`,
        label: `${s} share of USD stablecoin supply`,
        value: (now / total) * 100,
        unit: "%",
        formula: "supply / total_usd_supply × 100",
      });
    for (const [k, tag, what] of [
      ["circulatingPrevWeek", "7d", "7-day"],
      ["circulatingPrevMonth", "30d", "30-day"],
    ] as const) {
      const prev = supply(c, k);
      if (finite(prev) && prev > 0)
        out.push({
          key: `${s}.stable.supply.change${tag}`,
          label: `${s} supply ${what} change`,
          value: (now / prev - 1) * 100,
          unit: "%",
          formula: `(supply / supply_${tag}_ago - 1) × 100`,
        });
    }
    if (finite(c.price)) out.push({ key: `${s}.stable.price`, label: `${s} price`, value: c.price, unit: "USD" });
    if (c.pegMechanism) out.push({ key: `${s}.stable.mechanism`, label: `${s} peg mechanism`, value: llamaText(c.pegMechanism) });
  }
  return out;
}

/** Stablecoin supply: total USD-pegged supply and the top `limit` coins. */
export async function llamaStablecoins(limit = 15): Promise<Dataset> {
  const r = await get<{ peggedAssets?: LlamaStablecoin[] }>("https://stablecoins.llama.fi/stablecoins?includePrices=true", "stablecoins", BIG);
  const rows = r.data.peggedAssets ?? [];
  if (!rows.length) throw new ProviderError(SOURCE, "no stablecoins returned");
  return {
    kind: "defi",
    title: "Stablecoin supply",
    subject: "STABLE",
    points: stablecoinPoints(rows, limit),
    provenance: prov(r),
    notes: ["supply grows when dollars come on-chain: a rising total is read as fresh liquidity, a falling one as outflow"],
  };
}

// ---------------------------------------------------------------- yields

export interface LlamaPool {
  pool: string;
  chain?: string;
  project?: string;
  symbol?: string;
  tvlUsd?: number | null;
  apy?: number | null;
  apyBase?: number | null;
  apyReward?: number | null;
  apyMean30d?: number | null;
  stablecoin?: boolean;
  ilRisk?: string | null;
  exposure?: string | null;
}

export interface PoolFilter {
  /** Matches a token inside the pool symbol ("USDC" matches "USDC-WETH"). */
  symbol?: string;
  project?: string;
  chain?: string;
  stablecoinOnly?: boolean;
  minTvlUsd?: number;
  limit?: number;
}

/** Filter the pool list, then keep the top `limit` by TVL. */
export function filterPools(rows: readonly LlamaPool[], f: PoolFilter = {}): LlamaPool[] {
  const sym = f.symbol?.toUpperCase();
  const proj = f.project?.toLowerCase();
  const chain = f.chain?.toLowerCase();
  return rows
    .filter((p) => p.pool && finite(p.tvlUsd) && p.tvlUsd >= (f.minTvlUsd ?? 0))
    .filter(
      (p) =>
        !sym ||
        (p.symbol ?? "")
          .toUpperCase()
          .split(/[-/+ ]/)
          .includes(sym),
    )
    .filter((p) => !proj || (p.project ?? "").toLowerCase() === proj)
    .filter((p) => !chain || (p.chain ?? "").toLowerCase() === chain)
    .filter((p) => !f.stablecoinOnly || p.stablecoin === true)
    .sort((a, b) => b.tvlUsd! - a.tvlUsd!)
    .slice(0, f.limit ?? 10);
}

/**
 * The share of a pool's APY paid in reward tokens (emissions) rather than
 * earned from fees or interest. A high share means the yield lasts only as
 * long as the emissions, and is paid in a token that can fall.
 */
export function rewardShare(apyBase: number | null | undefined, apyReward: number | null | undefined): number | undefined {
  const base = finite(apyBase) ? apyBase : 0;
  const reward = finite(apyReward) ? apyReward : 0;
  const total = base + reward;
  return total > 0 ? (reward / total) * 100 : undefined;
}

/** Points for filtered pools: TVL, APY split and the reward share. */
export function poolPoints(rows: readonly LlamaPool[]): Point[] {
  const out: Point[] = [];
  for (const p of rows) {
    const k = `YIELD.${llamaId(p.pool).slice(0, 8)}`;
    const what = `${llamaText(p.project ?? "?")} ${llamaText(p.symbol ?? "?")} on ${llamaText(p.chain ?? "?")}`;
    out.push({ key: `${k}.tvl`, label: `${what} pool TVL`, value: p.tvlUsd!, unit: "USD" });
    if (finite(p.apy)) out.push({ key: `${k}.apy`, label: `${what} APY`, value: p.apy, unit: "%" });
    if (finite(p.apyBase)) out.push({ key: `${k}.apy.base`, label: `${what} base APY (fees, interest)`, value: p.apyBase, unit: "%" });
    if (finite(p.apyReward)) out.push({ key: `${k}.apy.reward`, label: `${what} reward APY (token emissions)`, value: p.apyReward, unit: "%" });
    const share = rewardShare(p.apyBase, p.apyReward);
    if (share !== undefined)
      out.push({
        key: `${k}.apy.rewardShare`,
        label: `${what} share of APY from emissions`,
        value: share,
        unit: "%",
        formula: "apyReward / (apyBase + apyReward) × 100",
      });
    if (finite(p.apyMean30d)) out.push({ key: `${k}.apy.mean30d`, label: `${what} 30-day mean APY`, value: p.apyMean30d, unit: "%" });
    if (p.ilRisk) out.push({ key: `${k}.ilRisk`, label: `${what} impermanent-loss risk flag`, value: p.ilRisk === "yes" });
  }
  return out;
}

/** The largest yield pools matching a filter, with base vs reward APY. */
export async function llamaYields(f: PoolFilter = {}): Promise<Dataset> {
  const all = await cachedJson("defillama:pools", TTL.intraday * 12, async () => {
    const r = await get<{ status?: string; data?: LlamaPool[] }>("https://yields.llama.fi/pools", "yield pools", BIG);
    if (!Array.isArray(r.data.data)) throw new ProviderError(SOURCE, "yield pools: no data array");
    const rows = r.data.data.map((p) => ({
      pool: p.pool,
      chain: p.chain,
      project: p.project,
      symbol: p.symbol,
      tvlUsd: p.tvlUsd,
      apy: p.apy,
      apyBase: p.apyBase,
      apyReward: p.apyReward,
      apyMean30d: p.apyMean30d,
      stablecoin: p.stablecoin,
      ilRisk: p.ilRisk,
      exposure: p.exposure,
    }));
    return { rows, url: r.url, fetchedAt: r.fetchedAt };
  });
  if (!all) throw new ProviderError(SOURCE, "yield pools unavailable (offline, nothing cached)", 0);
  const rows = filterPools(all.rows, f);
  if (!rows.length) throw new ProviderError(SOURCE, "no yield pool matches the filter", 404);
  const shares = rows.map((p) => rewardShare(p.apyBase, p.apyReward)).filter((x): x is number => x !== undefined);
  const notes = ["APY is variable and backward-looking; reward APY is paid in the protocol's token at its current price"];
  const heavy = shares.filter((x) => x >= 50).length;
  if (heavy) notes.push(`${heavy} of ${rows.length} pools earn half or more of their APY from emissions: that yield depends on the reward token`);
  return {
    kind: "defi-yield",
    title: `Top ${rows.length} yield pools by TVL`,
    subject: "YIELD",
    points: poolPoints(rows),
    provenance: prov(all),
    notes,
  };
}

// ---------------------------------------------------------------- fees

export interface LlamaFeesOverview {
  total24h?: number | null;
  total7d?: number | null;
  total30d?: number | null;
  change_1d?: number | null;
  change_7d?: number | null;
  change_1m?: number | null;
  protocols?: Array<{ slug?: string; name?: string; category?: string; total24h?: number | null; total7d?: number | null; total30d?: number | null }>;
}

/** Totals and the top `limit` fee earners over 24h. */
export function feesPoints(o: LlamaFeesOverview, scope: string, limit = 15): Point[] {
  const S = llamaId(scope.toUpperCase());
  const out: Point[] = [];
  const push = (key: string, label: string, v: number | null | undefined, unit: string) => {
    if (finite(v)) out.push({ key, label, value: v, unit });
  };
  push(`${S}.fees.24h`, `${scope} fees, last 24h`, o.total24h, "USD");
  push(`${S}.fees.7d`, `${scope} fees, last 7 days`, o.total7d, "USD");
  push(`${S}.fees.30d`, `${scope} fees, last 30 days`, o.total30d, "USD");
  push(`${S}.fees.change1d`, `${scope} fees 1-day change`, o.change_1d, "%");
  push(`${S}.fees.change7d`, `${scope} fees 7-day change`, o.change_7d, "%");
  push(`${S}.fees.change30d`, `${scope} fees 30-day change`, o.change_1m, "%");
  const top = (o.protocols ?? []).filter((p) => p.slug && finite(p.total24h)).sort((a, b) => b.total24h! - a.total24h!);
  for (const p of top.slice(0, limit)) {
    const s = llamaId(p.slug!);
    push(`${s}.defi.fees.24h`, `${s} fees, last 24h`, p.total24h, "USD");
    push(`${s}.defi.fees.30d`, `${s} fees, last 30 days`, p.total30d, "USD");
  }
  return out;
}

/** Fees paid to protocols — across DeFi, or on one chain ("Ethereum", "Solana"). */
export async function llamaFees(opts: { chain?: string; limit?: number } = {}): Promise<Dataset> {
  const path = opts.chain ? `/overview/fees/${encodeURIComponent(opts.chain.toLowerCase())}` : "/overview/fees";
  const r = await get<LlamaFeesOverview>(`${API}${path}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`, "fees overview", BIG);
  const scope = opts.chain ? llamaText(opts.chain) : "DeFi";
  const points = feesPoints(r.data, scope, opts.limit ?? 15);
  if (!points.length) throw new ProviderError(SOURCE, `no fee figures for ${scope}`, 404);
  return {
    kind: "defi",
    title: `Protocol fees (${scope})`,
    subject: opts.chain ? llamaId(scope.toUpperCase()) : "DEFI",
    points,
    provenance: prov(r),
    notes: ["fees are what users paid; revenue (what the protocol keeps) is a smaller, separate figure"],
  };
}
