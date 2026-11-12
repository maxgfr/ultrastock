// The researched-facts domains, in one registry: what `facts research|template|
// set|show <domain>` (and the MCP `facts` tool) accept, and for each, what its
// country is and which period a command means when none is given.
//
//   tax            a country's tax rules for a tax year (tax/rules.ts)
//   jurisdiction   what the investor's country allows (core/jurisdiction.ts)
//   funds          what a fund DOMICILE means for withholding (core/fund-facts.ts)
//   venues         venue and broker fees for the investor's residence (trading/venue-facts.ts)
//   geo            EU, EEA and euro-area membership, filed under EU (core/geo.ts)
//   calendar       exchange hours and one-off closures, per exchange country and year (core/calendar.ts)
//
// A domain module declares its keys (core/researched.ts's defineDomain); a
// domain missing here cannot be researched or stored from the command line,
// so every new one is added below (tests/facts-domains.test.ts checks each).
import { TAX } from "../tax/rules.js";
import { VENUES } from "../trading/venue-facts.js";
import { CALENDAR, MARKET_COUNTRY } from "./calendar.js";
import { FUNDS } from "./fund-facts.js";
import { GEO } from "./geo.js";
import { JURISDICTION } from "./jurisdiction.js";
import { clockNow } from "./net.js";
import type { Profile } from "./profile.js";
import { countryCode, type Domain } from "./researched.js";
import { UsageError } from "../engine.js";

export interface FactDomain {
  domain: Domain;
  /** What the country of a file is, in words: named when --country is missing or not one the domain keeps. */
  country: string;
  /** The only countries the domain keeps facts for (undefined: any ISO 3166 alpha-2 code). */
  countries?: readonly string[];
  /** The country used without --country, from the profile (or fixed); undefined when --country is required. */
  defaultCountry?(p: Profile | undefined): string | undefined;
  /** A `year` domain: the year used without --year, and the latest year accepted. */
  years?: { default(now: Date): number; latest(now: Date): number };
}

const lastYear = (now: Date) => now.getUTCFullYear() - 1;
const thisYear = (now: Date) => now.getUTCFullYear();

export const FACT_DOMAINS: Readonly<Record<string, FactDomain>> = Object.freeze({
  tax: {
    domain: TAX,
    country: "the tax residence",
    defaultCountry: (p) => p?.taxResidence,
    years: { default: lastYear, latest: thisYear },
  },
  jurisdiction: { domain: JURISDICTION, country: "the country of residence", defaultCountry: (p) => p?.jurisdiction },
  funds: { domain: FUNDS, country: "a fund domicile (IE, LU, US…), not the investor's country" },
  venues: {
    domain: VENUES,
    country: "the country of residence (a venue's fees are the ones its entity charges there)",
    defaultCountry: (p) => p?.jurisdiction,
  },
  geo: { domain: GEO, country: "the area code EU", countries: ["EU"], defaultCountry: () => "EU" },
  calendar: {
    domain: CALENDAR,
    country: `an exchange's country (${Object.entries(MARKET_COUNTRY)
      .map(([m, c]) => `${c} for ${m}`)
      .join(", ")})`,
    countries: [...new Set(Object.values(MARKET_COUNTRY))],
    years: { default: thisYear, latest: (now) => thisYear(now) + 1 },
  },
});

export const FACT_DOMAIN_NAMES: readonly string[] = Object.keys(FACT_DOMAINS);

/** A registered domain by name; a usage error listing them otherwise. */
export function factDomain(name: string | undefined, usage = ""): FactDomain {
  const d = name ? FACT_DOMAINS[name] : undefined;
  if (!d)
    throw new UsageError(`${name ? `"${name}" is not a facts domain` : "which domain?"} — one of ${FACT_DOMAIN_NAMES.join(", ")}.${usage ? ` ${usage}` : ""}`);
  return d;
}

/** The country a command's facts are for: `given` (--country), else the domain's default; a usage error naming what it is. */
export function factsCountry(fd: FactDomain, given: string | undefined, profile: () => Profile | undefined): string {
  const name = fd.domain.name;
  const raw = given ?? fd.defaultCountry?.(profile());
  if (!raw)
    throw new UsageError(
      `${name} facts are kept per ${fd.country}: pass --country CC${fd.defaultCountry ? " (or run `ultrastock profile init --jurisdiction <CC>`)" : ""}`,
    );
  const c = countryCode(raw);
  if (fd.countries && !fd.countries.includes(c))
    throw new UsageError(`${name} facts are kept for ${fd.country}: --country ${fd.countries.join(" or ")}, not ${c}`);
  return c;
}

/** The period a command's facts are for: a `year` domain's --year (or its default), else today's date. */
export function factsPeriod(fd: FactDomain, year: string | undefined, now = clockNow()): number | string {
  const name = fd.domain.name;
  if (fd.domain.period === "date") {
    if (year) throw new UsageError(`${name} facts are dated by the day they were researched: --year does not apply`);
    return now.toISOString().slice(0, 10);
  }
  const span = fd.years ?? { default: lastYear, latest: thisYear };
  const y = year === undefined ? span.default(now) : Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > span.latest(now))
    throw new UsageError(`--year ${year} is not a year ${name} facts are kept for (2000–${span.latest(now)})`);
  return y;
}
