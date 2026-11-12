// Asset location, the pure part: which envelope suits each kind of holding
// best, and the holdings sitting in a worse envelope than one the investor
// already has. ultrastock has envelope rankings for one tax residence only —
// France (PEA, PEA-PME, assurance-vie, PER, CTO) — and even there it states no
// tax rule of its own: the holding periods, the ceiling and the treaty rate in
// the advice are the researched "tax" facts for the user's tax year
// (src/tax/rules.ts: pea.ceiling, pea.minYears, av.minYears,
// us.dividendWithholdingTreaty). A fact not researched is left out of the
// advice, which says so and names the command to research it. For any other
// residence no advice is given at all (run-book.ts locationAnalysis).
//
// Eligibility is a FIRST PASS: the ISIN's country prefix (usually the
// issuer's country of incorporation) against the EU/EEA list of core/geo.ts
// for shares, the issuer's own flag (Amundi's FUND_PEA) for funds. Always
// "confirm with the broker": the broker refuses an ineligible order anyway.
import { euEeaMembers, isEuEea } from "../../core/geo.js";
import { ruleStatus } from "../../core/jurisdiction.js";
import type { EnvelopeType } from "../../core/profile.js";
import { loadRules, TAX, templateCommand } from "../../tax/rules.js";
import { isinCountry } from "./risk.js";

export interface LocationRule {
  id: string;
  /** Who it applies to, in words. */
  applies: string;
  /** Envelopes from best to worst for a French resident (tax on gains and income); the first held one wins. */
  ranking: EnvelopeType[];
  why: string;
  sources: Array<{ label: string; url: string }>;
}

/** The researched facts the French advice is written with, for one tax year; a field absent is not researched (or stale). */
export interface LocationFacts {
  country: string;
  year: number;
  /** PEA deposit ceiling (tax currency). */
  peaCeiling?: number;
  /** Years after which PEA withdrawals are free of income tax. */
  peaMinYears?: number;
  /** Assurance-vie contract age for the reduced rate and the allowance. */
  avMinYears?: number;
  /** The US treaty withholding rate on dividends for a resident (a fraction). */
  usTreatyRate?: number;
  /** The sources of the facts read, as researched. */
  sources: string[];
  /** The keys the advice would use and could not read. */
  missing: string[];
  /** Why the facts could not be read at all (no file for the year…). */
  problem?: string;
}

const KEYS = { peaCeiling: "pea.ceiling", peaMinYears: "pea.minYears", avMinYears: "av.minYears", usTreatyRate: "us.dividendWithholdingTreaty" } as const;

/** The tax facts the advice reads for a tax year: whatever is researched and current, the rest listed as missing. */
export function locationFacts(year: number, country = "FR"): LocationFacts {
  const out: LocationFacts = { country, year, sources: [], missing: [] };
  let facts: Record<string, { value: unknown; sources: string[] }> = {};
  try {
    facts = loadRules(country, year).rules.facts;
  } catch (e) {
    out.problem = `no ${country} tax facts for ${year}: ${(e as Error).message.split(" — ")[0]}`;
  }
  for (const [field, key] of Object.entries(KEYS) as Array<[keyof typeof KEYS, string]>) {
    const f = facts[key];
    if (f && typeof f.value === "number") {
      out[field] = f.value;
      for (const u of f.sources) if (!out.sources.includes(u)) out.sources.push(u);
    } else out.missing.push(key);
  }
  return out;
}

/** What the advice lacks, in words, with the command to research it — undefined when every fact it uses is researched. */
export function locationFactsNote(lf: LocationFacts): string | undefined {
  if (!lf.missing.length) return undefined;
  return `${lf.country} tax facts not researched for ${lf.year}: ${lf.missing.join(", ")} — the advice leaves out what they would say (no holding period, ceiling or treaty rate is assumed); run \`${templateCommand(lf.country, lf.year)}\`, research the keys and store them with \`${TAX.setCommand}\``;
}

/** Facts with nothing researched: the advice without any holding period, ceiling or rate. */
export const unresearched = (year: number, country = "FR"): LocationFacts => ({ country, year, sources: [], missing: Object.values(KEYS) });

