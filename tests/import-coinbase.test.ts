import { describe, expect, it } from "vitest";
import { parseStatement } from "../src/portfolio/import/index.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { bySymbol, replay, sample } from "./helpers/import.js";

const parse = (text: string) => parseStatement("coinbase", text, { account: "coinbase" });

describe("Coinbase transaction history", () => {
  const r = parse(sample("coinbase.csv"));
  it("skips the preamble and maps buys, sells, converts, sends, receives and income", () => {
    expect(r.transactions.map((t) => `${t.type}:${t.symbol ?? t.currency}`)).toEqual([
      "deposit:EUR",
      "buy:BTCEUR",
      "buy:ETHEUR",
      "sell:ETHEUR",
      "buy:BTCEUR",
      "transfer-in:ETHEUR",
      "transfer-in:XLMEUR",
      "transfer-out:BTCEUR",
      "transfer-in:ETHEUR",
      "sell:BTCEUR",
      "withdrawal:EUR",
    ]);
    // Execution price from the subtotal, fee from "Fees and/or Spread"; the cash out is the total.
    const buy = r.transactions[1]!;
    expect(buy).toMatchObject({ quantity: 0.01, price: 38000, fee: 5.99 });
    expect(buy.quantity! * buy.price! + buy.fee!).toBeCloseTo(385.99, 8);
    // Convert: a sell of ETH and a buy of BTC that move no cash.
    const [sell, into] = [r.transactions[3]!, r.transactions[4]!];
    expect(sell).toMatchObject({ quantity: 0.05, price: 2450, fee: 1.84, note: "convert to BTC" });
    expect(into).toMatchObject({ quantity: 0.003175, note: "convert from ETH" });
    expect(sell.quantity! * sell.price! - sell.fee! - into.quantity! * into.price!).toBeCloseTo(0, 6);
    // Income enters at the spot price; a receive at the running average cost.
    expect(r.transactions[5]).toMatchObject({ type: "transfer-in", quantity: 0.0005, price: 2500 });
    expect(r.transactions[8]!.price).toBeUndefined();
    expect(r.transactions[7]).toMatchObject({ type: "transfer-out", quantity: 0.002 });
  });
  it("reports skipped rows", () => {
    expect(r.skipped.map((s) => s.line)).toEqual([15, 16, 17]);
    expect(r.skipped[0]!.reason).toMatch(/inside Coinbase/);
    expect(r.skipped[1]!.reason).toMatch(/Retail Synthetic Migration/);
    expect(r.skipped[2]!.reason).toMatch(/yesterday/);
  });
  it("replays without selling beyond holdings and dedupes on re-import", async () => {
    const book = replay(r.transactions);
    expect(book.positions.find((p) => p.symbol === "BTCEUR")!.quantity).toBeCloseTo(0.01 + 0.003175 - 0.002 - 0.005, 12);
    expect(book.cash.find((c) => c.currency === "EUR")!.amount).toBeCloseTo(1000 - 385.99 - 481.2 + 197.01 - 100, 6);
    expect((await appendTransactions(r.transactions, "test-coinbase")).added).toHaveLength(11);
    expect((await appendTransactions(parse(sample("coinbase.csv")).transactions, "test-coinbase")).added).toHaveLength(0);
  });
  it("reads the ID / Price Currency layout and the older USD-named columns", () => {
    const withId = [
      "ID,Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes",
      "abc,2026-02-01 10:00:00 UTC,Buy,SOL,2,USD,$100.00,$200.00,$202.00,$2.00,",
    ].join("\n");
    expect(bySymbol(parse(withId).transactions, "SOLUSD")[0]).toMatchObject({ date: "2026-02-01T10:00:00", quantity: 2, price: 100, fee: 2, currency: "USD" });
    const old = [
      "Transactions",
      "User,Synthetic,0000",
      "Timestamp,Transaction Type,Asset,Quantity Transacted,USD Spot Price at Transaction,USD Subtotal,USD Total (inclusive of fees),USD Fees,Notes",
      "2021-01-05T10:00:00Z,Buy,BTC,0.1,30000,3000,3015,15,Bought 0.1 BTC",
    ].join("\n");
    expect(parse(old).transactions[0]).toMatchObject({ symbol: "BTCUSD", quantity: 0.1, price: 30000, fee: 15, currency: "USD" });
  });
});
