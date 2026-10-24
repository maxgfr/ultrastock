// What every statement parser shares: the result shape, a CSV reader that
// remembers the physical line each row started on (so a skipped row can be
// pointed at), date and number readers that never consult the local time
// zone, crypto pair and cash-asset rules, and a pre-check that mirrors the
// ledger's own validation — a parser hands back only transactions the ledger
// will accept, and reports the rest in `skipped` with a reason.
import { parseLooseNumber } from "../../core/csv.js";
import type { Transaction } from "../ledger.js";

export type ImportTx = Omit<Transaction, "id">;

export interface ImportResult {
  transactions: ImportTx[];
  /** Rows not imported: the 1-based physical line in the file and why. */
  skipped: Array<{ line: number; reason: string }>;
  warnings: string[];
}

export interface ImportOptions {
  /** Envelope / account id the transactions are booked to. */
  account: string;
  /**
   * Crypto only: the quote currency of the pair a coin movement that has no
   * trade pair (a deposit, a withdrawal, a staking reward) is booked against —
   * BTC deposited becomes a transfer-in of BTC<quote>. Defaults per venue.
   */
  quote?: string;
}

export const emptyResult = (): ImportResult => ({ transactions: [], skipped: [], warnings: [] });

export interface CsvRow {
  line: number;
  cells: string[];
}

/** RFC 4180 rows with the physical line each started on; blank rows dropped. */
export function csvRowsWithLines(text: string, delimiter?: string): CsvRow[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sep = delimiter ?? sniffSeparator(src);
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const flush = () => {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push({ line: start, cells: row });
    row = [];
    cell = "";
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      flush();
      line++;
      start = line;
    } else cell += ch;
  }
  if (cell !== "" || row.length) flush();
  return rows;
}

/** The separator of the line with the most of one: `;`, tab or `,` (disclaimer lines before the header carry none or few). */
export function sniffSeparator(text: string): string {
  let best: [string, number] = [",", 0];
  for (const line of text.split(/\r?\n/, 30)) {
    for (const d of [";", "\t", ","]) {
      const n = line.split(d).length - 1;
      if (n > best[1]) best = [d, n];
    }
  }
  return best[0];
}

/** A header key reduced to lowercase letters and digits: "Date(UTC)" → "dateutc", "Buy/Sell" → "buysell". */
export const normKey = (k: string): string =>
  k
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

/** The rows after `header` as records keyed by normalised header names. */
export function recordsAfter(rows: readonly CsvRow[], headerIndex: number): Array<{ line: number; rec: Record<string, string> }> {
  const header = rows[headerIndex]?.cells.map(normKey) ?? [];
  return rows.slice(headerIndex + 1).map((r) => ({ line: r.line, rec: Object.fromEntries(header.map((h, i) => [h, (r.cells[i] ?? "").trim()])) }));
}

/** Index of the first row whose normalised cells include every `required` key. */
export function findHeader(rows: readonly CsvRow[], required: readonly string[], within = 40): number {
  for (let i = 0; i < Math.min(rows.length, within); i++) {
    const keys = new Set(rows[i]!.cells.map(normKey));
    if (required.every((k) => keys.has(k))) return i;
  }
  return -1;
}

/**
 * A statement date as "YYYY-MM-DD", or "YYYY-MM-DDTHH:MM:SS" when the cell
 * carries a time (kept so two identical fills on one day stay distinct).
 * Reads 2026-01-05, 20260105, "20260105;103000", "2026-01-05, 10:30:00",
 * 2026-01-05T10:30:00Z, "2026-01-05 10:30:00.123", and day-first (or, with
 * order "MDY", month-first) 05/01/2026, 05.01.2026, 05-01-2026. No time zone
 * arithmetic: statements give UTC or the venue's day, and the day is kept.
 */
