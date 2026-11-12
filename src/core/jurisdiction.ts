// What the investor's country allows — researched, never built in.
//
// Whether Polymarket or Kalshi may be used, whether a retail investor may buy a
// US-domiciled ETF, which register says a crypto platform may serve the
// country: these rules differ by country and change (a regulator blocks a
// site, a transitional period ends). ultrastock holds none of them. The agent
// researches each one on official sources (`facts research jurisdiction`
// gathers the documents), concludes, and stores the conclusion with its
// sources in the researched-facts store (core/researched.ts) as the
// "jurisdiction" domain: <home>/facts/jurisdiction/<CC>-<date>.json. This
// module declares the keys and reads the stored conclusions.
//
// Fail-closed: a rule that was never researched, is past its age limit, or was
// concluded "unknown" reads as unknown — readable and paper-tradable at most,
// never live-tradable; for Polymarket, not even read. Every refusal names the
// research command to run.
//
// What it still checks on public registers: ESMA's MiCA interim register (its
// CSV links discovered on ESMA's page) when the researched register for the
// country is ESMA's, and a regulator's DNS block page (detection only).
import { lookup, resolveCname } from "node:dns/promises";
import { cachedJson, TTL } from "./cache.js";
import { parseCsvText } from "./csv.js";
import { clockNow, fetchText } from "./net.js";
import { countryCode, defineDomain, type FactSpec, loadLatestFacts, type LatestFacts, researchCommand, specsFor } from "./researched.js";

export type Status = "allowed" | "blocked" | "restricted" | "unknown";
export const STATUSES: readonly Status[] = ["allowed", "restricted", "blocked", "unknown"];

export interface Rule {
  id: string;
  status: Status;
  summary: string;
  sources: Array<{ label: string; url: string }>;
  verifiedAt: string;
  /** False when no current researched fact backs the status (it is then "unknown"). */
  researched: boolean;
}

export interface JurisdictionRules {
  code: string;
  name: string;
  rules: Rule[];
}

/** The registers a country's crypto-platform authorisation can be read from: ESMA's is the one ultrastock reads itself. */
export const CRYPTO_REGISTERS = ["esma-mica", "other", "none"] as const;
export type CryptoRegister = (typeof CRYPTO_REGISTERS)[number];

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return undefined;
  }
})();

/** The country's English name, for search queries ("France" for FR); the code when the runtime has no names. */
export function countryName(code: string): string {
  const c = code.toUpperCase();
  try {
    return regionNames?.of(c) ?? c;
  } catch {
    return c;
  }
}

const STATUS_NOTE =
  'allowed: residents may use it; restricted: only under conditions (a local regulated entity, some products only) — say which in "note"; blocked: barred or blocked by a regulator; unknown: the sources do not settle it.';

const status = (key: string, label: string, query: string, prefer: string, maxAgeDays: number, note: string): FactSpec => ({
  key,
  label,
  type: "text",
  unit: "allowed | restricted | blocked | unknown",
  values: STATUSES,
  query,
  prefer,
  maxAgeDays,
  note,
});

