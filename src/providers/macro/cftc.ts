// CFTC Commitments of Traders, from the regulator's own Socrata API — keyless
// and official. Positions are as of Tuesday and published the following Friday
// (15:30 ET), so the latest report is 3–10 days old.
//
//   legacy, futures only   https://publicreporting.cftc.gov/resource/6dca-aqww.json
//   TFF, futures only      https://publicreporting.cftc.gov/resource/gpe5-46if.json   (financial futures:
//                          dealers, asset managers, leveraged funds)
//
// Queried with SoQL — `$where` on the contract market code (or a name match to
// find it), `$order` by report date descending, `$limit` the number of weeks,
// `$select` only the columns used so three years stay small. A name like
// "E-MINI S&P 500" also matches the micro contract, so markets are pinned to
// their CFTC contract code; aliases below cover the usual ones.
//
// COT index = (net − min(net)) / (max(net) − min(net)) × 100 over the window —
// 0 is the most bearish positioning of the window, 100 the most bullish.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { requireOk } from "./common.js";

export const SOURCE = "cftc";
const BASE = "https://publicreporting.cftc.gov/resource";
const DATASETS = { legacy: "6dca-aqww", tff: "gpe5-46if" } as const;
export type CotReportKind = keyof typeof DATASETS;

/** Usual markets → CFTC contract market code. */
export const COT_MARKETS: Record<string, { code: string; name: string }> = {
  ES: { code: "13874A", name: "E-mini S&P 500" },
  NQ: { code: "209742", name: "Nasdaq-100 E-mini" },
  RTY: { code: "239742", name: "Russell 2000 E-mini" },
  YM: { code: "124603", name: "DJIA ($5)" },
  VX: { code: "1170E1", name: "VIX futures" },
  "6E": { code: "099741", name: "Euro FX" },
  "6J": { code: "097741", name: "Japanese yen" },
  "6B": { code: "096742", name: "British pound" },
  GC: { code: "088691", name: "Gold" },
  SI: { code: "084691", name: "Silver" },
  CL: { code: "067651", name: "WTI crude oil" },
  ZN: { code: "043602", name: "10-year T-note" },
  ZB: { code: "020601", name: "US Treasury bond" },
  BTC: { code: "133741", name: "Bitcoin (CME)" },
  ETH: { code: "146021", name: "Ether (CME)" },
};
const ALIASES: Record<string, string> = {
  "E-MINI S&P 500": "ES",
  "S&P 500": "ES",
  SPX: "ES",
  "NASDAQ-100": "NQ",
  "NASDAQ 100": "NQ",
  "EURO FX": "6E",
  EUR: "6E",
  EURUSD: "6E",
  JPY: "6J",
  GBP: "6B",
  GOLD: "GC",
  SILVER: "SI",
  WTI: "CL",
  OIL: "CL",
  "10-YEAR": "ZN",
  "10Y": "ZN",
  "10-YEAR NOTE": "ZN",
  "30-YEAR": "ZB",
  BITCOIN: "BTC",
  ETHER: "ETH",
  VIX: "VX",
};

/** The alias a market name or code resolves to, if any. */
export function cotAlias(market: string): string | undefined {
  const m = market.trim().toUpperCase();
  return COT_MARKETS[m] ? m : ALIASES[m];
}

export interface CotWeek {
  date: string;
  openInterest: number;
  /** Net long (long − short) per trader group; legacy: noncomm, comm; TFF: levFunds, assetMgr, dealer. */
  net: Record<string, number>;
}

const GROUPS: Record<CotReportKind, Record<string, [string, string]>> = {
  legacy: {
    noncomm: ["noncomm_positions_long_all", "noncomm_positions_short_all"],
    comm: ["comm_positions_long_all", "comm_positions_short_all"],
  },
  tff: {
    levFunds: ["lev_money_positions_long", "lev_money_positions_short"],
    assetMgr: ["asset_mgr_positions_long", "asset_mgr_positions_short"],
    dealer: ["dealer_positions_long_all", "dealer_positions_short_all"],
  },
};
const GROUP_LABEL: Record<string, string> = {
  noncomm: "non-commercials (speculators)",
  comm: "commercials (hedgers)",
  levFunds: "leveraged funds",
  assetMgr: "asset managers",
  dealer: "dealers",
};

