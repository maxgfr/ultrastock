// A crypto-asset is the asset, not the pair a platform quotes it in: BTCEUR, BTCUSD and BTCUSDT all hold BTC.
// US: the basis is per unit, in dollars, at the acquisition — a cost paid in another currency is converted at the
// acquisition date's rate, and a move between the user's own platforms carries it whatever pair each uses
// (https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-digital-asset-transactions).
// FR: one global portfolio (CGI art. 150 VH bis, BOI-RPPM-PVBMC-30-20): the pair and the platform do not matter.
// Values are TEST rules (tests/helpers/tax-rules.ts), not law.
import { beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../src/core/profile.js";
import { type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { FranceRegime } from "../src/tax/fr.js";
import type { TaxInput } from "../src/tax/regime.js";
import { UsRegime } from "../src/tax/us.js";
import { installTaxTestRules } from "./helpers/tax-rules.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const raw = { origin: "manual", currency: "EUR", ...t } as Omit<Transaction, "id">;
  return { ...raw, id: transactionId(raw) } as Transaction;
};
const KRAKEN: Envelope = { id: "kraken", type: "CRYPTO", broker: "Kraken", currency: "EUR" };
const BINANCE: Envelope = { id: "binance", type: "CRYPTO", broker: "Binance", currency: "USD" };
const COINBASE: Envelope = { id: "coinbase", type: "CRYPTO", broker: "Coinbase", currency: "USD" };

beforeEach(() => installTaxTestRules([2025]));

describe("US: a transfer carries the basis by asset, in dollars at the acquisition date's rate", () => {
  // 1 € = 1.05 $ in 2023, 1.20 $ from 2024: converting the 20 000 € at the transfer's date would give 24 000 $.
  const fx = (c: string, d: string) => (c === "USD" ? 1 : c === "EUR" ? (d < "2024-01-01" ? 1.05 : 1.2) : undefined);
  const txs = [
    tx({ date: "2023-03-01", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 1, price: 20_000 }),
    tx({ date: "2025-01-10", type: "transfer-out", account: "kraken", symbol: "BTCEUR", quantity: 1 }),
    tx({ date: "2025-01-10", type: "transfer-in", account: "binance", symbol: "BTCUSDT", currency: "USDT", quantity: 0.6 }),
    tx({ date: "2025-01-12", type: "transfer-in", account: "coinbase", symbol: "BTCUSD", currency: "USD", quantity: 0.4 }),
    tx({ date: "2025-06-02", type: "sell", account: "binance", symbol: "BTCUSDT", currency: "USDT", quantity: 0.6, price: 100_000 }),
    tx({ date: "2025-07-01", type: "sell", account: "coinbase", symbol: "BTCUSD", currency: "USD", quantity: 0.4, price: 90_000 }),
  ];
  const input: TaxInput = { year: 2025, transactions: txs, envelopes: [KRAKEN, BINANCE, COINBASE], fx };

  it("BTCEUR bought, moved, sold as BTCUSDT and BTCUSD: 21 000 $ of basis split pro rata, held since 2023", () => {
    const ev = new UsRegime(2025).realize(input).filter((e) => e.kind === "crypto-disposal");
    expect(ev.map((e) => [e.symbol, e.proceeds, e.cost, e.gain, e.term, e.acquired])).toEqual([
      ["BTCUSDT", 60_000, 12_600, 47_400, "long", "2023-03-01"],
      ["BTCUSD", 36_000, 8400, 27_600, "long", "2023-03-01"],
    ]);
  });
});

describe("US: a security moved between brokers that book it under different tickers", () => {
  it("is the same asset by its ISIN: the basis and the holding period follow it", () => {
    const IBKR: Envelope = { id: "ibkr", type: "TAXABLE", broker: "Interactive Brokers", currency: "USD" };
    const SCHWAB: Envelope = { id: "schwab", type: "TAXABLE", broker: "Schwab", currency: "USD" };
    const ISIN = "DE0007164600";
    const txs = [
      tx({ date: "2023-05-02", type: "buy", account: "ibkr", symbol: "SAP", isin: ISIN, currency: "USD", quantity: 10, price: 130 }),
      tx({ date: "2025-02-03", type: "transfer-out", account: "ibkr", symbol: "SAP", isin: ISIN, currency: "USD", quantity: 10 }),
      tx({ date: "2025-02-05", type: "transfer-in", account: "schwab", symbol: "SAPGF", isin: ISIN, currency: "USD", quantity: 10 }),
      tx({ date: "2025-08-01", type: "sell", account: "schwab", symbol: "SAPGF", isin: ISIN, currency: "USD", quantity: 10, price: 250 }),
    ];
    const ev = new UsRegime(2025)
      .realize({ year: 2025, transactions: txs, envelopes: [IBKR, SCHWAB], fx: () => 1 })
      .filter((e) => e.kind === "securities-disposal");
    expect(ev.map((e) => [e.cost, e.gain, e.term, e.acquired])).toEqual([[1300, 1200, "long", "2023-05-02"]]);
  });
});

describe("FR: one crypto portfolio whatever the platform and the pair", () => {
  // BTC bought for euros at Kraken, ETH for dollars at Coinbase (1 $ = 0.90 €), BTC moved to Binance and sold there for
  // euros. The acquisition price of the portfolio (line 220) is every purchase's, and the gain is the one the same
  // trades give on a single platform in euros.
  const fx = (c: string) => (c === "EUR" ? 1 : c === "USD" ? 0.9 : undefined);
  const value = () => 41_000;
  const spread = [
    tx({ date: "2025-01-10", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 1, price: 20_000 }),
    tx({ date: "2025-02-01", type: "buy", account: "coinbase", symbol: "ETHUSD", currency: "USD", quantity: 1, price: 1000 }),
    tx({ date: "2025-03-01", type: "transfer-out", account: "kraken", symbol: "BTCEUR", quantity: 1 }),
    tx({ date: "2025-03-01", type: "transfer-in", account: "binance", symbol: "BTCUSDT", currency: "USDT", quantity: 1 }),
    tx({ date: "2025-06-01", type: "sell", account: "binance", symbol: "BTCEUR", quantity: 0.5, price: 40_000 }),
  ];
  const single = [
    tx({ date: "2025-01-10", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 1, price: 20_000 }),
    tx({ date: "2025-02-01", type: "buy", account: "kraken", symbol: "ETHEUR", quantity: 1, price: 900 }),
    tx({ date: "2025-06-01", type: "sell", account: "kraken", symbol: "BTCEUR", quantity: 0.5, price: 40_000 }),
  ];
  const run = (txs: Transaction[]) =>
    new FranceRegime(2025)
      .realize({ year: 2025, transactions: txs, envelopes: [KRAKEN, BINANCE, COINBASE], fx, cryptoValue: value })
      .filter((e) => e.kind === "crypto-disposal");

  it("the same acquisition price and the same gain", () => {
    const a = run(spread);
    const b = run(single);
    expect(a).toHaveLength(1);
    expect(a[0]!.lines?.["220"]).toBe(20_900);
    expect(a[0]!.gain).toBe(b[0]!.gain);
    // 20 000 − 20 900 × 20 000 / 41 000
    expect(a[0]!.gain).toBe(9804.88);
  });
});
