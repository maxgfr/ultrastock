// Kraken history exports (History → Export) → ledger transactions. Two CSVs,
// told apart by their header:
//
//   trades.csv: txid,ordertxid,pair,time,type,ordertype,price,cost,fee,vol,margin,misc,ledgers
//     one row per execution; price, cost and fee in the quote currency, vol in
//     the base (https://support.kraken.com/articles/360001184886-how-to-interpret-trades-history-fields).
//   ledgers.csv: txid,refid,time,type,subtype,aclass,asset,amount,fee,balance
//     one row per balance change; amount and fee in `asset`, balance =
//     previous + amount − fee (https://support.kraken.com/articles/360001169383-how-to-interpret-ledger-history-fields).
//
// trades.csv carries the trades; from ledgers.csv only what trades.csv lacks
// is taken — deposits, withdrawals (with their fee), staking/earn rewards, and
// the spend/receive pairs of instant and card buys (paired by refid). Its
// "trade" rows are skipped (they duplicate trades.csv), as are moves between
// spot and staking/earn wallets. Margin trades are skipped (the ledger has no
// leverage). Rows without a txid are Kraken's pending duplicates and skipped.
//
// Asset codes (https://support.kraken.com/articles/360001185506-how-to-interpret-asset-codes):
// legacy X/Z-prefixed codes map to tickers (XXBT/XBT→BTC, XETH→ETH, XXDG→DOGE,
// ZEUR→EUR, ZUSD→USD, …) and staking/earn variants to their coin (DOT.S, ETH2.S,
// USDT.M, SOL.F → DOT, ETH, USDT, SOL). Pairs become ultrastock's form:
// XXBTZEUR → BTCEUR, with the quote as currency. Fiat and stablecoins are cash;
// other coins are positions, and a coin deposited or earned is a transfer-in of
// <COIN><quote> (quote from --map {"quote": …}, else EUR) without a price —
// it enters at the position's running average cost.
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

const ORIGIN = "import:kraken";

const LEGACY: Record<string, string> = {
  XXBT: "BTC",
  XBT: "BTC",
  XETH: "ETH",
  ETH2: "ETH",
  XXDG: "DOGE",
  XDG: "DOGE",
  XLTC: "LTC",
  XXRP: "XRP",
  XXLM: "XLM",
  XXMR: "XMR",
  XETC: "ETC",
  XZEC: "ZEC",
  XREP: "REP",
  XMLN: "MLN",
  ZEUR: "EUR",
  ZUSD: "USD",
  ZGBP: "GBP",
  ZCAD: "CAD",
  ZJPY: "JPY",
  ZAUD: "AUD",
};

/** A Kraken asset code as a ticker: XXBT → BTC, ZEUR → EUR, DOT.S → DOT, ETH2.S → ETH. */
export function krakenAsset(code: string): string {
  const s = code
    .trim()
    .toUpperCase()
    .replace(/\.(S|M|F|P|B|HOLD)$/, "");
  return LEGACY[s] ?? s;
}

const PAIR_QUOTES = [
  "ZEUR",
  "ZUSD",
  "ZGBP",
  "ZCAD",
  "ZJPY",
  "XXBT",
  "XETH",
  "USDT",
  "USDC",
  "EUR",
  "USD",
  "GBP",
  "CAD",
  "CHF",
  "JPY",
  "AUD",
  "XBT",
  "ETH",
  "DAI",
];

/** A Kraken pair as base and quote tickers: XXBTZEUR, XBTUSDT, DOTEUR, "SOL/EUR". */
export function krakenPair(pair: string): { base: string; quote: string } | undefined {
  const s = pair.trim().toUpperCase();
  const slash = /^([A-Z0-9.]+)\/([A-Z0-9.]+)$/.exec(s);
  if (slash) return { base: krakenAsset(slash[1]!), quote: krakenAsset(slash[2]!) };
  if (s.length === 8 && LEGACY[s.slice(0, 4)] && LEGACY[s.slice(4)]) return { base: LEGACY[s.slice(0, 4)]!, quote: LEGACY[s.slice(4)]! };
  const q = PAIR_QUOTES.find((x) => s.endsWith(x) && s.length > x.length);
  return q ? { base: krakenAsset(s.slice(0, -q.length)), quote: krakenAsset(q) } : undefined;
}

