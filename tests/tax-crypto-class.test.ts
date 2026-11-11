// What is read as a crypto-asset, and a fiat-base pair in the US regime.
import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/core/profile.js";
import { type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { FranceRegime } from "../src/tax/fr.js";
import { envelopeOf, isCryptoTx, type TaxInput } from "../src/tax/regime.js";
import { UsRegime } from "../src/tax/us.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const raw = { origin: "manual", currency: "USD", ...t } as Omit<Transaction, "id">;
  return { ...raw, id: transactionId(raw) } as Transaction;
};

describe("a listed bitcoin trust (GBTC, FBTC: a share with an ISIN) in an account the profile does not list", () => {
  // 49dd58f: "A listed product (an ETP has an ISIN or a suffix) stays a security." GBTC is a security: §1091 applies
  // to it, and in France it is a share on form 2074, not a crypto-asset on form 2086.
  const gbtc = { symbol: "GBTC", isin: "US3896371099", currency: "USD" };
  it("is not a crypto-asset, whatever the account", () => {
    expect(isCryptoTx({ account: "ibkr", ...gbtc }, [])).toBe(false);
    expect(isCryptoTx({ account: "ibkr", symbol: "FBTC", isin: "US3159481098", currency: "USD" }, [])).toBe(false);
  });
  it("its account is not guessed a crypto account from the ticker; a bare pair still is", () => {
    expect(envelopeOf("ibkr", [], "GBTC", "US3896371099").type).toBe("CTO");
    expect(envelopeOf("ibkr", [], "BTCE.DE").type).toBe("CTO");
    expect(envelopeOf("acct", [], "SOLUSDT").type).toBe("CRYPTO");
    expect(isCryptoTx({ account: "ibkr", symbol: "GBTC", isin: "US3896371099", currency: "USD", assetClass: "crypto" }, [])).toBe(true);
  });
  const txs = [
    tx({ date: "2024-01-02", type: "buy", account: "ibkr", ...gbtc, quantity: 10, price: 100 }),
    tx({ date: "2025-03-01", type: "sell", account: "ibkr", ...gbtc, quantity: 10, price: 80 }),
    tx({ date: "2025-03-10", type: "buy", account: "ibkr", ...gbtc, quantity: 10, price: 82 }),
  ];
  it("US: its loss sale followed by a repurchase 9 days later is a wash sale (§1091)", () => {
    const input: TaxInput = { year: 2025, transactions: txs, envelopes: [], fx: () => 1 };
    const ev = new UsRegime(2025).realize(input);
    expect(ev.map((e) => [e.kind, e.gain, e.washSaleDisallowed])).toEqual([["securities-disposal", 0, 200]]);
  });
  it("FR: its sale is a securities disposal at the PMP (form 2074), not a line of form 2086", () => {
    const input: TaxInput = { year: 2025, transactions: txs, envelopes: [], fx: () => 1, cryptoValue: () => 5000 };
    const ev = new FranceRegime(2025).realize(input);
    expect(ev.map((e) => [e.kind, e.gain])).toEqual([["securities-disposal", -200]]);
  });
});

describe("US: euros sold for a stablecoin on a fiat-base pair (EURUSDT)", () => {
  const binance: Envelope = { id: "binance", type: "CRYPTO", broker: "Binance", currency: "USD" };
  it("is not a crypto disposal with a zero basis", () => {
    // 10 000 € deposited on Binance and sold for 10 800 USDT (SELL EURUSDT @ 1.08). The engine treats stablecoins as
    // dollars: euros were changed into dollars at the day's rate. No virtual currency was given (Notice 2014-21
    // taxes the disposal of virtual currency); the euros are worth 10 800 $ and cost 10 800 $ the same day (§988 at
    // most, on a rate that did not move). Nothing to report on Form 8949.
    const txs = [
      tx({ date: "2025-02-03", type: "deposit", account: "binance", amount: 10000, currency: "EUR" }),
      tx({ date: "2025-02-03", type: "sell", account: "binance", symbol: "EURUSDT", quantity: 10000, price: 1.08, currency: "USDT" }),
    ];
    const input: TaxInput = { year: 2025, transactions: txs, envelopes: [binance], fx: (c) => (c === "EUR" ? 1.08 : 1) };
    const s = new UsRegime(2025).annualSummary(input);
    const gains = s.events.filter((e) => e.kind === "crypto-disposal").map((e) => [e.symbol, e.proceeds, e.cost, e.gain]);
    expect(gains).toEqual([]);
    expect(s.figures.find((f) => f.key === "TAX.US.2025.shortTerm.net")?.value).toBe(0);
  });
  it("buying euros back with the stablecoin opens no euro lot, and BTC bought with the dollars keeps its own basis", () => {
    const txs = [
      tx({ date: "2025-02-03", type: "buy", account: "binance", symbol: "EURUSDT", quantity: 1000, price: 1.08, currency: "USDT" }),
      tx({ date: "2025-02-04", type: "buy", account: "binance", symbol: "BTCUSDT", quantity: 0.01, price: 100_000, currency: "USDT" }),
      tx({ date: "2025-05-04", type: "sell", account: "binance", symbol: "BTCUSDT", quantity: 0.01, price: 110_000, currency: "USDT" }),
    ];
    const input: TaxInput = { year: 2025, transactions: txs, envelopes: [binance], fx: (c) => (c === "EUR" ? 1.08 : 1) };
    const r = new UsRegime(2025).replay(input);
    expect(r.events.filter((e) => e.kind === "crypto-disposal").map((e) => [e.symbol, e.gain])).toEqual([["BTCUSDT", 100]]);
    expect(r.lots.filter((l) => l.asset === "EUR")).toEqual([]);
  });
});
