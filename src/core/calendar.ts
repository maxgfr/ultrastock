// Exchange calendars. The holiday RULES are computed, not copied from a table
// that silently expires every 1 January: fixed holidays with their observance
// rules, moveable feasts from the date of Easter, early closes — `calendar
// verify` lists what a web search should confirm for a given year.
//
// What no rule predicts is a researched fact of the "calendar" domain
// (core/researched.ts), per exchange country and year, keyed by the
// calendar's MIC (`XNYS.open`, `XNYS.close`, `XNYS.specialClosures`):
//
//   <home>/facts/calendar/<CC>-<year>.json      (US for XNYS, FR for XPAR…)
//
// - Trading hours: the researched ones; without them, the hours published on
//   the exchange's site when this file was written (BUILT_IN_HOURS, dated and
//   sourced), and the outputs that print them say so.
// - One-off closures (a national day of mourning, an outage): the researched
//   list of the year; without it, only the past closures recorded below up to
//   the date they were checked. A session count reaching past that date says
//   the closures are unknown (`sessionCountCaveat`) — it never assumes none.
//
// Only the venues below have a calendar. Any other listing (Xetra, London,
// Tokyo, São Paulo…) gets none: its sessions are counted as weekdays and the
// caller says so — a holiday is never guessed.
import { existsSync, statSync } from "node:fs";
import type { Instrument } from "../providers/types.js";
import { clockNow } from "./net.js";
import { defineDomain, type FactSpec, factsPath, factsSetCommand, loadFacts, researchCommand } from "./researched.js";

export type CalendarMarket = "XNYS" | "XPAR" | "XMIL" | "XOSL" | "CRYPTO";
type ExchangeMarket = Exclude<CalendarMarket, "CRYPTO">;

export interface Holiday {
  date: string;
  name: string;
  /** "closed", or an early close time in the exchange's local time. */
  kind: "closed" | "early-close";
  closeAt?: string;
}

export interface MarketSpec {
  id: CalendarMarket;
  name: string;
  timeZone: string;
  /** Venues sharing this calendar. */
  mics: string[];
}

export const MARKETS: Record<CalendarMarket, MarketSpec> = {
  XNYS: { id: "XNYS", name: "NYSE / Nasdaq", timeZone: "America/New_York", mics: ["XNYS", "XNAS", "ARCX", "BATS"] },
  XPAR: {
    id: "XPAR",
    name: "Euronext (Paris, Amsterdam, Brussels, Lisbon, Dublin)",
    timeZone: "Europe/Paris",
    mics: ["XPAR", "XAMS", "XBRU", "XLIS", "XMSM", "ALXP", "XMLI", "ETFP", "TNLA", "ALXB", "ALXL", "XESM"],
  },
  XMIL: { id: "XMIL", name: "Euronext Milan", timeZone: "Europe/Rome", mics: ["MTAA", "EXGM"] },
  XOSL: { id: "XOSL", name: "Euronext Oslo", timeZone: "Europe/Oslo", mics: ["XOSL", "MERK", "XOAS"] },
  CRYPTO: { id: "CRYPTO", name: "Crypto venues (24/7)", timeZone: "UTC", mics: [] },
};

/** The country a calendar's facts are filed under (its home exchange's). */
export const MARKET_COUNTRY: Readonly<Record<ExchangeMarket, string>> = { XNYS: "US", XPAR: "FR", XMIL: "IT", XOSL: "NO" };

const SOURCE: Readonly<Record<ExchangeMarket, string>> = {
  XNYS: "https://www.nyse.com/markets/hours-calendars",
  XPAR: "https://www.euronext.com/en/trade/trading-hours-holidays",
  XMIL: "https://www.borsaitaliana.it/borsaitaliana/calendario-e-orari-di-negoziazione/calendario-borsa-orari-di-negoziazione.en.htm",
  XOSL: "https://www.euronext.com/en/trade/trading-hours-holidays",
};

