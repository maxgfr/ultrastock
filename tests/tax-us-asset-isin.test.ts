// src/tax/us.ts, commit c5954a1 "carry a transferred cost by asset, not by symbol".
//
// assetOf (us.ts:110-111) keys a security by the ISIN of its row, else by the ISIN the ledger gave its ticker — one
// ISIN per ticker for the whole ledger, the last row read winning (isinsOf, us.ts:114-118). Lots are then matched on
// that key inside the account (us.ts:342). Before the change a sale matched its account's lots by ticker. Now:
//   1. a ticker whose ISIN changed (a redomiciliation, a reverse split: the FR engine pools those, tax/fr.ts:103-124)
//      no longer finds the lots bought under the former ISIN in the SAME account;
//   2. a row without an ISIN takes the ISIN another account's rows gave the same ticker — another security there
//      (tickers are per exchange) — and misses its own account's lots.
// Both end as "no recorded lot: basis 0": the whole proceeds reported as a short-term gain.
import { beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../src/core/profile.js";
import { type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { UsRegime } from "../src/tax/us.js";
import { installTaxTestRules } from "./helpers/tax-rules.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const raw = { origin: "manual", currency: "USD", ...t } as Omit<Transaction, "id">;
  return { ...raw, id: transactionId(raw) } as Transaction;
};
const A: Envelope = { id: "a", type: "TAXABLE", broker: "Schwab", currency: "USD" };
const B: Envelope = { id: "b", type: "TAXABLE", broker: "Fidelity", currency: "USD" };
const rows = (txs: Transaction[]) =>
  new UsRegime(2025)
    .realize({ year: 2025, transactions: txs, envelopes: [A, B], fx: () => 1 })
    .filter((e) => e.kind === "securities-disposal")
    .map((e) => [e.account, e.proceeds, e.cost, e.gain, e.term, e.acquired]);

// TEST rules (tests/helpers/tax-rules.ts), not law.
beforeEach(() => installTaxTestRules([2025]));

describe("US lots keyed by ISIN keep the lots of the same ticker in the same account", () => {
  it("control: without any ISIN the sale finds its lot by ticker", () => {
    const txs = [
      tx({ date: "2023-05-02", type: "buy", account: "a", symbol: "ACME", quantity: 10, price: 130 }),
      tx({ date: "2025-08-01", type: "sell", account: "a", symbol: "ACME", quantity: 10, price: 250 }),
    ];
    expect(rows(txs)).toEqual([["a", 2500, 1300, 1200, "long", "2023-05-02"]]);
  });

  it("the ISIN changed under the ticker (same account, same shares): the basis and the holding period are kept", () => {
    const txs = [
      tx({ date: "2023-05-02", type: "buy", account: "a", symbol: "ACME", isin: "US0000000001", quantity: 10, price: 130 }),
      tx({ date: "2025-08-01", type: "sell", account: "a", symbol: "ACME", isin: "IE00B0BBBBB2", quantity: 10, price: 250 }),
    ];
    expect(rows(txs)).toEqual([["a", 2500, 1300, 1200, "long", "2023-05-02"]]);
  });

  it("a sale without an ISIN is not given the ISIN another account books the same ticker under", () => {
    const txs = [
      // Account a: AIR is Airbus (Paris line), typed by hand without its ISIN on the sale.
      tx({ date: "2023-05-02", type: "buy", account: "a", symbol: "AIR", isin: "NL0000235190", quantity: 10, price: 130 }),
      // Account b: AIR is AAR Corp (NYSE).
      tx({ date: "2024-03-01", type: "buy", account: "b", symbol: "AIR", isin: "US0003611052", quantity: 5, price: 60 }),
      tx({ date: "2025-08-01", type: "sell", account: "a", symbol: "AIR", quantity: 10, price: 250 }),
    ];
    expect(rows(txs)).toEqual([["a", 2500, 1300, 1200, "long", "2023-05-02"]]);
  });
});

describe("the ISIN links one security across accounts and tickers", () => {
  it("shares moved to a broker whose rows carry no ISIN keep their basis (the ticker is booked as one security)", () => {
    const txs = [
      tx({ date: "2023-05-02", type: "buy", account: "a", symbol: "ACME", isin: "US0000000001", quantity: 10, price: 130 }),
      tx({ date: "2025-02-03", type: "transfer-out", account: "a", symbol: "ACME", isin: "US0000000001", quantity: 10 }),
      tx({ date: "2025-02-05", type: "transfer-in", account: "b", symbol: "ACME", quantity: 10 }),
      tx({ date: "2025-08-01", type: "sell", account: "b", symbol: "ACME", quantity: 10, price: 250 }),
    ];
    expect(rows(txs)).toEqual([["b", 2500, 1300, 1200, "long", "2023-05-02"]]);
  });
});
