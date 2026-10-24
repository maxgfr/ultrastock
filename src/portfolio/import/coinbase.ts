// Coinbase account statement (Statements / Reports → Transaction history →
// CSV) → ledger transactions. The file opens with a few lines of preamble
// ("Transactions", "User,<name>,<id>", a tax disclaimer) that are skipped up
// to the header row:
//
//   Timestamp,Transaction Type,Asset,Quantity Transacted,Spot Price Currency,
//   Spot Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),
//   Fees and/or Spread,Notes
//
// Also read: the variant with a leading ID column and "Price Currency" /
// "Price at Transaction", and the older layout whose money columns carry the
// currency in their name ("USD Spot Price at Transaction", "USD Subtotal",
// "USD Total (inclusive of fees)", "USD Fees"). Money cells may carry a
// currency sign ("€1,234.56"); signs are ignored, the transaction type says
// the direction. Coinbase publishes no column reference for the retail
// statement (its help centre, https://help.coinbase.com, documents how to
// generate it, not its columns): the columns are those of the exports users
// download — best-effort.
//
// Mapping (symbol = <ASSET><price currency>, e.g. BTCEUR; currency = the price currency):
//   Buy / Advanced Trade Buy    → buy; price = Subtotal ÷ quantity (the execution
//                                  price, spread included), fee = Fees and/or Spread
//   Sell / Advanced Trade Sell  → sell, same rule
//   Convert                     → two legs at the same time: a sell of the asset
//                                  converted (proceeds = Subtotal, fee) and a buy of
//                                  the asset received (read from Notes "Converted
//                                  0.01 ETH to 0.0005 BTC") costing Subtotal − fee,
//                                  so no cash moves
//   Send / Receive              → transfer-out / transfer-in (a receive enters at
//                                  the position's running average cost: its
//                                  original cost is not in the file)
//   Staking Income, Rewards Income, Learning Reward, Coinbase Earn, Inflation
//   Reward                      → transfer-in at the spot price (income at
//                                  market value is its cost basis)
//   Deposit / Withdrawal of fiat → deposit / withdrawal
// Fiat and stablecoin assets are cash: their sends, receives and rewards are
// deposits, withdrawals and interest.
import {
  accept,
  CASH_ASSETS,
  csvRowsWithLines,
  emptyResult,
  findHeader,
  type ImportOptions,
  type ImportResult,
  pairSymbol,
  recordsAfter,
  round,
  statementDate,
  statementNumber,
} from "./shared.js";

const ORIGIN = "import:coinbase";

const BUYS = new Set(["buy", "advanced trade buy", "advance trade buy"]);
const SELLS = new Set(["sell", "advanced trade sell", "advance trade sell"]);
const INCOME = new Set(["staking income", "rewards income", "learning reward", "coinbase earn", "inflation reward", "interest"]);
const INTERNAL = new Set(["exchange deposit", "exchange withdrawal", "pro deposit", "pro withdrawal", "retail staking transfer", "retail unstaking transfer"]);

/** The money columns of whichever layout the header uses. */
function columnsOf(rec: Record<string, string>): { currencyFixed?: string; currency?: string; price: string; subtotal: string; fees?: string } {
  const keys = Object.keys(rec);
  const old = keys.map((k) => /^([a-z]{3})spotpriceattransaction$/.exec(k)).find(Boolean);
  if (old) {
    const c = old[1]!;
    return {
      currencyFixed: c.toUpperCase(),
      price: `${c}spotpriceattransaction`,
      subtotal: `${c}subtotal`,
      fees: keys.find((k) => k.startsWith(`${c}fees`)),
    };
  }
  return {
    currency: keys.includes("spotpricecurrency") ? "spotpricecurrency" : "pricecurrency",
    price: keys.includes("spotpriceattransaction") ? "spotpriceattransaction" : "priceattransaction",
    subtotal: "subtotal",
    fees: keys.find((k) => k.startsWith("feesandorspread") || k === "fees"),
  };
}

