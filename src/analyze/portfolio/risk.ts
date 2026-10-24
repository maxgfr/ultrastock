// Portfolio risk, the pure part: exposures, concentration, the return series
// of today's weights, its tail risk and the profile's limits. The command
// (src/commands/portfolio-analytics.ts) fetches; these functions only count.
//
// Conventions: weights are fractions here (0.25 = 25 %) and percentages in the
// evidence; returns are simple daily returns; the portfolio return of a day is
// Σ wᵢ rᵢ with today's weights held constant (cash earns 0) — what today's
// book would have done, not what the past book did.
import { correlationMatrix, stdev } from "../../analytics/stats.js";
import type { Limits } from "../../core/profile.js";

/** Sum of weights by a label (asset class, currency, country, sector). */
export function weightsBy<T>(items: readonly T[], label: (x: T) => string, weight: (x: T) => number): Array<{ label: string; weight: number }> {
  const m = new Map<string, number>();
  for (const it of items) m.set(label(it), (m.get(label(it)) ?? 0) + weight(it));
  return [...m.entries()].map(([l, w]) => ({ label: l, weight: w })).sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
}

/**
 * Herfindahl–Hirschman index of the invested weights (renormalised to sum to
 * 1, cash excluded): 1 for one position, 1/n for n equal ones. The effective
 * number of positions is its inverse.
 */
export function concentration(weights: readonly number[]): { hhi: number; effectiveN: number; top5: number } {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!(total > 0)) return { hhi: Number.NaN, effectiveN: Number.NaN, top5: Number.NaN };
  const w = weights.map((x) => x / total);
  const hhi = w.reduce((s, x) => s + x * x, 0);
  const top5 = [...w]
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((s, x) => s + x, 0);
  return { hhi, effectiveN: 1 / hhi, top5 };
}

/** Σ wᵢ rᵢ,t per day; `weights` aligned with `returns` (one series per asset). */
export function portfolioReturns(weights: readonly number[], returns: readonly (readonly number[])[]): number[] {
  const n = Math.min(...returns.map((r) => r.length));
  if (!Number.isFinite(n)) return [];
  const out: number[] = [];
  for (let t = 0; t < n; t++) out.push(returns.reduce((s, r, i) => s + weights[i]! * r[t]!, 0));
  return out;
}

/** Diversification ratio (Choueifaty): Σ wᵢ σᵢ ÷ σₚ — 1 when everything moves together, higher when holdings offset. */
export function diversificationRatio(weights: readonly number[], returns: readonly (readonly number[])[]): number {
  const p = portfolioReturns(weights, returns);
  const sp = stdev(p);
  const num = returns.reduce((s, r, i) => s + weights[i]! * stdev(r), 0);
  return sp > 0 ? num / sp : Number.NaN;
}

/** Pairwise correlations of the given series, upper triangle only. */
export function pairwiseCorrelations(names: readonly string[], returns: readonly (readonly number[])[]): Array<{ a: string; b: string; rho: number }> {
  const m = correlationMatrix(returns);
  const out: Array<{ a: string; b: string; rho: number }> = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) out.push({ a: names[i]!, b: names[j]!, rho: m[i]![j]! });
  return out;
}

export interface LimitCheck {
  /** "position", "sector", "crypto", "cash". */
  kind: string;
  subject: string;
  /** The exposure and the limit, in %. */
  valuePct: number;
  limitPct: number;
  breach: boolean;
  reason: string;
}

/**
 * The profile's caps against today's exposures (all in % of the portfolio):
 * each position ≤ maxPositionPct, each resolved sector ≤ maxSectorPct, crypto
 * ≤ maxCryptoPct, cash ≥ cashBufferPct. Every check is returned, breached or not.
 */
export function limitChecks(
  limits: Limits,
  exposure: { positions: Array<{ label: string; weight: number }>; sectors: Array<{ label: string; weight: number }>; cryptoPct: number; cashPct: number },
): LimitCheck[] {
  const out: LimitCheck[] = [];
  for (const p of exposure.positions)
    out.push({
      kind: "position",
      subject: p.label,
      valuePct: p.weight,
      limitPct: limits.maxPositionPct,
      breach: p.weight > limits.maxPositionPct + 1e-9,
      reason: `${p.label} is ${p.weight.toFixed(2)} % of the portfolio; the profile caps one position at ${limits.maxPositionPct} %`,
    });
  for (const s of exposure.sectors)
    out.push({
      kind: "sector",
      subject: s.label,
      valuePct: s.weight,
      limitPct: limits.maxSectorPct,
      breach: s.weight > limits.maxSectorPct + 1e-9,
      reason: `sector ${s.label} is ${s.weight.toFixed(2)} %; the profile caps one sector at ${limits.maxSectorPct} %`,
    });
  out.push({
    kind: "crypto",
    subject: "crypto",
    valuePct: exposure.cryptoPct,
    limitPct: limits.maxCryptoPct,
    breach: exposure.cryptoPct > limits.maxCryptoPct + 1e-9,
    reason: `crypto is ${exposure.cryptoPct.toFixed(2)} %; the profile caps crypto at ${limits.maxCryptoPct} %`,
  });
  out.push({
    kind: "cash",
    subject: "cash",
    valuePct: exposure.cashPct,
    limitPct: limits.cashBufferPct,
    breach: exposure.cashPct < limits.cashBufferPct - 1e-9,
    reason: `cash is ${exposure.cashPct.toFixed(2)} %; the profile keeps at least ${limits.cashBufferPct} % aside`,
  });
  return out;
}

/** TradingView's sector names (its FactSet-derived classification): the only sector labels used as keys. Anything else is "unclassified". */
export const TV_SECTORS = [
  "Commercial Services",
  "Communications",
  "Consumer Durables",
  "Consumer Non-Durables",
  "Consumer Services",
  "Distribution Services",
  "Electronic Technology",
  "Energy Minerals",
  "Finance",
  "Government",
  "Health Services",
  "Health Technology",
  "Industrial Services",
  "Miscellaneous",
  "Non-Energy Minerals",
  "Process Industries",
  "Producer Manufacturing",
  "Retail Trade",
  "Technology Services",
  "Transportation",
  "Utilities",
] as const;

/** The known sector a raw label names, or undefined (external text is never used as a key). */
export function knownSector(raw: unknown): string | undefined {
  return typeof raw === "string" ? TV_SECTORS.find((s) => s.toLowerCase() === raw.trim().toLowerCase()) : undefined;
}

/** A label as a key segment: "Electronic Technology" → "electronic-technology". */
export const keySlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** EU and EEA member states (ISO 3166 alpha-2), for the "where is it incorporated" first pass. */
export const EU_EEA = new Set([
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
  "IS",
  "LI",
  "NO",
]);

/** The country an ISIN was issued under (its first two letters), when it looks like one. */
export function isinCountry(isin: string | undefined): string | undefined {
  return isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) ? isin.slice(0, 2) : undefined;
}
