// Asset location for a French resident, the pure part: which envelope suits
// each kind of holding best, as a table of rules with their sources, and the
// holdings sitting in a worse envelope than one the investor already has.
//
// Eligibility is a FIRST PASS: the PEA takes shares of companies whose
// registered office is in the EU/EEA and that pay corporate tax, and funds at
// least 75 % invested in them — the ISIN's country prefix approximates the
// first (it is the issuer's country of incorporation, usually), and only the
// issuer says the second (Amundi's FUND_PEA flag when it answers). Always
// "confirm with the broker": the broker refuses an ineligible order anyway.
import type { EnvelopeType } from "../../core/profile.js";
import { EU_EEA, isinCountry } from "./risk.js";

/** PEA deposit ceiling (versements), and the combined PEA + PEA-PME ceiling. */
export const PEA_CEILING = 150_000;
export const PEA_PME_COMBINED_CEILING = 225_000;

export interface LocationRule {
  id: string;
  /** Who it applies to, in words. */
  applies: string;
  /** Envelopes from best to worst for a French resident (tax on gains and income); the first held one wins. */
  ranking: EnvelopeType[];
  why: string;
  sources: Array<{ label: string; url: string }>;
}

const SP_PEA = { label: "service-public.fr — Plan d'épargne en actions (PEA)", url: "https://www.service-public.fr/particuliers/vosdroits/F2385" };
const SP_AV = { label: "service-public.fr — Contrat d'assurance-vie : fonctionnement", url: "https://www.service-public.fr/particuliers/vosdroits/F15274" };
const SP_AV_TAX = {
  label: "service-public.fr — Comment sont imposés les revenus d'un contrat d'assurance-vie",
  url: "https://www.service-public.fr/particuliers/vosdroits/F22414",
};
const SP_CTO = { label: "service-public.fr — Plus-values sur valeurs mobilières", url: "https://www.service-public.fr/particuliers/vosdroits/F21618" };
const PRIIPS = { label: "Regulation (EU) 1286/2014 (PRIIPs)", url: "https://eur-lex.europa.eu/eli/reg/2014/1286/oj" };
const ACCOUNTS_ABROAD = {
  label: "service-public.gouv.fr — comptes à l'étranger (3916, 3916-bis)",
  url: "https://www.service-public.gouv.fr/particuliers/actualites/A18891",
};

/** The rules, verified 2026-10-24. Rankings put the tax-sheltered envelope first where the holding is eligible for it. */
export const LOCATION_RULES: Record<string, LocationRule> = {
  "eu-share": {
    id: "eu-share",
    applies: "shares of a company incorporated in the EU/EEA (ISIN prefix)",
    ranking: ["PEA", "PEA-PME", "CTO", "TAXABLE"],
    why: "PEA-eligible: gains and dividends are free of income tax after 5 years (social levies remain); in a CTO every sale and dividend is taxed",
    sources: [SP_PEA, SP_CTO],
  },
  "pea-fund": {
    id: "pea-fund",
    applies: "an ETF or fund its issuer flags PEA-eligible (≥ 75 % EU/EEA shares, physically or by swap)",
    ranking: ["PEA", "AV", "CTO", "TAXABLE"],
    why: "PEA-eligible fund: the PEA shelters it; an assurance-vie unit-linked line is second best",
    sources: [SP_PEA, SP_AV],
  },
  "other-fund": {
    id: "other-fund",
    applies: "an ETF or fund not known to be PEA-eligible (world/US physical UCITS ETFs, bond funds)",
    ranking: ["AV", "PER", "CTO", "TAXABLE"],
    why: "not PEA-eligible as far as is known: an assurance-vie contract that lists it defers tax (allowance after 8 years); otherwise a CTO",
    sources: [SP_AV, SP_AV_TAX, SP_CTO],
  },
  "us-etf": {
    id: "us-etf",
    applies: "a US-domiciled ETF",
    ranking: ["CTO", "TAXABLE"],
    why: "no PRIIPs key information document: EU brokers do not sell it to retail clients — an existing line stays in a CTO; buy the UCITS equivalent instead",
    sources: [PRIIPS, SP_CTO],
  },
  "non-eu-share": {
    id: "non-eu-share",
    applies: "shares of a company incorporated outside the EU/EEA (US, UK, Switzerland…)",
    ranking: ["CTO", "TAXABLE"],
    why: "not PEA-eligible: a CTO (file a W-8BEN for the 15 % US treaty rate on dividends; declare an account held abroad on form 3916)",
    sources: [SP_CTO, ACCOUNTS_ABROAD],
  },
  crypto: {
    id: "crypto",
    applies: "crypto-assets",
    ranking: ["CRYPTO"],
    why: "no tax wrapper takes crypto: an exchange account (a MiCA-authorised venue; form 3916-bis for an account abroad), gains taxed when converted to euros",
    sources: [ACCOUNTS_ABROAD],
  },
  unknown: {
    id: "unknown",
    applies: "a holding whose country or fund eligibility could not be read",
    ranking: ["CTO", "TAXABLE"],
    why: "eligibility unknown: a CTO takes anything — check the ISIN and the KID before moving it",
    sources: [SP_CTO],
  },
};

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

