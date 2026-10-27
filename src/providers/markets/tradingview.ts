// TradingView's screener backend — keyless, undocumented (marked unofficial):
//
//   POST https://scanner.tradingview.com/<market>/scan
//        {"symbols":{"tickers":["XETR:SAP"]},"columns":[…]}                 a snapshot of named instruments
//        {"filter":[…],"columns":[…],"sort":{…},"range":[0,50]}             a screener over a market
//
// One call returns a delayed snapshot (price, change, valuation, technical
// rating, RSI, moving averages, performance windows, sector, ISIN) for any
// listed instrument, and screens a whole market — ETFs included ("typespecs"
// has "etf"; expense_ratio, aum, isin answer on market "france"). Markets are
// countries ("germany", "france", "america"…) or "global". An unknown column
// comes back null rather than failing, so nulls are dropped, not reported as 0.
// Names, descriptions and sector labels are TradingView's text: untrusted.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { yahooVenue } from "./yahoo.js";

const BASE = "https://scanner.tradingview.com";
export const SOURCE = "tradingview";
const NOTE = "unofficial endpoint (TradingView's screener backend); delayed snapshot";

/** The snapshot columns verified to answer for a listed stock. */
export const TV_SNAPSHOT_COLUMNS = [
  "description",
  "close",
  "change",
  "currency",
  "volume",
  "market_cap_basic",
  "price_earnings_ttm",
  "earnings_per_share_basic_ttm",
  "dividends_yield_current",
  "beta_1_year",
  "Recommend.All",
  "RSI",
  "SMA50",
  "SMA200",
  "price_52_week_high",
  "price_52_week_low",
  "Perf.W",
  "Perf.1M",
  "Perf.3M",
  "Perf.6M",
  "Perf.Y",
  "Perf.YTD",
  "sector",
  "industry",
  "country",
  "isin",
  "exchange",
  "type",
  "fundamental_currency_code",
  "update_mode",
] as const;

/**
 * The fund columns verified to answer for an ETF (2026-10-26, on CW8, EWLD,
 * IWDA, URTH, QQQ). `issuer` is left out on purpose: it answers an address
 * ("SAS Rue la Boétie"), not the issuer's name — `brand` is the family name.
 * Null for a swap ETF: `etf_holdings_count`, `weight_top_10`. AUM, NAV and
 * flows are in `fundamental_currency_code` (USD even for a EUR fund such as
 * CW8), not in `etf_fund_currency` (the fund's base currency).
 */
export const TV_ETF_COLUMNS = [
  "description",
  "close",
  "currency",
  "fundamental_currency_code",
  "isin",
  "brand",
  "expense_ratio",
  "aum",
  "nav",
  "nav_discount_premium",
  "fund_flows.1M",
  "fund_flows.1Y",
  "nav_perf.1Y",
  "nav_total_return.1Y",
  "nav_total_return.3Y",
  "Perf.Y",
  "dividend_treatment",
  "country_code_fund",
  "etf_holdings_count",
  "weight_top_10",
  "ucits_compliant_flag",
  "index_tracked",
  "index_provider",
  "leveraged_flag",
  "currency_hedged_flag",
  "actively_managed",
  "etf_fund_currency",
  "launch_date",
  "transparent_holding_flag",
  "category.tr",
  "focus.tr",
  "asset_class.tr",
] as const;

/** Columns that are codes, not prose: safe as plain values. Every other string column is external text. */
const CODE_COLUMNS = new Set([
  "currency",
  "fundamental_currency_code",
  "country",
  "isin",
  "exchange",
  "type",
  "subtype",
  "update_mode",
  "name",
  // ETF flags and codes: "Capitalizes"/"Distributes", "LU", "1"/"0", "Non-leveraged", "EUR".
  "dividend_treatment",
  "country_code_fund",
  "ucits_compliant_flag",
  "leveraged_flag",
  "currency_hedged_flag",
  "actively_managed",
  "etf_fund_currency",
  "transparent_holding_flag",
]);

interface ColumnInfo {
  label: string;
  /** "price": the quote currency; "fundamental": the reporting currency (an ETF's AUM, NAV, flows); "date": unix seconds → ISO date. */
  unit?: "price" | "fundamental" | "date" | string;
  formula?: string;
}

