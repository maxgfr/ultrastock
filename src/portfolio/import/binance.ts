// Binance statement exports → ledger transactions. Two CSV files, told apart
// by their header:
//
//   Trade History (Orders → Spot Order → Trade History → Export):
//     Date(UTC),Pair,Side,Price,Executed,Amount,Fee
//     2026-01-05 10:30:00,BTCUSDT,BUY,40000,0.0012BTC,48USDT,0.0000012BTC
//   quantities carry their unit in the cell: Executed is in the base asset,
//   Amount in the quote asset, Fee in whatever coin was charged. The older
//   layout (Date(UTC),Market,Type,Price,Amount,Total,Fee,Fee Coin — bare
//   numbers, the fee coin in its own column) is read too.
//
//   Transaction History (Wallet → Transaction History → Export):
//     User_ID,UTC_Time,Account,Operation,Coin,Change,Remark
//   one row per balance change. Deposits, withdrawals and income (staking
//   rewards, Simple Earn interest, distributions, airdrops, rebates) are
//   imported; trade legs ("Buy", "Sell", "Transaction Related", "Fee", …) are
//   skipped because the Trade History carries the same trades with their
//   prices; moves between Binance wallets (Spot ↔ Funding ↔ Earn) are skipped
//   because they change nothing the ledger tracks.
// Help pages: https://www.binance.com/en/support/faq/how-to-download-spot-trading-transaction-history-statement-e4ff64f2533f4d23a0b3f8f17f510eab
// and https://www.binance.com/en/support/faq/how-to-generate-transaction-history-990afa0a0a9341f78e7a9298a9575163
// (the help pages describe the export steps, not the columns: the column sets
// here are the ones these exports are known to carry — best-effort).
//
// Choices, so the cash and the positions replay right:
//   - Symbol = the pair as ultrastock writes it (BTCUSDT), currency = the quote.
//   - Fee in the quote asset → the trade's `fee`.
//   - Fee in the base asset (Binance's default on buys) → the quantity is net
//     of it (a buy of 0.0012 BTC with 0.0000012 BTC fee holds 0.0011988) and the
//     fee's quote value goes into `fee`, so the cash spent stays exactly Amount.
//   - Fee in a third coin (BNB discount) → a separate `fee` transaction whose
//     currency IS that coin (amount −0.0001 BNB): the ledger's cash line for
//     BNB records it, the BNBUSDT position is not touched (the ledger has no
//     way to take units out of a position for a fee). Documented in the note.
//   - Fiat and stablecoins (EUR, USDT, USDC, …) are cash: their deposits and
//     withdrawals are `deposit`/`withdrawal`, their income `interest`. Other
//     coins are positions: a deposit is a `transfer-in` of <COIN><quote> (quote
//     from the --map {"quote": …} option, else USDT), a reward a `transfer-in`
//     without a price (it enters at the position's running average cost —
//     the export has no price; add its market value by hand for tax).
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
  splitPair,
  statementDate,
  statementNumber,
} from "./shared.js";

const ORIGIN = "import:binance";

/** "0.0012BTC" → { value: 0.0012, unit: "BTC" }; a bare number has no unit. */
export function amountWithUnit(cell: string | undefined): { value: number; unit?: string } | undefined {
  const m = /^\s*(-?[\d.,]+(?:[eE][-+]?\d+)?)\s*([A-Za-z][A-Za-z0-9]{1,14}|\d[A-Za-z][A-Za-z0-9]{0,13})?\s*$/.exec(cell ?? "");
  if (!m) return undefined;
  const value = statementNumber(m[1]);
  return value === undefined ? undefined : { value, unit: m[2]?.toUpperCase() };
}

/** Parse a Binance Trade History or Transaction History CSV export. */
export function parseBinance(text: string, opts: ImportOptions): ImportResult {
  const rows = csvRowsWithLines(text);
  const tx = findHeader(rows, ["operation", "coin", "change"]);
  if (tx >= 0) return transactionHistory(recordsAfter(rows, tx), opts);
  const tr = findHeader(rows, ["dateutc", "price"]);
  if (tr >= 0) return tradeHistory(recordsAfter(rows, tr), opts);
  const res = emptyResult();
  res.warnings.push("no Binance Trade History (Date(UTC),Pair,Side,…) or Transaction History (UTC_Time,Operation,Coin,Change,…) header found");
  return res;
}