/** Parse a Kraken trades.csv or ledgers.csv export. */
export function parseKraken(text: string, opts: ImportOptions): ImportResult {
  const rows = csvRowsWithLines(text);
  const lg = findHeader(rows, ["refid", "asset", "amount", "balance"]);
  if (lg >= 0) return ledgers(recordsAfter(rows, lg), opts);
  const tr = findHeader(rows, ["pair", "type", "price", "vol"]);
  if (tr >= 0) return trades(recordsAfter(rows, tr), opts);
  const res = emptyResult();
  res.warnings.push("no Kraken trades.csv (txid,ordertxid,pair,…,vol) or ledgers.csv (txid,refid,…,asset,amount,fee,balance) header found");
  return res;
}

function trades(recs: Array<{ line: number; rec: Record<string, string> }>, opts: ImportOptions): ImportResult {
  const res = emptyResult();
  for (const { line, rec } of recs) {
    const pair = krakenPair(rec.pair ?? "");
    const side = (rec.type ?? "").toLowerCase();
    const date = statementDate(rec.time);
    const price = statementNumber(rec.price, ".");
    const vol = statementNumber(rec.vol, ".");
    const fee = statementNumber(rec.fee, ".") ?? 0;
    if (!pair || !date || price === undefined || !vol || (side !== "buy" && side !== "sell")) {
      res.skipped.push({ line, reason: `unreadable trade row (pair "${rec.pair ?? ""}", time, type "${rec.type ?? ""}", price or vol)` });
      continue;
    }
    if ((statementNumber(rec.margin, ".") ?? 0) !== 0) {
      res.skipped.push({ line, reason: "margin trade: the ledger has no leverage" });
      continue;
    }
    accept(res, line, {
      date,
      type: side === "buy" ? "buy" : "sell",
      account: opts.account,
      symbol: pairSymbol(pair.base, pair.quote),
      quantity: Math.abs(vol),
      price,
      fee: Math.abs(fee) || undefined,
      currency: pair.quote,
      note: rec.txid ? `kraken trade ${rec.txid}` : undefined,
      origin: ORIGIN,
    });
  }
  return res;
}

const INTERNAL_SUBTYPES = /spottostaking|stakingfromspot|stakingtospot|spotfromstaking|spottofutures|spotfromfutures|allocation|deallocation|migration/;

