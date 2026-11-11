// Calendar dates as people and pages write them — 2026-11-17, 17/11/2026,
// 17.11.26, 17 novembre 2026, le 1er mars, Nov. 17, 2026, 17 November 2026 —
// read into one comparable form, so `check` can hold a date to the evidence
// that states it and a brief can find an issuer's page that confirms one.
//
// A slash or dot date is ambiguous between day-month and month-day: both
// readings are kept when both are valid. A date written without its year
// matches any year.

export interface WrittenDate {
  raw: string;
  year?: number;
  /** Every valid [month, day] reading (two for 03/04/2026). */
  readings: Array<[month: number, day: number]>;
}

const MONTH_NAMES: Array<[RegExp, number]> = [
  [/^(?:janv?|janvier|january)$/, 1],
  [/^(?:f[ée]vr?|f[ée]vrier|feb|february)$/, 2],
  [/^(?:mars|mar|march)$/, 3],
  [/^(?:avr|avril|apr|april)$/, 4],
  [/^(?:mai|may)$/, 5],
  [/^(?:juin|jun|june)$/, 6],
  [/^(?:juil|juillet|jul|july)$/, 7],
  [/^(?:ao[uû]t|aug|august)$/, 8],
  [/^(?:sept?|septembre|september)$/, 9],
  [/^(?:oct|octobre|october)$/, 10],
  [/^(?:nov|novembre|november)$/, 11],
  [/^(?:d[ée]c|d[ée]cembre|dec|december)$/, 12],
];
export const MONTH_WORD =
  "janvier|janv|january|jan|février|fevrier|févr|fevr|february|feb|mars|march|mar|avril|avr|april|apr|mai|may|juin|june|jun|juillet|juil|july|jul|août|aout|august|aug|septembre|september|sept|sep|octobre|october|oct|novembre|november|nov|décembre|decembre|december|déc|dec";

const monthOf = (w: string): number | undefined => {
  const k = w.toLowerCase().replace(/\.$/, "");
  return MONTH_NAMES.find(([re]) => re.test(k))?.[1];
};
const valid = (y: number | undefined, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31 && (y === undefined || new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d);
const year4 = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

const ISO = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d])/g;
const NUMERIC = /(?<![\d./-])(\d{1,2})([/.])(\d{1,2})\2(\d{4}|\d{2})(?![\d./])/g;
/**
 * A day and month with a slash and no year — "le 17/11", "on 11/17" — only after a word that introduces a date: alone,
 * "17/11" may as well be a ratio.
 */