/** The hours published on each exchange's site when this module was written: the fallback, always reported as such. */
export const BUILT_IN_HOURS = {
  checkedAt: "2026-10-24",
  hours: { XNYS: ["09:30", "16:00"], XPAR: ["09:00", "17:30"], XMIL: ["09:00", "17:30"], XOSL: ["09:00", "16:20"] },
} as const satisfies { checkedAt: string; hours: Record<ExchangeMarket, readonly [string, string]> };

/**
 * One-off closures no rule predicts that had happened when the list was checked (history, not a forecast), with
 * their source. After `CLOSURES_CHECKED_THROUGH` only a researched `<MIC>.specialClosures` fact says which there are.
 */
export const PAST_SPECIAL_CLOSURES: Array<Holiday & { market: CalendarMarket; source: string }> = [
  {
    market: "XNYS",
    date: "2025-01-09",
    name: "National Day of Mourning (President Carter)",
    kind: "closed",
    source: "https://www.nyse.com/markets/hours-calendars",
  },
];
export const CLOSURES_CHECKED_THROUGH = "2026-10-24";

const keysOf = (m: ExchangeMarket): FactSpec[] => [
  {
    key: `${m}.open`,
    label: `${MARKETS[m].name}: regular session open, local time (${MARKETS[m].timeZone})`,
    type: "time",
    unit: "HH:MM local time",
    query: `${MARKETS[m].name} trading hours {period}`,
    prefer: SOURCE[m],
    maxAgeDays: 120,
  },
  {
    key: `${m}.close`,
    label: `${MARKETS[m].name}: regular session close (closing auction included), local time (${MARKETS[m].timeZone})`,
    type: "time",
    unit: "HH:MM local time",
    query: `${MARKETS[m].name} trading hours close {period}`,
    prefer: SOURCE[m],
    maxAgeDays: 120,
  },
  {
    key: `${m}.specialClosures`,
    label: `${MARKETS[m].name}: one-off full-day closures in the year that the regular holiday calendar does not list (a day of mourning, an outage) — [] for none`,
    type: "dates",
    unit: "YYYY-MM-DD dates",
    query: `${MARKETS[m].name} market closed unscheduled closure {period}`,
    prefer: SOURCE[m],
    maxAgeDays: 120,
    note: "name each closure in the fact's note",
  },
];

const marketsOf = (country: string): ExchangeMarket[] => (Object.keys(MARKET_COUNTRY) as ExchangeMarket[]).filter((m) => MARKET_COUNTRY[m] === country);

/** The calendar domain: trading hours and one-off closures, per exchange country and year. */
export const CALENDAR = defineDomain({
  name: "calendar",
  period: "year",
  keysFor: (c) => marketsOf(c).flatMap(keysOf),
  strict: (c) => marketsOf(c).length > 0,
  templateCommand: (c) => researchCommand("calendar", c),
  setCommand: factsSetCommand("calendar"),
  about: (c, year) =>
    `TEMPLATE to fill by research: the trading hours and the one-off closures of ${marketsOf(c).join(", ") || "no calendar ultrastock computes"} in ${year}, read on the exchange's own calendar page. The regular holidays are computed from the rules (\`ultrastock calendar verify --year ${year}\` lists them to compare).`,
});

// Reading a year's facts on every "is this a session?" would read the file hundreds of times a count: it is read once
// per file state (its modification time), so a file stored meanwhile is picked up.
const FACTS = new Map<string, { stamp: string; facts: Record<string, { value: unknown; sources: string[]; verifiedAt: string; note?: string }> }>();

function calendarFacts(market: ExchangeMarket, year: number) {
  const country = MARKET_COUNTRY[market];
  const path = factsPath(CALENDAR, country, year);
  const stamp = existsSync(path) ? String(statSync(path).mtimeMs) : "none";
  const hit = FACTS.get(path);
  if (hit && hit.stamp === stamp) return hit.facts;
  let facts: Record<string, { value: unknown; sources: string[]; verifiedAt: string; note?: string }> = {};
  try {
    if (stamp !== "none") facts = loadFacts(CALENDAR, country, year).current;
  } catch {
    facts = {}; // an invalid file is reported by `facts research calendar`, never used
  }
  FACTS.set(path, { stamp, facts });
  return facts;
}