/** The keys to research for a country. The queries are starting points for the search; the law is in the sources. */
export function jurisdictionKeys(country: string): FactSpec[] {
  const c = country.toUpperCase();
  const n = countryName(c);
  const y = clockNow().getUTCFullYear();
  const keys: FactSpec[] = [
    status(
      "polymarket",
      `Polymarket access for residents of ${n}`,
      `Polymarket ${n} legal ban regulator ${y}`,
      "the national gambling or financial regulator (its decisions, blocked-site or authorised-operator lists)",
      90,
      `${STATUS_NOTE} A Polymarket that is not "allowed" is not read, not paper-traded and never bet.`,
    ),
    status(
      "kalshi",
      `Kalshi event contracts for residents of ${n}`,
      `Kalshi ${n} residents event contracts legal ${y}`,
      "the national gambling or derivatives regulator, and Kalshi's own list of supported countries",
      90,
      `${STATUS_NOTE} Live Kalshi orders need "allowed"; anything else is paper only.`,
    ),
    status(
      "us-domiciled-etf",
      `Retail access to US-domiciled ETFs for residents of ${n}`,
      `${n} retail investors US-domiciled ETF access key information document PRIIPs ${y}`,
      "the financial regulator or the law on retail investment products (for the EU/EEA, Regulation (EU) 1286/2014 on eur-lex.europa.eu)",
      180,
      `${STATUS_NOTE} A US-domiciled ETF is proposed and passes the risk gate only when this is "allowed".`,
    ),
    status(
      "crypto-casp",
      `Authorisation crypto-asset platforms need to serve residents of ${n}`,
      `${n} crypto-asset service provider authorisation register regulator ${y}`,
      "the financial regulator (EU/EEA: MiCA and ESMA's register; UK: the FCA; Switzerland: FINMA; elsewhere the national regulator)",
      180,
      'allowed: no authorisation is needed; restricted: only authorised platforms may serve residents (say in crypto-register which register lists them); blocked: crypto-asset services are banned; unknown: the sources do not settle it. Live crypto orders need "allowed", or "restricted" with the venue found on the register.',
    ),
    {
      key: "crypto-register",
      label: `The register of authorised crypto-asset platforms for residents of ${n}`,
      type: "text",
      unit: "esma-mica | other | none",
      values: CRYPTO_REGISTERS,
      query: `${n} official register authorised crypto-asset service providers`,
      prefer: "the regulator that keeps the register",
      maxAgeDays: 180,
      note: 'esma-mica: ESMA\'s MiCA interim register (EU/EEA) — ultrastock reads it before each live crypto order; other: another register (FCA, FINMA, a state regulator…) — name it and its URL in "note"; ultrastock cannot read it, so each venue needs its own fact cryptoVenue.<venue> ("allowed" once found on that register); none: no register applies.',
    },
    status(
      "foreign-accounts",
      `Duty to report accounts held abroad (broker, crypto platform) for residents of ${n}`,
      `${n} declare foreign bank securities crypto account tax authority form ${y}`,
      "the tax authority",
      180,
      'allowed: no reporting duty; restricted: a duty applies — name the form(s) and thresholds in "note"; blocked: residents may not hold such accounts; unknown: the sources do not settle it.',
    ),
  ];
  if (c === "US")
    keys.push(
      status(
        "pfic",
        "Tax treatment of non-US funds (UCITS ETFs) held by a US person (PFIC)",
        `PFIC non-US ETF UCITS US person Form 8621 IRS ${y}`,
        "the IRS (irs.gov)",
        180,
        "allowed: non-US funds carry no special regime; restricted: they are PFICs (a punitive tax regime and Form 8621) — non-US funds are then not proposed; unknown: the sources do not settle it, and non-US funds are not proposed either.",
      ),
    );
  return keys;
}

const VENUE_KEY = /^cryptoVenue\.([a-z0-9]+)$/;
const VENUE_LEI_KEY = /^cryptoVenue\.([a-z0-9]+)\.lei$/;

/** The "jurisdiction" domain of the researched-facts store: one file per country and research date. */
export const JURISDICTION = defineDomain<FactSpec>({
  name: "jurisdiction",
  period: "date",
  keysFor: jurisdictionKeys,
  strict: () => true,
  extraKey: (key, country) => {
    const n = countryName(country);
    const v = VENUE_KEY.exec(key)?.[1];
    if (v)
      return status(
        key,
        `${v} authorised to offer crypto-asset services to residents of ${n}`,
        `${v} authorised crypto-asset service provider ${n} register`,
        "the register named in crypto-register",
        180,
        `${STATUS_NOTE} Read when crypto-register is "other": ultrastock cannot query that register itself.`,
      );
    const l = VENUE_LEI_KEY.exec(key)?.[1];
    if (l)
      return {
        key,
        label: `LEI of the ${l} entity that serves residents of ${n}`,
        type: "text",
        unit: "20-character LEI",
        query: `${l} legal entity identifier ${n} entity`,
        prefer: "GLEIF (search.gleif.org) or the register entry",
        maxAgeDays: 365,
        note: "When stored, ESMA's register is matched on this LEI rather than on the venue's name.",
      };
    return undefined;
  },
  templateCommand: (country) => `ultrastock facts template jurisdiction --country ${countryCode(country)}`,
  setCommand: "ultrastock facts set jurisdiction --file <file.json>",
  about: (c, date) =>
    `TEMPLATE to fill by research. ultrastock contains no jurisdiction rule: every value is the conclusion you drew from official sources for ${c} on ${date}. For each key fill "value" (one of its "values"), "note" (what the sources say, in a sentence), "sources" (at least one URL), "verifiedAt" and "confidence"; set "researchedAt"; then run \`ultrastock facts set jurisdiction --file <this file>\`. Leave out a key you could not settle, or store it "unknown": either way it fails closed. \`ultrastock facts research jurisdiction --country ${c} --out <run>\` gathers the documents to read.`,
});

