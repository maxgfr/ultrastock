// Kraken importer, ledger ids: re-importing trades.csv into a ledger written before c2fdfc7.
// `tests/helpers/kraken-before-c2fdfc7.ts` is `git show c2fdfc7^:src/portfolio/import/kraken.ts`.
import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/core/profile.js";
import { parseStatement } from "../src/portfolio/import/index.js";
import { legacyKrakenPair } from "../src/portfolio/import/kraken.js";
import { appendTransactions, readLedger } from "../src/portfolio/ledger.js";
import type { TaxInput } from "../src/tax/regime.js";
import { UsRegime } from "../src/tax/us.js";
import { parseKraken as parseKrakenBefore } from "./helpers/kraken-before-c2fdfc7.js";

const CSV =
  '"txid","ordertxid","pair","time","type","ordertype","price","cost","fee","vol","margin","misc","ledgers"\n' +
  '"T1","O1","XXBTZUSD","2024-01-02 10:00:00","buy","limit",40000,40000,0,1,0,"",""\n' +
  '"T2","O2","AVAXXBT","2025-02-03 10:00:00","buy","limit",0.0005,0.05,0,100,0,"",""\n';
const KRAKEN: Envelope = { id: "kraken", type: "CRYPTO", broker: "Kraken", currency: "USD" };

describe('a Kraken AVAX/XBT trade imported before c2fdfc7 (as "AVA") and imported again after it', () => {
  it("the 0.05 BTC paid for the AVAX leave the book once, and are one disposal for the US return", async () => {
    const before = parseKrakenBefore(CSV, { account: "kraken" });
    expect(before.transactions.map((t) => t.symbol)).toEqual(["BTCUSD", "AVABTC"]);
    await appendTransactions(before.transactions, "review-kraken");
    const now = parseStatement("kraken", CSV, { account: "kraken" });
    expect(now.transactions.map((t) => t.symbol)).toEqual(["BTCUSD", "AVAXBTC"]);
    await appendTransactions(now.transactions, "review-kraken");
    const ledger = readLedger("review-kraken");
    // Notice 2014-21: 0.05 BTC given for 100 AVAX, BTC at 100 000 $ → one disposal, proceeds 5 000 $, basis 2 000 $.
    const input: TaxInput = { year: 2025, transactions: ledger, envelopes: [KRAKEN], fx: (c) => (c === "BTC" ? 100_000 : 1) };
    const ev = new UsRegime(2025).realize(input).filter((e) => e.kind === "crypto-disposal");
    expect(ev.map((e) => [e.symbol, e.quantity, e.proceeds, e.cost, e.gain])).toEqual([["BTC", 0.05, 5000, 2000, 3000]]);
  });
  it("names the earlier reading only where it differs", () => {
    expect(legacyKrakenPair("AVAXXBT")).toEqual({ base: "AVA", quote: "BTC" });
    expect(legacyKrakenPair("DYDXXBT")).toEqual({ base: "DYD", quote: "BTC" });
    expect(legacyKrakenPair("XXBTZUSD")).toBeUndefined();
    expect(legacyKrakenPair("XTZEUR")).toBeUndefined();
    expect(legacyKrakenPair("SOL/EUR")).toBeUndefined();
  });
});
