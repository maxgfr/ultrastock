// US, transfer carry: one transfer-in fed by a taxable account and an IRA.
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
const IRA: Envelope = { id: "ira", type: "IRA", broker: "Vanguard", currency: "USD" };

// The engines hold no tax value: every test computes with TEST rules (tests/helpers/tax-rules.ts), not law.
beforeEach(() => installTaxTestRules());

describe("US: a transfer-in fed first by a taxable lot, then by an IRA lot", () => {
  it("the IRA part is a distribution from the transfer date, not a copy of the taxable lot", () => {
    // 5 X bought in a 2024-01-02 @ 100, 5 X in the IRA 2024-01-03 @ 50; both leave 2025-03-01, 10 arrive in b
    // 2025-03-02 without a price, sold 2025-06-02 @ 120. The 5 from a keep 500 $ and 2024-01-02 (§1223(1)); the 5 out
    // of the IRA are a distribution: basis their value that day (0 until given), held from 2025-03-02 (Pub. 590-B).
    const txs = [
      tx({ date: "2024-01-02", type: "buy", account: "a", symbol: "X", quantity: 5, price: 100 }),
      tx({ date: "2024-01-03", type: "buy", account: "ira", symbol: "X", quantity: 5, price: 50 }),
      tx({ date: "2025-03-01", type: "transfer-out", account: "a", symbol: "X", quantity: 5 }),
      tx({ date: "2025-03-01", type: "transfer-out", account: "ira", symbol: "X", quantity: 5 }),
      tx({ date: "2025-03-02", type: "transfer-in", account: "b", symbol: "X", quantity: 10 }),
      tx({ date: "2025-06-02", type: "sell", account: "b", symbol: "X", quantity: 10, price: 120 }),
    ];
    const r = new UsRegime(2025).replay({ year: 2025, transactions: txs, envelopes: [A, B, IRA], fx: () => 1 });
    expect(r.events.map((e) => [e.quantity, e.cost, e.acquired, e.term])).toEqual([
      [5, 500, "2024-01-02", "long"],
      [5, 0, "2025-03-02", "short"],
    ]);
    expect(r.warnings.join(" ")).toMatch(/moved out of ira \(IRA\) into b on 2025-03-02: a distribution/);
  });
});
