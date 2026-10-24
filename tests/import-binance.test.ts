import { describe, expect, it } from "vitest";
import { amountWithUnit, parseStatement } from "../src/portfolio/import/index.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { bySymbol, replay, sample } from "./helpers/import.js";

const parse = (file: string, quote?: string) => parseStatement("binance", sample(file), { account: "binance", quote });

describe("Binance exports", () => {
  it("reads quantities that carry their unit", () => {
    expect(amountWithUnit("0.0012BTC")).toEqual({ value: 0.0012, unit: "BTC" });
    expect(amountWithUnit("1,250.5USDT")).toEqual({ value: 1250.5, unit: "USDT" });
    expect(amountWithUnit("0.5 1INCH")).toEqual({ value: 0.5, unit: "1INCH" });
    expect(amountWithUnit("42")).toEqual({ value: 42, unit: undefined });
    expect(amountWithUnit("lots")).toBeUndefined();
  });
  it("Trade History: pairs, base-coin fees netted, BNB fees as their own transaction", () => {
    const r = parse("binance-trades.csv");
    const btc = bySymbol(r.transactions, "BTCUSDT")[0]!;
    // 0.0012 BTC bought, 0.0000012 BTC kept as fee: the position holds the rest, cash spent stays 48 USDT.
    expect(btc).toMatchObject({ type: "buy", quantity: 0.0011988, price: 40000, fee: 0.048, currency: "USDT" });
    expect(btc.quantity! * btc.price! + btc.fee!).toBeCloseTo(48, 10);
    const eth = bySymbol(r.transactions, "ETHUSDT");
    expect(eth.map((t) => [t.type, t.currency, t.quantity ?? t.amount])).toEqual([
      ["buy", "USDT", 0.5],
      ["fee", "BNB", -0.0006],
      ["sell", "USDT", 0.2],
    ]);
    expect(bySymbol(r.transactions, "SOLEUR")[0]).toMatchObject({ currency: "EUR", fee: 0.3 });
    expect(r.skipped.map((s) => s.line)).toEqual([7, 8]);
    expect(r.skipped[0]!.reason).toMatch(/side "HOLD"/);
    expect(r.warnings.join(" ")).toMatch(/BNB/);
    const book = replay(r.transactions);
    expect(book.cash.find((c) => c.currency === "BNB")!.amount).toBeCloseTo(-0.0006, 12);
    expect(book.positions.find((p) => p.symbol === "ETHUSDT")).toMatchObject({ quantity: 0.3 });
  });
  it("reads the older Trade History layout (Market, Type, Amount, Total, Fee Coin)", () => {
    const old = "Date(UTC),Market,Type,Price,Amount,Total,Fee,Fee Coin\n2026-01-05 10:30:00,ETHBTC,BUY,0.05,2,0.1,0.0001,BTC\n";
    const r = parseStatement("binance", old, { account: "binance" });
    expect(r.transactions).toEqual([
      {
        date: "2026-01-05T10:30:00",
        type: "buy",
        account: "binance",
        symbol: "ETHBTC",
        quantity: 2,
        price: 0.05,
        fee: 0.0001,
        currency: "BTC",
        origin: "import:binance",
      },
    ]);
  });
  it("Transaction History: deposits, withdrawals and income; trade legs and wallet moves skipped", () => {
    const r = parse("binance-transactions.csv");
    expect(r.transactions.map((t) => `${t.type}:${t.symbol ?? t.currency}`)).toEqual([
      "deposit:USDT",
      "transfer-in:BTCUSDT",
      "interest:USDT",
      "transfer-in:ETHUSDT",
      "transfer-out:BTCUSDT",
      "withdrawal:USDT",
    ]);
    expect(r.transactions.find((t) => t.type === "withdrawal")!.amount).toBe(-500);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.line, s.reason]));
    expect(reasons[4]).toMatch(/trade leg/);
    expect(reasons[9]).toMatch(/between Binance wallets/);
    expect(reasons[12]).toMatch(/not-a-date/);
    expect(reasons[13]).toMatch(/Mystery Operation/);
    expect(replay(r.transactions).positions.find((p) => p.symbol === "BTCUSDT")!.quantity).toBeCloseTo(0.006, 12);
    // The quote option names the pair coin movements are booked against.
    expect(bySymbol(parse("binance-transactions.csv", "EUR").transactions, "BTCEUR")).toHaveLength(2);
  });
  it("dedupes a re-import", async () => {
    const txs = [...parse("binance-trades.csv").transactions, ...parse("binance-transactions.csv").transactions];
    const first = await appendTransactions(txs, "test-binance");
    expect(first.added).toHaveLength(txs.length);
    expect((await appendTransactions(txs, "test-binance")).added).toHaveLength(0);
  });
});