export interface SessionHours {
  open: string;
  close: string;
  origin: "researched" | "built-in";
  sources: string[];
  /** When the hours were verified (researched) or written down (built-in). */
  asOf: string;
}

/** A venue's regular session hours, local time: researched for the year, else the dated built-in ones. */
export function marketHours(market: CalendarMarket, year = clockNow().getUTCFullYear()): SessionHours {
  if (market === "CRYPTO") return { open: "00:00", close: "24:00", origin: "built-in", sources: [], asOf: BUILT_IN_HOURS.checkedAt };
  const f = calendarFacts(market, year);
  const open = f[`${market}.open`];
  const close = f[`${market}.close`];
  if (open && close)
    return {
      open: open.value as string,
      close: close.value as string,
      origin: "researched",
      sources: [...new Set([...open.sources, ...close.sources])],
      asOf: [open.verifiedAt, close.verifiedAt].sort()[0]!,
    };
  const [o, c] = BUILT_IN_HOURS.hours[market];
  return { open: o, close: c, origin: "built-in", sources: [SOURCE[market]], asOf: BUILT_IN_HOURS.checkedAt };
}

/** What an output printing `h` must say when the hours are the built-in ones. */
export function hoursNote(market: CalendarMarket, h: SessionHours): string | undefined {
  if (market === "CRYPTO" || h.origin === "researched") return undefined;
  return `${MARKETS[market].name} hours ${h.open}–${h.close} are ultrastock's built-in ones (as published on ${h.sources.join(", ")} on ${h.asOf}), not a current research — \`${researchCommand("calendar", MARKET_COUNTRY[market])}\``;
}

/** A year's one-off closures: the researched list when there is one (known), else the past ones recorded here (known only up to CLOSURES_CHECKED_THROUGH). */
export function specialClosures(market: CalendarMarket, year: number): { closures: Holiday[]; researched: boolean } {
  if (market === "CRYPTO") return { closures: [], researched: true };
  const f = calendarFacts(market, year)[`${market}.specialClosures`];
  if (f) {
    const names = f.note ? ` — ${f.note}` : "";
    return {
      closures: (f.value as string[]).map((date) => ({ date, name: `one-off closure (researched${names})`, kind: "closed" as const })),
      researched: true,
    };
  }
  return {
    closures: PAST_SPECIAL_CLOSURES.filter((s) => s.market === market && s.date.startsWith(String(year))).map((s) => ({
      date: s.date,
      name: s.name,
      kind: s.kind,
    })),
    researched: false,
  };
}

/**
 * What a session count from `from` to `to` (YYYY-MM-DD) must say: undefined when every one-off closure on the way is
 * known (researched for its year, or before CLOSURES_CHECKED_THROUGH), else that the count assumes none it does not know.
 */
export function sessionCountCaveat(market: CalendarMarket | undefined, from: string, to: string): string | undefined {
  if (!market || market === "CRYPTO") return undefined;
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  if (hi <= CLOSURES_CHECKED_THROUGH) return undefined;
  const years: number[] = [];
  for (let y = Math.max(Number(lo.slice(0, 4)), Number(CLOSURES_CHECKED_THROUGH.slice(0, 4))); y <= Number(hi.slice(0, 4)); y++)
    if (!specialClosures(market, y).researched) years.push(y);
  if (!years.length) return undefined;
  return `${MARKETS[market].name}: one-off closures (a day of mourning, an outage) after ${CLOSURES_CHECKED_THROUGH} are not researched for ${years.join(", ")} — the session count counts every rule-computed session as open and may be off by a day; research them with \`${researchCommand("calendar", MARKET_COUNTRY[market])}\``;
}

