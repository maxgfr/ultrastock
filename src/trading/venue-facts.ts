// The `venues` domain of the researched-facts store (core/researched.ts): what a
// venue charges, as the agent read it on the venue's own fee page. ultrastock
// holds no fee schedule: paper fills, backtests and the Kalshi readings take
// their fees from here (or from the user's own ledger, trading/fees.ts), and
// say plainly when there is none.
//
// What a venue publishes through its API is read live instead, never stored
// here: tick and lot rules (trading/brokers/rules.ts), Kalshi's per-series
// `fee_type` and `fee_multiplier` (providers/prediction/kalshi.ts).
//
// A file holds the facts for the user's country of residence (the entity that
// serves an account, and so its schedule, depends on it) as researched on a
// date: <home>/facts/venues/<CC>-<YYYY-MM-DD>.json. The latest file dated on or
// before today is the one read. Keys:
//
//   <venue>.fees      rates {maker, taker}: share of the notional per side, the venue's entry (lowest-volume) tier
//   ibkr.perUnit      amount: per share, in the instrument's currency
//   ibkr.minimum      amount: minimum per order, in the instrument's currency
//   kalshi.feeFormula text: the fee formula as the schedule writes it — the engine computes only KALSHI_QUADRATIC
//   kalshi.fees       rates {taker, maker}: the coefficients of that formula
//   account.<id>.fees|perUnit|minimum   free keys: the broker behind one of the user's accounts
//
// Every fee key is read as unknown 365 days after it was verified.
import { UsageError } from "../engine.js";
import { clockNow } from "../core/net.js";
import { loadProfile } from "../core/profile.js";
import {
  countryCode,
  defineDomain,
  type Fact,
  type FactSpec,
  factsTemplate,
  loadFacts,
  saveFacts,
  storedPeriods,
  type ValidatedFacts,
} from "../core/researched.js";

/** The one Kalshi fee formula the engine computes: anything else researched is refused, not guessed. */
export const KALSHI_QUADRATIC = "ceil_to_cent(coefficient × fee_multiplier × contracts × price × (1 − price))";

const FEE_MAX_AGE_DAYS = 365;

const feeSpec = (venue: string, what: string, query: string, prefer: string): FactSpec => ({
  key: `${venue}.fees`,
  label: `${what}: maker and taker fee, entry tier`,
  type: "rates",
  fields: ["maker", "taker"],
  unit: "fraction of the notional per side (0.001 = 0.1 %)",
  query,
  prefer,
  maxAgeDays: FEE_MAX_AGE_DAYS,
  note: "the lowest-volume tier, without a token discount; a percentage of the notional is the whole schedule ultrastock applies to this venue",
});

export const VENUE_SPEC: readonly FactSpec[] = [
  feeSpec("binance.spot", "Binance spot", "Binance spot trading fee rate regular user {country}", "binance.com/en/fee/schedule"),
  feeSpec("binance.usdm", "Binance USDⓈ-M perpetual futures", "Binance USDⓈ-M futures trading fee regular user", "binance.com/en/fee/futureFee"),
  feeSpec("kraken.spot", "Kraken spot (Kraken Pro)", "Kraken Pro spot fee schedule lowest tier {country}", "kraken.com/features/fee-schedule"),
  feeSpec("coinbase.spot", "Coinbase Advanced Trade spot", "Coinbase Advanced Trade fee tiers lowest tier {country}", "help.coinbase.com Advanced Trade fees"),
  feeSpec(
    "ibkr",
    "Interactive Brokers stocks and ETFs (IBKR Pro, fixed)",
    "Interactive Brokers fixed commissions stocks {country}",
    "interactivebrokers.com commissions-stocks page",
  ),
  {
    key: "ibkr.perUnit",
    label: "Interactive Brokers stocks and ETFs: commission per share",
    type: "amount",
    unit: "instrument currency per share (0 where the schedule is a percentage)",
    query: "Interactive Brokers fixed commission per share {country}",
    prefer: "interactivebrokers.com commissions-stocks page",
    maxAgeDays: FEE_MAX_AGE_DAYS,
  },
  {
    key: "ibkr.minimum",
    label: "Interactive Brokers stocks and ETFs: minimum commission per order",
    type: "amount",
    unit: "instrument currency per order",
    query: "Interactive Brokers fixed commission minimum per order {country}",
    prefer: "interactivebrokers.com commissions-stocks page",
    maxAgeDays: FEE_MAX_AGE_DAYS,
  },
  {
    key: "kalshi.feeFormula",
    label: "Kalshi trading fee formula",
    type: "text",
    unit: "the formula, as ultrastock writes it",
    query: "Kalshi fee schedule trading fee formula",
    prefer: "kalshi.com/docs/kalshi-fee-schedule.pdf",
    maxAgeDays: FEE_MAX_AGE_DAYS,
    note: `write exactly "${KALSHI_QUADRATIC}" when the schedule's formula is that one (rounded up to the next cent); anything else is stored, and ultrastock then refuses to compute a Kalshi fee it does not know`,
  },
  {
    key: "kalshi.fees",
    label: "Kalshi fee coefficients (taker, maker) of that formula",
    type: "rates",
    fields: ["taker", "maker"],
    unit: "coefficient of contracts × price × (1 − price)",
    query: "Kalshi fee schedule taker maker coefficient",
    prefer: "kalshi.com/docs/kalshi-fee-schedule.pdf",
    maxAgeDays: FEE_MAX_AGE_DAYS,
    note: "the per-series fee_multiplier is read live from Kalshi's series API: do not fold it in here",
  },
];