function ledgers(recs: Array<{ line: number; rec: Record<string, string> }>, opts: ImportOptions): ImportResult {
  const res = emptyResult();
  const quote = (opts.quote ?? "EUR").toUpperCase();
  const legs = new Map<string, Array<{ line: number; asset: string; amount: number; fee: number; date: string }>>();
  for (const { line, rec } of recs) {
    const type = (rec.type ?? "").toLowerCase();
    const subtype = (rec.subtype ?? "").toLowerCase();
    const asset = krakenAsset(rec.asset ?? "");
    const amount = statementNumber(rec.amount, ".");
    const fee = Math.abs(statementNumber(rec.fee, ".") ?? 0);
    const date = statementDate(rec.time);
    if (!rec.txid) {
      res.skipped.push({ line, reason: "entry without a ledger id (Kraken's pending duplicate of a settled entry)" });
      continue;
    }
    if (!date || amount === undefined || !asset) {
      res.skipped.push({ line, reason: `unreadable ledger row (time "${rec.time ?? ""}", asset or amount "${rec.amount ?? ""}")` });
      continue;
    }
    if (type === "trade" || type === "margin" || type === "rollover" || type === "settled") {
      res.skipped.push({ line, reason: `"${type}" ledger leg — import trades.csv for trades` });
      continue;
    }
    if (type === "spend" || type === "receive") {
      const k = rec.refid || rec.txid;
      legs.set(k, [...(legs.get(k) ?? []), { line, asset, amount, fee, date }]);
      continue;
    }
    const reward = type === "staking" || (type === "earn" && subtype === "reward") || (type === "dividend" && amount > 0);
    if (type === "transfer" || type === "earn" || INTERNAL_SUBTYPES.test(subtype)) {
      if (!reward) {
        res.skipped.push({ line, reason: `"${type}${subtype ? `/${subtype}` : ""}" moves funds between Kraken wallets — nothing to book` });
        continue;
      }
    }
    if (type !== "deposit" && type !== "withdrawal" && !reward) {
      res.skipped.push({ line, reason: `ledger type "${type}" is not imported` });
      continue;
    }
    if (CASH_ASSETS.has(asset)) {
      accept(res, line, {
        date,
        type: reward ? "interest" : type === "deposit" ? "deposit" : "withdrawal",
        account: opts.account,
        amount: reward ? amount : type === "deposit" ? Math.abs(amount) : -Math.abs(amount),
        currency: asset,
        note: reward ? `kraken ${type} reward` : undefined,
        origin: ORIGIN,
      });
      if (fee > 0) accept(res, line, { date, type: "fee", account: opts.account, amount: -fee, currency: asset, note: `kraken ${type} fee`, origin: ORIGIN });
      continue;
    }
    const out = type === "withdrawal";
    accept(res, line, {
      date,
      type: out ? "transfer-out" : "transfer-in",
      account: opts.account,
      symbol: pairSymbol(asset, quote),
      quantity: round(out ? Math.abs(amount) + fee : Math.abs(amount) - fee),
      currency: quote,
      note: reward ? `kraken ${type} reward: no price in the export, booked at the running average cost` : undefined,
      origin: ORIGIN,
    });
  }
  // Instant / card buys and sells: a spend leg and a receive leg share a refid.
  for (const [ref, ls] of legs) {
    const spend = ls.find((l) => l.amount < 0);
    const recv = ls.find((l) => l.amount > 0);
    if (!spend || !recv || ls.length !== 2) {
      for (const l of ls) res.skipped.push({ line: l.line, reason: `spend/receive ${ref} without its other leg` });
      continue;
    }
    const spendCash = CASH_ASSETS.has(spend.asset);
    const recvCash = CASH_ASSETS.has(recv.asset);
    if (spendCash === recvCash) {
      for (const l of ls) res.skipped.push({ line: l.line, reason: `conversion between two ${spendCash ? "cash assets" : "coins"} is not imported` });
      continue;
    }
    if (spendCash) {
      const qty = round(recv.amount - recv.fee);
      accept(res, recv.line, {
        date: recv.date,
        type: "buy",
        account: opts.account,
        symbol: pairSymbol(recv.asset, spend.asset),
        quantity: qty,
        price: round(Math.abs(spend.amount) / qty),
        fee: spend.fee || undefined,
        currency: spend.asset,
        note: `kraken instant buy ${ref}`,
        origin: ORIGIN,
      });
    } else {
      const qty = round(Math.abs(spend.amount) + spend.fee);
      accept(res, spend.line, {
        date: spend.date,
        type: "sell",
        account: opts.account,
        symbol: pairSymbol(spend.asset, recv.asset),
        quantity: qty,
        price: round(recv.amount / qty),
        fee: recv.fee || undefined,
        currency: recv.asset,
        note: `kraken instant sell ${ref}`,
        origin: ORIGIN,
      });
    }
  }
  const coins = [...new Set(res.transactions.filter((t) => t.type.startsWith("transfer")).map((t) => t.symbol))];
  if (coins.length)
    res.warnings.push(`coin movements booked as transfers of ${coins.join(", ")} — pass --map '{"quote":"USD"}' if you hold them against another quote`);
  return res;
}
