// src/tax/neutral.ts, the neutral facts report: a security was keyed by the ISIN of its row, else by the LAST ISIN any
// row of the ledger gave its ticker. A ticker whose ISIN changed (the FR engine pools those: tax/fr.ts), or the same
// ticker for two securities at two brokers, split one holding in two: the sale found no acquisition.
import { describe, expect, it } from "vitest";
import { type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { neutralReport } from "../src/tax/neutral.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const r = { origin: "manual", currency: "EUR", ...t } as Omit<Transaction, "id">;
  return { ...r, id: transactionId(r) } as Transaction;
};
const fx = (c: string) => (c === "EUR" ? 1 : c === "USD" ? 0.9 : undefined);
const report = (txs: Transaction[]) => neutralReport({ year: 2025, transactions: txs, envelopes: [], fx, currency: "EUR" });

describe("one holding booked under a ticker whose rows carry different ISINs", () => {
  it("an ISIN changed under the same ticker in the same account: the sale still finds its purchase", () => {
    const r = report([
      tx({ date: "2023-05-02", type: "buy", account: "broker", symbol: "ACME", isin: "DE000A0AAAA1", quantity: 10, price: 130 }),
      // The issuer redomiciled: same ticker, same shares, a new ISIN on the later rows.
      tx({ date: "2025-08-01", type: "sell", account: "broker", symbol: "ACME", isin: "IE00B0BBBBB2", quantity: 10, price: 250 }),
    ]);
    expect(r.disposals.map((d) => [d.proceeds, d.costFifo, d.costAverage, d.acquiredFirst])).toEqual([[2500, 1300, 1300, "2023-05-02"]]);
  });

  it("a sale without an ISIN is not given the ISIN another account books the same ticker under", () => {
    const r = report([
      // Account a: AIR is Airbus (Paris line), typed by hand without its ISIN on the sale.
      tx({ date: "2023-05-02", type: "buy", account: "a", symbol: "AIR", isin: "NL0000235190", quantity: 10, price: 130 }),
      // Account b: AIR is AAR Corp (NYSE).
      tx({ date: "2024-03-01", type: "buy", account: "b", symbol: "AIR", isin: "US0003611052", quantity: 5, price: 60 }),
      tx({ date: "2025-08-01", type: "sell", account: "a", symbol: "AIR", quantity: 10, price: 250 }),
    ]);
    expect(r.disposals.map((d) => [d.asset, d.proceeds, d.costFifo, d.acquiredFirst])).toEqual([["NL0000235190", 2500, 1300, "2023-05-02"]]);
  });
});