export const templateCommand = (country: string) => `ultrastock facts template venues --country ${countryCode(country)}`;
export const RESEARCH_COMMAND = "ultrastock facts research venues";

/** The venues domain. Not strict: the broker behind an account (`account.<id>.fees`…) is free research. */
export const VENUES = defineDomain<FactSpec>({
  name: "venues",
  period: "date",
  keysFor: () => VENUE_SPEC,
  strict: () => false,
  templateCommand: (c) => templateCommand(c),
  setCommand: "ultrastock facts set venues --file <file.json>",
  about: (c, date) =>
    `TEMPLATE to fill by research. ultrastock contains no venue fee: every value must come from the venue's own fee page, as it applies to a resident of ${c}, read on ${date}. For each key fill "value", "sources" (at least one URL), "verifiedAt" and "confidence"; set "researchedAt"; remove a key you did not research rather than guessing it. For one of the user's own accounts at another broker, add "account.<id>.fees" ({maker, taker}), "account.<id>.perUnit" and "account.<id>.minimum" (the account id letters and digits only). Tick sizes, lot steps and Kalshi's per-series fee multiplier are read live from the venues: do not store them. Then store the file with \`ultrastock facts set venues --file <this file>\`.`,
});

/** A key's id for an account (letters and digits only: a facts key is dotted words). */
export const accountKey = (account: string): string => `account.${account.replace(/[^A-Za-z0-9]/g, "")}`;

/** The country the venue facts are read for: the profile's residence. */
export function venueCountry(): string | undefined {
  return loadProfile()?.jurisdiction;
}

export interface VenueFacts {
  country: string;
  date: string;
  path: string;
  current: Record<string, Fact>;
  stale: ValidatedFacts["stale"];
}

/** The latest venue facts for a country dated on or before today; undefined when none is stored. */
export function latestVenueFacts(country: string, now = clockNow()): VenueFacts | undefined {
  const c = countryCode(country);
  const today = now.toISOString().slice(0, 10);
  const date = (storedPeriods(VENUES, c) as string[]).filter((d) => d <= today).at(-1);
  if (!date) return undefined;
  const v = loadFacts(VENUES, c, date);
  return { country: c, date, path: v.path, current: v.current, stale: v.stale };
}

/** Why a venue fact is not available, in words that say what to do. */
export function missingVenueFact(country: string | undefined, keys: readonly string[], facts?: VenueFacts): string {
  const what = keys.join(", ");
  if (!country)
    return `no fee is known for ${what}: no profile names the country of residence (\`ultrastock profile init\`), and ultrastock holds no fee schedule`;
  const stale = facts?.stale.filter((s) => keys.includes(s.key)) ?? [];
  const where = facts
    ? `${facts.path} does not hold ${what} as current${stale.length ? ` (${stale.map((s) => `${s.key} ${s.reason}`).join("; ")})` : ""}`
    : `no venue facts are stored for ${country}`;
  return `no fee is known for ${what}: ${where} — ultrastock holds no fee schedule. Research it: \`${RESEARCH_COMMAND} --country ${country}\` (the template: \`${templateCommand(country)}\`)`;
}

export interface FactRead<T> {
  value: T;
  fact: Fact;
  key: string;
  /** "<path> (verified <date>, <source>)": what an output names as the fee's origin. */
  basis: string;
}

/** One current venue fact, or why it is not there. */
export function venueFact<T>(key: string, opts: { country?: string; now?: Date } = {}): FactRead<T> | { missing: string } {
  const country = opts.country ?? venueCountry();
  if (!country) return { missing: missingVenueFact(undefined, [key]) };
  let facts: VenueFacts | undefined;
  try {
    facts = latestVenueFacts(country, opts.now);
  } catch (e) {
    if (e instanceof UsageError) return { missing: e.message };
    throw e;
  }
  const fact = facts?.current[key];
  if (!facts || !fact) return { missing: missingVenueFact(country, [key], facts) };
  return { value: fact.value as T, fact, key, basis: `researched ${key} in ${facts.path} (verified ${fact.verifiedAt}, ${fact.sources[0]})` };
}

/** Validate and store a venues facts file; returns where it went and what is still missing or stale. */
export const saveVenueFacts = (raw: unknown, expect: { country?: string; date?: string } = {}) =>
  saveFacts(VENUES, raw, { country: expect.country, period: expect.date });

/** The JSON skeleton to research and fill for a country, dated today. */
export const venueTemplate = (country: string, now = clockNow()) => factsTemplate(VENUES, country, now.toISOString().slice(0, 10));
