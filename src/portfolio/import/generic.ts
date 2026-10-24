// Any broker's CSV, read through a column map the user supplies — the way in
// for brokers without a dedicated parser (French banks and brokers above all).
//
//   --map '{"date":"Date","type":"Type","symbol":"Ticker","quantity":"Qty","price":"Price","fee":"Fees","currency":"Ccy"}'
//
// Map keys (values are header names, matched without case or accents):
//   date (required), type, symbol, isin, quantity, price, amount, fee, currency, note
// and options:
//   defaultType      a ledger type for every row when the file has no type column
//   defaultCurrency  the currency when the file has no currency column (else EUR, with a warning)
//   dateOrder        "DMY" (default: 05/01/2026 is 5 January) or "MDY"
//   decimal          "," or "." — default "," when the delimiter is ";", else auto
//   delimiter        ";", "," or "\t" — default: sniffed
//   types            extra type words → ledger types, e.g. {"ACHAT COMPTANT":"buy"}
//
// Type words are recognised in English and French (accents ignored, inside a
// longer label too): achat/buy/souscription → buy; vente/sell/rachat → sell;
// dividende/dividend/coupon/distribution → dividend; dépôt/versement/deposit →
// deposit; retrait/withdrawal → withdrawal; intérêts/interest → interest;
// impôt/taxe/prélèvements/retenue/withholding/CSG → tax; frais/fee/commission/
// courtage/droits de garde → fee; split/division → split. Amount signs are
// normalised by type (deposits, dividends and interest +, withdrawals, fees and
// taxes −); a buy or sell without a price takes it from a net amount:
// buy price = (|amount| − fee) / quantity, sell price = (|amount| + fee) / quantity.
// A row without a symbol uses its ISIN (the router resolves EU ISINs).
//
// Named maps (--map boursorama|fortuneo|trade-republic) are BEST-EFFORT: none
// of these brokers publishes the column layout of its export, so the column
// names below are the usual ones, not verified against a reference — a column
// a named map expects but the file lacks is reported, and an explicit JSON map
// overrides it.
import { deaccent } from "../../engine.js";
import type { TxType } from "../ledger.js";
import {
  accept,
  csvRowsWithLines,
  emptyResult,
  type ImportOptions,
  type ImportResult,
  normKey,
  round,
  sniffSeparator,
  statementDate,
  statementNumber,
} from "./shared.js";

const ORIGIN = "import:generic";

export interface ColumnMap {
  date: string;
  type?: string;
  symbol?: string;
  isin?: string;
  quantity?: string;
  price?: string;
  amount?: string;
  fee?: string;
  currency?: string;
  note?: string;
  defaultType?: TxType;
  defaultCurrency?: string;
  dateOrder?: "DMY" | "MDY";
  decimal?: "," | ".";
  delimiter?: string;
  types?: Record<string, TxType>;
}

const COLUMN_KEYS = ["date", "type", "symbol", "isin", "quantity", "price", "amount", "fee", "currency", "note"] as const;
const OPTION_KEYS = ["defaultType", "defaultCurrency", "dateOrder", "decimal", "delimiter", "types"] as const;
const TX_TYPES: readonly TxType[] = ["deposit", "withdrawal", "buy", "sell", "dividend", "interest", "fee", "tax", "split", "transfer-in", "transfer-out"];

/** Ready-made maps for French brokers' exports — all best-effort (see the module header). */
export const GENERIC_PRESETS: Record<string, { map: ColumnMap; verified: boolean; source: string }> = {
  boursorama: {
    map: {
      date: "Date opération",
      type: "Opération",
      isin: "Code ISIN",
      quantity: "Quantité",
      price: "Cours",
      fee: "Frais",
      amount: "Montant net",
      currency: "Devise",
      decimal: ",",
      delimiter: ";",
    },
    verified: false,
    source: "Boursorama/BoursoBank documents how to export, not the columns of the securities-account export",
  },
  fortuneo: {
    map: {
      date: "Date",
      type: "Opération",
      isin: "Code ISIN",
      quantity: "Qté",
      price: "Cours",
      fee: "Courtage",
      amount: "Montant net",
      currency: "Devise",
      decimal: ",",
      delimiter: ";",
    },
    verified: false,
    source: "Fortuneo publishes no column reference for its order-history export",
  },
  "trade-republic": {
    map: { date: "Date", type: "Type", isin: "ISIN", quantity: "Shares", price: "Price", fee: "Fee", amount: "Amount", currency: "Currency", decimal: "." },
    verified: false,
    source: "Trade Republic's in-app transaction export (2025) has no published column reference",
  },
};

