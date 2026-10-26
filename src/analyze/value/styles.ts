// `value`: the five value styles and the regions they search. A style is a
// minimal crible DSL (primary listings, the region's ISO countries, the size
// floor in EUR, one cheapness filter) plus the components ultrastock scores on
// the filtered universe. Everything else — the anti-trap gates, the hygiene,
// the style's own client-side rules — runs in TypeScript, because a DSL
// comparison silently drops the rows where a field is null.
import { EU_EEA_ISO } from "../screen/presets.js";

export const VALUE_STYLE_IDS = ["quality-value", "deep-value", "dividend", "garp", "magic-formula"] as const;
export type ValueStyleId = (typeof VALUE_STYLE_IDS)[number];

/** One scored component: a crible field (or a figure computed from crible fields), better high or low. */
export interface ValueComponent {
  field: string;
  label: string;
  better: "high" | "low";
  weight: number;
}

export interface ValueStyle {
  id: ValueStyleId;
  title: string;
  /** What the style is looking for, in one sentence. */
  thesis: string;
  /** The cheapness filter in crible DSL (ANDed after the universe). */
  cheapness: string;
  /** crible --sort for paging the candidates, cheapest first. */
  sort: string;
  components: ValueComponent[];
  /** Fields shown and registered besides the components. */
  display: string[];
  /** Sectors the style leaves out (also enforced in TypeScript). */
  excludeSectors?: string[];
  /** Client-side rules on top of the DSL, each with the reason a row fails it. */
  rules?: Array<{ id: string; label: string; test: (row: Record<string, unknown>) => boolean | undefined }>;
  /** What would break the thesis: a field crossing a line (fractions as crible stores them). */
  invalidation: Array<{ field: string; below?: number; above?: number; text: string }>;
  source: string;
}

