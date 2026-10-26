// The `screen` presets, in the open: every TradingView preset is a list of
// scanner filters (printed in plain words by `screen --list`, generated from
// the very filters sent), every builtin preset names the checks it runs on
// daily bars, and each one cites where the rule comes from. Thresholds are
// published starting points — edit them here, never hide them elsewhere.
//
// TradingView columns used below were probed live on the scanner (2026-10):
// an unknown column does not fail, it silently matches nothing, so only
// verified names appear. Where the scanner lacks the exact figure a rule
// needs, the preset says what stands in for it (`approximations`).
//
// Sorting: presets whose filter defines membership sort by market cap,
// largest first — sorting by the screened ratio itself surfaces data errors
// and micro-caps first (a P/E of 0.005, a 600 % six-month run). `--sort`
// overrides it.
import type { TvFilter } from "../../providers/markets/tradingview.js";

export type Engine = "tradingview" | "crible" | "builtin";

/** How a scanner column is shown: its label and unit ("price"/"fundamental" resolve to the row's currencies). */
export interface TvColumn {
  label: string;
  unit?: "price" | "fundamental" | "%" | "x" | "ratio" | "index" | "shares" | "years" | "count";
}

/** Every scanner column a preset filters on or shows. */
export const TV_COLUMNS: Record<string, TvColumn> = {
  description: { label: "name" },
  sector: { label: "sector" },
  country: { label: "country (company)" },
  currency: { label: "quote currency" },
  isin: { label: "ISIN" },
  close: { label: "last price", unit: "price" },
  market_cap_basic: { label: "market capitalisation", unit: "fundamental" },
  market_cap_calc: { label: "market capitalisation", unit: "price" },
  price_earnings_ttm: { label: "P/E (trailing 12 months)", unit: "x" },
  price_book_fq: { label: "P/B (most recent quarter)", unit: "x" },
  dividends_yield_current: { label: "dividend yield (current)", unit: "%" },
  return_on_equity: { label: "return on equity (TTM)", unit: "%" },
  total_revenue_yoy_growth_ttm: { label: "revenue growth year on year (TTM)", unit: "%" },
  net_margin_ttm: { label: "net margin (TTM)", unit: "%" },
  debt_to_equity: { label: "debt to equity", unit: "ratio" },
  "Perf.6M": { label: "performance 6 months", unit: "%" },
  "Perf.Y": { label: "performance 1 year", unit: "%" },
  SMA50: { label: "50-day simple moving average", unit: "price" },
  SMA200: { label: "200-day simple moving average", unit: "price" },
  RSI: { label: "RSI(14)", unit: "index" },
  price_52_week_high: { label: "52-week high", unit: "price" },
  volume: { label: "volume on the day", unit: "shares" },
  average_volume_30d_calc: { label: "average volume (30 days)", unit: "shares" },
  relative_volume_10d_calc: { label: "relative volume (vs 10-day average)", unit: "x" },
  dividend_payout_ratio_ttm: { label: "dividend payout ratio (TTM)", unit: "%" },
  continuous_dividend_growth: { label: "consecutive years of dividend increases", unit: "years" },
  dps_common_stock_prim_issue_yoy_growth_fy: { label: "dividend per share growth (last fiscal year)", unit: "%" },
  enterprise_value_to_ebit_ttm: { label: "EV/EBIT (TTM)", unit: "x" },
  return_on_invested_capital: { label: "return on invested capital (TTM)", unit: "%" },
  price_earnings_growth_ttm: { label: "PEG ratio (P/E ÷ EPS growth, TTM)", unit: "x" },
  earnings_per_share_diluted_yoy_growth_ttm: { label: "diluted EPS growth year on year (TTM)", unit: "%" },
  expense_ratio: { label: "ETF expense ratio", unit: "%" },
  aum: { label: "ETF assets under management", unit: "fundamental" },
  typespecs: { label: "instrument type" },
  type: { label: "instrument type" },
  is_primary: { label: "primary listing" },
  exchange: { label: "exchange" },
  crypto_common_categories: { label: "crypto category" },
};

/** "stock" presets screen primary listings of common stocks; "etf" screens ETFs; "crypto" works on --market crypto too. */
export interface TvPreset {
  id: string;
  title: string;
  assets: "stock" | "etf";
  /** Also valid on --market crypto (TradingView's "coin" scanner: one row per coin). */
  crypto?: boolean;
  filter: TvFilter[];
  /** Columns shown per match (besides name, price, currency). */
  columns: string[];
  sort: { sortBy: string; sortOrder: "asc" | "desc" };
  defaultMarket: string;
  /** Rules applied after the scan, in plain words. */
  extraRules?: string[];
  source: string;
  approximations?: string[];
  /** Rows fetched per market when the preset ranks client-side. */
  pool?: number;
}