/** Validate a column map parsed from --map JSON; throws an Error naming what is wrong. */
export function checkColumnMap(raw: unknown): ColumnMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error('the column map is a JSON object such as {"date":"Date","type":"Type"}');
  const o = raw as Record<string, unknown>;
  const allowed = new Set<string>([...COLUMN_KEYS, ...OPTION_KEYS, "quote"]);
  const unknown = Object.keys(o).filter((k) => !allowed.has(k));
  if (unknown.length) throw new Error(`unknown column-map key(s) ${unknown.join(", ")} — use ${[...COLUMN_KEYS, ...OPTION_KEYS].join(", ")}`);
  for (const k of COLUMN_KEYS) if (o[k] !== undefined && typeof o[k] !== "string") throw new Error(`column-map "${k}" names a header, a string`);
  if (typeof o.date !== "string" || !o.date) throw new Error('the column map needs "date" (the header of the date column)');
  if (o.type === undefined && o.defaultType === undefined)
    throw new Error('the column map needs "type" (a column) or "defaultType" (one ledger type for every row)');
  if (o.defaultType !== undefined && !TX_TYPES.includes(o.defaultType as TxType)) throw new Error(`defaultType is one of ${TX_TYPES.join(", ")}`);
  if (o.dateOrder !== undefined && o.dateOrder !== "DMY" && o.dateOrder !== "MDY") throw new Error('dateOrder is "DMY" or "MDY"');
  if (o.decimal !== undefined && o.decimal !== "," && o.decimal !== ".") throw new Error('decimal is "," or "."');
  if (o.delimiter !== undefined && ![";", ",", "\t", "|"].includes(o.delimiter as string)) throw new Error('delimiter is ";", ",", "|" or a tab');
  if (o.defaultCurrency !== undefined && !/^[A-Za-z]{3,5}$/.test(String(o.defaultCurrency))) throw new Error("defaultCurrency is a currency code such as EUR");
  if (o.types !== undefined) {
    if (!o.types || typeof o.types !== "object") throw new Error('types maps words to ledger types, e.g. {"ACHAT COMPTANT":"buy"}');
    for (const [w, t] of Object.entries(o.types as Record<string, unknown>))
      if (!TX_TYPES.includes(t as TxType)) throw new Error(`types["${w}"] is "${String(t)}", not one of ${TX_TYPES.join(", ")}`);
  }
  return o as unknown as ColumnMap;
}

const fold = (s: string) => deaccent(s).toLowerCase().trim();
const headerKey = (s: string) => normKey(deaccent(s));

/** Ordered: the first rule that matches a label wins (a withholding on a dividend is a tax, not a dividend). */
const TYPE_WORDS: Array<[RegExp, TxType]> = [
  [/\b(retenue|withholding|prelevements?|impots?|taxes?|tax|csg)\b/, "tax"],
  [/\b(dividendes?|dividends?|coupons?|distributions?)\b/, "dividend"],
  [/\b(achats?|buy|bought|purchase|souscriptions?)\b/, "buy"],
  [/\b(ventes?|sell|sold|sale|rachats?)\b/, "sell"],
  [/\b(depots?|versements?|deposits?|apports?)\b/, "deposit"],
  [/\b(retraits?|withdrawals?|withdraw)\b/, "withdrawal"],
  [/\b(interets?|interest)\b/, "interest"],
  [/\b(frais|fees?|commissions?|courtage|droits de garde)\b/, "fee"],
  [/\b(split|division)\b/, "split"],
];

/** The ledger type a type cell names, in English or French; undefined when none matches. */
export function typeFromWord(raw: string, extra: Record<string, TxType> = {}): TxType | undefined {
  const w = fold(raw);
  for (const [k, t] of Object.entries(extra)) if (fold(k) === w) return t;
  if (TX_TYPES.includes(w as TxType)) return w as TxType;
  return TYPE_WORDS.find(([re]) => re.test(w))?.[1];
}

