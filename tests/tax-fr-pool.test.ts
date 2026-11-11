// FR securities: the household PMP pool (CGI art. 150-0 D 3; BOI-RPPM-PVBMI-20-10-20-40).
import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/core/profile.js";
import { buildBook, type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { FranceRegime } from "../src/tax/fr.js";
import type { TaxInput } from "../src/tax/regime.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const raw = { origin: "manual", currency: "EUR", ...t } as Omit<Transaction, "id">;
  return { ...raw, id: transactionId(raw) } as Transaction;
};
const A: Envelope = { id: "cto1", type: "CTO", broker: "Boursorama", currency: "EUR" };
const B: Envelope = { id: "cto2", type: "CTO", broker: "Fortuneo", currency: "EUR" };
const input = (txs: Transaction[]): TaxInput => ({ year: 2025, transactions: txs, envelopes: [A, B], fx: () => 1 });
const run = (txs: Transaction[]) => {
  const st = new FranceRegime(2025).replay(input(txs));
  return { sales: st.events.filter((e) => e.kind === "securities-disposal"), warnings: st.warnings };
};

describe("FR: a split recorded in each of two accounts that hold the same security", () => {
  // The ledger keeps a position per account, so a 2-for-1 is one split row per account (buildBook needs both).
  //   cto1: 10 X @ 100, cto2: 10 X @ 100 → 20 shares, 2 000 €. After the split: 40 shares, PMP 50 €.
  //   cto1 sells its 20 @ 60 → 1 200 − 20 × 50 = +200 €.
  const txs = [
    tx({ date: "2024-01-02", type: "buy", account: "cto1", symbol: "X.PA", quantity: 10, price: 100 }),
    tx({ date: "2024-01-03", type: "buy", account: "cto2", symbol: "X.PA", quantity: 10, price: 100 }),
    tx({ date: "2025-03-01", type: "split", account: "cto1", symbol: "X.PA", quantity: 2 }),
    tx({ date: "2025-03-01", type: "split", account: "cto2", symbol: "X.PA", quantity: 2 }),
    tx({ date: "2025-06-02", type: "sell", account: "cto1", symbol: "X.PA", quantity: 20, price: 60 }),
  ];
  it("the book needs both split rows: 20 shares in each account before the sale", () => {
    const book = buildBook(txs.slice(0, 4));
    expect(book.positions.map((p) => [p.account, p.quantity, p.averageCost])).toEqual([
      ["cto1", 20, 50],
      ["cto2", 20, 50],
    ]);
  });
  it("the tax pool splits once: cost 1 000 €, gain 200 €", () => {
    const { sales } = run(txs);
    expect(sales.map((e) => [e.cost, e.gain])).toEqual([[1000, 200]]);
  });
  it("a split recorded in one account only still splits the household's pool", () => {
    const { sales } = run([...txs.slice(0, 3), txs[4]!]);
    expect(sales.map((e) => [e.cost, e.gain])).toEqual([[1000, 200]]);
  });
});

describe("FR: a security whose ISIN changes (reverse split, new ISIN) under the same ticker", () => {
  it("the sale still finds the cost of the shares bought under the old ISIN", () => {
    // 100 X bought @ 10 (ISIN US1111111116), 1-for-10 reverse split with a new ISIN, 10 X sold @ 150 under it.
    // A share consolidation is not a disposal: the 10 shares keep the 1 000 € paid → 1 500 − 1 000 = +500 €.
    const txs = [
      tx({ date: "2024-01-02", type: "buy", account: "cto1", symbol: "X", isin: "US1111111116", quantity: 100, price: 10 }),
      tx({ date: "2025-03-01", type: "split", account: "cto1", symbol: "X", isin: "US2222222224", quantity: 0.1 }),
      tx({ date: "2025-06-02", type: "sell", account: "cto1", symbol: "X", isin: "US2222222224", quantity: 10, price: 150 }),
    ];
    // The ledger's book has no trouble with it.
    expect(buildBook(txs.slice(0, 2)).positions.map((p) => [p.quantity, p.averageCost])).toEqual([[10, 100]]);
    const { sales, warnings } = run(txs);
    expect(warnings.filter((w) => /no recorded purchase|no cost/.test(w))).toEqual([]);
    expect(sales.map((e) => [e.cost, e.gain])).toEqual([[1000, 500]]);
  });
});
