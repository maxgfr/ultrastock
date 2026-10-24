// Interactive Brokers statements → ledger transactions.
//
// Reads the four shapes an IBKR user ends up with:
//   - Flex Query XML: FlexQueryResponse/FlexStatements/FlexStatement with
//     <Trades><Trade …/></Trades>, <CashTransactions><CashTransaction …/>,
//     <CorporateActions><CorporateAction …/>, <SecuritiesInfo><SecurityInfo …/>;
//     every field is an attribute (symbol, isin, listingExchange, currency,
//     assetCategory, tradeDate, dateTime, quantity, tradePrice, ibCommission,
//     ibCommissionCurrency, taxes, buySell, levelOfDetail, fxRateToBase, type,
//     amount, description).
//   - Flex Query CSV, plain: one header row per section (ClientAccountID,
//     CurrencyPrimary, AssetClass, Symbol, …, Buy/Sell), the data rows under it.
//   - Flex Query CSV/text with "Include header and trailer records": rows tagged
//     BOF/BOA/BOS/HEADER/DATA/EOS/EOA/EOF with the section code (TRNT trades,
//     CTRN cash transactions, CORP corporate actions) in the first or second cell.
//   - The Activity Statement CSV: every row prefixed with its section name and a
//     row kind ("Trades,Header,…", "Trades,Data,…", "Dividends,Data,…",
//     "Withholding Tax", "Deposits & Withdrawals", "Interest", "Fees",
//     "Corporate Actions", "Financial Instrument Information").
// Field reference: https://www.ibkrguides.com/reportingreference/reportguide/tradesfq.htm,
// https://www.ibkrguides.com/reportingreference/reportguide/cash%20transactionsfq.htm,
// header/trailer records and section codes:
// https://www.ibkrguides.com/reportingreference/reportguide/delivery%20configuration%20and%20general%20configuration.htm
//
// Mapping. Buys and sells of stocks, ETFs, funds and crypto (commission and
// transaction taxes → `fee`, positive; a commission charged in another currency
// becomes its own `fee` transaction in that currency). Options, futures, bonds
// and FX conversions are skipped with a reason: the ledger has no contract
// multiplier, no clean-price convention and no FX transaction. Cash
// transactions: dividends (and payments in lieu), withholding tax → `tax` with
// IBKR's sign (negative; a refund stays positive), deposits/withdrawals by sign,
// broker/bond interest, fees. Splits come from corporate actions whose
// description reads "SPLIT n FOR m" (ratio n/m). When a section carries both
// detail and summary rows (EXECUTION and ORDER trades, DETAIL and SUMMARY cash
// rows), only the detail is taken, so nothing is counted twice.
//
// Symbols: US listings stay as IBKR writes them ("BRK B" → BRK.B); European
// listings take the suffix of their listing exchange (SBF→.PA, AEB→.AS,
// IBIS/XETRA→.DE, LSE→.L, EBS→.SW, …, table below — best-effort: the codes are
// IBKR's exchange abbreviations as they appear in statements). When the
// exchange is not in the table, a non-US ISIN stands in as the symbol (the
// router resolves EU ISINs) and a warning says so.
import { decodeEntities } from "../../engine.js";
import {
  accept,
  type CsvRow,
  csvRowsWithLines,
  emptyResult,
  type ImportOptions,
  type ImportResult,
  normKey,
  pairSymbol,
  round,
  statementDate,
  statementNumber,
} from "./shared.js";

const ORIGIN = "import:ibkr-flex";

/** IBKR listing-exchange code → ultrastock market suffix (only suffixes a provider covers). */
export const IBKR_EXCHANGE_SUFFIX: Record<string, string> = {
  SBF: "PA",
  AEB: "AS",
  "ENEXT.BE": "BR",
  BVL: "LS",
  BVME: "MI",
  "BVME.ETF": "MI",
  OSE: "OL",
  ISED: "IR",
  IBIS: "DE",
  IBIS2: "DE",
  XETRA: "DE",
  LSE: "L",
  LSEETF: "L",
  EBS: "SW",
  VIRTX: "SW",
  BM: "MC",
  SFB: "ST",
  VSE: "VI",
  WSE: "WA",
};
const US_EXCHANGES = new Set(["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS", "IEX", "PINK", "NYSENAT", "ISLAND"]);
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

