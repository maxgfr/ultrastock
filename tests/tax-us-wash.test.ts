// US: wash sales and holding periods. Expected figures by IRC §1091(a)/(d), Treas. Reg. §1.1091-1 and Rev. Rul. 66-7.
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
const input = (year: number, txs: Transaction[]): TaxInput => ({ year, transactions: txs, envelopes: [A], fx: () => 1 });
const disposals = (year: number, txs: Transaction[]): TaxEvent[] =>
  new UsRegime(year).realize(input(year, txs)).filter((e) => e.kind === "securities-disposal");

describe("US wash sale: the 30 days AFTER a December loss sale run into January", () => {
  // §1091(a): the window ends 30 days after the sale. 10 X bought 2024-01-02 @ 100, sold 2025-12-20 @ 80 (loss 200),
  // 10 X bought back 2026-01-05 @ 82 (16 days later) and sold 2026-06-01 @ 90.
  //   2025: loss 200 disallowed → gain 0, code W 200.
  //   2026: basis 82 + 20 = 102 a share (§1091(d)) → 900 − 1 020 = −120.
  // Two years together: 800 + 900 − 1 000 − 820 = −120.
  const txs = [
    tx({ date: "2024-01-02", type: "buy", account: "a", symbol: "X", quantity: 10, price: 100 }),
    tx({ date: "2025-12-20", type: "sell", account: "a", symbol: "X", quantity: 10, price: 80 }),
    tx({ date: "2026-01-05", type: "buy", account: "a", symbol: "X", quantity: 10, price: 82 }),
    tx({ date: "2026-06-01", type: "sell", account: "a", symbol: "X", quantity: 10, price: 90 }),
  ];
  it("the 2025 report disallows the December loss", () => {
    const ev = disposals(2025, txs);
    expect(ev.map((e) => [e.date, e.gain, e.washSaleDisallowed])).toEqual([["2025-12-20", 0, 200]]);
  });
  it("the two years do not deduct the same 200 $ twice", () => {
    const y25 = disposals(2025, txs).reduce((s, e) => s + (e.gain ?? 0), 0);
    const y26 = disposals(2026, txs).reduce((s, e) => s + (e.gain ?? 0), 0);
    expect(y25 + y26).toBe(-120);
  });
  it("a purchase after the window, or the next year's own events, stay out of the earlier report", () => {
    const later = [...txs.slice(0, 2), tx({ date: "2026-01-20", type: "buy", account: "a", symbol: "X", quantity: 10, price: 82 })];
    expect(disposals(2025, later).map((e) => [e.gain, e.washSaleDisallowed])).toEqual([[-200, undefined]]);
    const r = new UsRegime(2025).replay(input(2025, txs));
    expect(r.open).toEqual([]);
    expect(r.events.every((e) => e.date <= "2025-12-31")).toBe(true);
  });
});
