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
const MONTH_WORD =
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
const DAY_MONTH = new RegExp(`(?<![\\p{L}\\p{N}.,])(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(${MONTH_WORD})\\.?(?:,?\\s+(\\d{4}))?(?![\\p{L}\\p{N}])`, "giu");
const MONTH_DAY = new RegExp(`(?<![\\p{L}])(${MONTH_WORD})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?![\\p{L}\\p{N}])`, "giu");

/** Every calendar date a text writes (a month and a year alone are not a date). */
export function extractDates(text: string): WrittenDate[] {
  const out: Array<WrittenDate & { at: number; end: number }> = [];
  const add = (m: RegExpMatchArray, d: WrittenDate) => {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (d.readings.length && !out.some((o) => at < o.end && end > o.at)) out.push({ ...d, at, end });
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
  for (const m of text.matchAll(DAY_MONTH)) {
    const mo = monthOf(m[2]!);
    const y = m[3] ? Number(m[3]) : undefined;
    const d = Number(m[1]);
    add(m, { raw: m[0].trim(), ...(y ? { year: y } : {}), readings: mo && valid(y, mo, d) ? [[mo, d]] : [] });
  }
  for (const m of text.matchAll(MONTH_DAY)) {
    const mo = monthOf(m[1]!);
    const y = m[3] ? Number(m[3]) : undefined;
    const d = Number(m[2]);
    add(m, { raw: m[0].trim(), ...(y ? { year: y } : {}), readings: mo && valid(y, mo, d) ? [[mo, d]] : [] });
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _a, end: _e, ...d }) => d);
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