const gt = (left: string, right: number | string): TvFilter => ({ left, operation: "greater", right });
const lt = (left: string, right: number | string): TvFilter => ({ left, operation: "less", right });
const ge = (left: string, right: number): TvFilter => ({ left, operation: "egreater", right });
const between = (left: string, lo: number, hi: number): TvFilter => ({ left, operation: "in_range", right: [lo, hi] });

/** EU and EEA member states as TradingView writes the company's country. */
export const EU_EEA_COUNTRIES = [
  "Austria",
  "Belgium",
  "Bulgaria",
  "Croatia",
  "Cyprus",
  "Czech Republic",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Ireland",
  "Italy",
  "Latvia",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Netherlands",
  "Poland",
  "Portugal",
  "Romania",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden",
  // EEA, outside the EU
  "Iceland",
  "Liechtenstein",
  "Norway",
];

/**
 * The same EU and EEA member states as ISO 3166-1 alpha-2 codes — crible's
 * `country`, and the first two letters of an ISIN issued there.
 */
export const EU_EEA_ISO = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  // EEA, outside the EU
  "IS",
  "LI",
  "NO",
] as const;

/** `--market europe`: the scanner markets run one by one and merged. */
export const EUROPE_MARKETS = [
  "france",
  "germany",
  "netherlands",
  "belgium",
  "portugal",
  "ireland",
  "italy",
  "spain",
  "austria",
  "finland",
  "denmark",
  "sweden",
  "norway",
  "switzerland",
];

