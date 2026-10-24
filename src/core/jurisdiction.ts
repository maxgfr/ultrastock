// What the investor's country allows. Rules change — a regulator blacklists a
// platform, a transitional period ends — so each rule carries its sources and
// the date it was last verified, `jurisdiction verify` re-checks what can be
// checked from public registers (ESMA's MiCA registers, the DNS block the ANJ
// imposes on Polymarket) and lists what must be checked by a web search.
//
// Fail-closed: a venue or an asset whose status is unknown in a jurisdiction is
// readable and paper-tradable, never live-tradable.
import { lookup, resolveCname } from "node:dns/promises";
import { parseCsvText } from "./csv.js";
import { fetchText } from "./net.js";
import { cachedJson, TTL } from "./cache.js";

export type Status = "allowed" | "blocked" | "restricted" | "unknown";

export interface Rule {
  id: string;
  status: Status;
  summary: string;
  sources: Array<{ label: string; url: string }>;
  verifiedAt: string;
}

export interface JurisdictionRules {
  code: string;
  name: string;
  rules: Rule[];
}

const FR: JurisdictionRules = {
  code: "FR",
  name: "France",
  rules: [
    {
      id: "polymarket",
      status: "blocked",
      summary:
        "Polymarket is an unauthorised gambling offer in France: payments banned since November 2024, ISP blocking ordered by the ANJ on 16 July 2026, and showing its live odds to people in France is treated as illegal gambling advertising. Not read, not paper-traded, never bet for a French resident.",
      sources: [{ label: "ANJ — blocking of the Polymarket website", url: "https://anj.fr/promotion-illegal-gambling-services-blocking-polymarket-website" }],
      verifiedAt: "2026-10-24",
    },
    {
      id: "kalshi",
      status: "unknown",
      summary: "No French authorisation known for event contracts on Kalshi: read and paper only until verified.",
      sources: [{ label: "ANJ — opérateurs agréés", url: "https://anj.fr/offre-de-jeu-et-marche/operateurs-agrees" }],
      verifiedAt: "2026-10-24",
    },
    {
      id: "us-domiciled-etf",
      status: "restricted",
      summary:
        "A US-domiciled ETF has no PRIIPs key information document, so EU brokers do not sell it to retail clients: use the UCITS equivalent (Irish or Luxembourg domicile).",
      sources: [{ label: "Regulation (EU) 1286/2014 (PRIIPs)", url: "https://eur-lex.europa.eu/eli/reg/2014/1286/oj" }],
      verifiedAt: "2026-10-24",
    },
    {
      id: "crypto-casp",
      status: "restricted",
      summary:
        "Crypto services to French residents require a MiCA CASP authorisation (the French PSAN transitional period ended on 1 July 2026): a venue absent from ESMA's register is not authorised.",
      sources: [
        {
          label: "ESMA interim MiCA register",
          url: "https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica",
        },
        {
          label: "AMF — PSAN / CASP",
          url: "https://www.amf-france.org/fr/espace-professionnels/fintech/mes-relations-avec-lamf/obtenir-un-enregistrement-un-agrement-psan",
        },
      ],
      verifiedAt: "2026-10-24",
    },
    {
      id: "pea",
      status: "allowed",
      summary:
        "PEA: shares of companies headquartered in the EU/EEA and subject to corporate tax, and funds/ETFs at least 75% invested in them; cash ceiling 150,000 € (PEA-PME: 225,000 € combined); withdrawals before 5 years close the plan except legal exceptions.",
      sources: [{ label: "service-public.fr — PEA", url: "https://www.service-public.fr/particuliers/vosdroits/F2385" }],
      verifiedAt: "2026-10-24",
    },
    {
      id: "foreign-accounts",
      status: "allowed",
      summary: "Accounts held abroad must be declared every year: form 3916 for a securities account (e.g. IBKR), 3916-bis for a crypto-asset account.",
      sources: [{ label: "service-public.gouv.fr — comptes à l'étranger", url: "https://www.service-public.gouv.fr/particuliers/actualites/A18891" }],
      verifiedAt: "2026-10-24",
    },
  ],
};

const US: JurisdictionRules = {
  code: "US",
  name: "United States",
  rules: [
    {
      id: "kalshi",
      status: "allowed",
      summary: "Kalshi is a CFTC-designated contract market; some states contest sports contracts.",
      sources: [{ label: "CFTC — designated contract markets", url: "https://www.cftc.gov/IndustryOversight/TradingOrganizations/DCMs/index.htm" }],
      verifiedAt: "2026-10-24",
    },
    {
      id: "polymarket",
      status: "unknown",
      summary: "Polymarket's US access depends on its regulated US entity and the user's state: verify before any live use.",
      sources: [{ label: "CFTC — designated contract markets", url: "https://www.cftc.gov/IndustryOversight/TradingOrganizations/DCMs/index.htm" }],
      verifiedAt: "2026-10-24",
    },
    {
      id: "us-domiciled-etf",
      status: "allowed",
      summary: "US-domiciled ETFs are the default; a UCITS fund is a PFIC for a US taxpayer — avoid.",
      sources: [{ label: "IRS — PFIC (Form 8621)", url: "https://www.irs.gov/forms-pubs/about-form-8621" }],
      verifiedAt: "2026-10-24",
    },
  ],
};

export const JURISDICTIONS: Record<string, JurisdictionRules> = { FR, US };