/** The rule for one holding. */
export function locationRule(h: LocationInput): { rule: LocationRule; basis: string } {
  if (h.assetClass === "crypto") return { rule: LOCATION_RULES.crypto!, basis: "crypto-asset" };
  const country = isinCountry(h.isin) ?? (h.market === "us" ? "US" : undefined);
  if (h.assetClass === "etf" || h.assetClass === "fund") {
    if (country === "US" || (h.market === "us" && !h.isin)) return { rule: LOCATION_RULES["us-etf"]!, basis: "US listing / US ISIN" };
    if (h.peaFlag === true) return { rule: LOCATION_RULES["pea-fund"]!, basis: "issuer flags it PEA-eligible (FUND_PEA)" };
    if (h.peaFlag === undefined && h.envelopes.includes("PEA"))
      return { rule: LOCATION_RULES["pea-fund"]!, basis: "already held in a PEA, so the broker accepted it as eligible" };
    return { rule: LOCATION_RULES["other-fund"]!, basis: h.peaFlag === false ? "issuer flags it not PEA-eligible" : "no issuer PEA flag read" };
  }
  if (!country) return { rule: LOCATION_RULES.unknown!, basis: "no ISIN read" };
  if (EU_EEA.has(country)) return { rule: LOCATION_RULES["eu-share"]!, basis: `ISIN prefix ${country} (EU/EEA)` };
  return { rule: LOCATION_RULES["non-eu-share"]!, basis: `ISIN prefix ${country} (outside the EU/EEA)` };
}

/**
 * The best envelope the investor HAS for the holding (first of the rule's
 * ranking among `available`; a PEA counts only with room under its ceiling),
 * and whether some of the holding sits in a worse one.
 */
export function bestEnvelope(
  h: LocationInput,
  available: ReadonlySet<EnvelopeType>,
  peaRoom: number,
): { rule: LocationRule; basis: string; best?: EnvelopeType; ideal: EnvelopeType; worse: Array<EnvelopeType | "unknown">; reason: string } {
  const { rule, basis } = locationRule(h);
  const usable = (e: EnvelopeType) => available.has(e) && (e !== "PEA" || peaRoom > 0);
  const best = rule.ranking.find(usable);
  const rank = (e: EnvelopeType | "unknown") =>
    e === "unknown" ? rule.ranking.length : rule.ranking.indexOf(e) === -1 ? rule.ranking.length : rule.ranking.indexOf(e);
  const worse = best ? h.envelopes.filter((e) => rank(e) > rank(best)) : [];
  const ideal = rule.ranking[0]!;
  const reason = [
    `${rule.applies} (${basis}): ${rule.why}`,
    best ? `best envelope held: ${best}` : `none of ${rule.ranking.join(", ")} is in the profile`,
    ideal !== best ? `ideal: ${ideal}${ideal === "PEA" && available.has("PEA") && peaRoom <= 0 ? " (the PEA has no room left under its ceiling)" : ""}` : "",
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
