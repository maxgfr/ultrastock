// Date helpers shared by the fundamentals providers. Every date here is an ISO
// calendar day handled in UTC: a filing's "2026-06-30" must never become the
// 29th because the machine runs west of Greenwich.

/** A Date's UTC calendar day, YYYY-MM-DD. */
export function isoDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const dayMs = 86_400_000;
const dayNumber = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / dayMs);

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** `iso` moved by `n` days. */
export function shiftIsoDay(iso: string, n: number): string {
  return new Date((dayNumber(iso) + n) * dayMs).toISOString().slice(0, 10);
}

/** "10/23/2026" or "4/5/2026" (US month/day/year) → "2026-10-23"; undefined otherwise. */
export function mdyToIso(s: string | undefined): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s ?? "").trim());
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "Oct 2026" → "2026-10"; undefined otherwise. */
export function monthYearToIso(s: string | undefined): string | undefined {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec((s ?? "").trim());
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
  return m && month >= 0 ? `${m[2]}-${String(month + 1).padStart(2, "0")}` : undefined;
}

/** A finite number from a number or a numeric string, else undefined. */
export function finiteNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}