export function rulesFor(code: string): JurisdictionRules {
  return JURISDICTIONS[code.toUpperCase()] ?? { code: code.toUpperCase(), name: code.toUpperCase(), rules: [] };
}

/** The status of one rule; unknown when the jurisdiction or the rule is not described. */
export function ruleStatus(code: string, id: string): Status {
  return rulesFor(code).rules.find((r) => r.id === id)?.status ?? "unknown";
}

// --- Checks against public registers -------------------------------------------------

/** Known sinkhole answers for the ANJ's DNS blocking. */
const ANJ_SINKHOLE_HOSTS = ["offre-illegale.anj.fr"];

export interface DnsBlockCheck {
  host: string;
  blocked: boolean;
  detail: string;
}

/** Does this machine's resolver send `host` to a regulator's block page? Reported, never worked around. */
export async function checkDnsBlock(host: string): Promise<DnsBlockCheck> {
  try {
    const cnames = await resolveCname(host).catch(() => [] as string[]);
    if (cnames.some((c) => ANJ_SINKHOLE_HOSTS.some((s) => c.replace(/\.$/, "").endsWith(s)))) {
      return { host, blocked: true, detail: `resolves to ${cnames.join(", ")} — blocked by the ANJ` };
    }
    const sinkIps = (await Promise.all(ANJ_SINKHOLE_HOSTS.map((h) => lookup(h, { all: true }).catch(() => [])))).flat().map((a) => a.address);
    const ips = (await lookup(host, { all: true })).map((a) => a.address);
    if (sinkIps.length && ips.some((ip) => sinkIps.includes(ip))) return { host, blocked: true, detail: `resolves to the ANJ block page (${ips.join(", ")})` };
    return { host, blocked: false, detail: `resolves to ${ips.join(", ")}` };
  } catch (e) {
    return { host, blocked: false, detail: `does not resolve (${(e as Error).message})` };
  }
}

const ESMA_CASPS = "https://www.esma.europa.eu/sites/default/files/2024-12/CASPS.csv";
const ESMA_NCASP = "https://www.esma.europa.eu/sites/default/files/2024-12/NCASP.csv";

export interface CaspEntry {
  name: string;
  commercialName: string;
  homeState: string;
  authority: string;
  authorisedOn: string;
  passportedTo: string[];
  website: string;
}

export interface MicaCheck {
  venue: string;
  authorised: CaspEntry[];
  /** Entries in ESMA's register of non-compliant entities. */
  warnings: Array<{ name: string; authority: string; reason: string; decidedOn: string }>;
  url: string;
  fetchedAt: string;
}

/** The registers' rows, cached for a day (ESMA updates them weekly). */
async function esmaRegister(url: string): Promise<{ rows: Record<string, string>[]; fetchedAt: string }> {
  const r = await cachedJson(`esma:${url}`, TTL.fundamentals, async () => {
    const res = await fetchText(url, { accept: "text/csv,*/*" });
    if (!res.ok) throw new Error(`ESMA register unavailable (${res.status})`);
    const rows = parseCsvText(res.body, ",");
    const header = rows[0]!.map((h) => h.trim());
    return { rows: rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]))), fetchedAt: res.fetchedAt };
  });
  return r!;
}

/** Is a crypto venue (Binance, Kraken, Coinbase…) an authorised MiCA CASP able to serve `country`? */
export async function checkMica(venue: string, country = "FR"): Promise<MicaCheck> {
  const needle = venue.toLowerCase();
  const aliases = needle === "kraken" ? ["kraken", "payward"] : [needle];
  const hit = (r: Record<string, string>) =>
    aliases.some((a) => `${r.ae_lei_name ?? ""} ${r.ae_commercial_name ?? ""} ${r.ae_website ?? ""}`.toLowerCase().includes(a));
  const [casps, ncasp] = await Promise.all([esmaRegister(ESMA_CASPS), esmaRegister(ESMA_NCASP)]);
  const authorised = casps.rows
    .filter(hit)
    .map((r) => ({
      name: r.ae_lei_name ?? "",
      commercialName: r.ae_commercial_name ?? "",
      homeState: r.ae_homeMemberState ?? "",
      authority: r.ae_competentAuthority ?? "",
      authorisedOn: r.ac_authorisationNotificationDate ?? "",
      passportedTo: (r.ac_serviceCode_cou ?? "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean),
      website: r.ae_website ?? "",
    }))
    .filter((e) => e.homeState === country || e.passportedTo.includes(country) || e.passportedTo.length === 0);
  const warnings = ncasp.rows.filter(hit).map((r) => ({
    name: r.ae_lei_name || r.ae_commercial_name || "",
    authority: r.ae_competentAuthority ?? "",
    reason: r.ae_reason ?? "",
    decidedOn: r.ae_decision_date ?? "",
  }));
  return { venue, authorised, warnings, url: ESMA_CASPS, fetchedAt: casps.fetchedAt };
}

/** What a web search must confirm, rule by rule, because no register answers it. */
export function verifyChecklist(code: string): Array<{ rule: string; current: string; verifiedAt: string; query: string; sources: string[] }> {
  return rulesFor(code).rules.map((r) => ({
    rule: r.id,
    current: `${r.status}: ${r.summary}`,
    verifiedAt: r.verifiedAt,
    query: `${r.id.replace(/-/g, " ")} ${rulesFor(code).name} ${new Date().getUTCFullYear()} réglementation`,
    sources: r.sources.map((s) => s.url),
  }));
}
