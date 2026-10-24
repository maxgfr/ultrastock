import { describe, expect, it } from "vitest";
import { ibkrSymbol, parseStatement, xmlElementAttrs } from "../src/portfolio/import/index.js";
import { appendTransactions, readLedger } from "../src/portfolio/ledger.js";
import { bySymbol, replay, sample } from "./helpers/import.js";

const parse = (file: string) => parseStatement("ibkr-flex", sample(file), { account: "ibkr" });

describe("IBKR symbols", () => {
  it("keeps US listings, suffixes European ones by exchange, falls back to the ISIN", () => {
    expect(ibkrSymbol({ symbol: "AAPL", listingExchange: "NASDAQ", currency: "USD" })).toBe("AAPL");
    expect(ibkrSymbol({ symbol: "BRK B", listingExchange: "NYSE", currency: "USD" })).toBe("BRK.B");
    expect(ibkrSymbol({ symbol: "MC", listingExchange: "SBF", currency: "EUR" })).toBe("MC.PA");
    expect(ibkrSymbol({ symbol: "ASML", listingExchange: "AEB", currency: "EUR" })).toBe("ASML.AS");
    expect(ibkrSymbol({ symbol: "SAP", listingExchange: "IBIS", currency: "EUR" })).toBe("SAP.DE");
    expect(ibkrSymbol({ symbol: "SAP", listingExchange: "XETRA", currency: "EUR" })).toBe("SAP.DE");
    expect(ibkrSymbol({ symbol: "BP.", listingExchange: "LSE", currency: "GBP" })).toBe("BP.L");
    expect(ibkrSymbol({ symbol: "NESN", listingExchange: "EBS", currency: "CHF" })).toBe("NESN.SW");
    expect(ibkrSymbol({ symbol: "BTC", currency: "USD", assetCategory: "CRYPTO" })).toBe("BTCUSD");
    const warnings: string[] = [];
    expect(ibkrSymbol({ symbol: "XYZ", listingExchange: "KFB", currency: "DKK", isin: "DK0099999990" }, (w) => warnings.push(w))).toBe("DK0099999990");
    expect(ibkrSymbol({ symbol: "XYZ", listingExchange: "TSE", currency: "JPY" }, (w) => warnings.push(w))).toBe("XYZ");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/kept as its ISIN/);
  });
  it("reads XML attributes with entities, skipping comments, with line numbers", () => {
    const xml = '<a>\n<!-- <Trade symbol="NO"/> -->\n<Trade symbol="S&amp;P" q=\'1\'/>\n<Trades><TradeConfirm symbol="X"/></Trades>\n<Trade\n symbol="B" />';
    const els = xmlElementAttrs(xml, "Trade");
    expect(els.map((e) => e.attrs.symbol)).toEqual(["S&P", "B"]);
    expect(els.map((e) => e.line)).toEqual([3, 5]);
    expect(els[0]!.attrs.q).toBe("1");
  });
});

