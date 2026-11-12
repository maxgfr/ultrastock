// The benchmark an analysis measures against. A user's own (`profile set
// benchmark <symbol>`) when the profile has one; otherwise a stated CONVENTION,
// not a fact: a US listing against SPY (S&P 500), a Paris listing against the
// CAC 40 (Euronext's index line FR0003500008), anything else — and a EUR book —
// against CW8.PA (Amundi MSCI World, in EUR), a USD book against SPY. Every
// output that uses one says which and why (`benchmarkNote`).
import { loadProfile } from "../core/profile.js";

export interface BenchmarkChoice {
  symbol: string;
  /** Why this one, in words: the profile's, or the convention that picked it. */
  why: string;
  source: "profile" | "convention";
}

/** The profile's benchmark, when there is a profile that sets one. */
export function profileBenchmark(): string | undefined {
  try {
    return loadProfile()?.benchmark;
  } catch {
    return undefined; // an unreadable profile is reported by the commands that need it
  }
}

/** The profile's benchmark when set, else the convention given (undefined: none, as for crypto). */
export function chooseBenchmark(convention: { symbol: string; why: string } | undefined): BenchmarkChoice | undefined {
  if (!convention) return undefined;
  const own = profileBenchmark();
  if (own) return { symbol: own, why: "the profile's benchmark (`profile set benchmark`)", source: "profile" };
  return { ...convention, source: "convention" };
}

/** The convention for one listing: crypto none, a US listing SPY, a Paris listing the CAC 40, anything else CW8.PA. */
export function listingConvention(market: string, mic?: string): { symbol: string; why: string } | undefined {
  if (market === "crypto") return undefined;
  if (market === "us") return { symbol: "SPY", why: "convention: a US listing is measured against SPY (S&P 500)" };
  if (mic === "XPAR" || mic === "ETFP") return { symbol: "FR0003500008", why: "convention: a Paris listing is measured against the CAC 40" };
  return { symbol: "CW8.PA", why: "convention: a listing outside the US and Paris is measured against CW8.PA (MSCI World, EUR)" };
}

/** The convention for a book in its base currency: EUR against CW8.PA, any other against SPY. */
export function bookConvention(base: string): { symbol: string; why: string } {
  return base === "EUR"
    ? { symbol: "CW8.PA", why: "convention: a EUR book is measured against CW8.PA (MSCI World, EUR)" }
    : { symbol: "SPY", why: `convention: a ${base} book is measured against SPY (S&P 500, USD)` };
}

/** The line an output carries about its benchmark. */
export const benchmarkNote = (c: BenchmarkChoice): string =>
  `benchmark ${c.symbol}: ${c.why}${c.source === "convention" ? " — `profile set benchmark <symbol>` to measure against your own" : ""}`;