/** The ultrastock symbol of an IBKR listing, or the ISIN with a warning when the listing cannot be placed. */
export function ibkrSymbol(
  raw: { symbol?: string; listingExchange?: string; currency?: string; isin?: string; assetCategory?: string },
  warn?: (w: string) => void,
): string | undefined {
  const sym = (raw.symbol ?? "").trim().toUpperCase();
  const exch = (raw.listingExchange ?? "").trim().toUpperCase();
  const isin = (raw.isin ?? "").trim().toUpperCase();
  const cat = (raw.assetCategory ?? "").toUpperCase();
  if (cat === "CRYPTO") return sym ? pairSymbol(sym, raw.currency ?? "USD") : undefined;
  const suffix = IBKR_EXCHANGE_SUFFIX[exch];
  if (suffix && sym) return `${sym.replace(/\.$/, "").replace(/\s+/g, "-")}.${suffix}`;
  if (sym && (US_EXCHANGES.has(exch) || (!exch && (raw.currency ?? "USD") === "USD"))) return sym.replace(/\s+/g, ".");
  if (ISIN.test(isin) && !isin.startsWith("US")) {
    warn?.(`${sym || isin} listed on "${exch || "?"}" kept as its ISIN ${isin}: no suffix is known for that exchange`);
    return isin;
  }
  if (sym) warn?.(`${sym} listed on "${exch || "?"}" (${raw.currency ?? "?"}) kept as written: no suffix is known for that exchange — check it resolves`);
  return sym || undefined;
}

// ── a minimal XML attribute reader (no DTD, no namespaces, no eval) ─────────

export interface XmlElement {
  line: number;
  attrs: Record<string, string>;
}

/** Every `<tag …>` / `<tag …/>` element's attributes, comments ignored, entities decoded. */
export function xmlElementAttrs(xml: string, tag: string): XmlElement[] {
  // Blank out comments and CDATA but keep their newlines, so line numbers hold.
  const src = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => m.replace(/[^\n]/g, " "));
  const out: XmlElement[] = [];
  const open = new RegExp(`<${tag}(?=[\\s/>])`, "g");
  const attr = /\s*([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  for (let m = open.exec(src); m; m = open.exec(src)) {
    const attrs: Record<string, string> = {};
    attr.lastIndex = m.index + m[0].length;
    for (let a = attr.exec(src); a; a = attr.exec(src)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
    out.push({ line: src.slice(0, m.index).split("\n").length, attrs });
  }
  return out;
}

// ── records, whatever the container ─────────────────────────────────────────

type Kind = "trade" | "cash" | "corp" | "secinfo";
interface Rec {
  kind: Kind;
  line: number;
  /** Normalised field names (normKey) → raw value. */
  f: Record<string, string>;
}

const pick = (f: Record<string, string>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = f[k];
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return undefined;
};

const normRecord = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [normKey(k), v]));

function xmlRecords(xml: string): Rec[] {
  const recs: Rec[] = [];
  const add = (kind: Kind, tag: string) => {
    for (const e of xmlElementAttrs(xml, tag)) recs.push({ kind, line: e.line, f: normRecord(e.attrs) });
  };
  add("trade", "Trade");
  add("trade", "Order");
  add("cash", "CashTransaction");
  add("corp", "CorporateAction");
  add("secinfo", "SecurityInfo");
  return recs;
}