export interface RuleReading {
  id: string;
  status: Status;
  /** What the research concluded, in words (the fact's note), or why the status is unknown. */
  note: string;
  sources: string[];
  verifiedAt?: string;
  /** Why no researched status applies: not researched, stale, unreadable. Absent when one does. */
  unresearched?: string;
  /** The command to (re-)research it. */
  research: string;
}

function latest(code: string): LatestFacts | Error {
  try {
    return loadLatestFacts(JURISDICTION, code);
  } catch (e) {
    return e as Error;
  }
}

/** A key's current researched value for a country, or why there is none. */
export function factReading(code: string, id: string): { value?: unknown; fact?: LatestFacts["facts"][string]; unresearched?: string; research: string } {
  const c = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return { unresearched: `"${code}" is not a country code`, research: researchCommand("jurisdiction", "CC", id) };
  const known = jurisdictionKeys(c).some((s) => s.key === id) || !!JURISDICTION.extraKey?.(id, c);
  const research = researchCommand("jurisdiction", c, known ? id : undefined);
  if (!known) return { unresearched: `no jurisdiction rule is kept for "${id}"`, research };
  const l = latest(c);
  if (l instanceof Error) return { unresearched: `the stored ${c} jurisdiction facts are unreadable (${l.message.split("\n")[0]})`, research };
  const f = l.facts[id];
  if (!f) return { unresearched: `not researched for ${c}`, research };
  const stale = l.stale.find((x) => x.key === id);
  if (stale) return { fact: f, unresearched: `the ${c} research is stale (${stale.reason})`, research };
  return { value: f.value, fact: f, research };
}

/** One rule as researched for a country: its status, what the sources said, or why it is unknown and how to research it. */
export function ruleFact(code: string, id: string): RuleReading {
  const r = factReading(code, id);
  const base = { id, sources: r.fact?.sources ?? [], ...(r.fact ? { verifiedAt: r.fact.verifiedAt } : {}), research: r.research };
  if (r.unresearched) return { ...base, status: "unknown", note: r.unresearched, unresearched: r.unresearched };
  const s = typeof r.value === "string" && (STATUSES as readonly string[]).includes(r.value) ? (r.value as Status) : "unknown";
  return { ...base, status: s, note: r.fact?.note ?? r.fact?.label ?? "" };
}

/** The status of one rule; unknown when it was not researched, is stale, or was concluded unknown. */
export function ruleStatus(code: string, id: string): Status {
  return ruleFact(code, id).status;
}

/** A refusal's tail: what the research says, or the command to research it. */
export function ruleWhy(r: RuleReading, code: string): string {
  if (r.unresearched) return `${r.unresearched} — research it: \`${r.research}\`, then \`${JURISDICTION.setCommand}\``;
  if (r.status === "unknown") return `the ${code.toUpperCase()} research concluded unknown (${r.note}) — research it again: \`${r.research}\``;
  return `${r.note}${r.verifiedAt ? ` (researched ${r.verifiedAt}${r.sources[0] ? `, ${r.sources[0]}` : ""})` : ""}`;
}

