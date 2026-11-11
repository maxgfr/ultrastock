// Importers and ledger ids: a ledger written by an earlier release must not see its rows come back under new ids, and
// an IBKR split must be replayed where the statement puts it.
//
// `tests/helpers/{shared,generic}-before-818a2ef.ts` are `git show 818a2ef^:<path>` (the parser as released before
// the 12-hour-clock change), only so the test shows what an existing ledger holds.
import { describe, expect, it } from "vitest";
import { type ColumnMap, parseStatement } from "../src/portfolio/import/index.js";
import { appendTransactions, buildBook, readLedger, type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { parseGeneric as parseGenericBefore } from "./helpers/generic-before-818a2ef.js";

const MAP: ColumnMap = {
  date: "Date",
  type: "Action",
  symbol: "Symbol",
  quantity: "Quantity",
  price: "Price",
  currency: "Currency",
  dateOrder: "MDY",
  decimal: ".",
};
// A US broker's CSV with a 12-hour clock.
const CSV = [
  "Date,Action,Symbol,Quantity,Price,Currency",
  "1/5/2026 10:15:00 AM,Buy,NVDA,10,100,USD",
  "1/5/2026 2:30:00 PM,Buy,NVDA,10,101,USD",
  "1/6/2026 3:45:00 PM,Sell,NVDA,5,110,USD",
].join("\n");

describe("re-importing a statement with AM/PM times into a ledger imported before 818a2ef", () => {
  it("adds nothing: the rows are already there", async () => {
    // What the previous release wrote (the PM marker was ignored: 2:30 PM was stored as 02:30).
    const before = parseGenericBefore(CSV, { account: "us", map: MAP });
    expect(before.transactions.map((t) => t.date)).toEqual(["2026-01-05T10:15:00", "2026-01-05T02:30:00", "2026-01-06T03:45:00"]);
    expect((await appendTransactions(before.transactions, "review-ampm")).added).toHaveLength(3);
    // The same file, imported again with the current parser.
    const now = parseStatement("generic", CSV, { account: "us", map: MAP });
    const again = await appendTransactions(now.transactions, "review-ampm");
    expect(again.added.map((t) => `${t.date} ${t.type} ${t.quantity}`)).toEqual([]);
    // 20 bought, 5 sold: 15 shares.
    expect(buildBook(readLedger("review-ampm")).positions.map((p) => p.quantity)).toEqual([15]);
  });
  it("a fresh ledger takes the morning and the afternoon fill of the same size apart", async () => {
    const csv = ["Date,Action,Symbol,Quantity,Price,Currency", "1/5/2026 2:30:00 AM,Buy,NVDA,10,100,USD", "1/5/2026 2:30:00 PM,Buy,NVDA,10,100,USD"].join("\n");
    const r = await appendTransactions(parseStatement("generic", csv, { account: "us", map: MAP }).transactions, "fresh-ampm");
    expect(r.added.map((t) => t.date)).toEqual(["2026-01-05T02:30:00", "2026-01-05T14:30:00"]);
  });
});

describe("an IBKR split whose row carries only its report date (the Flex query has no Date/Time field)", () => {
  it("is applied before the trades of that day, which are already in split shares", () => {
    // The repository's own fixture (tests/fixtures/import/ibkr-flex.xml): reportDate="20260402",
    // dateTime="20260401;202500" — the report date is the first day the shares trade split.
    // 10 AAPL bought 04-01 @ 200; 2-for-1 reported 04-02; 15 (split) shares sold 04-02 10:00 @ 101 → 5 left @ 100.
    const xml = `<?xml version="1.0"?><FlexQueryResponse><FlexStatements><FlexStatement accountId="U1">
<Trades>
<Trade accountId="U1" currency="USD" assetCategory="STK" symbol="AAPL" isin="US0378331005" listingExchange="NASDAQ" dateTime="20260401;153000" quantity="10" tradePrice="200" ibCommission="0" buySell="BUY" levelOfDetail="EXECUTION" tradeID="1"/>
<Trade accountId="U1" currency="USD" assetCategory="STK" symbol="AAPL" isin="US0378331005" listingExchange="NASDAQ" dateTime="20260402;100000" quantity="-15" tradePrice="101" ibCommission="0" buySell="SELL" levelOfDetail="EXECUTION" tradeID="2"/>
</Trades>
<CorporateActions>
<CorporateAction accountId="U1" currency="USD" assetCategory="STK" symbol="AAPL" isin="US0378331005" listingExchange="NASDAQ" type="FS" reportDate="20260402" description="AAPL(US0378331005) SPLIT 2 FOR 1 (AAPL, APPLE INC, US0378331005)" quantity="10"/>
</CorporateActions>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
    const r = parseStatement("ibkr-flex", xml, { account: "ibkr" });
    expect(r.transactions.map((t) => [t.type, t.date])).toEqual([
      ["buy", "2026-04-01T15:30:00"],
      ["sell", "2026-04-02T10:00:00"],
      ["split", "2026-04-02"],
    ]);
    const txs = r.transactions.map((t) => ({ ...t, id: transactionId(t) }) as Transaction);
    const book = buildBook(txs);
    expect(book.positions.map((p) => [p.symbol, p.quantity, p.averageCost])).toEqual([["AAPL", 5, 100]]);
  });
  it("keeps the id a split row always had, whichever field dates it", () => {
    const corp = (attrs: string) =>
      `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U1"><CorporateActions><CorporateAction accountId="U1" currency="USD" assetCategory="STK" symbol="AAPL" isin="US0378331005" type="FS" ${attrs} description="AAPL(US0378331005) SPLIT 2 FOR 1" quantity="10"/></CorporateActions></FlexStatement></FlexStatements></FlexQueryResponse>`;
    const id = (xml: string) => parseStatement("ibkr-flex", xml, { account: "ibkr" }).transactions.map((t) => transactionId(t));
    const legacy = transactionId({
      date: "2026-04-02",
      type: "split",
      account: "ibkr",
      symbol: "AAPL",
      isin: "US0378331005",
      quantity: 2,
      currency: "USD",
      origin: "import:ibkr-flex",
    });
    expect(id(corp('reportDate="20260402"'))).toEqual([legacy]);
    expect(id(corp('dateTime="20260402;202500"'))).toEqual([legacy]);
  });
});