const SP_CTO = { label: "service-public.fr — Plus-values sur valeurs mobilières", url: "https://www.service-public.fr/particuliers/vosdroits/F21618" };
const PRIIPS = { label: "Regulation (EU) 1286/2014 (PRIIPs)", url: "https://eur-lex.europa.eu/eli/reg/2014/1286/oj" };
const researched = (lf: LocationFacts) => lf.sources.map((url) => ({ label: `researched ${lf.country} tax fact (${lf.year})`, url }));

/**
 * The French location rules, written with the researched facts of `lf`: a holding period, a ceiling or a treaty
 * rate that is not researched is left out of the text, never assumed. Rankings put the tax-sheltered envelope first
 * where the holding is eligible for it.
 */
export function locationRules(lf: LocationFacts = unresearched(new Date().getUTCFullYear())): Record<string, LocationRule> {
  const src = researched(lf);
  const pea =
    lf.peaMinYears !== undefined
      ? `gains and dividends are free of income tax after ${lf.peaMinYears} years (social levies remain)`
      : "the PEA shelters gains and dividends (its holding period is not researched for this tax year)";
  const av =
    lf.avMinYears !== undefined
      ? `an assurance-vie contract that lists it defers tax (allowance after ${lf.avMinYears} years)`
      : "an assurance-vie contract that lists it defers tax (its holding period is not researched for this tax year)";
  const treaty = lf.usTreatyRate !== undefined ? `file a W-8BEN for the ${Number((lf.usTreatyRate * 100).toFixed(2))} % US treaty rate on dividends; ` : "";
  const priips = ruleStatus(lf.country, "us-domiciled-etf") === "restricted";
  return {
    "eu-share": {
      id: "eu-share",
      applies: "shares of a company incorporated in the EU/EEA (ISIN prefix)",
      ranking: ["PEA", "PEA-PME", "CTO", "TAXABLE"],
      why: `PEA-eligible: ${pea}; in a CTO every sale and dividend is taxed`,
      sources: [...src, SP_CTO],
    },
    "pea-fund": {
      id: "pea-fund",
      applies: "an ETF or fund its issuer flags PEA-eligible",
      ranking: ["PEA", "AV", "CTO", "TAXABLE"],
      why: "PEA-eligible fund: the PEA shelters it; an assurance-vie unit-linked line is second best",
      sources: [...src, SP_CTO],
    },
    "other-fund": {
      id: "other-fund",
      applies: "an ETF or fund not known to be PEA-eligible (world/US physical UCITS ETFs, bond funds)",
      ranking: ["AV", "PER", "CTO", "TAXABLE"],
      why: `not PEA-eligible as far as is known: ${av}; otherwise a CTO`,
      sources: [...src, SP_CTO],
    },
    "us-etf": {
      id: "us-etf",
      applies: "a US-domiciled ETF",
      ranking: ["CTO", "TAXABLE"],
      why: priips
        ? "no PRIIPs key information document: EU brokers do not sell it to retail clients — an existing line stays in a CTO; buy the UCITS equivalent instead"
        : "not PEA-eligible: a CTO",
      sources: [...(priips ? [PRIIPS] : []), SP_CTO],
    },
    "non-eu-share": {
      id: "non-eu-share",
      applies: "shares of a company incorporated outside the EU/EEA (US, UK, Switzerland…)",
      ranking: ["CTO", "TAXABLE"],
      why: `not PEA-eligible: a CTO (${treaty}declare an account held abroad on form 3916)`,
      sources: [...src, SP_CTO],
    },
    crypto: {
      id: "crypto",
      applies: "crypto-assets",
      ranking: ["CRYPTO"],
      why: "no tax wrapper takes crypto: an exchange account (form 3916-bis for an account abroad)",
      sources: [...src],
    },
    unknown: {
      id: "unknown",
      applies: "a holding whose country or fund eligibility could not be read",
      ranking: ["CTO", "TAXABLE"],
      why: "eligibility unknown: a CTO takes anything — check the ISIN and the KID before moving it",
      sources: [SP_CTO],
    },
  };
}

export interface LocationInput {
  symbol: string;
  assetClass: string;
  market?: string;
  isin?: string;
  /** The issuer's PEA flag for a fund, when read (Amundi's FUND_PEA). */
  peaFlag?: boolean;
  /** Current envelopes holding it. */
  envelopes: Array<EnvelopeType | "unknown">;
}

