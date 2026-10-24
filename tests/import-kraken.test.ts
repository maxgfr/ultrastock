import { describe, expect, it } from "vitest";
import { krakenAsset, krakenPair, parseStatement } from "../src/portfolio/import/index.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { bySymbol, replay, sample } from "./helpers/import.js";

const parse = (file: string) => parseStatement("kraken", sample(file), { account: "kraken" });

describe("Kraken asset codes and pairs", () => {
  it("maps legacy X/Z codes and staking variants", () => {
    expect(["XXBT", "XBT", "XETH", "ZEUR", "ZUSD", "XXDG", "DOT.S", "ETH2.S", "USDT.M", "SOL"].map(krakenAsset)).toEqual([
      "BTC",
      "BTC",
      "ETH",
      "EUR",
      "USD",
      "DOGE",
      "DOT",
      "ETH",
      "USDT",
      "SOL",
    ]);
    expect(krakenPair("XXBTZEUR")).toEqual({ base: "BTC", quote: "EUR" });
    expect(krakenPair("XETHZUSD")).toEqual({ base: "ETH", quote: "USD" });
    expect(krakenPair("DOTEUR")).toEqual({ base: "DOT", quote: "EUR" });
    expect(krakenPair("XBTUSDT")).toEqual({ base: "BTC", quote: "USDT" });
    expect(krakenPair("SOL/EUR")).toEqual({ base: "SOL", quote: "EUR" });
    expect(krakenPair("???")).toBeUndefined();
  });
});

describe("Kraken exports", () => {
  it("trades.csv: buys and sells with the quote-currency fee; margin and malformed rows skipped", () => {
    const r = parse("kraken-trades.csv");
    expect(r.transactions.map((t) => `${t.type}:${t.symbol}`)).toEqual(["buy:BTCEUR", "buy:ETHUSD", "buy:DOTEUR", "sell:BTCEUR", "buy:SOLEUR"]);
    expect(r.transactions[0]).toMatchObject({ date: "2026-01-05T10:30:00", quantity: 0.01, price: 38000, fee: 0.988, currency: "EUR" });
    expect(r.skipped).toEqual([
      { line: 7, reason: "margin trade: the ledger has no leverage" },
      { line: 8, reason: expect.stringMatching(/pair "\?\?\?"/) },
    ]);
    expect(replay(r.transactions).positions.find((p) => p.symbol === "BTCEUR")!.quantity).toBeCloseTo(0.006, 12);
  });
  it("ledgers.csv: deposits, withdrawals with fees, rewards and instant buys; trade legs skipped", () => {
    const r = parse("kraken-ledgers.csv");
    expect(r.transactions.map((t) => `${t.type}:${t.symbol ?? t.currency}`)).toEqual([
      "deposit:EUR",
      "transfer-in:BTCEUR",
      "transfer-in:DOTEUR",
      "interest:EUR",
      "transfer-out:BTCEUR",
      "withdrawal:EUR",
      "fee:EUR",
      "buy:ETHEUR",
    ]);
    // A coin withdrawal takes its network fee out of the holding too.
    expect(bySymbol(r.transactions, "BTCEUR")[1]).toMatchObject({ type: "transfer-out", quantity: 0.0202 });
    // An instant buy: the spend and receive legs that share a refid.
    expect(bySymbol(r.transactions, "ETHEUR")[0]).toMatchObject({ quantity: 0.04, price: 2500, fee: 1.49, currency: "EUR" });
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.line, s.reason]));
    expect(reasons[3]).toMatch(/pending duplicate/);
    expect(reasons[5]).toMatch(/import trades\.csv/);
    expect(reasons[9]).toMatch(/between Kraken wallets/);
    expect(reasons[14]).toMatch(/adjustment/);
    expect(reasons[15]).toMatch(/yesterday/);
    expect(r.warnings.join(" ")).toMatch(/BTCEUR, DOTEUR/);
  });
  it("both files replay together and dedupe on re-import", async () => {
    const txs = [...parse("kraken-trades.csv").transactions, ...parse("kraken-ledgers.csv").transactions];
    const book = replay(txs);
    expect(book.positions.find((p) => p.symbol === "BTCEUR")!.quantity).toBeCloseTo(0.05 + 0.01 - 0.004 - 0.0202, 12);
    expect((await appendTransactions(txs, "test-kraken")).added).toHaveLength(txs.length);
    expect((await appendTransactions(txs, "test-kraken")).duplicates).toBe(txs.length);
  });
});
