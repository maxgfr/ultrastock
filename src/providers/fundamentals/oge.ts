// US executive branch financial disclosures (official: the Office of Government
// Ethics), keyless:
//
//   index    https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v3/rest?search[value]=<name>&length=<n>
//            (the JSON behind OGE's "Officials' Individual Disclosures Search
//            Collection": the President, the Vice President, Senate-confirmed
//            officials and nominees — name, title, agency, report type, date)
//   reports  https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/<UNID>/$FILE/<name>.pdf
//
// The OGE Form 278-T is the executive branch's periodic transaction report:
// a purchase, sale or exchange above $1,000 is due within 30 days of the
// filer's notice of it and no later than 45 days after the trade. Amounts are
// disclosed as the form's value bands only. A report is public when the index
// links its PDF; the others are "on request" (OGE Form 201) and are listed as
// such. The PDFs are scans with an OCR text layer: rows are read best effort,
// the OCR's usual confusions repaired, and a row that still does not read is
// counted, never guessed.
import { cachedJson, TTL } from "../../core/cache.js";
import { fetchJson } from "../../core/net.js";
import { decodeEntities, extractPdf } from "../../engine.js";
import { ProviderError } from "../types.js";
import { fetchBinary } from "./binary.js";
import { daysBetween } from "./util.js";

export const OGE_SOURCE = "oge";
const API = "https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v3/rest";
export const OGE_SEARCH_URL = "https://www.oge.gov/web/OGE.nsf/Officials%20Individual%20Disclosures%20Search%20Collection?OpenForm";

export type OgeReportKind = "278-T" | "annual" | "nominee" | "new-entrant" | "termination" | "candidate" | "other";

export interface OgeFiling {
  /** "Trump, Donald J" — external text, as OGE records it. */
  name: string;
  title: string;
  agency: string;
  kind: OgeReportKind;
  /** The day OGE posted it (YYYY-MM-DD). */
  date: string;
  amended: boolean;
  /** The public PDF; absent when the report is only available on request. */
  url?: string;
  /** OGE's document id when the PDF is public, else a stable id from the row. */
  id: string;
}

type OgeJson = { recordsFiltered?: number; data?: Array<Record<string, string | undefined>> };

function kindOf(type: string): OgeReportKind {
  if (/278\s*Transaction|278-?T/i.test(type)) return "278-T";
  if (/annual/i.test(type)) return "annual";
  if (/nominee/i.test(type)) return "nominee";
  if (/new entrant/i.test(type)) return "new-entrant";
  if (/termination/i.test(type)) return "termination";
  if (/candidate/i.test(type)) return "candidate";
  return "other";
}

