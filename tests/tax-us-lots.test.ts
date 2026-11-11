// US lots across the user's own accounts and the wash-sale rule: a transfer between accounts, replacement shares,
// trades quoted in a crypto-asset. The expected figures are computed by hand in the comments.
import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/core/profile.js";
import { type Transaction, transactionId } from "../src/portfolio/ledger.js";
import type { TaxEvent, TaxInput } from "../src/tax/regime.js";
import { UsRegime } from "../src/tax/us.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const raw = { origin: "manual", currency: "USD", ...t } as Omit<Transaction, "id">;
  return { ...raw, id: transactionId(raw) } as Transaction;
};
const A: Envelope = { id: "a", type: "TAXABLE", broker: "Schwab", currency: "USD" };
const B: Envelope = { id: "b", type: "TAXABLE", broker: "Fidelity", currency: "USD" };
const C: Envelope = { id: "c", type: "TAXABLE", broker: "Vanguard", currency: "USD" };
const input = (txs: Transaction[], extra: Partial<TaxInput> = {}): TaxInput => ({ year: 2025, transactions: txs, envelopes: [A, B, C], fx: () => 1, ...extra });
const disposals = (txs: Transaction[], extra: Partial<TaxInput> = {}): TaxEvent[] =>
  new UsRegime(2025).realize(input(txs, extra)).filter((e) => e.kind === "securities-disposal" || e.kind === "crypto-disposal");
const total = (ev: TaxEvent[]) => Math.round(ev.reduce((s, e) => s + (e.gain ?? 0), 0) * 100) / 100;

describe("US: a transfer between own accounts and the wash-sale rule", () => {
  it("a transfer-in that carries old lots is not a replacement purchase for a loss sale made in the 30 days before it", () => {
    // §1091: a loss is disallowed only when substantially identical stock is ACQUIRED within 30 days. Here nothing is
    // bought in 2025: 10 X bought in 2020 only move from account a to account b two weeks after the loss sale in c.
    //   2025-03-01 sell 10 @ 80, bought 2024-01-02 @ 100 → loss 200, allowed.
    //   2025-11-01 sell the 10 moved shares @ 90, basis 50 → gain 400.
    const txs = [
      tx({ date: "2020-01-02", type: "buy", account: "a", symbol: "X", quantity: 10, price: 50 }),
      tx({ date: "2024-01-02", type: "buy", account: "c", symbol: "X", quantity: 10, price: 100 }),
      tx({ date: "2025-03-01", type: "sell", account: "c", symbol: "X", quantity: 10, price: 80 }),
      tx({ date: "2025-03-15", type: "transfer-out", account: "a", symbol: "X", quantity: 10 }),
      tx({ date: "2025-03-15", type: "transfer-in", account: "b", symbol: "X", quantity: 10 }),
      tx({ date: "2025-11-01", type: "sell", account: "b", symbol: "X", quantity: 10, price: 90 }),
    ];
    const ev = disposals(txs);
    expect(ev.map((e) => [e.date, e.account, e.gain, e.washSaleDisallowed])).toEqual([
      ["2025-03-01", "c", -200, undefined],
      ["2025-11-01", "b", 400, undefined],
    ]);
    // 1 700 $ came in for 1 500 $ of cost: the year's result is +200.
    expect(total(ev)).toBe(200);
    // The statement lists the transfer-in first: the same reading.
    const swapped = [txs[0]!, txs[1]!, txs[2]!, txs[4]!, txs[3]!, txs[5]!];
    expect(total(disposals(swapped))).toBe(200);
  });
});