/** The UTC instant of a local wall-clock time on a day in an IANA time zone (daylight saving included), by Intl. */
export function localTimeToUtc(day: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const offset = (at: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
  };
  // Twice: the offset at the first guess may be the other side of a daylight-saving change.
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Easter Sunday (Gregorian), by the anonymous algorithm (Meeus/Jones/Butcher). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/** The n-th weekday (0 = Sunday) of a month; n = -1 for the last. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    const first = utc(year, month, 1);
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return addDays(first, offset + (n - 1) * 7);
  }
  const last = utc(year, month + 1, 0);
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return addDays(last, -offset);
}

/** NYSE observance: Saturday → Friday before, Sunday → Monday after. */
function observed(d: Date): Date {
  const w = d.getUTCDay();
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, 1) : d;
}

export function holidays(market: CalendarMarket, year: number): Holiday[] {
  const out: Holiday[] = [];
  const closed = (d: Date, name: string) => out.push({ date: fmt(d), name, kind: "closed" });
  const early = (d: Date, name: string, closeAt: string) => {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push({ date: fmt(d), name, kind: "early-close", closeAt });
  };
  const easter = easterSunday(year);
  if (market === "XNYS") {
    // New Year's Day falling on a Saturday is not observed on the Friday before (NYSE rule 7.2).
    const ny = utc(year, 1, 1);
    if (ny.getUTCDay() !== 6) closed(observed(ny), "New Year's Day");
    closed(nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day");
    closed(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
    closed(addDays(easter, -2), "Good Friday");
    closed(nthWeekday(year, 5, 1, -1), "Memorial Day");
    if (year >= 2022) closed(observed(utc(year, 6, 19)), "Juneteenth");
    const july4 = utc(year, 7, 4);
    closed(observed(july4), "Independence Day");
    if (july4.getUTCDay() >= 2 && july4.getUTCDay() <= 5) early(utc(year, 7, 3), "Day before Independence Day", "13:00");
    closed(nthWeekday(year, 9, 1, 1), "Labor Day");
    const thanksgiving = nthWeekday(year, 11, 4, 4);
    closed(thanksgiving, "Thanksgiving Day");
    early(addDays(thanksgiving, 1), "Day after Thanksgiving", "13:00");
    const xmas = utc(year, 12, 25);
    closed(observed(xmas), "Christmas Day");
    if (xmas.getUTCDay() >= 2 && xmas.getUTCDay() <= 5) early(utc(year, 12, 24), "Christmas Eve", "13:00");
  } else if (market === "XPAR") {
    closed(utc(year, 1, 1), "New Year's Day");
    closed(addDays(easter, -2), "Good Friday");
    closed(addDays(easter, 1), "Easter Monday");
    closed(utc(year, 5, 1), "Labour Day");
    closed(utc(year, 12, 25), "Christmas Day");
    closed(utc(year, 12, 26), "Boxing Day");
    early(utc(year, 12, 24), "Christmas Eve", "14:05");
    early(utc(year, 12, 31), "New Year's Eve", "14:05");
  } else if (market === "XMIL") {
    closed(utc(year, 1, 1), "New Year's Day");
    closed(addDays(easter, -2), "Good Friday");
    closed(addDays(easter, 1), "Easter Monday");
    closed(utc(year, 5, 1), "Labour Day");
    closed(utc(year, 8, 15), "Assumption Day");
    closed(utc(year, 12, 24), "Christmas Eve");
    closed(utc(year, 12, 25), "Christmas Day");
    closed(utc(year, 12, 26), "St Stephen's Day");
    closed(utc(year, 12, 31), "New Year's Eve");
  } else if (market === "XOSL") {
    closed(utc(year, 1, 1), "New Year's Day");
    closed(addDays(easter, -3), "Maundy Thursday");
    closed(addDays(easter, -2), "Good Friday");
    closed(addDays(easter, 1), "Easter Monday");
    closed(utc(year, 5, 1), "Labour Day");
    closed(utc(year, 5, 17), "Constitution Day");
    closed(addDays(easter, 39), "Ascension Day");
    closed(addDays(easter, 50), "Whit Monday");
    closed(utc(year, 12, 24), "Christmas Eve");
    closed(utc(year, 12, 25), "Christmas Day");
    closed(utc(year, 12, 26), "Boxing Day");
    closed(utc(year, 12, 31), "New Year's Eve");
  }
  for (const h of specialClosures(market, year).closures) if (!out.some((x) => x.date === h.date && x.kind === "closed")) out.push(h);
  // A weekend "holiday" closes nothing; keep the list to sessions it changes.
  return out.filter((h) => ![0, 6].includes(new Date(`${h.date}T00:00:00Z`).getUTCDay())).sort((a, b) => a.date.localeCompare(b.date));
}

/** The calendar a listing venue follows. */
export function marketForMic(mic: string | undefined): CalendarMarket {
  if (!mic) return "XNYS";
  for (const m of Object.values(MARKETS)) if (m.mics.includes(mic)) return m.id;
  return /^X?NAS|NYSE|ARCA|AMEX|BATS/i.test(mic) ? "XNYS" : "XPAR";
}

/**
 * The calendar an instrument follows, or undefined when this module has none
 * for its venue (a European venue outside Euronext, the rest of the world).
 */
export function calendarFor(i: Pick<Instrument, "market" | "mic">): CalendarMarket | undefined {
  if (i.market === "crypto") return "CRYPTO";
  if (i.market === "us") return "XNYS";
  if (i.market === "euronext") return marketForMic(i.mic);
  return undefined;
}

// Counting sessions asks "is this day a session?" for every day it steps over,
// and the answer came from rebuilding the whole year's holidays — Easter
// included — each time: sixty sessions ahead rebuilt the list some ninety times.
// A year's closed days and early closes are worked out once per market.
// The key carries the facts file's state: one-off closures stored meanwhile are picked up.
const YEARS = new Map<string, { closed: ReadonlySet<string>; early: ReadonlyMap<string, Holiday> }>();

function yearOf(market: CalendarMarket, year: number): { closed: ReadonlySet<string>; early: ReadonlyMap<string, Holiday> } {
  const path = market === "CRYPTO" ? "" : factsPath(CALENDAR, MARKET_COUNTRY[market], year);
  const key = `${market}:${year}:${path && existsSync(path) ? `${path}@${statSync(path).mtimeMs}` : "none"}`;
  let y = YEARS.get(key);
  if (!y) {
    const list = holidays(market, year);
    y = {
      closed: new Set(list.filter((h) => h.kind === "closed").map((h) => h.date)),
      early: new Map(list.filter((h) => h.kind === "early-close").map((h) => [h.date, h])),
    };
    YEARS.set(key, y);
  }
  return y;
}

/** A session day; with no calendar (undefined), any weekday — holidays unknown, never guessed. */
export function isTradingDay(market: CalendarMarket | undefined, date: string): boolean {
  if (market === "CRYPTO") return true;
  const d = new Date(`${date}T00:00:00Z`);
  if ([0, 6].includes(d.getUTCDay())) return false;
  if (!market) return true;
  return !yearOf(market, d.getUTCFullYear()).closed.has(date);
}

/** The next `n` sessions on or after `from` (YYYY-MM-DD), with any early close. */
export function nextSessions(market: CalendarMarket, from: string, n: number): Array<{ date: string; closeAt: string; early: boolean }> {
  const out: Array<{ date: string; closeAt: string; early: boolean }> = [];
  let d = new Date(`${from}T00:00:00Z`);
  for (let guard = 0; out.length < n && guard < 400; guard++, d = addDays(d, 1)) {
    const day = fmt(d);
    if (!isTradingDay(market, day)) continue;
    const e = yearOf(market, d.getUTCFullYear()).early.get(day);
    out.push({ date: day, closeAt: e?.closeAt ?? marketHours(market, d.getUTCFullYear()).close, early: !!e });
  }
  return out;
}

/** Trading sessions strictly between two dates — for "five trading days later" (weekdays when the venue has no calendar). */
export function addSessions(market: CalendarMarket | undefined, from: string, n: number): string {
  let d = new Date(`${from}T00:00:00Z`);
  let left = n;
  for (let guard = 0; left > 0 && guard < 2000; guard++) {
    d = addDays(d, 1);
    if (isTradingDay(market, fmt(d))) left--;
  }
  return fmt(d);
}