/** OGE's index JSON → filings, newest first. */
export function parseOgeIndex(json: OgeJson): OgeFiling[] {
  return (json.data ?? [])
    .flatMap((r) => {
      const html = r.type ?? "";
      const href = /href='([^']+)'/.exec(html)?.[1];
      const pdf = href && /\/\$FILE\//.test(href) ? decodeEntities(href) : undefined;
      const date = (r.docDate ?? "").slice(0, 10);
      const name = (r.name ?? "").trim();
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
      const type = decodeEntities(html.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
      const unid = pdf ? /\/([0-9A-F]{32})\//i.exec(pdf)?.[1] : undefined;
      return [
        {
          name,
          title: (r.title ?? "").trim(),
          agency: (r.agency ?? "").trim(),
          kind: kindOf(type),
          date,
          amended: !!r.amended?.trim(),
          ...(pdf ? { url: pdf } : {}),
          id: unid ?? `${name}|${type}|${r.docDate ?? ""}`,
        },
      ];
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/** Every report OGE lists under a name (its search matches any column; only rows whose filer name matches are kept). */
export async function ogeFilings(name: string, opts: { limit?: number } = {}): Promise<{ filings: OgeFiling[]; url: string; fetchedAt: string }> {
  const q = name.trim();
  if (!q) throw new ProviderError(OGE_SOURCE, "a name is needed", 400);
  const url = `${API}?search%5Bvalue%5D=${encodeURIComponent(q)}&length=${opts.limit ?? 200}`;
  const res = await fetchJson<OgeJson>(url, { timeoutMs: 30_000 });
  if (!res.ok || !res.data) throw new ProviderError(OGE_SOURCE, `${url} (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const words = q
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  const filings = parseOgeIndex(res.data).filter((f) => words.every((w) => f.name.toLowerCase().includes(w)));
  return { filings, url, fetchedAt: res.fetchedAt };
}

// ─── the 278-T rows ────────────────────────────────────────────────────────

/** The value bands of OGE Form 278-T (Part 1, "Amount"): a reported amount is one of these. */
export const OGE_BANDS: ReadonlyArray<readonly [number, number | undefined]> = [
  [1_001, 15_000],
  [15_001, 50_000],
  [50_001, 100_000],
  [100_001, 250_000],
  [250_001, 500_000],
  [500_001, 1_000_000],
  [1_000_001, 5_000_000],
  [5_000_001, 25_000_000],
  [25_000_001, 50_000_000],
  [50_000_001, undefined],
];

export interface OgeTransaction {
  /** The row number the form prints. */
  row: number;
  /** As filed (OCR text) — external text. */
  description: string;
  type: "purchase" | "sale" | "exchange";
  /** Undefined when the date did not read unambiguously. */
  date?: string;
  amountLow?: number;
  /** Undefined for the open top band ("over $50,000,000"). */
  amountHigh?: number;
  /** The filer was notified more than 30 days before reporting. */
  late?: boolean;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** "lourchaso", "I Purchase", "oun:hasc" → purchase; undefined when no type is close enough. */
export function ogeType(raw: string): OgeTransaction["type"] | undefined {
  const s = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (/sa[l1i][eoa]/.test(s) || /^[a-z]?sa[l1i]$/.test(s)) return "sale";
  const t = s.replace(/^[li]/, "");
  const best = (["purchase", "exchange"] as const).map((w) => ({ w, d: Math.min(editDistance(s, w), editDistance(t, w)) })).sort((a, b) => a.d - b.d)[0]!;
  return best.d <= (best.w === "purchase" ? 4 : 3) ? best.w : undefined;
}

const OCR_DIGITS: Record<string, string> = { O: "0", o: "0", D: "0", Q: "0", l: "1", I: "1", i: "1", "|": "1", B: "8", R: "8", "?": "2", Z: "2" };
const fixDigits = (s: string) => s.replace(/[OoDQlIi|BR?Z]/g, (c) => OCR_DIGITS[c]!);

function validDay(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : undefined;
}

/**
 * A 278-T date cell → YYYY-MM-DD, or undefined when it does not read to ONE
 * day within `windowDays` before the report: "8/31/?026" and "8/3112026" read,
 * "81412026" (8/4 or 8/14?) does not.
 */
export function ogeDate(raw: string, filed: string, windowDays = 150): string | undefined {
  const s = fixDigits(raw.replace(/\s+/g, ""));
  const inWindow = (iso: string) => {
    const age = daysBetween(iso, filed);
    return age >= -1 && age <= windowDays;
  };
  const exact = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (exact) {
    const iso = validDay(Number(exact[3]), Number(exact[1]), Number(exact[2]));
    return iso && inWindow(iso) ? iso : undefined;
  }
  const years = [Number(filed.slice(0, 4)), Number(filed.slice(0, 4)) - 1];
  const found = new Set<string>();
  for (const y of years) {
    const yy = String(y);
    // The year as read, whole ("…2026") or with its first digit eaten by the separator before it ("8/10h026").
    for (const tail of [yy, yy.slice(1)]) {
      const at = s.lastIndexOf(tail);
      if (at < 0 || at + tail.length !== s.length) continue;
      const head = s.slice(0, at).replace(/[^0-9/]+$/, "");
      const parts = head.split(/[^0-9]+/).filter(Boolean);
      // A separator that was read ("8/312026") places month and day: the one eaten is the year's.
      if (parts.length === 2) {
        const iso = validDay(y, Number(parts[0]), Number(parts[1]));
        if (iso && inWindow(iso)) {
          found.add(iso);
          continue;
        }
      }
      const candidates: Array<[string, string]> = [];
      // Month and day out of digits: split anywhere, or at a "1" that is a slash read as a digit.
      const splits = (digits: string) => {
        for (let k = 1; k < digits.length && k <= 2; k++) candidates.push([digits.slice(0, k), digits.slice(k)]);
        for (let k = 1; k < digits.length; k++) if (digits[k] === "1") candidates.push([digits.slice(0, k), digits.slice(k + 1)]);
      };
      const digits = parts.join("");
      splits(digits);
      // The slash before the year read as a "1" too: "8/3112026" is 8/31/2026, "81412026" is 8/14 or 8/4.
      if (digits.endsWith("1")) splits(digits.slice(0, -1));
      for (const [m, d] of candidates) {
        if (!m || !d || d.length > 2) continue;
        const iso = validDay(y, Number(m), Number(d));
        if (iso && inWindow(iso)) found.add(iso);
      }
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** "$1 000 D01 • $5 000,0D0", "S1.001-S15.000", "Over $50,000,000" → the form's band; undefined when it matches none. */
export function ogeAmount(raw: string): { low: number; high?: number } | undefined {
  if (/over/i.test(raw)) {
    const top = OGE_BANDS[OGE_BANDS.length - 1]!;
    return { low: top[0] };
  }
  const sides = raw
    .replace(/[•·~–—=]/g, "-")
    .split("-")
    .map((side) => {
      const t = side.replace(/[\s,.'"`]/g, "").replace(/^[$Ss]/, "");
      const n = Number(fixDigits(t.replace(/[Ss]/g, "5")).replace(/[^0-9]/g, ""));
      return Number.isFinite(n) && n > 0 ? n : undefined;
    });
  const [low, high] = [sides[0], sides[sides.length - 1]];
  const band = OGE_BANDS.find(([l]) => l === low) ?? OGE_BANDS.find(([, h]) => h !== undefined && h === high);
  return band ? { low: band[0], ...(band[1] !== undefined ? { high: band[1] } : {}) } : undefined;
}