export const TV_PRESETS: TvPreset[] = [
  {
    id: "value",
    title: "Value",
    assets: "stock",
    filter: [
      gt("price_earnings_ttm", 0),
      lt("price_earnings_ttm", 15),
      gt("price_book_fq", 0),
      lt("price_book_fq", 2),
      gt("dividends_yield_current", 3),
      gt("market_cap_basic", 1e9),
    ],
    columns: ["price_earnings_ttm", "price_book_fq", "dividends_yield_current", "market_cap_basic", "sector"],
    sort: { sortBy: "price_earnings_ttm", sortOrder: "asc" },
    defaultMarket: "america",
    source: "after Benjamin Graham's defensive-investor tests (The Intelligent Investor, 1949, ch. 14: moderate P/E and P/B, a dividend record, adequate size)",
  },
  {
    id: "quality-growth",
    title: "Quality growth",
    assets: "stock",
    filter: [gt("return_on_equity", 15), gt("total_revenue_yoy_growth_ttm", 10), gt("net_margin_ttm", 10), ge("debt_to_equity", 0), lt("debt_to_equity", 1)],
    columns: ["return_on_equity", "total_revenue_yoy_growth_ttm", "net_margin_ttm", "debt_to_equity", "market_cap_basic", "sector"],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    defaultMarket: "america",
    source:
      "quality-growth screen in the spirit of Philip Fisher (Common Stocks and Uncommon Profits, 1958) and Buffett's 15 % return-on-equity test (Hagstrom, The Warren Buffett Way, 1994)",
  },
  {
    id: "momentum",
    title: "Momentum",
    assets: "stock",
    crypto: true,
    filter: [gt("Perf.6M", 0), gt("Perf.Y", 0), gt("close", "SMA50"), gt("SMA50", "SMA200"), between("RSI", 50, 70)],
    columns: ["Perf.6M", "Perf.Y", "SMA50", "SMA200", "RSI", "market_cap_basic"],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    defaultMarket: "america",
    source:
      "6- and 12-month momentum (Jegadeesh & Titman, Journal of Finance, 1993) with the price > 50-day > 200-day alignment of a stage-2 uptrend (Weinstein, Secrets for Profiting in Bull and Bear Markets, 1988) and RSI in its bull range (Wilder, 1978)",
  },
  {
    id: "breakout-52w",
    title: "52-week-high breakout",
    assets: "stock",
    filter: [{ left: "close", operation: "above%", right: ["price_52_week_high", 0.98] }, gt("volume", "average_volume_30d_calc")],
    columns: ["price_52_week_high", "volume", "average_volume_30d_calc", "relative_volume_10d_calc", "market_cap_basic"],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    defaultMarket: "america",
    source:
      "52-week-high momentum (George & Hwang, Journal of Finance, 2004) with O'Neil's rule that a breakout needs above-average volume (How to Make Money in Stocks, 1988)",
    approximations: ["the day's volume is the session so far while the market is open (delayed snapshot)"],
  },
  {
    id: "dividend-growth",
    title: "Dividend growth",
    assets: "stock",
    filter: [
      gt("dividends_yield_current", 2),
      gt("dividend_payout_ratio_ttm", 0),
      lt("dividend_payout_ratio_ttm", 70),
      ge("continuous_dividend_growth", 5),
      gt("dps_common_stock_prim_issue_yoy_growth_fy", 5),
    ],
    columns: [
      "dividends_yield_current",
      "dividend_payout_ratio_ttm",
      "continuous_dividend_growth",
      "dps_common_stock_prim_issue_yoy_growth_fy",
      "market_cap_basic",
    ],
    sort: { sortBy: "continuous_dividend_growth", sortOrder: "desc" },
    defaultMarket: "america",
    source: "dividend-growth investing (Lowell Miller, The Single Best Investment, 2006); a payout under 70 % as the usual sustainability rule of thumb",
    approximations: [
      "the scanner has no 5-year dividend-growth rate: it is approximated by at least 5 consecutive years of dividend increases plus more than 5 % growth in the last fiscal year",
    ],
  },
  {
    id: "oversold-quality",
    title: "Oversold quality",
    assets: "stock",
    filter: [lt("RSI", 30), gt("return_on_equity", 15)],
    columns: ["RSI", "return_on_equity", "Perf.6M", "market_cap_basic", "sector"],
    sort: { sortBy: "RSI", sortOrder: "asc" },
    defaultMarket: "america",
    source:
      "short-term RSI oversold entries (Connors & Alvarez, Short Term Trading Strategies That Work, 2009) restricted to profitable companies (return on equity > 15 %)",
  },
  {
    id: "small-cap-value",
    title: "Small-cap value",
    assets: "stock",
    filter: [
      between("market_cap_basic", 300e6, 2e9),
      gt("price_earnings_ttm", 0),
      lt("price_earnings_ttm", 15),
      gt("price_book_fq", 0),
      lt("price_book_fq", 1.5),
    ],
    columns: ["market_cap_basic", "price_earnings_ttm", "price_book_fq", "dividends_yield_current", "sector"],
    sort: { sortBy: "price_book_fq", sortOrder: "asc" },
    defaultMarket: "america",
    source: "the size and value premia (Banz, 1981; Fama & French, 'The Cross-Section of Expected Stock Returns', Journal of Finance, 1992)",
  },
  {
    id: "magic-formula",
    title: "Magic formula",
    assets: "stock",
    filter: [
      gt("market_cap_basic", 100e6),
      gt("enterprise_value_to_ebit_ttm", 0),
      gt("return_on_invested_capital", 0),
      { left: "sector", operation: "not_in_range", right: ["Finance", "Utilities"] },
    ],
    columns: ["enterprise_value_to_ebit_ttm", "return_on_invested_capital", "market_cap_basic", "sector"],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    defaultMarket: "america",
    pool: 300,
    extraRules: [
      "earnings yield = 100 ÷ EV/EBIT (EBIT/EV, %); rank 1 = highest",
      "return on capital ranked, rank 1 = highest",
      "combined = earnings-yield rank + return-on-capital rank; lowest combined first",
    ],
    source:
      "Joel Greenblatt, The Little Book That Beats the Market (2005): rank by earnings yield (EBIT/EV) and return on capital, add the ranks; financials and utilities excluded",
    approximations: [
      "Greenblatt's return on capital, EBIT ÷ (net working capital + net fixed assets), is approximated by TradingView's return on invested capital (TTM)",
      "ranked within the 300 largest qualifying companies (by market cap) of each scanned market, not a whole-market ranking",
    ],
  },
  {
    id: "garp",
    title: "GARP",
    assets: "stock",
    filter: [gt("price_earnings_growth_ttm", 0), lt("price_earnings_growth_ttm", 1.5), gt("earnings_per_share_diluted_yoy_growth_ttm", 10)],
    columns: ["price_earnings_growth_ttm", "price_earnings_ttm", "earnings_per_share_diluted_yoy_growth_ttm", "market_cap_basic", "sector"],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    defaultMarket: "america",
    source: "growth at a reasonable price — Peter Lynch's PEG (One Up on Wall Street, 1989)",
    approximations: ["TradingView's PEG divides the P/E by trailing EPS growth, not the forward or multi-year growth Lynch preferred"],
  },
  {
    id: "etf",
    title: "Low-cost large ETFs",
    assets: "etf",
    filter: [{ left: "typespecs", operation: "has", right: ["etf"] }, ge("expense_ratio", 0), lt("expense_ratio", 0.4), gt("aum", 500e6)],
    columns: ["expense_ratio", "aum", "isin", "Perf.Y"],
    sort: { sortBy: "aum", sortOrder: "desc" },
    defaultMarket: "america",
    extraRules: ["one row per ISIN (a fund listed on several exchanges is kept once, at its first listing found)"],
    source: "costs compound against the holder (John C. Bogle, Common Sense on Mutual Funds, 1999); size as a liquidity and survival proxy",
  },
  {
    id: "pea-candidates",
    title: "PEA candidates",
    assets: "stock",
    filter: [{ left: "country", operation: "in_range", right: EU_EEA_COUNTRIES }, gt("market_cap_basic", 0)],
    columns: ["country", "market_cap_basic", "isin", "sector"],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    defaultMarket: "europe",
    extraRules: [
      'plus, on market france (or europe): ETFs whose name contains "PEA" — a hint only, the name is the issuer\'s marketing',
      "candidates: PEA eligibility must be confirmed with the broker",
    ],
    source:
      "French PEA rules (Code monétaire et financier, art. L221-31: shares of companies with their registered office in the EU or EEA, subject to corporate tax)",
    approximations: [
      "TradingView's country is the company's country, not always its registered office; corporate-tax status and the broker's own list are not checked",
    ],
  },
];