describe("IBKR Flex Query XML", () => {
  const r = parse("ibkr-flex.xml");
  it("maps trades, commissions, taxes and cash transactions", () => {
    expect(r.transactions).toHaveLength(16);
    const aapl = bySymbol(r.transactions, "AAPL");
    expect(aapl.map((t) => t.type)).toEqual(["buy", "sell", "dividend", "tax", "split"]);
    expect(aapl[0]).toMatchObject({ date: "2026-01-05T15:30:00", quantity: 10, price: 190.5, fee: 1, currency: "USD", fxToBase: 0.92, isin: "US0378331005" });
    expect(aapl[1]).toMatchObject({ type: "sell", quantity: 4, price: 200 });
    expect(aapl[3]).toMatchObject({ type: "tax", amount: -0.38 });
    expect(aapl[4]).toMatchObject({ type: "split", quantity: 2, date: "2026-04-01" });
    // Commission plus the French transaction tax.
    expect(bySymbol(r.transactions, "MC.PA")[0]).toMatchObject({ fee: 7.2, currency: "EUR" });
    expect(bySymbol(r.transactions, "SAP.DE")).toHaveLength(1);
    // A commission charged in USD on a GBP trade is its own fee transaction.
    const vusa = bySymbol(r.transactions, "VUSA.L");
    expect(vusa.map((t) => [t.type, t.currency, t.fee ?? t.amount])).toEqual([
      ["buy", "GBP", undefined],
      ["fee", "USD", -3],
    ]);
    expect(bySymbol(r.transactions, "DK0099999990")).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/KFB.*ISIN DK0099999990/);
    const cash = r.transactions.filter((t) => !t.symbol);
    expect(cash.map((t) => [t.type, t.amount, t.currency])).toEqual([
      ["deposit", 5000, "USD"],
      ["deposit", 3000, "EUR"],
      ["deposit", 2000, "GBP"],
      ["interest", 1.2, "USD"],
      ["fee", -10, "USD"],
      ["withdrawal", -500, "USD"],
    ]);
    // The SUMMARY dividend row duplicates the DETAIL one and is not counted twice.
    expect(r.transactions.filter((t) => t.type === "dividend")).toHaveLength(1);
  });
  it("reports skipped rows with a reason and the line", () => {
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.line, s.reason]));
    expect(reasons[8]).toMatch(/order detail row/);
    expect(reasons[14]).toMatch(/asset class OPT/);
    expect(reasons[15]).toMatch(/FX conversion/);
    expect(reasons[16]).toMatch(/quantity "abc"/);
    expect(reasons[28]).toMatch(/Price Adjustments/);
    expect(reasons[32]).toMatch(/corporate action TC/);
    expect(r.skipped).toHaveLength(6);
  });
  it("replays into a consistent book and dedupes on re-import", async () => {
    const book = replay(r.transactions);
    expect(book.positions.find((p) => p.symbol === "AAPL")).toMatchObject({ quantity: 12 });
    expect(book.positions.find((p) => p.symbol === "MC.PA")!.averageCost).toBeCloseTo((1400 + 7.2) / 2, 10);
    const usd = book.cash.find((c) => c.currency === "USD")!.amount;
    expect(usd).toBeCloseTo(5000 - 1906 + 799 + 2.5 - 0.38 + 1.2 - 10 - 500 - 3, 8);
    const first = await appendTransactions(r.transactions, "test-ibkr-xml");
    expect(first.added).toHaveLength(16);
    const again = await appendTransactions(parse("ibkr-flex.xml").transactions, "test-ibkr-xml");
    expect(again).toMatchObject({ added: [], duplicates: 16 });
    expect(readLedger("test-ibkr-xml")).toHaveLength(16);
  });
});

describe("IBKR Flex Query CSV", () => {
  it("reads the plain layout (one header row per section)", () => {
    const r = parse("ibkr-flex-plain.csv");
    expect(r.transactions.map((t) => `${t.type}:${t.symbol ?? t.currency}`)).toEqual([
      "buy:ASML.AS",
      "buy:NESN.SW",
      "sell:ASML.AS",
      "deposit:EUR",
      "deposit:CHF",
      "dividend:ASML.AS",
      "tax:ASML.AS",
    ]);
    expect(r.skipped).toEqual([{ line: 5, reason: "unreadable trade: date" }]);
    expect(replay(r.transactions).positions.find((p) => p.symbol === "ASML.AS")).toMatchObject({ quantity: 2 });
  });
  it("reads header and trailer records (BOF/BOS/HEADER/DATA/EOS/EOF)", () => {
    const r = parse("ibkr-flex-sections.csv");
    expect(r.transactions.map((t) => `${t.type}:${t.symbol ?? t.currency}`)).toEqual(["buy:MSFT", "buy:BRK.B", "deposit:USD", "dividend:MSFT"]);
    expect(r.skipped).toEqual([]);
    expect(replay(r.transactions).positions).toHaveLength(2);
  });
  it("reads the Activity Statement (section-prefixed rows) with listings from the instrument section", () => {
    const r = parse("ibkr-activity.csv");
    expect(bySymbol(r.transactions, "TTE.PA").map((t) => t.type)).toEqual(["buy", "dividend", "tax"]);
    expect(bySymbol(r.transactions, "TTE.PA")[0]).toMatchObject({ quantity: 20, price: 60, fee: 3, isin: "FR0000120271", date: "2026-01-08T09:15:00" });
    expect(bySymbol(r.transactions, "NVDA").map((t) => [t.type, t.quantity])).toEqual([
      ["buy", 5],
      ["sell", 2],
    ]);
    expect(r.transactions.filter((t) => !t.symbol).map((t) => [t.type, t.amount])).toEqual([
      ["deposit", 2000],
      ["deposit", 1000],
      ["interest", 0.42],
      ["fee", -1.5],
    ]);
    expect(r.skipped.map((s) => s.line)).toEqual([11, 25]);
    expect(r.skipped[0]!.reason).toMatch(/FX conversion/);
    replay(r.transactions);
  });
  it("says so when the file is not an IBKR export", () => {
    const r = parseStatement("ibkr-flex", "a,b\n1,2\n", { account: "ibkr" });
    expect(r.transactions).toEqual([]);
    expect(r.warnings[0]).toMatch(/no IBKR/);
  });
});