export function statementDate(raw: string | undefined, order: "DMY" | "MDY" = "DMY"): string | undefined {
  const s = (raw ?? "").trim();
  let y: string;
  let mo: string;
  let d: string;
  let time: [string, string, string?] | undefined;
  const iso = /^(\d{4})-?(\d{2})-?(\d{2})(?:(?:[T ;]|,\s*)(\d{2}):?(\d{2})(?::?(\d{2}))?)?/.exec(s);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:(?:[T ]|,\s*)(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (iso) {
    [y, mo, d] = [iso[1]!, iso[2]!, iso[3]!];
    if (iso[4]) time = [iso[4], iso[5]!, iso[6]];
  } else if (dmy) {
    y = dmy[3]!;
    [d, mo] = order === "DMY" ? [dmy[1]!, dmy[2]!] : [dmy[2]!, dmy[1]!];
    if (dmy[4]) time = [dmy[4], dmy[5]!, dmy[6]];
  } else return undefined;
  const M = Number(mo);
  const D = Number(d);
  if (M < 1 || M > 12 || D < 1 || D > 31) return undefined;
  const day = `${y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
  if (!time) return day;
  const [hh, mm, ss] = time;
  if (Number(hh) > 23 || Number(mm) > 59) return undefined;
  return `${day}T${hh.padStart(2, "0")}:${mm}:${(ss ?? "00").padStart(2, "0")}`;
}

/**
 * A number in a statement cell. `decimal: ","` reads the French form
 * ("1 234,56", "0,125"), `"."` the English one ("1,234.56"); without a hint
 * the loose reader decides (and "0,125" would read as 125 — pass the hint).
 */
export function statementNumber(raw: string | undefined, decimal?: "," | "."): number | undefined {
  if (raw === undefined) return undefined;
  if (!decimal) return parseLooseNumber(raw);
  let s = raw.replace(/[\s  $€£%]/g, "");
  if (!s || s === "-" || s === "—") return undefined;
  s = decimal === "," ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Fiat currencies and dollar/euro stablecoins: balances in them are cash, not positions. */
export const CASH_ASSETS = new Set([
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "JPY",
  "CAD",
  "AUD",
  "TRY",
  "BRL",
  "PLN",
  "SEK",
  "NOK",
  "DKK",
  "USDT",
  "USDC",
  "FDUSD",
  "BUSD",
  "TUSD",
  "DAI",
  "EURC",
  "PYUSD",
]);

/** Quote assets a concatenated pair can end with, longest first so FDUSD wins over USD. */
const PAIR_QUOTES = [
  "FDUSD",
  "USDT",
  "USDC",
  "BUSD",
  "TUSD",
  "EURC",
  "EUR",
  "USD",
  "GBP",
  "TRY",
  "BRL",
  "JPY",
  "AUD",
  "CHF",
  "CAD",
  "PLN",
  "BTC",
  "ETH",
  "BNB",
  "DAI",
];

/** Split a pair: "BTCUSDT", "ETH-EUR", "SOL/USDC" → base and quote; undefined when no known quote ends it. */
export function splitPair(pair: string): { base: string; quote: string } | undefined {
  const s = pair.trim().toUpperCase();
  const sep = /^([A-Z0-9]{1,15})[-/_]([A-Z0-9]{2,6})$/.exec(s);
  if (sep) return { base: sep[1]!, quote: sep[2]! };
  const quote = PAIR_QUOTES.find((q) => s.endsWith(q) && s.length > q.length);
  return quote ? { base: s.slice(0, -quote.length), quote } : undefined;
}

/** ultrastock's form of a crypto pair: base and quote concatenated (ETH-EUR → ETHEUR); the quote is the currency. */
export const pairSymbol = (base: string, quote: string): string => `${base}${quote}`.toUpperCase();

/**
 * Why the ledger would refuse this transaction, or undefined when it would
 * accept it — the same rules as the ledger's own validation, applied before
 * the append so one bad row is skipped instead of failing the whole import.
 */
export function ledgerRefusal(t: ImportTx): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}/.test(t.date)) return `date "${t.date}" is not YYYY-MM-DD`;
  if (!/^[A-Z]{3,5}$/.test(t.currency)) return `currency "${t.currency}" is not a 3–5 letter code`;
  const trade = t.type === "buy" || t.type === "sell" || t.type === "transfer-in" || t.type === "transfer-out";
  if ((trade || t.type === "split") && !t.symbol) return `a ${t.type} needs a symbol`;
  if ((trade || t.type === "split") && !(typeof t.quantity === "number" && Number.isFinite(t.quantity) && t.quantity > 0))
    return `a ${t.type} needs a positive quantity`;
  if ((t.type === "buy" || t.type === "sell") && !(typeof t.price === "number" && Number.isFinite(t.price) && t.price >= 0)) return `a ${t.type} needs a price`;
  const cash = t.type === "deposit" || t.type === "withdrawal" || t.type === "dividend" || t.type === "interest" || t.type === "fee" || t.type === "tax";
  if (cash && !(typeof t.amount === "number" && Number.isFinite(t.amount))) return `a ${t.type} needs an amount`;
  return undefined;
}

/** Push `t` when the ledger would take it, else record why on `line`. Drops undefined optional fields so ids stay stable. */
export function accept(res: ImportResult, line: number, t: ImportTx): void {
  const clean = Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined && v !== "")) as unknown as ImportTx;
  const why = ledgerRefusal(clean);
  if (why) res.skipped.push({ line, reason: why });
  else res.transactions.push(clean);
}

/** Round away binary noise (0.1 + 0.2) without losing satoshis. */
export const round = (n: number, dp = 10): number => Number(n.toFixed(dp));