/** Parse a Coinbase transaction-history CSV. */
export function parseCoinbase(text: string, opts: ImportOptions): ImportResult {
  const res = emptyResult();
  const rows = csvRowsWithLines(text, ",");
  const h = findHeader(rows, ["timestamp", "transactiontype", "asset", "quantitytransacted"]);
  if (h < 0) {
    res.warnings.push("no Coinbase header (Timestamp,Transaction Type,Asset,Quantity Transacted,…) found");
    return res;
  }
  const recs = recordsAfter(rows, h);
  const cols = recs[0] ? columnsOf(recs[0].rec) : undefined;
  for (const { line, rec } of recs) {
    if (!cols) break;
    const kind = (rec.transactiontype ?? "").trim().toLowerCase();
    const asset = (rec.asset ?? "").trim().toUpperCase();
    const qty = Math.abs(statementNumber(rec.quantitytransacted) ?? Number.NaN);
    const date = statementDate(rec.timestamp);
    const currency = (cols.currencyFixed ?? rec[cols.currency ?? ""] ?? "").trim().toUpperCase();
    const spot = statementNumber(rec[cols.price]);
    const subtotal = Math.abs(statementNumber(rec[cols.subtotal]) ?? Number.NaN);
    const fee = Math.abs(statementNumber(cols.fees ? rec[cols.fees] : undefined) ?? 0);
    if (!date || !asset || !Number.isFinite(qty) || qty === 0) {
      res.skipped.push({ line, reason: `unreadable row (timestamp "${rec.timestamp ?? ""}", asset or quantity "${rec.quantitytransacted ?? ""}")` });
      continue;
    }
    if (INTERNAL.has(kind)) {
      res.skipped.push({ line, reason: `"${rec.transactiontype}" moves funds inside Coinbase — nothing to book` });
      continue;
    }
    const execPrice = Number.isFinite(subtotal) && subtotal > 0 ? round(subtotal / qty) : spot;
    const base = { date, account: opts.account, origin: ORIGIN } as const;
    const cashAsset = CASH_ASSETS.has(asset);
    if (BUYS.has(kind) || SELLS.has(kind)) {
      accept(res, line, {
        ...base,
        type: BUYS.has(kind) ? "buy" : "sell",
        symbol: pairSymbol(asset, currency),
        quantity: qty,
        price: execPrice,
        fee: fee || undefined,
        currency,
      });
      continue;
    }
    if (kind === "convert") {
      const m = /converted\s+([\d.,]+)\s+([A-Z0-9]+)\s+to\s+([\d.,]+)\s+([A-Z0-9]+)/i.exec(rec.notes ?? "");
      const toQty = statementNumber(m?.[3]);
      const to = m?.[4]?.toUpperCase();
      if (!m || !to || !toQty || !Number.isFinite(subtotal)) {
        res.skipped.push({ line, reason: 'convert without a readable "Converted <qty> <asset> to <qty> <asset>" note or subtotal' });
        continue;
      }
      if (cashAsset || CASH_ASSETS.has(to)) {
        res.skipped.push({ line, reason: `convert between ${asset} and ${to} involves a cash asset — record it as a buy or sell by hand` });
        continue;
      }
      accept(res, line, {
        ...base,
        type: "sell",
        symbol: pairSymbol(asset, currency),
        quantity: qty,
        price: execPrice,
        fee: fee || undefined,
        currency,
        note: `convert to ${to}`,
      });
      accept(res, line, {
        ...base,
        type: "buy",
        symbol: pairSymbol(to, currency),
        quantity: toQty,
        price: round((subtotal - fee) / toQty),
        currency,
        note: `convert from ${asset}`,
      });
      continue;
    }
    const income = INCOME.has(kind);
    const into = kind === "receive" || kind === "deposit" || income;
    const outOf = kind === "send" || kind === "withdrawal";
    if (!into && !outOf) {
      res.skipped.push({ line, reason: `transaction type "${rec.transactiontype}" is not imported` });
      continue;
    }
    if (cashAsset) {
      accept(res, line, {
        ...base,
        type: income ? "interest" : into ? "deposit" : "withdrawal",
        amount: into ? qty : -qty,
        currency: asset,
        note: income ? `coinbase ${kind}` : undefined,
      });
      continue;
    }
    if (!currency) {
      res.skipped.push({ line, reason: `${kind} of ${asset} without a price currency to name its pair` });
      continue;
    }
    accept(res, line, {
      ...base,
      type: into ? "transfer-in" : "transfer-out",
      symbol: pairSymbol(asset, currency),
      quantity: qty,
      price: income ? spot : undefined,
      currency,
      note: income ? `coinbase ${kind} at the spot price` : undefined,
    });
  }
  return res;
}