/** Parse a CSV through a column map. `presetName` relaxes missing optional columns to warnings. */
export function parseGeneric(text: string, opts: ImportOptions & { map: ColumnMap; presetName?: string }): ImportResult {
  const res = emptyResult();
  const map = opts.map;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = map.delimiter ?? sniffSeparator(src);
  const decimal = map.decimal ?? (delimiter === ";" ? "," : undefined);
  const rows = csvRowsWithLines(src, delimiter);
  const want = headerKey(map.date);
  const h = rows.findIndex((r) => r.cells.some((c) => headerKey(c) === want));
  const hint = opts.presetName ? ` (the "${opts.presetName}" map is best-effort: pass --map '{…}' with your file's headers)` : "";
  if (h < 0) throw new Error(`no header row with the date column "${map.date}" in the file${hint}`);
  const header = rows[h]!.cells.map(headerKey);
  const col: Partial<Record<(typeof COLUMN_KEYS)[number], number>> = {};
  const missing: string[] = [];
  for (const k of COLUMN_KEYS) {
    const name = map[k];
    if (name === undefined) continue;
    const i = header.indexOf(headerKey(name));
    if (i < 0) missing.push(`${k} → "${name}"`);
    else col[k] = i;
  }
  const available = rows[h]!.cells.map((c) => `"${c.trim()}"`).join(", ");
  if (missing.length) {
    const fatal = !opts.presetName || col.date === undefined || (map.type !== undefined && col.type === undefined);
    const msg = `column(s) not in the file: ${missing.join(", ")} — the header is ${available}`;
    if (fatal) throw new Error(`${msg}${hint}`);
    res.warnings.push(`${msg} — those fields are left empty`);
  }
  if (opts.presetName && GENERIC_PRESETS[opts.presetName] && !GENERIC_PRESETS[opts.presetName]!.verified)
    res.warnings.push(`the "${opts.presetName}" column map is best-effort (${GENERIC_PRESETS[opts.presetName]!.source}) — check the result with --dry-run`);
  const defaultCurrency = (map.defaultCurrency ?? "EUR").toUpperCase();
  if (col.currency === undefined && !map.defaultCurrency) res.warnings.push("no currency column: every row is booked in EUR (set defaultCurrency in the map)");
  let pricedFromAmount = 0;
  let isinAsSymbol = 0;
  for (const r of rows.slice(h + 1)) {
    const cell = (k: (typeof COLUMN_KEYS)[number]) => {
      const i = col[k];
      return i === undefined ? undefined : (r.cells[i] ?? "").trim() || undefined;
    };
    const n = (k: (typeof COLUMN_KEYS)[number]) => statementNumber(cell(k), decimal);
    const date = statementDate(cell("date"), map.dateOrder ?? "DMY");
    if (!date) {
      res.skipped.push({ line: r.line, reason: `unreadable date "${cell("date") ?? ""}"` });
      continue;
    }
    const word = cell("type");
    const type = word !== undefined ? typeFromWord(word, map.types) : map.defaultType;
    if (!type) {
      res.skipped.push({ line: r.line, reason: `type "${word ?? ""}" is not a known operation (add it to "types" in the map)` });
      continue;
    }
    const isin = cell("isin")?.toUpperCase();
    let symbol = cell("symbol")?.toUpperCase();
    if (!symbol && isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) && !["deposit", "withdrawal", "interest", "fee"].includes(type)) {
      symbol = isin;
      isinAsSymbol++;
    }
    const quantity = n("quantity");
    let price = n("price");
    const fee = n("fee");
    let amount = n("amount");
    const currency = (cell("currency") ?? defaultCurrency).toUpperCase();
    if ((type === "buy" || type === "sell") && price === undefined && amount !== undefined && quantity) {
      const f = Math.abs(fee ?? 0);
      price = round((type === "buy" ? Math.abs(amount) - f : Math.abs(amount) + f) / Math.abs(quantity));
      pricedFromAmount++;
    }
    const cashType = type === "deposit" || type === "withdrawal" || type === "dividend" || type === "interest" || type === "fee" || type === "tax";
    if (cashType && amount === undefined && quantity !== undefined && price !== undefined) amount = round(quantity * price);
    if (cashType && amount !== undefined) amount = type === "deposit" || type === "dividend" || type === "interest" ? Math.abs(amount) : -Math.abs(amount);
    accept(res, r.line, {
      date,
      type,
      account: opts.account,
      symbol,
      isin: isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) ? isin : undefined,
      quantity: quantity !== undefined && !cashType ? Math.abs(quantity) : undefined,
      price: cashType ? undefined : price,
      amount: cashType ? amount : undefined,
      fee: !cashType && fee ? Math.abs(fee) : undefined,
      currency,
      note: cell("note"),
      origin: ORIGIN,
    });
  }
  if (pricedFromAmount) res.warnings.push(`${pricedFromAmount} trade(s) had no price: taken from the net amount and the fee`);
  if (isinAsSymbol) res.warnings.push(`${isinAsSymbol} row(s) had no symbol: their ISIN stands in (the router resolves EU ISINs)`);
  return res;
}