/** Every rule for a country, researched or not: a key with no current fact is listed as unknown with the command to research it. */
export function rulesFor(code: string): JurisdictionRules {
  const c = code.toUpperCase();
  const keys = /^[A-Z]{2}$/.test(c) ? jurisdictionKeys(c).map((s) => s.key) : [];
  const l = /^[A-Z]{2}$/.test(c) ? latest(c) : undefined;
  if (l && !(l instanceof Error)) for (const k of Object.keys(l.facts)) if (!keys.includes(k)) keys.push(k);
  return {
    code: c,
    name: countryName(c),
    rules: keys.map((id) => {
      const r = ruleFact(c, id);
      return {
        id,
        status: r.status,
        summary: r.unresearched ? `${r.unresearched} — \`${r.research}\`` : r.note,
        sources: r.sources.map((url) => ({ label: hostOf(url), url })),
        verifiedAt: r.verifiedAt ?? "",
        researched: !r.unresearched,
      };
    }),
  };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** What to (re-)research, rule by rule: the current reading, its search query and the sources to re-check. */
export function verifyChecklist(
  code: string,
): Array<{ rule: string; current: string; verifiedAt: string; query: string; sources: string[]; research: string }> {
  const c = countryCode(code);
  return specsFor(JURISDICTION, c).map((s) => {
    const r = ruleFact(c, s.key);
    return {
      rule: s.key,
      current: `${r.status}: ${r.unresearched ?? r.note}`,
      verifiedAt: r.verifiedAt ?? "",
      query: s.query,
      sources: r.sources,
      research: r.research,
    };
  });
}

// --- Crypto platforms: the researched regime, then the register ---------------------

export interface CryptoVenueGate {
  ok: boolean;
  /** Why not, or what allowed it. */
  reason: string;
  /** The register read, when one was. */
  mica?: MicaCheck;
}

/**
 * May a live order go to a crypto venue for a resident of `code`? The researched regime decides; when it says only
 * authorised platforms may serve the country, the register the research names is checked: ESMA's MiCA register is read
 * here; another register needs the venue's own researched fact. Anything unresearched refuses, naming the command.
 */
export async function cryptoVenueGate(venue: string, code: string, opts: { micaAuthorised?: boolean } = {}): Promise<CryptoVenueGate> {
  const c = code.toUpperCase();
  const casp = ruleFact(c, "crypto-casp");
  if (casp.status === "blocked") return { ok: false, reason: `crypto-asset services are blocked for residents of ${c}: ${ruleWhy(casp, c)}` };
  if (casp.status === "unknown") return { ok: false, reason: `the authorisation crypto platforms need in ${c} is unknown: ${ruleWhy(casp, c)}` };
  if (casp.status === "allowed") return { ok: true, reason: `no authorisation is needed in ${c}: ${ruleWhy(casp, c)}` };
  // crypto-register names a register, not a status: its raw value is read.
  const reg = ruleFact(c, "crypto-register");
  const raw = factReading(c, "crypto-register").value;
  if (reg.unresearched || typeof raw !== "string")
    return { ok: false, reason: `which register lists the platforms authorised in ${c} is not known: ${ruleWhy(reg, c)}` };
  if (raw === "esma-mica") {
    if (opts.micaAuthorised !== undefined)
      return {
        ok: opts.micaAuthorised,
        reason: opts.micaAuthorised ? "authorised (test answer)" : `${venue} is not in ESMA's MiCA register for ${c} (test answer)`,
      };
    const leiValue = factReading(c, `cryptoVenue.${venue}.lei`).value;
    const lei = typeof leiValue === "string" ? leiValue : undefined;
    try {
      const m = await checkMica(venue, c, lei ? { lei } : {});
      if (m.authorised.length)
        return { ok: true, reason: `${venue} is in ESMA's MiCA register for ${c} (${m.authorised[0]!.name}, ${m.authorised[0]!.homeState})`, mica: m };
      return {
        ok: false,
        reason: `${venue} is not an authorised MiCA crypto-asset service provider for ${c} in ESMA's register${m.notes.length ? ` (${m.notes.join("; ")})` : ""}: no live orders there`,
        mica: m,
      };
    } catch (e) {
      return { ok: false, reason: `ESMA's MiCA register could not be read (${(e as Error).message.split("\n")[0]}): no live crypto orders until it can` };
    }
  }
  if (raw === "none")
    return {
      ok: false,
      reason: `the ${c} research says authorisation is needed (crypto-casp restricted) but no register applies (crypto-register none): settle it — \`${researchCommand("jurisdiction", c, "crypto-casp")}\``,
    };
  const v = ruleFact(c, `cryptoVenue.${venue}`);
  if (v.status === "allowed") return { ok: true, reason: `${venue} is authorised for ${c} per the research: ${ruleWhy(v, c)}` };
  return {
    ok: false,
    reason: `${c}'s register is one ultrastock cannot read (${ruleWhy(reg, c)}); ${venue} for ${c} is ${v.status}: ${ruleWhy(v, c)}`,
  };
}

// --- Checks against public registers -------------------------------------------------

/**
 * Detection hints, not rules: the host a regulator's DNS block points a blocked site to, so `doctor` and `jurisdiction
 * verify` can say "this machine's resolver sends Polymarket to a block page". Whether Polymarket may be used is the
 * researched `polymarket` fact, never this list — a hint missing here only means a block goes unreported, and the gate
 * still refuses on the fact. Source: ANJ, "blocking of the Polymarket website" (anj.fr), whose block page this is.
 */
const SINKHOLE_HINTS: Array<{ host: string; by: string }> = [{ host: "offre-illegale.anj.fr", by: "the ANJ (France)" }];

export interface DnsBlockCheck {
  host: string;
  blocked: boolean;
  detail: string;
}

/** Does this machine's resolver send `host` to a regulator's block page? Reported, never worked around. */
export async function checkDnsBlock(host: string): Promise<DnsBlockCheck> {
  try {
    const cnames = await resolveCname(host).catch(() => [] as string[]);
    const hint = SINKHOLE_HINTS.find((s) => cnames.some((c) => c.replace(/\.$/, "").endsWith(s.host)));
    if (hint) return { host, blocked: true, detail: `resolves to ${cnames.join(", ")} — the block page of ${hint.by}` };
    const sinks = (
      await Promise.all(SINKHOLE_HINTS.map(async (s) => (await lookup(s.host, { all: true }).catch(() => [])).map((a) => ({ ip: a.address, by: s.by }))))
    ).flat();
    const ips = (await lookup(host, { all: true })).map((a) => a.address);
    const sink = sinks.find((s) => ips.includes(s.ip));
    if (sink) return { host, blocked: true, detail: `resolves to the block page of ${sink.by} (${ips.join(", ")})` };
    return { host, blocked: false, detail: `resolves to ${ips.join(", ")}` };
  } catch (e) {
    return { host, blocked: false, detail: `does not resolve (${(e as Error).message})` };
  }
}

/** ESMA's page that links the interim MiCA register's CSV files. */
export const ESMA_MICA_PAGE = "https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica";
/** The last-resort copies, at the dated path they were first published under: used only when the page lists none, and said so. */
const ESMA_FALLBACK = {
  casps: "https://www.esma.europa.eu/sites/default/files/2024-12/CASPS.csv",
  ncasp: "https://www.esma.europa.eu/sites/default/files/2024-12/NCASP.csv",
};

export interface CaspEntry {
  name: string;
  lei: string;
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
  warnings: Array<{ name: string; lei: string; authority: string; reason: string; decidedOn: string }>;
  url: string;
  fetchedAt: string;
  /** How the register was found and matched: a fallback copy, name matches set aside. */
  notes: string[];
}

/** The CSV links ESMA's page carries, newest dated folder first; undefined when the page lists none. */
export function esmaRegisterLinks(html: string, base = ESMA_MICA_PAGE): { casps: string; ncasp: string } | undefined {
  const links = [...html.matchAll(/href\s*=\s*["']([^"']+\.csv(?:\?[^"']*)?)["']/gi)].map((m) => {
    try {
      return new URL(m[1]!.replace(/&amp;/g, "&"), base).toString();
    } catch {
      return "";
    }
  });
  const dated = (u: string) => /\/(\d{4})-(\d{2})\//.exec(u)?.slice(1).join("") ?? "";
  const pick = (name: RegExp) => links.filter((u) => name.test(u.split("?")[0]!.split("/").pop() ?? "")).sort((a, b) => dated(b).localeCompare(dated(a)))[0];
  const casps = pick(/^CASPS?\.csv$/i);
  const ncasp = pick(/^NCASPS?\.csv$/i);
  return casps && ncasp ? { casps, ncasp } : undefined;
}

