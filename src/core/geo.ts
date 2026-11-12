// Who belongs to the European Union, the European Economic Area and the euro
// area — the one place ultrastock reads it from. Membership changes (Croatia
// joined the euro in 2023, Bulgaria on 1 January 2026), so it is not written
// into the analyses: it is a researched fact of the "geo" domain
// (core/researched.ts), stored with its sources by the agent:
//
//   <home>/facts/geo/EU-<YYYY-MM-DD>.json   the membership as of that date
//
// No keyless, machine-readable official list was found to read live (Eurostat
// and the ECB publish aggregates such as EU27_2020 and the euro area series,
// not their member lists as data), so when nothing current is stored the
// readers fall back to ONE built-in list, dated and sourced below, and say so:
// every caller passes `membershipNote()` on to its output. A stale stored list
// (older than a year) is not used either — the built-in one is, with the note —
// nor one verified before the built-in list's own date: the newer of the two
// wins, and the note says the stored one was set aside as older.
//
// The English names are how TradingView's scanner writes a company's country
// (protocol data, not a fact that changes): they also give the order the
// lists are written in, so requests already recorded stay byte for byte.
import { clockNow } from "./net.js";
import { defineDomain, type FactSpec, factsSetCommand, factsTemplateCommand, type LatestFacts, loadLatestFacts, researchCommand } from "./researched.js";

const SOURCES = {
  eu: "https://european-union.europa.eu/principles-countries-history/eu-countries_en",
  eea: "https://www.efta.int/eea/eea-agreement",
  euro: "https://european-union.europa.eu/institutions-law-budget/euro/countries-using-euro_en",
} as const;

const KEYS: readonly FactSpec[] = [
  {
    key: "eu.members",
    label: "member states of the European Union (ISO 3166 alpha-2)",
    type: "codes",
    unit: "ISO 3166 alpha-2 codes",
    query: "EU member states list {period}",
    prefer: "european-union.europa.eu (the EU's own list of countries)",
    maxAgeDays: 365,
  },
  {
    key: "eea.nonEuMembers",
    label: "EEA states outside the EU (ISO 3166 alpha-2)",
    type: "codes",
    unit: "ISO 3166 alpha-2 codes",
    query: "EEA EFTA states party to the EEA agreement {period}",
    prefer: "efta.int (the EEA agreement's own page)",
    maxAgeDays: 365,
  },
  {
    key: "euroArea.members",
    label: "member states whose currency is the euro — the euro area (ISO 3166 alpha-2)",
    type: "codes",
    unit: "ISO 3166 alpha-2 codes",
    query: "countries using the euro euro area members {period}",
    prefer: "european-union.europa.eu or ecb.europa.eu",
    maxAgeDays: 365,
  },
];

/** The geo domain: one file per date, for the area code EU. */
export const GEO = defineDomain({
  name: "geo",
  period: "date",
  keysFor: (c) => (c === "EU" ? KEYS : []),
  strict: (c) => c === "EU",
  templateCommand: () => factsTemplateCommand("geo", "EU"),
  setCommand: factsSetCommand("geo"),
  about: (_c, date) =>
    `TEMPLATE to fill by research: the EU, EEA and euro-area membership as of ${date}. Each value is a list of ISO 3166 alpha-2 codes read from the official page named in "prefer", with its URL in "sources".`,
});

/** TradingView's English country names (protocol data): every European state, members or not. */
const NAMES: Readonly<Record<string, string>> = {
  AT: "Austria",
  BE: "Belgium",
  BG: "Bulgaria",
  HR: "Croatia",
  CY: "Cyprus",
  CZ: "Czech Republic",
  DK: "Denmark",
  EE: "Estonia",
  FI: "Finland",
  FR: "France",
  DE: "Germany",
  GR: "Greece",
  HU: "Hungary",
  IE: "Ireland",
  IT: "Italy",
  LV: "Latvia",
  LT: "Lithuania",
  LU: "Luxembourg",
  MT: "Malta",
  NL: "Netherlands",
  PL: "Poland",
  PT: "Portugal",
  RO: "Romania",
  SK: "Slovakia",
  SI: "Slovenia",
  ES: "Spain",
  SE: "Sweden",
  IS: "Iceland",
  LI: "Liechtenstein",
  NO: "Norway",
  GB: "United Kingdom",
  CH: "Switzerland",
  AL: "Albania",
  BA: "Bosnia and Herzegovina",
  ME: "Montenegro",
  MK: "North Macedonia",
  RS: "Serbia",
  MD: "Moldova",
  UA: "Ukraine",
  GE: "Georgia",
  TR: "Turkey",
};