/** Which kind of section a Flex header row opens, from the fields it carries. */
function kindOfHeader(keys: Set<string>): Kind | undefined {
  if (keys.has("buysell") || keys.has("tradeprice")) return "trade";
  if (keys.has("type") && keys.has("amount") && !keys.has("quantity")) return "cash";
  if (keys.has("type") && keys.has("description") && keys.has("quantity")) return "corp";
  return undefined;
}
const FLEX_SECTION: Record<string, Kind> = { TRNT: "trade", CTRN: "cash", CORP: "corp" };
const FLEX_TAGS = new Set(["BOF", "BOA", "BOS", "HEADER", "DATA", "EOS", "EOA", "EOF"]);
const FIELD_HINTS = new Set([
  "clientaccountid",
  "accountid",
  "currencyprimary",
  "currency",
  "symbol",
  "isin",
  "tradedate",
  "datetime",
  "quantity",
  "tradeprice",
  "buysell",
  "type",
  "amount",
  "description",
  "assetclass",
  "listingexchange",
  "ibcommission",
  "levelofdetail",
  "reportdate",
  "settledate",
]);

/** Activity Statement section name → record kind and, for cash sections, the type the rows stand for. */
const ACTIVITY_SECTIONS: Record<string, { kind: Kind; type?: string }> = {
  trades: { kind: "trade" },
  dividends: { kind: "cash", type: "Dividends" },
  paymentinlieuofdividends: { kind: "cash", type: "Payment In Lieu Of Dividends" },
  withholdingtax: { kind: "cash", type: "Withholding Tax" },
  depositswithdrawals: { kind: "cash", type: "Deposits/Withdrawals" },
  interest: { kind: "cash", type: "Broker Interest" },
  fees: { kind: "cash", type: "Other Fees" },
  corporateactions: { kind: "corp" },
  financialinstrumentinformation: { kind: "secinfo" },
};
const ACTIVITY_ROW_KINDS = new Set(["header", "data", "subtotal", "total", "notes", "metainfo"]);

function ibkrCsvRecords(rows: readonly CsvRow[], res: ImportResult): Rec[] {
  const recs: Rec[] = [];
  const first = rows.find((r) => r.cells.length > 1);
  const c0 = (r: CsvRow) => (r.cells[0] ?? "").trim();
  const c1 = (r: CsvRow) => (r.cells[1] ?? "").trim();
  // Tags are upper case ("HEADER"); the Activity Statement's "Header" row kind is not one.
  if (rows.some((r) => c0(r) === "BOF" || c0(r) === "BOS" || c1(r) === "BOS")) {
    // Header/trailer records: "HEADER","TRNT",fields… / "DATA","TRNT",values…
    const headers: Record<string, string[]> = {};
    for (const r of rows) {
      const [a, b] = [c0(r), c1(r)];
      const tag = FLEX_TAGS.has(a) ? a : b;
      const code = FLEX_TAGS.has(a) ? b : a;
      if (tag === "HEADER") headers[code] = r.cells.slice(2).map(normKey);
      else if (tag === "DATA") {
        const kind = FLEX_SECTION[code];
        const h = headers[code];
        if (!kind) continue;
        if (!h) {
          res.skipped.push({ line: r.line, reason: `${code} data row before its HEADER row` });
          continue;
        }
        recs.push({ kind, line: r.line, f: Object.fromEntries(h.map((k, i) => [k, r.cells[i + 2] ?? ""])) });
      }
    }
    return recs;
  }
  if (first && ACTIVITY_ROW_KINDS.has(normKey(c1(first))) && rows.filter((r) => ACTIVITY_ROW_KINDS.has(normKey(c1(r)))).length >= rows.length * 0.8) {
    // Activity Statement: section,rowKind,fields…
    const headers: Record<string, string[]> = {};
    for (const r of rows) {
      const sec = normKey(c0(r));
      const rk = normKey(c1(r));
      if (rk === "header") headers[sec] = r.cells.slice(2).map(normKey);
      if (rk !== "data") continue;
      const def = ACTIVITY_SECTIONS[sec];
      const h = headers[sec];
      if (!def || !h) continue;
      const f: Record<string, string> = Object.fromEntries(h.map((k, i) => [k, r.cells[i + 2] ?? ""]));
      // "Total" / "Total in EUR" lines sit among Data rows of the cash sections.
      if (/^total/i.test(f.currency ?? "") || /^total/i.test(f.assetcategory ?? "")) continue;
      if (def.type) f.type = def.type;
      recs.push({ kind: def.kind, line: r.line, f });
    }
    return recs;
  }
  // Plain Flex CSV: a header row opens each section.
  let header: string[] | undefined;
  let kind: Kind | undefined;
  for (const r of rows) {
    const keys = r.cells.map(normKey);
    if (keys.filter((k) => FIELD_HINTS.has(k)).length >= 3) {
      header = keys;
      kind = kindOfHeader(new Set(keys));
      continue;
    }
    if (!header) {
      res.skipped.push({ line: r.line, reason: "row before any header row" });
      continue;
    }
    if (!kind) continue;
    const h = header;
    recs.push({ kind, line: r.line, f: Object.fromEntries(h.map((k, i) => [k, r.cells[i] ?? ""])) });
  }
  return recs;
}