function tradeHistory(recs: Array<{ line: number; rec: Record<string, string> }>, opts: ImportOptions): ImportResult {
  const res = emptyResult();
  for (const { line, rec } of recs) {
    const pairCell = rec.pair ?? rec.market ?? "";
    const side = (rec.side ?? rec.type ?? "").toUpperCase();
    const date = statementDate(rec.dateutc);
    const price = statementNumber(rec.price);
    // New layout: Executed (base, with unit), Amount (quote, with unit), Fee (with unit).
    // Old layout: Amount (base), Total (quote), Fee + Fee Coin.
    const newLayout = rec.executed !== undefined;
    const executed = amountWithUnit(newLayout ? rec.executed : rec.amount);
    const quoteAmt = amountWithUnit(newLayout ? rec.amount : rec.total);
    const feeCell = amountWithUnit(rec.fee);
    const pair = splitPair(pairCell);
    const base = executed?.unit ?? pair?.base;
    const quote = quoteAmt?.unit ?? pair?.quote;
    if (!date || price === undefined || !executed || (side !== "BUY" && side !== "SELL") || !base || !quote) {
      res.skipped.push({ line, reason: `unreadable trade row (date, side "${side}", price, executed amount or pair "${pairCell}")` });
      continue;
    }
    const feeCoin = (feeCell?.unit ?? rec.feecoin ?? quote).toUpperCase();
    const fee = Math.abs(feeCell?.value ?? 0);
    const symbol = pairSymbol(base, quote);
    let quantity = Math.abs(executed.value);
    let feeQuote = 0;
    if (fee > 0 && feeCoin === quote) feeQuote = fee;
    else if (fee > 0 && feeCoin === base) {
      // Charged in the coin traded: a buy delivers less, a sell takes more.
      quantity = round(side === "BUY" ? quantity - fee : quantity + fee);
      feeQuote = round(fee * price);
    }
    accept(res, line, {
      date,
      type: side === "BUY" ? "buy" : "sell",
      account: opts.account,
      symbol,
      quantity,
      price,
      fee: feeQuote || undefined,
      currency: quote,
      note: feeCoin === base && fee > 0 ? `fee of ${fee} ${base} netted from the quantity` : undefined,
      origin: ORIGIN,
    });
    if (fee > 0 && feeCoin !== quote && feeCoin !== base)
      accept(res, line, {
        date,
        type: "fee",
        account: opts.account,
        symbol,
        amount: -fee,
        currency: feeCoin,
        note: `trading fee paid in ${feeCoin} for a ${symbol} ${side.toLowerCase()} (booked as ${feeCoin} cash, the ${feeCoin} position is not reduced)`,
        origin: ORIGIN,
      });
  }
  if (res.transactions.some((t) => t.type === "fee"))
    res.warnings.push(
      "fees paid in a third coin (BNB) are booked as negative cash in that coin, not as a reduction of its position — see the transaction notes",
    );
  return res;
}

const DEPOSIT_OPS = new Set(["deposit", "fiat deposit", "crypto deposit"]);
const WITHDRAW_OPS = new Set(["withdraw", "withdrawal", "fiat withdraw", "fiat withdrawal", "crypto withdrawal"]);
const INTERNAL = /subscription|redemption|transfer|main and funding|funding account|savings purchase|staking purchase|locked|allocation/;
const INCOME = /interest|reward|distribution|airdrop|rebate|cashback|bonus|mining|launchpool|referral|income/;
const TRADE_LEG = /buy|sell|sold|transaction|fee|small assets|convert|otc|trade|spend|revenue|exchange/;

function transactionHistory(recs: Array<{ line: number; rec: Record<string, string> }>, opts: ImportOptions): ImportResult {
  const res = emptyResult();
  const quote = (opts.quote ?? "USDT").toUpperCase();
  const coinsAsPositions = new Set<string>();
  for (const { line, rec } of recs) {
    const op = (rec.operation ?? "").trim().toLowerCase();
    const coin = (rec.coin ?? "").trim().toUpperCase();
    const change = statementNumber(rec.change);
    const date = statementDate(rec.utctime);
    if (!date || change === undefined || !coin) {
      res.skipped.push({ line, reason: `unreadable row (time "${rec.utctime ?? ""}", coin or change "${rec.change ?? ""}")` });
      continue;
    }
    const kind = DEPOSIT_OPS.has(op)
      ? "in"
      : WITHDRAW_OPS.has(op)
        ? "out"
        : INTERNAL.test(op)
          ? "internal"
          : INCOME.test(op)
            ? "income"
            : TRADE_LEG.test(op)
              ? "trade"
              : "unknown";
    if (kind === "internal" || kind === "trade" || kind === "unknown") {
      res.skipped.push({
        line,
        reason:
          kind === "internal"
            ? `"${rec.operation}" moves coins between Binance wallets — nothing to book`
            : kind === "trade"
              ? `"${rec.operation}" is a trade leg — import the Trade History export for trades`
              : `operation "${rec.operation}" is not imported`,
      });
      continue;
    }
    const amount = Math.abs(change);
    if (CASH_ASSETS.has(coin)) {
      accept(res, line, {
        date,
        type: kind === "in" ? "deposit" : kind === "out" ? "withdrawal" : "interest",
        account: opts.account,
        amount: kind === "out" ? -amount : amount,
        currency: coin,
        note: kind === "income" ? `binance: ${op}` : undefined,
        origin: ORIGIN,
      });
      continue;
    }
    coinsAsPositions.add(coin);
    accept(res, line, {
      date,
      type: kind === "out" ? "transfer-out" : "transfer-in",
      account: opts.account,
      symbol: pairSymbol(coin, quote),
      quantity: amount,
      currency: quote,
      note: kind === "income" ? `binance ${op}: no price in the export, booked at the running average cost` : undefined,
      origin: ORIGIN,
    });
  }
  if (coinsAsPositions.size)
    res.warnings.push(
      `coin movements booked as transfers of ${[...coinsAsPositions].map((c) => pairSymbol(c, quote)).join(", ")} — pass --map '{"quote":"EUR"}' if you hold them against another quote`,
    );
  return res;
}
