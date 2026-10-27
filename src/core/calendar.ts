// Exchange calendars computed from their rules, not copied from a table that
// silently expires every 1 January: fixed holidays with their observance rules,
// moveable feasts from the date of Easter, early closes, and a short list of
// one-off closures (a national day of mourning) each with its source.
// `calendar verify` lists what a web search should confirm for a given year.
//
// Only the venues below have a calendar. Any other listing (Xetra, London,
// Tokyo, São Paulo…) gets none: its sessions are counted as weekdays and the
// caller says so — a holiday is never guessed.
import type { Instrument } from "../providers/types.js";

export type CalendarMarket = "XNYS" | "XPAR" | "XMIL" | "XOSL" | "CRYPTO";

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
  open: string;
  close: string;
  /** Venues sharing this calendar. */
  mics: string[];
}

export const MARKETS: Record<CalendarMarket, MarketSpec> = {
  XNYS: { id: "XNYS", name: "NYSE / Nasdaq", timeZone: "America/New_York", open: "09:30", close: "16:00", mics: ["XNYS", "XNAS", "ARCX", "BATS"] },
  XPAR: {
    id: "XPAR",
    name: "Euronext (Paris, Amsterdam, Brussels, Lisbon, Dublin)",
    timeZone: "Europe/Paris",
    open: "09:00",
    close: "17:30",
    mics: ["XPAR", "XAMS", "XBRU", "XLIS", "XMSM", "ALXP", "XMLI", "ETFP", "TNLA", "ALXB", "ALXL", "XESM"],
  },
  XMIL: { id: "XMIL", name: "Euronext Milan", timeZone: "Europe/Rome", open: "09:00", close: "17:30", mics: ["MTAA", "EXGM"] },
  XOSL: { id: "XOSL", name: "Euronext Oslo", timeZone: "Europe/Oslo", open: "09:00", close: "16:20", mics: ["XOSL", "MERK", "XOAS"] },
  CRYPTO: { id: "CRYPTO", name: "Crypto venues (24/7)", timeZone: "UTC", open: "00:00", close: "24:00", mics: [] },
};

/** One-off closures no rule predicts, with their source. */
export const SPECIAL_CLOSURES: Array<Holiday & { market: CalendarMarket; source: string }> = [
  {
    market: "XNYS",
    date: "2025-01-09",
    name: "National Day of Mourning (President Carter)",
    kind: "closed",
    source: "https://www.nyse.com/markets/hours-calendars",
  },
];

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
  for (const s of SPECIAL_CLOSURES) if (s.market === market && s.date.startsWith(String(year))) out.push({ date: s.date, name: s.name, kind: s.kind });
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

/** A session day; with no calendar (undefined), any weekday — holidays unknown, never guessed. */
export function isTradingDay(market: CalendarMarket | undefined, date: string): boolean {
  if (market === "CRYPTO") return true;
  const d = new Date(`${date}T00:00:00Z`);
  if ([0, 6].includes(d.getUTCDay())) return false;
  if (!market) return true;
  return !holidays(market, d.getUTCFullYear()).some((h) => h.date === date && h.kind === "closed");
}

/** The next `n` sessions on or after `from` (YYYY-MM-DD), with any early close. */
export function nextSessions(market: CalendarMarket, from: string, n: number): Array<{ date: string; closeAt: string; early: boolean }> {
  const out: Array<{ date: string; closeAt: string; early: boolean }> = [];
  let d = new Date(`${from}T00:00:00Z`);
  for (let guard = 0; out.length < n && guard < 400; guard++, d = addDays(d, 1)) {
    const day = fmt(d);
    if (!isTradingDay(market, day)) continue;
    const e = holidays(market, d.getUTCFullYear()).find((h) => h.date === day && h.kind === "early-close");
    out.push({ date: day, closeAt: e?.closeAt ?? MARKETS[market].close, early: !!e });
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