const COLUMN_INFO: Record<string, ColumnInfo> = {
  close: { label: "last price", unit: "price" },
  change: { label: "change on the day", unit: "%" },
  volume: { label: "volume on the day", unit: "shares" },
  market_cap_basic: { label: "market capitalisation", unit: "fundamental" },
  price_earnings_ttm: { label: "P/E (trailing 12 months)", unit: "x" },
  earnings_per_share_basic_ttm: { label: "EPS basic (trailing 12 months)", unit: "fundamental" },
  dividends_yield_current: { label: "dividend yield (current)", unit: "%" },
  dividend_yield_recent: { label: "dividend yield (recent)", unit: "%" },
  beta_1_year: { label: "beta (1 year)", unit: "ratio" },
  "Recommend.All": { label: "TradingView technical rating (-1 sell … +1 buy)", unit: "index" },
  RSI: { label: "RSI(14)", unit: "index" },
  SMA50: { label: "50-day simple moving average", unit: "price" },
  SMA200: { label: "200-day simple moving average", unit: "price" },
  price_52_week_high: { label: "52-week high", unit: "price" },
  price_52_week_low: { label: "52-week low", unit: "price" },
  "Perf.W": { label: "performance 1 week", unit: "%" },
  "Perf.1M": { label: "performance 1 month", unit: "%" },
  "Perf.3M": { label: "performance 3 months", unit: "%" },
  "Perf.6M": { label: "performance 6 months", unit: "%" },
  "Perf.Y": { label: "performance 1 year", unit: "%" },
  "Perf.YTD": { label: "performance year to date", unit: "%" },
  expense_ratio: { label: "ETF expense ratio", unit: "%" },
  aum: { label: "ETF assets under management", unit: "fundamental" },
  nav: { label: "ETF net asset value per share", unit: "fundamental" },
  nav_discount_premium: { label: "ETF premium (+) or discount (−) of the price to the NAV", unit: "%" },
  "fund_flows.1M": { label: "ETF net fund flows, 1 month", unit: "fundamental" },
  "fund_flows.1Y": { label: "ETF net fund flows, 1 year", unit: "fundamental" },
  "nav_perf.1Y": { label: "ETF NAV performance 1 year (price only)", unit: "%" },
  "nav_total_return.1Y": { label: "ETF NAV total return 1 year (distributions included)", unit: "%" },
  "nav_total_return.3Y": { label: "ETF NAV total return 3 years (distributions included)", unit: "%" },
  dividend_treatment: { label: "ETF dividend treatment (Capitalizes = accumulating, Distributes = distributing)" },
  country_code_fund: { label: "ETF fund domicile (country code)" },
  etf_holdings_count: { label: "ETF number of holdings", unit: "count" },
  weight_top_10: { label: "ETF weight of the top 10 holdings", unit: "%" },
  ucits_compliant_flag: { label: "ETF UCITS-compliant flag (1 = yes, 0 = no)" },
  index_tracked: { label: "ETF index tracked" },
  index_provider: { label: "ETF index provider" },
  leveraged_flag: { label: "ETF leverage flag" },
  currency_hedged_flag: { label: "ETF currency-hedged flag (1 = hedged, 0 = not)" },
  actively_managed: { label: "ETF actively managed flag (1 = active, 0 = passive)" },
  etf_fund_currency: { label: "ETF fund (base) currency" },
  launch_date: { label: "ETF launch date", unit: "date" },
  transparent_holding_flag: { label: "ETF transparent holdings flag (1 = published)" },
  "category.tr": { label: "ETF category" },
  "focus.tr": { label: "ETF focus" },
  "asset_class.tr": { label: "ETF asset class" },
  "holdings_region.tr": { label: "ETF geographic exposure (region of the holdings)" },
  brand: { label: "ETF brand (fund family)" },
  total_revenue_ttm: { label: "revenue (trailing 12 months)", unit: "fundamental" },
  net_margin_ttm: { label: "net margin (trailing 12 months)", unit: "%" },
  return_on_equity: { label: "return on equity", unit: "%" },
  debt_to_equity: { label: "debt to equity", unit: "ratio" },
  enterprise_value_fq: { label: "enterprise value", unit: "fundamental" },
  average_volume_30d_calc: { label: "average volume (30 days)", unit: "shares" },
  description: { label: "name" },
  isin: { label: "ISIN" },
  currency: { label: "quote currency" },
  fundamental_currency_code: { label: "reporting currency (fundamentals; an ETF's AUM, NAV and flows)" },
  sector: { label: "sector" },
  industry: { label: "industry" },
};