const num = (row: Record<string, unknown>, f: string): number | undefined => {
  const v = row[f];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** P/E × P/B, Graham's "product" (below 22.5 = his 15 × 1.5): computed here from crible's two multiples. */
export function grahamProduct(row: Record<string, unknown>): number | undefined {
  const pe = num(row, "price_to_earnings_ratio");
  const pb = num(row, "price_to_book_ratio");
  return pe !== undefined && pb !== undefined && pe > 0 && pb > 0 ? pe * pb : undefined;
}

/** The value of a component on a row: the crible field, or the figure ultrastock computes. */
export function componentValue(row: Record<string, unknown>, field: string): number | undefined {
  return field === "graham_product" ? grahamProduct(row) : num(row, field);
}

/** The highest trailing dividend yield the dividend style believes (above it, a cut or a stale price is likelier). */
export const DIVIDEND_YIELD_CAP = 0.12;

export const VALUE_STYLES: Record<ValueStyleId, ValueStyle> = {
  "quality-value": {
    id: "quality-value",
    title: "Quality at a cheap price",
    thesis: "a high earnings yield on a business that earns its capital back, with solid accounts and moderate debt",
    cheapness: "earnings_yield > 0.05",
    sort: "-earnings_yield",
    components: [
      { field: "earnings_yield", label: "earnings yield", better: "high", weight: 0.35 },
      { field: "roic", label: "return on invested capital", better: "high", weight: 0.25 },
      { field: "piotroski_f", label: "Piotroski F-score", better: "high", weight: 0.15 },
      { field: "altman_z", label: "Altman Z-score", better: "high", weight: 0.1 },
      { field: "net_debt_to_ebitda_ratio", label: "net debt / EBITDA", better: "low", weight: 0.15 },
    ],
    display: ["price_to_earnings_ratio", "price_to_book_ratio"],
    invalidation: [
      { field: "earnings_yield", below: 0.05, text: "the earnings yield falls under 0.05 (earnings drop, or the price already re-rated)" },
      { field: "roic", below: 0.08, text: "return on invested capital falls under 0.08 (the quality was cyclical)" },
      { field: "piotroski_f", below: 5, text: "the Piotroski F-score falls under 5 (the fundamentals turn)" },
      { field: "net_debt_to_ebitda_ratio", above: 3, text: "net debt / EBITDA rises above 3" },
    ],
    source: "Greenblatt's earnings yield and return on capital, Piotroski (2000), Altman (1968); Novy-Marx (2013) on quality and value together",
  },
  "deep-value": {
    id: "deep-value",
    title: "Deep value (Graham)",
    thesis: "a price near or below the balance sheet: net current assets, the Graham number, P/E × P/B under 22.5",
    cheapness: "price_to_book_ratio < 2.5 AND price_to_earnings_ratio > 0 AND price_to_earnings_ratio < 25",
    sort: "price_to_book_ratio",
    components: [
      { field: "ncav_to_market_cap", label: "net current asset value / market cap", better: "high", weight: 0.3 },
      { field: "graham_margin_of_safety", label: "margin of safety to the Graham number", better: "high", weight: 0.3 },
      { field: "graham_product", label: "P/E × P/B", better: "low", weight: 0.25 },
      { field: "current_ratio", label: "current ratio", better: "high", weight: 0.15 },
    ],
    display: ["graham_number", "price_to_earnings_ratio", "price_to_book_ratio"],
    rules: [
      {
        id: "graham-product",
        label: "P/E × P/B at or above 22.5 (Graham's 15 × 1.5), or not computable",
        test: (row) => {
          const p = grahamProduct(row);
          return p === undefined ? undefined : p < 22.5;
        },
      },
    ],
    invalidation: [
      { field: "graham_margin_of_safety", below: 0, text: "the price climbs above the Graham number (margin of safety under 0)" },
      { field: "current_ratio", below: 1.5, text: "the current ratio falls under 1.5 (the asset cushion is being spent)" },
      { field: "ncav_to_market_cap", below: 0, text: "net current asset value turns negative" },
    ],
    source: "Graham, The Intelligent Investor (1973), ch. 14 (P/E × P/B ≤ 22.5) and Security Analysis (net current asset value)",
  },
  dividend: {
    id: "dividend",
    title: "Covered dividend yield",
    thesis: "a dividend the profits and cash cover, a reasonable payout, buybacks counted, increases on record",
    cheapness: "weighted_dividend_yield > 0.03",
    sort: "-weighted_dividend_yield",
    components: [
      { field: "weighted_dividend_yield", label: "dividend yield", better: "high", weight: 0.35 },
      { field: "dividend_coverage", label: "dividend coverage", better: "high", weight: 0.25 },
      { field: "dividend_payout_ratio", label: "payout ratio", better: "low", weight: 0.15 },
      { field: "shareholder_yield", label: "shareholder yield (dividends + buybacks)", better: "high", weight: 0.25 },
    ],
    display: [],
    rules: [
      {
        id: "yield-cap",
        label: `dividend yield above ${DIVIDEND_YIELD_CAP * 100} % (a cut or a stale price is likelier than a gift)`,
        test: (row) => {
          const y = num(row, "weighted_dividend_yield");
          return y === undefined ? undefined : y <= DIVIDEND_YIELD_CAP;
        },
      },
      {
        id: "payout",
        label: "payout ratio above 100 % or negative (the dividend is not earned)",
        test: (row) => {
          const p = num(row, "dividend_payout_ratio");
          return p === undefined ? undefined : p > 0 && p <= 1;
        },
      },
    ],
    invalidation: [
      { field: "dividend_coverage", below: 1.5, text: "dividend coverage falls under 1.5 (a cut gets likelier)" },
      { field: "dividend_payout_ratio", above: 0.8, text: "the payout ratio rises above 0.8" },
      { field: "shareholder_yield", below: 0, text: "shareholder yield turns negative (issuance outweighs the payout)" },
    ],
    source: "dividend coverage and payout discipline; shareholder yield (Faber, 2013); consecutive increases from TradingView",
  },
  garp: {
    id: "garp",
    title: "Growth at a reasonable price",
    thesis: "earnings and sales growing at a PEG under 1.5, on a business that earns its capital back",
    cheapness: "peg_ratio > 0 AND peg_ratio < 1.5",
    sort: "peg_ratio",
    components: [
      { field: "peg_ratio", label: "PEG ratio", better: "low", weight: 0.3 },
      { field: "revenue_cagr_3y", label: "revenue growth (3-year CAGR)", better: "high", weight: 0.2 },
      { field: "net_income_cagr_3y", label: "net income growth (3-year CAGR)", better: "high", weight: 0.2 },
      { field: "roic", label: "return on invested capital", better: "high", weight: 0.15 },
      { field: "mohanram_g", label: "Mohanram G-score", better: "high", weight: 0.15 },
    ],
    display: ["price_to_earnings_ratio"],
    rules: [
      {
        id: "growth",
        label: "net income shrinking over three years (a PEG on falling earnings means nothing)",
        test: (row) => {
          const g = num(row, "net_income_cagr_3y");
          return g === undefined ? undefined : g > 0;
        },
      },
    ],
    invalidation: [
      { field: "peg_ratio", above: 1.5, text: "the PEG rises above 1.5 (the growth is priced in)" },
      { field: "net_income_cagr_3y", below: 0, text: "three-year net income growth turns negative" },
      { field: "revenue_cagr_3y", below: 0, text: "three-year revenue growth turns negative" },
    ],
    source: "Lynch, One Up on Wall Street (1989) — the PEG; Mohanram (2005) — the G-score",
  },
  "magic-formula": {
    id: "magic-formula",
    title: "Magic formula (Greenblatt)",
    thesis: "a high EBIT / enterprise value on a high return on tangible capital, financials and utilities left out",
    cheapness: "greenblatt_earnings_yield > 0.05 AND greenblatt_roc > 0.1 AND sector != 'Financials' AND sector != 'Utilities'",
    sort: "-greenblatt_earnings_yield",
    components: [
      { field: "greenblatt_earnings_yield", label: "EBIT / enterprise value", better: "high", weight: 0.5 },
      { field: "greenblatt_roc", label: "return on tangible capital", better: "high", weight: 0.5 },
    ],
    display: ["magic_formula_rank"],
    excludeSectors: ["Financials", "Utilities"],
    invalidation: [
      { field: "greenblatt_earnings_yield", below: 0.05, text: "EBIT / enterprise value falls under 0.05" },
      { field: "greenblatt_roc", below: 0.1, text: "return on tangible capital falls under 0.1" },
    ],
    source: "Greenblatt, The Little Book That Beats the Market (2005)",
  },
};

export const valueStyle = (id: string): ValueStyle | undefined => VALUE_STYLES[id as ValueStyleId];

/** `--style`: one id, or all of them in a fixed order. */
export function valueStyles(arg: string | undefined): ValueStyle[] {
  const id = (arg ?? "quality-value").trim().toLowerCase();
  if (id === "all") return VALUE_STYLE_IDS.map((s) => VALUE_STYLES[s]);
  const s = valueStyle(id);
  if (!s) throw new Error(`--style is one of ${VALUE_STYLE_IDS.join(", ")} or all, not "${arg}"`);
  return [s];
}

export interface ValueRegion {
  id: string;
  label: string;
  /** ISO 3166-1 alpha-2 countries, none = the whole world. */
  countries?: readonly string[];
  /** PEA eligibility: country AND ISIN prefix in the EU / EEA. */
  pea?: boolean;
}

/** Europe as an investor means it: the EU / EEA, the United Kingdom and Switzerland. */
const EUROPE_ISO = [...EU_EEA_ISO, "GB", "CH"];

/** `--region`: world, europe, pea, us, or a comma list of ISO countries. crible's own `region` is not geography. */
export function valueRegion(arg: string | undefined): ValueRegion {
  const raw = (arg ?? "world").trim();
  const id = raw.toLowerCase();
  if (id === "world") return { id, label: "the world" };
  if (id === "us") return { id, label: "the United States", countries: ["US"] };
  if (id === "europe") return { id, label: "Europe (EU / EEA, United Kingdom, Switzerland)", countries: EUROPE_ISO };
  if (id === "pea") return { id, label: "PEA-eligible (EU / EEA issuer and ISIN)", countries: EU_EEA_ISO, pea: true };
  const codes = raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  if (!codes.length || codes.some((c) => !/^[A-Z]{2}$/.test(c)))
    throw new Error(`--region is world, europe, pea, us or a comma list of ISO country codes (FR,DE,IT), not "${raw}"`);
  return { id: codes.join(","), label: codes.join(", "), countries: [...new Set(codes)] };
}

/** PEA: an EU / EEA issuer (crible's country) with an EU / EEA ISIN. Eligibility still needs confirming security by security. */
export function peaEligible(row: Record<string, unknown>): boolean {
  const iso = EU_EEA_ISO as readonly string[];
  const isin = typeof row.isin === "string" ? row.isin.trim().toUpperCase() : "";
  return typeof row.country === "string" && iso.includes(row.country) && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) && iso.includes(isin.slice(0, 2));
}

const quoteList = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "")}'`).join(",");

/** The minimal crible query for a style: primary listings, the region's countries, the size floor in EUR, the cheapness filter. */
export function valueCandidateDsl(style: ValueStyle, region: ValueRegion, minCapEur: number): string {
  const parts = ["primary_listing = 1", `cap_eur >= ${Math.round(minCapEur)}`];
  if (region.countries?.length) parts.push(`country IN (${quoteList(region.countries)})`);
  parts.push(style.cheapness);
  return parts.join(" AND ");
}