/** A builtin screen: technical rules computed by ultrastock on daily bars. */
export interface BuiltinPreset {
  id: string;
  title: string;
  rules: string[];
  source: string;
  approximations?: string[];
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "minervini",
    title: "Minervini trend template",
    rules: [
      "close above the 150- and 200-day SMA",
      "150-day SMA above the 200-day",
      "200-day SMA rising over the last 21 sessions",
      "50-day SMA above the 150- and 200-day",
      "close above the 50-day SMA",
      "close at least 30 % above the 52-week low",
      "close within 25 % of the 52-week high",
      "relative strength: IBD-weighted 12-month performance above the benchmark's",
      "all 8 must pass",
    ],
    source: "Mark Minervini, Trade Like a Stock Market Wizard (2013), the trend template",
    approximations: [
      "criterion 8 (an IBD RS rating ≥ 70, a percentile over all stocks) is replaced by beating the benchmark's IBD-weighted 12-month performance",
    ],
  },
  {
    id: "vcp",
    title: "Volatility contraction pattern",
    rules: [
      "at least 2 successively shallower pullbacks (swing high → swing low) in the last 260 sessions",
      "first pullback ≤ 40 %, last ≤ 10 %",
      "average volume lower in the last pullback than in the first",
      "status: forming below the pivot, or breakout above it",
    ],
    source: "Mark Minervini, Trade Like a Stock Market Wizard (2013), the volatility contraction pattern",
  },
  {
    id: "canslim-technical",
    title: "CAN SLIM — technical parts (N and L)",
    rules: [
      "N: a new 52-week high set in one of the last 5 sessions",
      "L: relative strength (IBD-weighted 12-month performance minus the benchmark's) in the top 20 % of the screened universe",
    ],
    source: "William J. O'Neil, How to Make Money in Stocks (1988), CAN SLIM",
    approximations: [
      "only N and L are technical: C, A (earnings growth), S (supply), I (institutional sponsorship) and M (market direction) need fundamentals and market context and are not checked",
      "L is a percentile within the screened universe, not IBD's percentile over all stocks",
    ],
  },
  {
    id: "momentum-burst",
    title: "Momentum burst (4 %)",
    rules: [
      "close ≥ 1.04 × the previous close",
      "volume above the previous session's",
      "volume above its average of the 20 previous sessions",
      "no run-up over 10 % in the 3 sessions before (close[t−1] ÷ close[t−4] − 1 ≤ 10 %)",
    ],
    source: "Pradeep Bonde (Stockbee), the 4 % breakout momentum burst",
  },
  {
    id: "exhaustion-hammer",
    title: "Exhaustion hammer",
    rules: [
      "lower wick (min(open, close) − low) at least 2 × the body |close − open|",
      "after a 10-session pullback: close[t−1] below close[t−11]",
      "close above the previous session's low",
    ],
    source: "the hammer candle (Steve Nison, Japanese Candlestick Charting Techniques, 1991)",
  },
  {
    id: "pullback-to-50",
    title: "Pullback to the 50-day",
    rules: ["uptrend: close above the 200-day SMA and the 50-day above the 200-day", "close within 2 % of the 50-day SMA", "RSI(14) between 40 and 50"],
    source:
      "buying the first pullbacks to the 50-day line in an uptrend (O'Neil, How to Make Money in Stocks); RSI 40–50 as the floor of a bull-market range (Constance Brown, Technical Analysis for the Trading Professional, 1999)",
  },
  {
    id: "golden-cross",
    title: "Golden cross",
    rules: ["the 50-day SMA crossed above the 200-day in the last 10 sessions", "and is still above it"],
    source: "the classic moving-average crossover (John J. Murphy, Technical Analysis of the Financial Markets, 1999)",
  },
  {
    id: "rs-leaders",
    title: "Relative-strength leaders",
    rules: ["6-month (126-session) return minus the benchmark's over the same window", "in the top 10 % of the screened universe"],
    source: "relative strength as a selection criterion (Robert A. Levy, Journal of Finance, 1967)",
    approximations: ["a percentile within the screened universe, not over all stocks"],
  },
];

