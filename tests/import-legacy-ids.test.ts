// Importers and ledger ids: a ledger written by an earlier release must not see its rows come back under new ids, and
// an IBKR split must be replayed where the statement puts it.
import { describe, expect, it } from "vitest";
import { parseStatement } from "../src/portfolio/import/index.js";
import { buildBook, type Transaction, transactionId } from "../src/portfolio/ledger.js";

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