// ── mapping ─────────────────────────────────────────────────────────────────

const IMPORTED_ASSETS = new Set(["STK", "STOCKS", "FUND", "FUNDS", "ETF", "CRYPTO", "CRYPTOCURRENCY"]);
const DESCRIPTION_ID = /^\s*([A-Z0-9.\s]+?)\s*\(([A-Z]{2}[A-Z0-9]{9}\d)\)/;

/** Parse an IBKR Flex Query (XML or CSV) or Activity Statement CSV. */
export function parseIbkr(text: string, opts: ImportOptions): ImportResult {
  const res = emptyResult();
  const isXml = /^\s*(<\?xml|<FlexQueryResponse|<FlexStatement)/.test(text.replace(/^﻿/, ""));
  const recs = isXml ? xmlRecords(text) : ibkrCsvRecords(csvRowsWithLines(text), res);
  if (!recs.length) {
    res.warnings.push("no IBKR trade, cash-transaction or corporate-action rows were found — is this a Flex Query or Activity Statement export?");
    return res;
  }
  const warnSet = new Set<string>();
  const warn = (w: string) => warnSet.add(w);

  // Listing exchanges from the instrument section, for rows that lack one.
  const exchangeOf = new Map<string, string>();
  const isinOf = new Map<string, string>();
  for (const r of recs.filter((x) => x.kind === "secinfo")) {
    const ex = pick(r.f, "listingexchange", "listingexch");
    const secIsin = pick(r.f, "isin", "securityid");
    const secSym = pick(r.f, "symbol");
    if (secSym && secIsin) isinOf.set(secSym.toUpperCase(), secIsin);
    if (!ex) continue;
    for (const id of [pick(r.f, "symbol"), pick(r.f, "isin", "securityid"), pick(r.f, "conid")]) if (id) exchangeOf.set(id.toUpperCase(), ex);
  }
  const symbolFor = (f: Record<string, string>, fromDescription = false) => {
    let sym = pick(f, "symbol");
    let isin = pick(f, "isin", "securityid") ?? isinOf.get((pick(f, "symbol") ?? "").toUpperCase());
    if (fromDescription && (!sym || !isin)) {
      const m = DESCRIPTION_ID.exec(pick(f, "description") ?? "");
      if (m) {
        sym ??= m[1]!.trim();
        isin ??= m[2]!;
      }
    }
    const ex =
      pick(f, "listingexchange", "listingexch") ??
      exchangeOf.get((sym ?? "").toUpperCase()) ??
      exchangeOf.get((isin ?? "").toUpperCase()) ??
      exchangeOf.get((pick(f, "conid") ?? "").toUpperCase());
    return {
      symbol:
        sym || isin
          ? ibkrSymbol(
              {
                symbol: sym,
                isin,
                listingExchange: ex,
                currency: pick(f, "currency", "currencyprimary"),
                assetCategory: pick(f, "assetcategory", "assetclass"),
              },
              warn,
            )
          : undefined,
      isin: isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin.toUpperCase()) ? isin.toUpperCase() : undefined,
    };
  };
  const dateOf = (f: Record<string, string>, ...keys: string[]) => {
    for (const k of keys) {
      const v = f[k];
      if (!v) continue;
      const time = k === "tradedate" ? f.tradetime : undefined;
      const d = statementDate(time ? `${v};${time}` : v);
      if (d) return d;
    }
    return undefined;
  };
  const accounts = new Set(recs.map((r) => pick(r.f, "accountid", "clientaccountid")).filter(Boolean));
  if (accounts.size > 1) res.warnings.push(`the file holds ${accounts.size} IBKR accounts; all are booked to "${opts.account}"`);

  // Trades: executions when present, else orders; never lots or summaries.
  const trades = recs.filter((r) => r.kind === "trade");
  const levels = new Set(trades.map((r) => (pick(r.f, "levelofdetail", "datadiscriminator") ?? "EXECUTION").toUpperCase()));
  const wanted = levels.has("EXECUTION") ? "EXECUTION" : levels.has("TRADE") ? "TRADE" : "ORDER";
  for (const r of trades) {
    const f = r.f;
    const level = (pick(f, "levelofdetail", "datadiscriminator") ?? "EXECUTION").toUpperCase();
    if (level !== wanted) {
      res.skipped.push({ line: r.line, reason: `${level.toLowerCase()} detail row (the ${wanted.toLowerCase()} rows are imported)` });
      continue;
    }
    const cat = (pick(f, "assetcategory", "assetclass") ?? "STK").toUpperCase();
    if (!IMPORTED_ASSETS.has(cat)) {
      res.skipped.push({
        line: r.line,
        reason:
          cat === "CASH" || cat === "FOREX"
            ? "FX conversion: the ledger has no FX transaction — record the two cash legs by hand"
            : `asset class ${cat} is not imported (the ledger has no contract multiplier or bond pricing)`,
      });
      continue;
    }
    const side = (pick(f, "buysell") ?? "").toUpperCase();
    if (/CA\.|CANCEL/.test(side)) {
      res.skipped.push({ line: r.line, reason: "cancelled trade" });
      continue;
    }
    const qty = statementNumber(pick(f, "quantity"));
    const price = statementNumber(pick(f, "tradeprice", "tprice", "price"));
    const date = dateOf(f, "datetime", "tradedate", "date");
    const currency = (pick(f, "currency", "currencyprimary") ?? "").toUpperCase();
    if (qty === undefined || qty === 0 || price === undefined || !date) {
      const bad = [qty === undefined || qty === 0 ? `quantity "${pick(f, "quantity") ?? ""}"` : "", price === undefined ? "price" : "", date ? "" : "date"];
      res.skipped.push({ line: r.line, reason: `unreadable trade: ${bad.filter(Boolean).join(", ")}` });
      continue;
    }
    const type = side.startsWith("SELL") || (!side.startsWith("BUY") && qty < 0) ? "sell" : "buy";
    const commission = Math.abs(statementNumber(pick(f, "ibcommission", "commfee", "commission")) ?? 0);
    const taxes = Math.abs(statementNumber(pick(f, "taxes")) ?? 0);
    const commCcy = (pick(f, "ibcommissioncurrency") ?? currency).toUpperCase();
    const fx = statementNumber(pick(f, "fxratetobase"));
    const { symbol, isin } = symbolFor(f);
    const tradeId = pick(f, "tradeid", "transactionid");
    const separateCommission = commission > 0 && commCcy !== currency;
    accept(res, r.line, {
      date,
      type,
      account: opts.account,
      symbol,
      isin,
      quantity: Math.abs(qty),
      price,
      fee: round((separateCommission ? 0 : commission) + taxes) || undefined,
      currency,
      fxToBase: fx && fx > 0 ? fx : undefined,
      note: tradeId ? `IBKR trade ${tradeId}` : undefined,
      origin: ORIGIN,
    });
    if (separateCommission)
      accept(res, r.line, {
        date,
        type: "fee",
        account: opts.account,
        symbol,
        amount: -commission,
        currency: commCcy,
        note: `commission in ${commCcy} on a ${currency} trade${tradeId ? ` (IBKR trade ${tradeId})` : ""}`,
        origin: ORIGIN,
      });
  }

  // Cash transactions: detail rows when the section also carries summaries.
  const cash = recs.filter((r) => r.kind === "cash");
  const hasDetail = cash.some((r) => (pick(r.f, "levelofdetail") ?? "").toUpperCase() === "DETAIL");
  for (const r of cash) {
    const f = r.f;
    if (hasDetail && (pick(f, "levelofdetail") ?? "").toUpperCase() !== "DETAIL") continue;
    const kind = (pick(f, "type") ?? "").toLowerCase();
    const amount = statementNumber(pick(f, "amount"));
    const date = dateOf(f, "datetime", "date", "settledate", "reportdate");
    const currency = (pick(f, "currency", "currencyprimary") ?? "").toUpperCase();
    if (amount === undefined || !date) {
      res.skipped.push({ line: r.line, reason: `unreadable cash transaction: ${amount === undefined ? `amount "${pick(f, "amount") ?? ""}"` : "date"}` });
      continue;
    }
    const type =
      kind.includes("withholding") || /\btax/.test(kind)
        ? "tax"
        : kind.includes("dividend")
          ? "dividend"
          : kind.includes("deposit") || kind.includes("withdraw")
            ? amount >= 0
              ? "deposit"
              : "withdrawal"
            : kind.includes("interest")
              ? "interest"
              : kind.includes("fee") || kind.includes("commission")
                ? "fee"
                : undefined;
    if (!type) {
      res.skipped.push({ line: r.line, reason: `cash transaction type "${pick(f, "type") ?? ""}" is not imported` });
      continue;
    }
    const { symbol, isin } = type === "dividend" || type === "tax" ? symbolFor(f, true) : { symbol: undefined, isin: undefined };
    const fx = statementNumber(pick(f, "fxratetobase"));
    accept(res, r.line, {
      date,
      type,
      account: opts.account,
      symbol,
      isin,
      amount,
      currency,
      fxToBase: fx && fx > 0 ? fx : undefined,
      note: type === "tax" ? "withholding tax" : undefined,
      origin: ORIGIN,
    });
  }

  // Corporate actions: splits only; one transaction per symbol and day.
  const splits = new Set<string>();
  for (const r of recs.filter((x) => x.kind === "corp")) {
    const f = r.f;
    const desc = pick(f, "description", "actiondescription") ?? "";
    const code = (pick(f, "type") ?? "").toUpperCase();
    const m = /SPLIT\s+(\d+(?:\.\d+)?)\s+FOR\s+(\d+(?:\.\d+)?)/i.exec(desc);
    if (!m && code !== "FS" && code !== "RS") {
      res.skipped.push({ line: r.line, reason: `corporate action ${code || "?"} is not imported (only splits are)` });
      continue;
    }
    const ratio = m ? Number(m[1]) / Number(m[2]) : undefined;
    const date = dateOf(f, "datetime", "reportdate", "date");
    if (!ratio || !date) {
      res.skipped.push({ line: r.line, reason: 'split without a readable ratio ("SPLIT n FOR m") or date' });
      continue;
    }
    const { symbol, isin } = symbolFor(f, true);
    const key = `${date.slice(0, 10)}|${symbol}|${ratio}`;
    if (splits.has(key)) continue;
    splits.add(key);
    accept(res, r.line, {
      date: date.slice(0, 10),
      type: "split",
      account: opts.account,
      symbol,
      isin,
      quantity: round(ratio),
      currency: (pick(f, "currency", "currencyprimary") ?? "").toUpperCase(),
      origin: ORIGIN,
    });
  }
  res.warnings.push(...warnSet);
  return res;
}