const OPS: Record<string, string> = {
  greater: ">",
  less: "<",
  egreater: "≥",
  eless: "≤",
  equal: "=",
  nequal: "≠",
};

const label = (col: string) => TV_COLUMNS[col]?.label ?? col;
const num = (v: unknown) => (typeof v === "number" ? (Math.abs(v) >= 1e6 ? v.toExponential(1).replace("e+", "e") : String(v)) : String(v));
/** The right side of a comparison: another column's label, or a number. */
const side = (v: unknown, col: string) => {
  if (typeof v === "string" && TV_COLUMNS[v]) return label(v);
  const u = TV_COLUMNS[col]?.unit;
  return `${num(v)}${u === "%" ? " %" : ""}`;
};

/** One scanner filter in plain words — what `screen --list` prints, generated from the filter itself. */
export function describeFilter(f: TvFilter): string {
  const l = label(f.left);
  if (OPS[f.operation]) return `${l} ${OPS[f.operation]} ${side(f.right, f.left)}`;
  if (f.operation === "in_range" && Array.isArray(f.right) && f.right.length === 2 && f.right.every((x) => typeof x === "number"))
    return `${l} between ${side(f.right[0], f.left)} and ${side(f.right[1], f.left)}`;
  if (f.operation === "in_range" && Array.isArray(f.right))
    return `${l} in ${f.right.length <= 4 ? f.right.join(", ") : `the ${f.right.length}-entry list (${f.right.join(", ")})`}`;
  if (f.operation === "not_in_range" && Array.isArray(f.right)) return `${l} not ${f.right.join(" or ")}`;
  if (f.operation === "has" && Array.isArray(f.right)) return `${l} is ${f.right.join(" or ")}`;
  if (f.operation === "has_none_of" && Array.isArray(f.right)) return `${l} is not ${f.right.join(" or ")}`;
  if (f.operation === "above%" && Array.isArray(f.right))
    return `${l} above ${Number(f.right[1]) * 100} % of the ${label(String(f.right[0]))} (within ${Math.round((1 - Number(f.right[1])) * 100)} % of it)`;
  if (f.operation === "match") return `${l} contains "${String(f.right)}"`;
  return `${l} ${f.operation} ${JSON.stringify(f.right)}`;
}

/** The baseline filters a stock preset adds per market, so `--list` can show them too. */
export function baseFilters(assets: "stock" | "etf", market: string): TvFilter[] {
  if (market === "coin") return [{ left: "crypto_common_categories", operation: "has_none_of", right: ["stablecoins"] }];
  if (assets === "etf") return [];
  const out: TvFilter[] = [
    { left: "type", operation: "equal", right: "stock" },
    { left: "is_primary", operation: "equal", right: true },
  ];
  if (market === "america") out.push({ left: "exchange", operation: "not_in_range", right: ["OTC"] });
  return out;
}

/** Every rule of a TradingView preset in plain words. */
export function tvPresetRules(p: TvPreset): string[] {
  return [...p.filter.map(describeFilter), ...(p.extraRules ?? [])];
}

export const tvPreset = (id: string) => TV_PRESETS.find((p) => p.id === id);
export const builtinPreset = (id: string) => BUILTIN_PRESETS.find((p) => p.id === id);
