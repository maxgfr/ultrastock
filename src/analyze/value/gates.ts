// `value`: what keeps a cheap stock out of the ranking. Two layers, both in
// TypeScript (a crible DSL comparison silently drops null rows, so a gate
// written there would hide every company it cannot judge):
//
//  - hygiene: is the row a security worth ranking at all — a home listing on a
//    real exchange, not a depositary receipt, one line per issuer, sane
//    multiples, a recent fiscal period, in the region (PEA: country and ISIN);
//  - anti value-trap gates: accounting manipulation, debt service, dilution,
//    cash generation, distress, bankruptcy odds, a falling knife. Each gate
//    answers pass, fail, unknown (the field is null — a distinct reason, never
//    a silent pass) or skipped (the gate does not apply, e.g. Altman on a bank).
import { isDepositaryReceipt, isForeignLine, issuerKey, OTC_VENUES } from "../screen/crible.js";
import { peaEligible, type ValueRegion, type ValueStyle } from "./styles.js";

export type CribleRow = Record<string, unknown>;

const num = (row: CribleRow, f: string): number | undefined => {
  const v = row[f];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

export type GateStatus = "pass" | "fail" | "unknown" | "skipped";

export interface GateResult {
  gate: string;
  status: GateStatus;
  reason: string;
  /** The crible fields the verdict rests on (registered as evidence for the shortlist). */
  fields: string[];
}

export interface ValueGate {
  id: string;
  label: string;
  fields: string[];
  check: (row: CribleRow) => Omit<GateResult, "gate" | "fields">;
}

const isFinancial = (row: CribleRow) => row.sector === "Financials";
const fmt = (x: number, digits = 2) => String(Number(x.toFixed(digits)));
const pct = (x: number) => `${fmt(x * 100, 1)} %`;

/** A gate whose every field is null answers "unknown", with the fields named. */
const unknown = (what: string, fields: string[]) => ({ status: "unknown" as const, reason: `${what} unknown: ${fields.join(", ")} null in crible` });

export const BENEISH_LIMIT = -1.78;
export const COVERAGE_MIN = 3;
export const DILUTION_MAX = 0.05;
export const FCF_YEARS_MIN = 3;
export const MONTIER_MAX = 3;
export const ALTMAN_ZPP_MIN = 1.1;
export const KNIFE_PROXIMITY = 0.6;
export const KNIFE_MOMENTUM = 20;

export const VALUE_GATES: ValueGate[] = [
  {
    id: "beneish",
    label: `Beneish M-score above ${BENEISH_LIMIT} (an earnings-manipulation profile)`,
    fields: ["beneish_m"],
    check: (row) => {
      const m = num(row, "beneish_m");
      if (m === undefined) return unknown("Beneish M-score", ["beneish_m"]);
      return m > BENEISH_LIMIT
        ? { status: "fail", reason: `Beneish M-score ${fmt(m)} > ${BENEISH_LIMIT}: earnings look managed` }
        : { status: "pass", reason: `Beneish M-score ${fmt(m)} ≤ ${BENEISH_LIMIT}` };
    },
  },
  {
    id: "interest-coverage",
    label: `interest coverage under ${COVERAGE_MIN}× (debt service eats the profit)`,
    fields: ["interest_coverage_ratio", "total_debt"],
    check: (row) => {
      if (isFinancial(row)) return { status: "skipped", reason: "interest coverage does not apply to a financial (interest is its business)" };
      const c = num(row, "interest_coverage_ratio");
      if (c === undefined) {
        const debt = num(row, "total_debt");
        if (debt !== undefined && debt <= 0) return { status: "pass", reason: "no interest-bearing debt" };
        return unknown("interest coverage", ["interest_coverage_ratio"]);
      }
      return c < COVERAGE_MIN
        ? { status: "fail", reason: `interest coverage ${fmt(c, 1)}× < ${COVERAGE_MIN}×` }
        : { status: "pass", reason: `interest coverage ${fmt(c, 1)}× ≥ ${COVERAGE_MIN}×` };
    },
  },
  {
    id: "dilution",
    label: `share count up more than ${DILUTION_MAX * 100} % in a year (the cheapness is diluted away)`,
    fields: ["shares_outstanding_growth", "net_share_issuance"],
    check: (row) => {
      const g = num(row, "shares_outstanding_growth");
      const n = num(row, "net_share_issuance");
      if (g === undefined && n === undefined) return unknown("dilution", ["shares_outstanding_growth", "net_share_issuance"]);
      const worst = Math.max(g ?? Number.NEGATIVE_INFINITY, n ?? Number.NEGATIVE_INFINITY);
      const which = worst === g ? "share count growth" : "net share issuance";
      return worst > DILUTION_MAX
        ? { status: "fail", reason: `${which} ${pct(worst)} > ${DILUTION_MAX * 100} %` }
        : { status: "pass", reason: `${which} ${pct(worst)} ≤ ${DILUTION_MAX * 100} %` };
    },
  },
  {
    id: "cash",
    label: `free cash flow positive in fewer than ${FCF_YEARS_MIN} of 5 years, or negative over the last 12 months`,
    fields: ["positive_fcf_years_5y", "ttm_free_cash_flow"],
    check: (row) => {
      if (isFinancial(row)) return { status: "skipped", reason: "free cash flow is not meaningful for a financial" };
      const years = num(row, "positive_fcf_years_5y");
      const ttm = num(row, "ttm_free_cash_flow");
      if (years === undefined && ttm === undefined) return unknown("cash generation", ["positive_fcf_years_5y", "ttm_free_cash_flow"]);
      if (ttm !== undefined && ttm < 0) return { status: "fail", reason: "free cash flow negative over the last 12 months" };
      if (years !== undefined && years < FCF_YEARS_MIN)
        return { status: "fail", reason: `free cash flow positive in ${years} of 5 years (< ${FCF_YEARS_MIN})` };
      return {
        status: "pass",
        reason: years !== undefined ? `free cash flow positive in ${years} of 5 years` : "free cash flow positive over the last 12 months",
      };
    },
  },
  {
    id: "montier",
    label: `Montier C-score above ${MONTIER_MAX} of 6 (accounts that flatter the earnings)`,
    fields: ["montier_c"],
    check: (row) => {
      const c = num(row, "montier_c");
      if (c === undefined) return unknown("Montier C-score", ["montier_c"]);
      return c > MONTIER_MAX
        ? { status: "fail", reason: `Montier C-score ${c} of 6 > ${MONTIER_MAX}` }
        : { status: "pass", reason: `Montier C-score ${c} of 6 ≤ ${MONTIER_MAX}` };
    },
  },
  {
    id: "ohlson",
    label: "Ohlson O-score above 0 (a bankruptcy probability above 50 %)",
    fields: ["ohlson_o"],
    check: (row) => {
      const o = num(row, "ohlson_o");
      if (o === undefined) return unknown("Ohlson O-score", ["ohlson_o"]);
      const p = 1 / (1 + Math.exp(-o));
      return o > 0
        ? { status: "fail", reason: `Ohlson O-score ${fmt(o)} > 0 (bankruptcy probability ${pct(p)})` }
        : { status: "pass", reason: `Ohlson O-score ${fmt(o)} ≤ 0 (bankruptcy probability ${pct(p)})` };
    },
  },
  {
    id: "altman",
    label: `Altman Z″ under ${ALTMAN_ZPP_MIN} (the distress zone); skipped for financials`,
    fields: ["altman_z_double_prime"],
    check: (row) => {
      if (isFinancial(row)) return { status: "skipped", reason: "Altman Z″ is not built for a financial's balance sheet" };
      const z = num(row, "altman_z_double_prime");
      if (z === undefined) return unknown("Altman Z″", ["altman_z_double_prime"]);
      return z < ALTMAN_ZPP_MIN
        ? { status: "fail", reason: `Altman Z″ ${fmt(z)} < ${ALTMAN_ZPP_MIN}: distress zone` }
        : { status: "pass", reason: `Altman Z″ ${fmt(z)} ≥ ${ALTMAN_ZPP_MIN}` };
    },
  },
  {
    id: "momentum",
    label: `a falling knife: below ${KNIFE_PROXIMITY * 100} % of the 52-week high AND bottom-${KNIFE_MOMENTUM} momentum in its peer group`,
    fields: ["high_52w_proximity", "momentum_rank"],
    check: (row) => {
      const p = num(row, "high_52w_proximity");
      const m = num(row, "momentum_rank");
      if (p === undefined && m === undefined) return unknown("price momentum", ["high_52w_proximity", "momentum_rank"]);
      if (p !== undefined && m !== undefined && p < KNIFE_PROXIMITY && m < KNIFE_MOMENTUM)
        return { status: "fail", reason: `at ${pct(p)} of its 52-week high with momentum rank ${fmt(m, 0)} / 100: a falling knife` };
      if (p !== undefined && p < KNIFE_PROXIMITY && m === undefined)
        return { status: "unknown", reason: `at ${pct(p)} of its 52-week high, momentum rank unknown (momentum_rank null in crible)` };
      return { status: "pass", reason: p !== undefined ? `at ${pct(p)} of its 52-week high` : `momentum rank ${fmt(m!, 0)} / 100` };
    },
  },
];

/** A candidate with more unknown gates than this cannot be cleared of being a trap: it is set aside, not ranked. */
export const MAX_UNKNOWN_GATES = 4;

export interface GateVerdict {
  pass: boolean;
  results: GateResult[];
  failed: GateResult[];
  unknown: GateResult[];
  /** Why the row is out, when it is. */
  reason?: string;
}

export function runValueGates(row: CribleRow, gates: readonly ValueGate[] = VALUE_GATES): GateVerdict {
  const results = gates.map((g) => ({ gate: g.id, fields: g.fields, ...g.check(row) }));
  const failed = results.filter((r) => r.status === "fail");
  const unknownOnes = results.filter((r) => r.status === "unknown");
  const reason = failed.length
    ? `gate ${failed[0]!.gate}: ${failed[0]!.reason}`
    : unknownOnes.length > MAX_UNKNOWN_GATES
      ? `too little data to rule out a trap: ${unknownOnes.length} of ${results.length} gates unknown`
      : undefined;
  return { pass: !reason, results, failed, unknown: unknownOnes, ...(reason ? { reason } : {}) };
}

// ── Hygiene ────────────────────────────────────────────────────────────────

/**
 * The exchanges a value ranking keeps, in crible's codes: home markets only.
 * Out: OTC, German regional floors (FRA, MUN, STU, DUS, HAM, HAN, BER), the
 * LSE international order book (IOB) and Cboe Canada's CDRs (NEO) — lines that
 * trade a company away from where it is listed.
 */
export const VALUE_VENUES: ReadonlySet<string> = new Set([
  // United States
  "NYQ",
  "NMS",
  "NGM",
  "NCM",
  "ASE",
  "PCX",
  "BTS",
  // Europe
  "PAR",
  "AMS",
  "BRU",
  "LIS",
  "ISE",
  "MIL",
  "MCE",
  "GER",
  "LSE",
  "EBS",
  "VIE",
  "STO",
  "HEL",
  "CPH",
  "OSL",
  "ICE",
  "WSE",
  "ATH",
  "PRA",
  "BUD",
  "IST",
  "TAL",
  "RIS",
  "LIT",
  // Asia-Pacific
  "JPX",
  "HKG",
  "SHH",
  "SHZ",
  "NSE",
  "NSI",
  "BSE",
  "KSC",
  "KOE",
  "TAI",
  "TWO",
  "SES",
  "KLS",
  "JKT",
  "SET",
  "PHS",
  "ASX",
  "NZE",
  // Americas
  "TOR",
  "VAN",
  "CNQ",
  "SAO",
  "MEX",
  "SGO",
  "BUE",
  "LIM",
  // Middle East, Africa
  "TLV",
  "JNB",
  "SAU",
  "DFM",
  "QAT",
]);

/**
 * Markets where a foreign company mostly trades through a cross-listing scheme
 * (Mexico's SIC, Brazil's BDRs, Argentina's CEDEARs, Chile and Peru): there,
 * only the country's own issuers are home listings.
 */
const HOME_ONLY_VENUES: Record<string, string> = { MEX: "MX", SAO: "BR", BUE: "AR", SGO: "CL", LIM: "PE" };

/** A fiscal period older than this (months) is stale: the next filing may already have changed the story. */
export const MAX_PERIOD_AGE_MONTHS = 18;

/** A period's end as a date: "2025-12-31", or a bare fiscal year "2025" read as its 31 December. */
export function periodEnd(period: unknown): Date | undefined {
  if (typeof period !== "string") return undefined;
  const m = /^(\d{4})(?:-(\d{2})-(\d{2}))?/.exec(period.trim());
  if (!m) return undefined;
  const d = new Date(m[2] ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : `${m[1]}-12-31T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** US preferred and other non-common lines crible lists as primary: BAC-PB, AGM-PD on NYSE; ZIONP, AGNCN (Nasdaq's fifth letter M–P preferred, R rights, U units, W warrants, Y ADR). */
const US_PREFERRED = /-P[A-Z]?$/;
const NASDAQ_VENUES = new Set(["NMS", "NGM", "NCM"]);
const NASDAQ_NON_COMMON = /^[A-Z]{4}[MNOPRUWY]$/;
const NON_COMMON_WORDING = /\b(preferred (?:stock|shares?)|pfd|depositary shares?|capital trust)\b/i;

export interface HygieneOptions {
  region: ValueRegion;
  style: ValueStyle;
  now: Date;
}

/** The first reason a row is not a security worth ranking, or undefined when it is. */
export function valueHygieneReason(row: CribleRow, opts: HygieneOptions): string | undefined {
  const exchange = typeof row.exchange === "string" ? row.exchange : "";
  if (typeof row.symbol !== "string" || !row.symbol) return "no symbol";
  if (OTC_VENUES.has(exchange)) return "over-the-counter line";
  if (!VALUE_VENUES.has(exchange)) return "not a home exchange (a regional floor, an order book, a CDR venue)";
  if (isDepositaryReceipt(row)) return "depositary receipt (ADR / GDR / CDR)";
  if (isForeignLine(row)) return "a line traded away from the issuer's home market";
  const home = HOME_ONLY_VENUES[exchange];
  if (home && row.country !== home) return "a foreign issuer's line on a cross-listing market (SIC, BDR, CEDEAR)";
  if (
    row.country === "US" &&
    (US_PREFERRED.test(row.symbol) || (NASDAQ_VENUES.has(exchange) && NASDAQ_NON_COMMON.test(row.symbol)) || NON_COMMON_WORDING.test(String(row.name ?? "")))
  )
    return "preferred share, trust or other non-common line";
  const countries = opts.region.countries;
  if (countries && !(typeof row.country === "string" && countries.includes(row.country))) return "outside the region";
  if (opts.region.pea && !peaEligible(row)) return "not PEA-eligible on country and ISIN (both must be EU / EEA)";
  if (opts.style.excludeSectors?.includes(String(row.sector))) return `sector left out of the style (${opts.style.excludeSectors.join(", ")})`;
  const ey = num(row, "earnings_yield");
  if (ey === undefined) return "earnings yield unknown";
  if (ey <= 0) return "earnings yield not positive (a loss)";
  if (ey >= 0.5) return "earnings yield at or above 50 % (an impossible multiple: a one-off gain or a bad price)";
  const pb = num(row, "price_to_book_ratio");
  if (pb !== undefined && pb <= 0.05) return "price-to-book at or below 0.05 (negative or absurd equity)";
  const end = periodEnd(row.period);
  if (!end) return "fiscal period unknown";
  const cutoff = new Date(opts.now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - MAX_PERIOD_AGE_MONTHS);
  if (end < cutoff) return `fiscal period more than ${MAX_PERIOD_AGE_MONTHS} months old`;
  for (const r of opts.style.rules ?? []) {
    const ok = r.test(row);
    if (ok === false) return r.label;
    if (ok === undefined) return `${r.label} — unknown (field null in crible)`;
  }
  return undefined;
}

export interface HygieneResult {
  kept: CribleRow[];
  /** Dropped rows by reason, in first-seen order. */
  dropped: Map<string, string[]>;
}

const cap = (row: CribleRow) => num(row, "cap_eur") ?? 0;

/**
 * Apply the hygiene to every row, then keep one line per issuer (the A/H, A/B
 * and preferred lines of one company share its fundamentals: ranked twice, they
 * would crowd the list). The largest line by EUR cap wins; ties keep the first.
 */
export function valueHygiene(rows: readonly CribleRow[], opts: HygieneOptions): HygieneResult {
  const dropped = new Map<string, string[]>();
  const drop = (reason: string, row: CribleRow) => {
    const list = dropped.get(reason) ?? [];
    list.push(String(row.symbol ?? "?"));
    dropped.set(reason, list);
  };
  const clean: CribleRow[] = [];
  for (const row of rows) {
    const reason = valueHygieneReason(row, opts);
    if (reason) drop(reason, row);
    else clean.push(row);
  }
  const best = new Map<string, CribleRow>();
  for (const row of clean) {
    const k = `${String(row.country ?? "")}|${typeof row.name === "string" && row.name.trim() ? issuerKey(row.name) : String(row.symbol)}`;
    const cur = best.get(k);
    if (!cur || cap(row) > cap(cur)) best.set(k, row);
  }
  const winners = new Set(best.values());
  const kept: CribleRow[] = [];
  for (const row of clean) {
    if (winners.has(row)) kept.push(row);
    else drop("another line of the same issuer ranks instead (one line per issuer)", row);
  }
  return { kept, dropped };
}