/** Socrata rows as weekly positions, oldest first. */
export function parseCotRows(rows: ReadonlyArray<Record<string, string>>, kind: CotReportKind): CotWeek[] {
  const weeks: CotWeek[] = [];
  for (const r of rows) {
    const date = (r.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const net: Record<string, number> = {};
    for (const [g, [l, s]] of Object.entries(GROUPS[kind])) {
      const long = Number(r[l]);
      const short = Number(r[s]);
      if (r[l] !== undefined && r[s] !== undefined && Number.isFinite(long) && Number.isFinite(short)) net[g] = long - short;
    }
    weeks.push({ date, openInterest: Number(r.open_interest_all ?? Number.NaN), net });
  }
  return weeks.sort((a, b) => a.date.localeCompare(b.date));
}

/** COT index of the last value over the last `window` values: 0 = window low, 100 = window high (50 when flat). */
export function cotIndex(values: readonly number[], window: number): number | undefined {
  const w = values.slice(-window);
  const last = w[w.length - 1];
  if (last === undefined || w.length < Math.min(window, 8)) return undefined;
  const lo = Math.min(...w);
  const hi = Math.max(...w);
  return hi === lo ? 50 : Number((((last - lo) / (hi - lo)) * 100).toFixed(1));
}

const soql = (dataset: string, params: Record<string, string>) => `${BASE}/${dataset}.json?${new URLSearchParams(params).toString()}`;

/** Find a contract code by (part of) its CFTC market name, preferring an exact "NAME - EXCHANGE" match. */
export async function findCotMarket(name: string, kind: CotReportKind = "legacy"): Promise<{ code: string; name: string }> {
  const q = name.trim().toUpperCase().replace(/'/g, "''");
  const res = await fetchJson<Array<Record<string, string>>>(
    soql(DATASETS[kind], {
      $select: "market_and_exchange_names,cftc_contract_market_code,report_date_as_yyyy_mm_dd",
      $where: `upper(market_and_exchange_names) like '%${q}%'`,
      $order: "report_date_as_yyyy_mm_dd DESC",
      $limit: "50",
    }),
  );
  requireOk(SOURCE, res, `market search "${name}"`);
  const rows = res.data ?? [];
  const latest = rows[0]?.report_date_as_yyyy_mm_dd;
  const current = rows.filter((r) => r.report_date_as_yyyy_mm_dd === latest);
  const exact = current.find((r) => (r.market_and_exchange_names ?? "").toUpperCase().startsWith(`${q} -`)) ?? current[0];
  if (!exact?.cftc_contract_market_code) throw new ProviderError(SOURCE, `no COT market matching "${name}"`);
  return { code: exact.cftc_contract_market_code, name: exact.market_and_exchange_names ?? name };
}

/**
 * Positioning for a market (alias like "ES", "GOLD", "EURO FX", or a CFTC
 * market name or contract code) over the last `weeks` reports: the latest net
 * positions per trader group, their weekly change, % of open interest and the
 * 26- and 156-week COT indices.
 */
export async function cotReport(market: string, opts: { kind?: CotReportKind; weeks?: number } = {}): Promise<Dataset> {
  const kind = opts.kind ?? "legacy";
  const weeks = Math.max(opts.weeks ?? 156, 27);
  const alias = cotAlias(market);
  const known = alias ? COT_MARKETS[alias] : undefined;
  const target = known ?? (/^[0-9A-Z]{6}$/.test(market.trim()) ? { code: market.trim(), name: market.trim() } : await findCotMarket(market, kind));
  const subject = alias ?? `COT${target.code}`;
  const cols = ["report_date_as_yyyy_mm_dd", "market_and_exchange_names", "open_interest_all", ...Object.values(GROUPS[kind]).flat()];
  const res = await fetchJson<Array<Record<string, string>>>(
    soql(DATASETS[kind], {
      $select: cols.join(","),
      $where: `cftc_contract_market_code='${target.code.replace(/'/g, "''")}'`,
      $order: "report_date_as_yyyy_mm_dd DESC",
      $limit: String(weeks),
    }),
  );
  requireOk(SOURCE, res, `COT ${kind} for ${target.code}`);
  const rows = res.data ?? [];
  const hist = parseCotRows(rows, kind);
  const last = hist[hist.length - 1];
  if (!last)
    throw new ProviderError(SOURCE, `no ${kind} COT report for contract ${target.code}${kind === "tff" ? " (TFF covers financial futures only)" : ""}`);
  const prev = hist[hist.length - 2];
  const points: Point[] = [];
  for (const g of Object.keys(GROUPS[kind])) {
    const net = last.net[g];
    if (net === undefined) continue;
    const label = `${subject} COT ${GROUP_LABEL[g]}`;
    const base = `${subject}.cot.${g}`;
    points.push({ key: `${base}.net`, label: `${label} net position`, value: net, unit: "contracts", asOf: last.date, formula: "long − short" });
    const p = prev?.net[g];
    if (p !== undefined)
      points.push({
        key: `${base}.net.chg`,
        label: `${label} net change on the week`,
        value: net - p,
        unit: "contracts",
        asOf: last.date,
        formula: `net@${last.date} − net@${prev!.date}`,
      });
    if (last.openInterest > 0)
      points.push({
        key: `${base}.net.pctOi`,
        label: `${label} net as % of open interest`,
        value: Number(((net / last.openInterest) * 100).toFixed(2)),
        unit: "%",
        asOf: last.date,
        formula: "net / open interest × 100",
      });
    const series = hist.flatMap((h) => (h.net[g] === undefined ? [] : [h.net[g]]));
    for (const w of [26, 156]) {
      const idx = cotIndex(series, w);
      if (idx !== undefined && series.length >= w)
        points.push({
          key: `${base}.index${w}w`,
          label: `${label} COT index (${w} weeks)`,
          value: idx,
          unit: "index",
          asOf: last.date,
          formula: `(net − min) / (max − min) × 100 over ${w} weeks`,
        });
    }
  }
  if (Number.isFinite(last.openInterest))
    points.push({ key: `${subject}.cot.openInterest`, label: `${subject} open interest`, value: last.openInterest, unit: "contracts", asOf: last.date });
  const cftcName = rows[0]?.market_and_exchange_names;
  if (cftcName) points.push({ key: `${subject}.cot.market`, label: `${subject} CFTC market name`, value: cftcName, untrusted: true, asOf: last.date });
  return {
    kind: "positioning",
    title: `${known?.name ?? subject} — Commitments of Traders (${kind === "tff" ? "traders in financial futures" : "legacy"}, futures only)`,
    subject,
    points,
    provenance: {
      source: SOURCE,
      url: res.url,
      fetchedAt: res.fetchedAt,
      delay: "weekly (Tuesday positions, published Friday)",
      official: true,
      asOf: last.date,
    },
    notes: [
      `${hist.length} weekly reports read (${hist[0]!.date} → ${last.date})${hist.length < 156 ? "; the 156-week index needs three years of reports" : ""}.`,
    ],
  };
}
