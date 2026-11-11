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

  it("replacement shares moved to another account before the loss sale still take the disallowed loss", () => {
    // 10 X bought 2025-02-20 @ 90 in a (the replacement purchase, 9 days before the loss sale), moved to b on 02-25.
    //   2025-03-01 sell 10 @ 80 in c, bought 2024-01-02 @ 100 → loss 200, disallowed (W).
    //   §1091(d): the 200 $ go into the basis of the replacement shares → 90 + 20 = 110 a share;
    //   §1223(3): their holding period includes the 424 days of the shares sold → 2025-02-20 − 424 d = 2023-12-24.
    //   2025-11-01 sell the 10 shares from b @ 95 → 950 − 1 100 = −150, long-term.
    const txs = [
      tx({ date: "2024-01-02", type: "buy", account: "c", symbol: "X", quantity: 10, price: 100 }),
      tx({ date: "2025-02-20", type: "buy", account: "a", symbol: "X", quantity: 10, price: 90 }),
      tx({ date: "2025-02-25", type: "transfer-out", account: "a", symbol: "X", quantity: 10 }),
      tx({ date: "2025-02-25", type: "transfer-in", account: "b", symbol: "X", quantity: 10 }),
      tx({ date: "2025-03-01", type: "sell", account: "c", symbol: "X", quantity: 10, price: 80 }),
      tx({ date: "2025-11-01", type: "sell", account: "b", symbol: "X", quantity: 10, price: 95 }),
    ];
    const ev = disposals(txs);
    expect(ev[0]).toMatchObject({ date: "2025-03-01", gain: 0, washSaleDisallowed: 200 });
    expect(ev[1]).toMatchObject({ date: "2025-11-01", account: "b", cost: 1100, gain: -150, term: "long", acquired: "2023-12-24" });
    // 800 + 950 of proceeds for 1 000 + 900 of cost: −150 over the year, the deferred loss included.
    expect(total(ev)).toBe(-150);
  });

  it("the adjustment follows each replacement share where it now is, half moved and half left behind", () => {
    // Same purchase, only 5 of the 10 shares moved to b: the 200 $ split 100 / 100 between a and b, both at 110 a share.
    const txs = [
      tx({ date: "2024-01-02", type: "buy", account: "c", symbol: "X", quantity: 10, price: 100 }),
      tx({ date: "2025-02-20", type: "buy", account: "a", symbol: "X", quantity: 10, price: 90 }),
      tx({ date: "2025-02-25", type: "transfer-out", account: "a", symbol: "X", quantity: 5 }),
      tx({ date: "2025-02-25", type: "transfer-in", account: "b", symbol: "X", quantity: 5 }),
      tx({ date: "2025-03-01", type: "sell", account: "c", symbol: "X", quantity: 10, price: 80 }),
      tx({ date: "2025-11-01", type: "sell", account: "a", symbol: "X", quantity: 5, price: 95 }),
      tx({ date: "2025-11-02", type: "sell", account: "b", symbol: "X", quantity: 5, price: 95 }),
    ];
    const ev = disposals(txs);
    expect(ev.slice(1).map((e) => [e.account, e.cost, e.term, e.acquired])).toEqual([
      ["a", 550, "long", "2023-12-24"],
      ["b", 550, "long", "2023-12-24"],
    ]);
    expect(total(ev)).toBe(-150);
  });
});
