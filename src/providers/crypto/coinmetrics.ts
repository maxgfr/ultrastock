// On-chain fundamentals from Coin Metrics' community API — keyless, computed by
// Coin Metrics from its own full nodes (a data vendor, so marked unofficial):
//
//   community-api.coinmetrics.io/v4/timeseries/asset-metrics
//     ?assets=btc&metrics=…&frequency=1d&page_size=N&paging_from=end
//
// The community tier serves a subset of the catalogue, and asking for one
// metric outside it fails the whole call with 403 — so only metrics verified
// to answer keyless are requested, per asset. Checked 2026-10: BTC and ETH
// answer; SOL answers none. Adjusted transfer value (TxTfrValAdjUSD), realised
// cap, NVT and USD fees are pro-only, so NVT cannot be computed from this tier:
// `nvtRatio` is kept for a caller holding both inputs from elsewhere.
// Values arrive as decimal strings; rows are daily, stamped at the day's start (UTC).
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";

const BASE = "https://community-api.coinmetrics.io/v4";
export const SOURCE = "coinmetrics";

interface MetricSpec {
  key: string;
  label: string;
  unit: (asset: string) => string;
}

/** The community-tier metrics this module reads, with their evidence key and unit. */
export const CM_METRICS: Record<string, MetricSpec> = {
  PriceUSD: { key: "market.price", label: "reference price", unit: () => "USD" },
  CapMrktCurUSD: { key: "market.mcap", label: "market cap", unit: () => "USD" },
  CapMVRVCur: { key: "onchain.mvrv", label: "MVRV (market value / realised value)", unit: () => "ratio" },
  AdrActCnt: { key: "onchain.activeAddresses", label: "active addresses", unit: () => "count" },
  TxCnt: { key: "onchain.txCount", label: "transactions", unit: () => "count" },
  TxTfrCnt: { key: "onchain.transferCount", label: "transfers", unit: () => "count" },
  SplyCur: { key: "supply.current", label: "current supply", unit: (a) => a },
  IssTotUSD: { key: "onchain.issuanceUsd", label: "daily new issuance value", unit: () => "USD" },
  FeeTotNtv: { key: "onchain.fees", label: "daily fees paid", unit: (a) => a },
  BlkCnt: { key: "onchain.blocks", label: "blocks", unit: () => "count" },
  HashRate: { key: "onchain.hashrate", label: "mean hashrate", unit: () => "TH/s" },
  ROI30d: { key: "market.roi30d", label: "30-day return", unit: () => "%" },
};

/** Per asset, the metrics verified to answer on the community tier. */
export const COMMUNITY_METRICS: Record<string, string[]> = {
  btc: ["PriceUSD", "CapMrktCurUSD", "CapMVRVCur", "AdrActCnt", "TxCnt", "TxTfrCnt", "SplyCur", "IssTotUSD", "FeeTotNtv", "BlkCnt", "HashRate", "ROI30d"],
  // Ethereum's hashrate ended with the move to proof of stake (2022).
  eth: ["PriceUSD", "CapMrktCurUSD", "CapMVRVCur", "AdrActCnt", "TxCnt", "TxTfrCnt", "SplyCur", "IssTotUSD", "FeeTotNtv", "BlkCnt", "ROI30d"],
};

/**
 * NVT: network value over the value it settles on-chain in a day. High means
 * the price runs ahead of usage. Undefined when the transfer value is not positive.
 */
export function nvtRatio(marketCapUsd: number, adjTransferValueUsd: number): number | undefined {
  return Number.isFinite(marketCapUsd) && Number.isFinite(adjTransferValueUsd) && adjTransferValueUsd > 0 ? marketCapUsd / adjTransferValueUsd : undefined;
}

export interface CmRow {
  /** YYYY-MM-DD */
  date: string;
  values: Record<string, number>;
}

/** Coin Metrics rows (string values) into dated numeric rows, oldest first. */
export function parseCoinmetricsRows(data: ReadonlyArray<Record<string, string>>): CmRow[] {
  const rows: CmRow[] = [];
  for (const r of data) {
    const date = /^(\d{4}-\d{2}-\d{2})T/.exec(r.time ?? "")?.[1];
    if (!date) continue;
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "asset" || k === "time") continue;
      const n = Number(v);
      if (v !== "" && Number.isFinite(n)) values[k] = n;
    }
    rows.push({ date, values });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The latest value of each metric (each with its own date: a metric can lag a
 * day), the window change of price and active addresses, and NVT when the
 * adjusted transfer value is present.
 */