// Number (on the row's line in recent forms, on a line of its own in older ones), description, type, date, notified over 30 days ago, amount.
const ROW = /^\s*(\d{1,4})?\s{2,}(\S.*?)\s{2,}(\S.{1,14}?)\s{2,}(\S.{2,14}?)\s{2,}(Yes|Yos|Ye5|Y0s|Vos|Ves|No|N0)\b\s*(.*)$/;
const NUMBERED = /^\s*\d{1,4}\s{3,}[A-Z0-9]/;
const ROW_START = new RegExp(`${NUMBERED.source}|\\s{2,}(?:Yes|Yos|Ye5|Y0s|Vos|Ves|No|N0)\\s+\\S{0,2}\\s*[$Ss5]?\\s*\\d[\\d\\s,.]*\\s*[-•·~–—]`);

/** A 278-T's text (pdftotext -layout) → its transactions, and the number of rows that did not read. */
export function parse278tText(text: string, filed: string): { rows: OgeTransaction[]; unread: number } {
  const rows: OgeTransaction[] = [];
  let unread = 0;
  // A numbered row that did not read may have wrapped: its rest, on the next line, is the same row.
  let wrapped = false;
  for (const line of text.split(/\r?\n/)) {
    if (!ROW_START.test(line)) {
      if (line.trim()) wrapped = false;
      continue;
    }
    const m = ROW.exec(line);
    const type = m ? ogeType(m[3]!) : undefined;
    if (!m || !type) {
      const numbered = NUMBERED.test(line);
      if (numbered || !wrapped) unread++;
      wrapped = numbered;
      continue;
    }
    wrapped = false;
    const date = ogeDate(m[4]!, filed);
    const amount = ogeAmount(m[6]!);
    rows.push({
      row: m[1] ? Number(m[1]) : rows.length + unread + 1,
      description: m[2]!.replace(/\s+/g, " ").trim(),
      type,
      ...(date ? { date } : {}),
      ...(amount ? { amountLow: amount.low, ...(amount.high !== undefined ? { amountHigh: amount.high } : {}) } : {}),
      late: /^[yv]/i.test(m[5]!),
    });
  }
  return { rows, unread };
}

export interface Oge278t {
  rows: OgeTransaction[];
  unread: number;
  /** Which extractor read the PDF, or why nothing did. */
  via?: string;
  reason?: string;
  fetchedAt: string;
}

/**
 * One public 278-T's transactions, read from its PDF (several MB, a scan with
 * an OCR layer: pdftotext reads it, the built-in reader does not). Reports are
 * immutable, so a parse is kept a year.
 */
export async function oge278t(filing: Pick<OgeFiling, "id" | "url" | "date">): Promise<Oge278t> {
  const url = filing.url;
  if (!url) throw new ProviderError(OGE_SOURCE, "this report is available on request only (OGE Form 201), not as a public PDF", 404);
  const read = async (): Promise<Oge278t> => {
    const res = await fetchBinary(url, { accept: "application/pdf,*/*", timeoutMs: 120_000 });
    if (!res.ok) throw new ProviderError(OGE_SOURCE, `${url} (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
    const pdf = await extractPdf(res.bytes, { engines: ["pdftotext", "anydoc", "ocr"] });
    const parsed = pdf.text ? parse278tText(pdf.text, filing.date) : { rows: [], unread: 0 };
    return { ...parsed, ...(pdf.via ? { via: pdf.via } : {}), ...(pdf.reason ? { reason: pdf.reason } : {}), fetchedAt: res.fetchedAt };
  };
  // Only a report that read is kept: an extractor installed later deserves another try.
  let fresh: Oge278t | undefined;
  const cached = await cachedJson(`oge:278t:${filing.id}`, TTL.immutable, async () => {
    fresh = await read();
    return fresh.rows.length ? fresh : undefined;
  });
  return cached ?? fresh ?? read();
}