/** The built-in fallback: read on the pages below, valid as of its date. */
export const BUILT_IN_MEMBERSHIP = {
  asOf: "2026-01-01",
  eu: [
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
  ],
  eeaNonEu: ["IS", "LI", "NO"],
  euroArea: ["AT", "BE", "BG", "HR", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"],
  sources: [SOURCES.eu, SOURCES.eea, SOURCES.euro],
} as const;

export interface Membership {
  /** ISO 3166 alpha-2 codes. */
  codes: readonly string[];
  /** "researched": a current stored fact; "built-in": the dated fallback above. */
  origin: "researched" | "built-in";
  asOf: string;
  sources: readonly string[];
  /** The built-in list is used although a list is stored: the stored one's verification date, older than the built-in's. */
  olderStored?: string;
}

const byName = (a: string, b: string) => {
  const [x, y] = [NAMES[a] ?? a, NAMES[b] ?? b];
  return x < y ? -1 : x > y ? 1 : 0;
};

function read(key: "eu.members" | "eea.nonEuMembers" | "euroArea.members", fallback: readonly string[]): Membership {
  let stored: LatestFacts | undefined;
  try {
    stored = loadLatestFacts(GEO, "EU", { upTo: clockNow().toISOString().slice(0, 10) });
  } catch {
    stored = undefined; // an invalid file is reported by `facts research geo`, never used
  }
  const f = stored?.current[key];
  // The newer of the two lists: one researched before the built-in list's date does not undo a change it records.
  if (f && f.verifiedAt >= BUILT_IN_MEMBERSHIP.asOf)
    return { codes: [...(f.value as string[])].sort(byName), origin: "researched", asOf: f.verifiedAt, sources: f.sources };
  return {
    codes: [...fallback].sort(byName),
    origin: "built-in",
    asOf: BUILT_IN_MEMBERSHIP.asOf,
    sources: BUILT_IN_MEMBERSHIP.sources,
    ...(f ? { olderStored: f.verifiedAt } : {}),
  };
}

/** EU member states, in the order of their English names. */
export const euMembers = (): Membership => read("eu.members", BUILT_IN_MEMBERSHIP.eu);

/** EU and EEA member states — the EU first, then the EEA states outside it, each in the order of their English names. */
export function euEeaMembers(): Membership {
  const eu = euMembers();
  const rest = read("eea.nonEuMembers", BUILT_IN_MEMBERSHIP.eeaNonEu);
  return {
    codes: [...eu.codes, ...rest.codes.filter((c) => !eu.codes.includes(c))],
    origin: eu.origin === "researched" && rest.origin === "researched" ? "researched" : "built-in",
    asOf: [eu.asOf, rest.asOf].sort()[0]!,
    sources: [...new Set([...eu.sources, ...rest.sources])],
    ...(eu.olderStored || rest.olderStored ? { olderStored: [eu.olderStored, rest.olderStored].filter((x): x is string => !!x).sort()[0] } : {}),
  };
}

/** The euro area: the member states whose currency is the euro (an ECB decision moves them all), in the order of their codes. */
export const euroAreaMembers = (): Membership => {
  const m = read("euroArea.members", BUILT_IN_MEMBERSHIP.euroArea);
  return { ...m, codes: [...m.codes].sort() };
};

/** Europe as an investor means it: the EU / EEA, the United Kingdom and Switzerland, in alphabetical order of the codes. */
export const europeCountries = (): Membership => {
  const m = euEeaMembers();
  return { ...m, codes: [...new Set([...m.codes, "GB", "CH"])].sort() };
};

export const isEuEea = (iso: string | undefined): boolean => !!iso && euEeaMembers().codes.includes(iso.toUpperCase());

/** How TradingView's scanner writes a country, when ultrastock knows it. */
export const tradingViewCountry = (iso: string): string | undefined => NAMES[iso.toUpperCase()];

/** What an output using `m` must say: nothing when it is a current researched list, the fallback's date and sources otherwise. */
export function membershipNote(m: Membership, what = "EU / EEA membership"): string | undefined {
  if (m.origin === "researched") return undefined;
  const setAside = m.olderStored ? ` (the stored list, verified ${m.olderStored}, is older and set aside)` : "";
  return `${what}: ultrastock's built-in list as of ${m.asOf}${setAside} (${m.sources.join(", ")}), not a current research — run \`${researchCommand("geo", "EU")}\` and store the result to read a current one`;
}