/** The rule for one holding, from `rules` (by default the rules with no researched fact). */
export function locationRule(h: LocationInput, rules: Record<string, LocationRule> = locationRules()): { rule: LocationRule; basis: string } {
  if (h.assetClass === "crypto") return { rule: rules.crypto!, basis: "crypto-asset" };
  const country = isinCountry(h.isin) ?? (h.market === "us" ? "US" : undefined);
  if (h.assetClass === "etf" || h.assetClass === "fund") {
    if (country === "US" || (h.market === "us" && !h.isin)) return { rule: rules["us-etf"]!, basis: "US listing / US ISIN" };
    if (h.peaFlag === true) return { rule: rules["pea-fund"]!, basis: "issuer flags it PEA-eligible (FUND_PEA)" };
    if (h.peaFlag === undefined && h.envelopes.includes("PEA"))
      return { rule: rules["pea-fund"]!, basis: "already held in a PEA, so the broker accepted it as eligible" };
    return { rule: rules["other-fund"]!, basis: h.peaFlag === false ? "issuer flags it not PEA-eligible" : "no issuer PEA flag read" };
  }
  if (!country) return { rule: rules.unknown!, basis: "no ISIN read" };
  if (isEuEea(country))
    return {
      rule: rules["eu-share"]!,
      basis: `ISIN prefix ${country} (EU/EEA${euEeaMembers().origin === "built-in" ? `, built-in list as of ${euEeaMembers().asOf}` : ""})`,
    };
  return { rule: rules["non-eu-share"]!, basis: `ISIN prefix ${country} (outside the EU/EEA)` };
}

/**
 * The best envelope the investor HAS for the holding (first of the rule's
 * ranking among `available`; a PEA counts only with room under its ceiling),
 * and whether some of the holding sits in a worse one.
 */
export function bestEnvelope(
  h: LocationInput,
  available: ReadonlySet<EnvelopeType>,
  /** Room under the PEA ceiling; undefined when the ceiling is not researched (the PEA then counts as usable, its room unknown). */
  peaRoom: number | undefined,
  rules: Record<string, LocationRule> = locationRules(),
): { rule: LocationRule; basis: string; best?: EnvelopeType; ideal: EnvelopeType; worse: Array<EnvelopeType | "unknown">; reason: string } {
  const { rule, basis } = locationRule(h, rules);
  const usable = (e: EnvelopeType) => available.has(e) && (e !== "PEA" || peaRoom === undefined || peaRoom > 0);
  const best = rule.ranking.find(usable);
  const rank = (e: EnvelopeType | "unknown") =>
    e === "unknown" ? rule.ranking.length : rule.ranking.indexOf(e) === -1 ? rule.ranking.length : rule.ranking.indexOf(e);
  const worse = best ? h.envelopes.filter((e) => rank(e) > rank(best)) : [];
  const ideal = rule.ranking[0]!;
  const reason = [
    `${rule.applies} (${basis}): ${rule.why}`,
    best ? `best envelope held: ${best}` : `none of ${rule.ranking.join(", ")} is in the profile`,
    ideal !== best
      ? `ideal: ${ideal}${ideal === "PEA" && available.has("PEA") && peaRoom !== undefined && peaRoom <= 0 ? " (the PEA has no room left under its ceiling)" : ""}`
      : "",
    best === "PEA" && peaRoom === undefined ? "the room under the PEA ceiling is unknown (the ceiling is not researched for this tax year)" : "",
    worse.length ? `held in ${worse.join(", ")}, worse than ${best}` : "",
    rule.id === "eu-share" || rule.id === "pea-fund" ? "eligibility is a first pass — confirm with the broker" : "",
  ]
    .filter(Boolean)
    .join("; ");
  return { rule, basis, best, ideal, worse, reason };
}

/** Σ deposits into the PEA accounts (the ceiling counts payments in; withdrawals do not give room back). */
export function peaDeposits(txs: ReadonlyArray<{ type: string; account: string; amount?: number }>, peaAccounts: ReadonlySet<string>): number {
  return txs.filter((t) => t.type === "deposit" && peaAccounts.has(t.account)).reduce((s, t) => s + Math.max(0, t.amount ?? 0), 0);
}