/** Sub-unit currencies TradingView quotes in. */
const SUBUNITS: Record<string, { currency: string; per: number }> = {
  GBX: { currency: "GBP", per: 100 },
  GBp: { currency: "GBP", per: 100 },
  ZAC: { currency: "ZAR", per: 100 },
  ILA: { currency: "ILS", per: 100 },
};

/** Euronext Yahoo-style suffixes on TradingView: one EURONEXT prefix, except Milan and Oslo. */
const EURONEXT_SUFFIX: Record<string, string> = { PA: "EURONEXT", AS: "EURONEXT", BR: "EURONEXT", LS: "EURONEXT", IR: "EURONEXT", MI: "MIL", OL: "OSL" };

/**
 * The TradingView ticker for a user symbol: SAP.DE → XETR:SAP, VOLV-B.ST →
 * OMXSTO:VOLV_B, MC.PA → EURONEXT:MC, 0700.HK → HKEX:700, PETR4.SA →
 * BMFBOVESPA:PETR4 (a venue TradingView keys otherwise, Bursa Malaysia, gives undefined). An already-prefixed ticker passes
 * through; a bare US ticker needs its exchange and is returned undefined.
 */
export function toTradingViewTicker(symbol: string): string | undefined {
  const s = symbol.toUpperCase().trim();
  if (/^[A-Z0-9_]+:[A-Z0-9._!-]+$/.test(s)) return s;
  const venue = yahooVenue(s);
  if (venue) {
    if (!venue.tradingview) return undefined;
    // Hong Kong codes lose their leading zeros on TradingView (0700.HK → HKEX:700).
    const ticker = venue.suffix === "HK" ? venue.ticker.replace(/^0+(?=\d)/, "") : venue.ticker;
    return `${venue.tradingview}:${ticker.replace(/-/g, "_")}`;
  }
  const m = /^(.+)\.([A-Z]{2})$/.exec(s);
  if (m && EURONEXT_SUFFIX[m[2]!]) return `${EURONEXT_SUFFIX[m[2]!]}:${m[1]!.replace(/-/g, "_")}`;
  return undefined;
}

export interface TvRow {
  /** EXCHANGE:TICKER */
  s: string;
  /** Values aligned with the requested columns. */
  d: Array<number | string | boolean | null | string[]>;
}

export interface TvScanResult {
  totalCount: number;
  data: TvRow[];
}

export interface TvFilter {
  left: string;
  operation: string;
  right?: unknown;
}

export interface TvScanOptions {
  filter?: TvFilter[];
  columns?: readonly string[];
  sort?: { sortBy: string; sortOrder: "asc" | "desc" };
  /** [offset, limit) — the screener's paging. */
  range?: [number, number];
  /** Restrict to these tickers instead of screening. */
  tickers?: string[];
}

/** The points of one scanned row: numbers with their units, codes as plain strings, prose untrusted. */
export function tvRowPoints(row: TvRow, columns: readonly string[], asOf?: string): Point[] {
  const ticker = row.s;
  const idx = (c: string) => columns.indexOf(c);
  const rawCurrency = row.d[idx("currency")];
  const sub = typeof rawCurrency === "string" ? SUBUNITS[rawCurrency] : undefined;
  const priceCurrency = sub?.currency ?? (typeof rawCurrency === "string" ? rawCurrency : undefined);
  const fundCode = row.d[idx("fundamental_currency_code")];
  const fundCurrency = typeof fundCode === "string" ? fundCode : priceCurrency;
  const out: Point[] = [];
  columns.forEach((col, i) => {
    const v = row.d[i];
    if (v === null || v === undefined || Array.isArray(v)) return;
    const info = COLUMN_INFO[col];
    const key = `${ticker}.tv.${col}`;
    const label = `${ticker} ${info?.label ?? col}`;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return;
      if (info?.unit === "date") {
        out.push({ key, label, value: new Date(v * 1000).toISOString().slice(0, 10), ...(asOf ? { asOf } : {}) });
        return;
      }
      const unit = info?.unit === "price" ? priceCurrency : info?.unit === "fundamental" ? fundCurrency : info?.unit;
      const value = info?.unit === "price" && sub ? v / sub.per : v;
      out.push({ key, label, value, ...(unit ? { unit } : {}), ...(asOf ? { asOf } : {}) });
    } else if (typeof v === "string") {
      const value = col === "currency" && sub ? sub.currency : v;
      out.push({ key, label, value, ...(CODE_COLUMNS.has(col) ? {} : { untrusted: true }), ...(asOf ? { asOf } : {}) });
    } else out.push({ key, label, value: v });
  });
  return out;
}