const NUMERIC_NO_YEAR =
  /(?<=(?:^|[^\p{L}])(?:le|du|au|dès|jusqu'au|jusqu’au|avant le|après le|on|by|from|until|till|before|after|since)\s)(\d{1,2})\/(\d{1,2})(?![\p{N}/]|[.,]\d|\s?[%‰$€£])/giu;
/** The second day of a range in one month: "17–21 November 2026", "November 17-21, 2026" — both ends are dates. */
const DAY_RANGE = "(?:\\s?[-–]\\s?(\\d{1,2}))?";
const DAY_MONTH = new RegExp(
  `(?<![\\p{L}\\p{N}.,])(?:(\\d{1,2})\\s?[-–]\\s?)?(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(${MONTH_WORD})\\.?(?:,?\\s+(\\d{4}))?(?![\\p{L}\\p{N}])`,
  "giu",
);
// A day is not followed by a decimal or a unit: "May 45 %", "mars 12 % du CA" and "Nov 17 €" are figures after a month.
const NO_UNIT =
  "(?![.,]\\d)(?!\\s?(?:[%‰$€£]|(?:pts?|bps?|x|k|K|M|m|mn|Mn|bn|Bn|B|Md|Mds|T|tn|EUR|USD|GBP|CHF|millions?|billions?|milliards?)(?![\\p{L}\\p{N}])))";
const MONTH_DAY = new RegExp(
  `(?<![\\p{L}])(${MONTH_WORD})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?${DAY_RANGE}${NO_UNIT}(?:,?\\s+(\\d{4}))?(?![\\p{L}\\p{N}])`,
  "giu",
);
/** English month names that are also words: lowercase, "may" and "march" are a verb ("21 may look rich"). */
const WORD_NOT_MONTH = /^(?:may|march)$/;

/** Every calendar date a text writes (a month and a year alone are not a date). */
export function extractDates(text: string): WrittenDate[] {
  return scanDates(text).map(({ at: _a, end: _e, ...d }) => d);
}

/** Where a text writes a valid calendar date: [start, end) of each. */
export function dateSpans(text: string): Array<[start: number, end: number]> {
  return scanDates(text).map((d) => [d.at, d.end]);
}

function scanDates(text: string): Array<WrittenDate & { at: number; end: number }> {
  const out: Array<WrittenDate & { at: number; end: number }> = [];
  // A range writes two dates in one span: both are kept, or neither.
  const add = (m: RegExpMatchArray, ...ds: WrittenDate[]) => {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (ds.every((d) => d.readings.length) && !out.some((o) => at < o.end && end > o.at)) for (const d of ds) out.push({ ...d, at, end });
  };
  for (const m of text.matchAll(ISO)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    add(m, { raw: m[0], year: y, readings: valid(y, mo, d) ? [[mo, d]] : [] });
  }
  for (const m of text.matchAll(NUMERIC)) {
    const y = year4(m[4]!);
    const [a, b] = [Number(m[1]), Number(m[3])];
    const readings: Array<[number, number]> = [];
    if (valid(y, b, a)) readings.push([b, a]);
    if (a !== b && valid(y, a, b)) readings.push([a, b]);
    add(m, { raw: m[0], year: y, readings });
  }
  for (const m of text.matchAll(NUMERIC_NO_YEAR)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const readings: Array<[number, number]> = [];
    if (valid(undefined, b, a)) readings.push([b, a]);
    if (a !== b && valid(undefined, a, b)) readings.push([a, b]);
    add(m, { raw: m[0], readings });
  }
  const named = (m: RegExpMatchArray, month: string, days: Array<string | undefined>, year: string | undefined) => {
    const mo = WORD_NOT_MONTH.test(month) ? undefined : monthOf(month);
    const y = year ? Number(year) : undefined;
    const ds = days.filter((d): d is string => d !== undefined).map(Number);
    // A range runs forward: "17–21", not "21–17" (that is two figures).
    if (ds.length === 2 && ds[0]! >= ds[1]!) return;
    add(m, ...ds.map((d): WrittenDate => ({ raw: m[0].trim(), ...(y ? { year: y } : {}), readings: mo && valid(y, mo, d) ? [[mo, d]] : [] })));
  };
  for (const m of text.matchAll(DAY_MONTH)) named(m, m[3]!, [m[1], m[2]], m[4]);
  for (const m of text.matchAll(MONTH_DAY)) named(m, m[1]!, [m[2], m[3]], m[4]);
  return out.sort((a, b) => a.at - b.at);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The comparable forms of the dates a text holds: "2026-11-17" for a dated one, "*-11-17" for one without its year. */
export function datesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const d of extractDates(text)) for (const [m, day] of d.readings) out.add(`${d.year ?? "*"}-${pad(m)}-${pad(day)}`);
  return out;
}

/** Does a set of held dates (see datesIn) hold this written date? A date without a year on either side matches on the day. */
export function holdsDate(held: ReadonlySet<string>, d: WrittenDate): boolean {
  for (const [m, day] of d.readings) {
    const md = `${pad(m)}-${pad(day)}`;
    if (d.year === undefined) {
      for (const h of held) if (h.endsWith(`-${md}`)) return true;
    } else if (held.has(`${d.year}-${md}`) || held.has(`*-${md}`)) return true;
  }
  return false;
}

/** The ISO day of a written date with its year and a single reading, else undefined. */
export function isoOf(d: WrittenDate): string | undefined {
  return d.year !== undefined && d.readings.length === 1 ? `${d.year}-${pad(d.readings[0]![0])}-${pad(d.readings[0]![1])}` : undefined;
}