/** Where the register's CSV files are now: from ESMA's page, else the dated fallback (reported). Cached for a day. */
async function esmaLinks(): Promise<{ casps: string; ncasp: string; note?: string }> {
  let why = "";
  try {
    const found = await cachedJson("esma:mica-links", TTL.fundamentals, async () => {
      const res = await fetchText(ESMA_MICA_PAGE, { accept: "text/html,*/*" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const l = esmaRegisterLinks(res.body, res.url || ESMA_MICA_PAGE);
      if (!l) throw new Error("the page lists no CASPS.csv / NCASP.csv link");
      return l;
    });
    if (found) return found;
  } catch (e) {
    why = (e as Error).message.split("\n")[0]!.slice(0, 120);
  }
  return {
    ...ESMA_FALLBACK,
    note: `ESMA's MiCA page did not give the register's current links (${why || "no answer"}): read the copy at its first dated path ${ESMA_FALLBACK.casps}, which may be out of date`,
  };
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

/** Names a venue is registered under besides its own (Kraken's EU entity is Payward). Matching hints, not rules. */
const VENUE_ALIASES: Record<string, string[]> = { kraken: ["kraken", "payward"] };

/**
 * Is a crypto venue (Binance, Kraken, Coinbase…) an authorised MiCA CASP able to serve `country`? An entry serves its
 * home state, and the states it notified a passport for — an entry with no passport list serves its home state only.
 * With the venue's LEI, the register is matched on it; without, on the name, then on the LEIs of the entries it found.
 */
export async function checkMica(venue: string, country = "FR", opts: { lei?: string } = {}): Promise<MicaCheck> {
  const c = country.toUpperCase();
  const needle = venue.toLowerCase();
  const aliases = VENUE_ALIASES[needle] ?? [needle];
  const lei = opts.lei?.trim().toUpperCase();
  const named = (r: Record<string, string>) =>
    aliases.some((a) => `${r.ae_lei_name ?? ""} ${r.ae_commercial_name ?? ""} ${r.ae_website ?? ""}`.toLowerCase().includes(a));
  const notes: string[] = [];
  const links = await esmaLinks();
  if (links.note) notes.push(links.note);
  const [casps, ncasp] = await Promise.all([esmaRegister(links.casps), esmaRegister(links.ncasp)]);
  const leiOf = (r: Record<string, string>) => (r.ae_lei ?? "").trim().toUpperCase();
  let hit: (r: Record<string, string>) => boolean;
  if (lei) {
    hit = (r) => leiOf(r) === lei || (!leiOf(r) && named(r));
    const others = [...new Set(casps.rows.filter((r) => named(r) && leiOf(r) && leiOf(r) !== lei).map(leiOf))];
    if (others.length) notes.push(`entries named like ${venue} under another LEI (${others.join(", ")}) are not counted: matched on LEI ${lei}`);
  } else {
    const leis = new Set(casps.rows.filter(named).map(leiOf).filter(Boolean));
    hit = (r) => named(r) || (!!leiOf(r) && leis.has(leiOf(r)));
  }
  const authorised = casps.rows
    .filter(hit)
    .map((r) => ({
      name: r.ae_lei_name ?? "",
      lei: leiOf(r),
      commercialName: r.ae_commercial_name ?? "",
      homeState: (r.ae_homeMemberState ?? "").toUpperCase(),
      authority: r.ae_competentAuthority ?? "",
      authorisedOn: r.ac_authorisationNotificationDate ?? "",
      passportedTo: (r.ac_serviceCode_cou ?? "")
        .split("|")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      website: r.ae_website ?? "",
    }))
    .filter((e) => e.homeState === c || e.passportedTo.includes(c));
  const warnings = ncasp.rows.filter(hit).map((r) => ({
    name: r.ae_lei_name || r.ae_commercial_name || "",
    lei: leiOf(r),
    authority: r.ae_competentAuthority ?? "",
    reason: r.ae_reason ?? "",
    decidedOn: r.ae_decision_date ?? "",
  }));
  return { venue, authorised, warnings, url: links.casps, fetchedAt: casps.fetchedAt, notes };
}