async function scan(market: string, body: Record<string, unknown>): Promise<{ data: TvScanResult; url: string; fetchedAt: string }> {
  if (!/^[a-z0-9_]+$/.test(market)) throw new ProviderError(SOURCE, `"${market}" is not a TradingView scanner market (germany, france, america, global…)`, 400);
  const url = `${BASE}/${market}/scan`;
  const res = await fetchJson<TvScanResult>(url, { method: "POST", json: body, userAgent: "browser", hostIntervalMs: 1000 });
  if (!res.ok || !res.data || !Array.isArray(res.data.data)) {
    if (res.status === 404) throw new ProviderError(SOURCE, `TradingView has no scanner market "${market}"`, 404);
    throw new ProviderError(SOURCE, `scan on ${market} failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  }
  return { data: res.data, url, fetchedAt: res.fetchedAt };
}

/**
 * A delayed snapshot of one listed instrument (a TradingView ticker or a
 * Yahoo-style symbol TradingView can map): price, valuation, technicals.
 */
export async function tradingviewSnapshot(symbol: string, opts: { columns?: readonly string[]; market?: string } = {}): Promise<Dataset> {
  const ticker = toTradingViewTicker(symbol);
  if (!ticker) throw new ProviderError(SOURCE, `cannot map ${symbol} to a TradingView ticker — pass EXCHANGE:TICKER (e.g. NASDAQ:AAPL)`, 400);
  const columns = opts.columns ?? TV_SNAPSHOT_COLUMNS;
  const res = await scan(opts.market ?? "global", { symbols: { tickers: [ticker] }, columns });
  const row = res.data.data.find((r) => r.s === ticker) ?? res.data.data[0];
  if (!row) throw new ProviderError(SOURCE, `TradingView knows no ${ticker}`, 404);
  const day = res.fetchedAt.slice(0, 10);
  const notes = [NOTE];
  const cur = row.d[columns.indexOf("currency")];
  if (typeof cur === "string" && SUBUNITS[cur])
    notes.push(`quoted in ${cur} (sub-unit): prices divided by ${SUBUNITS[cur]!.per} and shown in ${SUBUNITS[cur]!.currency}`);
  return {
    kind: "snapshot",
    title: `${ticker} TradingView snapshot`,
    subject: symbol.toUpperCase(),
    points: tvRowPoints(row, columns, day),
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "delayed (15 min or more)", official: false, asOf: day },
    notes,
  };
}

/**
 * A screener run over a market: the matching rows (keys `<EXCHANGE:TICKER>.tv.<column>`),
 * plus a count of every match. Example — the ten largest ETFs listed in France:
 * `tradingviewScan("france", { filter: [{ left: "typespecs", operation: "has", right: ["etf"] }], columns: ["description", "close", "expense_ratio", "aum", "isin", "currency"], sort: { sortBy: "aum", sortOrder: "desc" }, range: [0, 10] })`.
 */
export async function tradingviewScan(market: string, opts: TvScanOptions = {}): Promise<Dataset> {
  const columns = opts.columns ?? ["description", "close", "change", "currency", "market_cap_basic"];
  const body: Record<string, unknown> = { columns, range: opts.range ?? [0, 50] };
  if (opts.filter) body.filter = opts.filter;
  if (opts.sort) body.sort = opts.sort;
  if (opts.tickers) body.symbols = { tickers: opts.tickers };
  const res = await scan(market, body);
  const day = res.fetchedAt.slice(0, 10);
  const points: Point[] = [
    { key: `TV.${market}.scan.matches`, label: `TradingView ${market} screener matches`, value: res.data.totalCount, unit: "count", asOf: day },
    ...res.data.data.flatMap((row) => tvRowPoints(row, columns, day)),
  ];
  const notes = [NOTE];
  if (res.data.totalCount > res.data.data.length) notes.push(`${res.data.data.length} of ${res.data.totalCount} matches returned (range)`);
  return {
    kind: "screener",
    title: `TradingView ${market} screener`,
    subject: market,
    points,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "delayed (15 min or more)", official: false, asOf: day },
    notes,
  };
}