export function coinmetricsPoints(asset: string, rows: readonly CmRow[]): Point[] {
  const A = asset.toUpperCase();
  const out: Point[] = [];
  const latest = (m: string) => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.values[m] !== undefined) return { date: rows[i]!.date, v: rows[i]!.values[m]! };
    return undefined;
  };
  const first = (m: string) => rows.find((r) => r.values[m] !== undefined);
  const metrics = new Set(rows.flatMap((r) => Object.keys(r.values)));
  for (const m of Object.keys(CM_METRICS)) {
    if (!metrics.has(m)) continue;
    const spec = CM_METRICS[m]!;
    const l = latest(m)!;
    out.push({ key: `${A}.${spec.key}`, label: `${A} ${spec.label} (${l.date})`, value: l.v, unit: spec.unit(A), asOf: l.date });
  }
  for (const [m, what] of [
    ["PriceUSD", "price"],
    ["AdrActCnt", "active addresses"],
  ] as const) {
    const l = latest(m);
    const f = first(m);
    if (!l || !f || f.date === l.date || f.values[m]! <= 0) continue;
    out.push({
      key: `${A}.${CM_METRICS[m]!.key}.change.window`,
      label: `${A} ${what} change ${f.date} → ${l.date}`,
      value: (l.v / f.values[m]! - 1) * 100,
      unit: "%",
      asOf: l.date,
      formula: `(${m}[${l.date}] / ${m}[${f.date}] - 1) × 100`,
    });
  }
  const cap = latest("CapMrktCurUSD");
  const tfr = latest("TxTfrValAdjUSD");
  if (cap && tfr && cap.date === tfr.date) {
    const nvt = nvtRatio(cap.v, tfr.v);
    if (nvt !== undefined)
      out.push({ key: `${A}.onchain.nvt`, label: `${A} NVT ratio`, value: nvt, unit: "x", asOf: cap.date, formula: "CapMrktCurUSD / TxTfrValAdjUSD" });
  }
  return out;
}

export interface CmSeries {
  asset: string;
  rows: CmRow[];
  url: string;
  fetchedAt: string;
}

/** Daily on-chain metric rows for `asset` (btc, eth) over the last `days` days, oldest first. */
export async function coinmetricsSeries(asset: string, days = 30): Promise<CmSeries> {
  const a = asset.toLowerCase();
  const metrics = COMMUNITY_METRICS[a];
  if (!metrics) throw new ProviderError(SOURCE, `${asset}: no community-tier metrics verified for this asset (btc, eth are)`, 403);
  const n = Math.min(Math.max(Math.round(days), 2), 1000);
  const url = `${BASE}/timeseries/asset-metrics?assets=${a}&metrics=${metrics.join(",")}&frequency=1d&page_size=${n}&paging_from=end`;
  const res = await fetchJson<{ data?: Array<Record<string, string>> }>(url, { hostIntervalMs: 700 });
  if (res.status === 403) throw new ProviderError(SOURCE, `${asset}: a requested metric is not on the community tier (403)`, 403);
  if (!res.ok || !Array.isArray(res.data?.data))
    throw new ProviderError(SOURCE, `asset metrics for ${asset} failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const rows = parseCoinmetricsRows(res.data.data);
  if (!rows.length) throw new ProviderError(SOURCE, `no rows for ${asset}`, 404);
  return { asset: a, rows, url: res.url, fetchedAt: res.fetchedAt };
}

/** A series as a dataset: the latest value of each metric, window changes, NVT when possible. */
export function coinmetricsToDataset(s: CmSeries): Dataset {
  return {
    kind: "crypto-onchain",
    title: `${s.asset.toUpperCase()} on-chain metrics (Coin Metrics, daily)`,
    subject: s.asset.toUpperCase(),
    points: coinmetricsPoints(s.asset, s.rows),
    provenance: { source: SOURCE, url: s.url, fetchedAt: s.fetchedAt, delay: "daily", official: false, asOf: s.rows[s.rows.length - 1]?.date },
    notes: [
      "daily values, stamped at the start of the UTC day they cover",
      "NVT is not computed: the community tier does not serve adjusted transfer value (TxTfrValAdjUSD)",
      "MVRV above ~3 has marked past cycle tops and below 1 past bottoms: a historical pattern, not a rule",
    ],
  };
}

/** Daily on-chain metrics for `asset` (btc, eth); the latest values become points. */
export async function coinmetricsAssetMetrics(asset: string, days = 30): Promise<Dataset> {
  return coinmetricsToDataset(await coinmetricsSeries(asset, days));
}
