// src/tax/us.ts, commit 5b032f9 "count wash-sale replacement shares sold before the loss sale".
//
// The engine's own rules, as us.ts states them:
//   - replacement shares are "not the shares sold, not already used" by an earlier wash sale (us.ts:396-399);
//   - "only the lot of the loss itself is never its own replacement" (us.ts:398-399).
// The new `soldBefore` path (us.ts:432-435) reads a purchase's recorded sales without either check:
//   1. it ignores `replaced`: shares that already absorbed one disallowed loss while held (`here` is 0 for them,
//      us.ts:426) become available again the day they are sold, and absorb a second loss;
//   2. `r.id === l.id` (us.ts:423) no longer covers a purchase that `take()` split in two lots (us.ts:412, a new id):
//      the half sold first is read as "replacement shares sold before" for the loss on the other half of the very
//      same purchase.
//   3. it takes the shares of the ORIGINAL loss sale for "replacement shares sold before" the sale of their own
//      replacement: buy, sell at a loss, buy back, sell again — the second sale's loss is disallowed and pushed back
//      into the first sale, which then shows a cost never paid and a deducted loss beside its code W.
// Reg. 1.1091-1(e): "The acquisition of any share of stock or any security which results in the nondeductibility of a
// loss […] shall be disregarded in determining the deductibility of any other loss."
// IRS Pub. 550, Wash Sales: adding the disallowed loss to the new stock's cost "postpones the loss deduction until the
// disposition of the new stock or securities".
// The year's total is unchanged when both sales fall in one year and one term; the Form 8949 rows are wrong (a code W
// adjustment that does not exist, a gain moved from one sale to another), and across a year end the loss leaves the
// year with an instruction to amend the earlier return.
import { beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../src/core/profile.js";
import { type Transaction, transactionId } from "../src/portfolio/ledger.js";
import type { TaxEvent, TaxInput } from "../src/tax/regime.js";
import { UsRegime } from "../src/tax/us.js";
import { installTaxTestRules } from "./helpers/tax-rules.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const raw = { origin: "manual", currency: "USD", symbol: "X", ...t } as Omit<Transaction, "id">;
  return { ...raw, id: transactionId(raw) } as Transaction;
};
const A: Envelope = { id: "a", type: "TAXABLE", broker: "Schwab", currency: "USD" };
const B: Envelope = { id: "b", type: "TAXABLE", broker: "Fidelity", currency: "USD" };
const input = (year: number, txs: Transaction[]): TaxInput => ({ year, transactions: txs, envelopes: [A, B], fx: () => 1 });
const rows = (year: number, txs: Transaction[]) =>
  new UsRegime(year)
    .realize(input(year, txs))
    .filter((e: TaxEvent) => e.kind === "securities-disposal")
    .map((e) => [e.date, e.account, e.gain, e.washSaleDisallowed]);

// TEST rules (tests/helpers/tax-rules.ts): a 30-day window, long-term after 1 year. Not law.
beforeEach(() => installTaxTestRules());

describe("replacement shares already used by a wash sale are not used again once they are sold", () => {
  //   2023-01-02  a  buy 100 @ 100     lot A (outside every window below)
  //   2025-03-03  a  sell 100 @ 90     S1: loss 1 000
  //   2025-03-10  a  buy 100 @ 90      lot B: the replacement shares of S1 → basis 100 a share, all 100 used
  //   2025-03-11  b  buy 100 @ 80      lot C
  //   2025-03-17  a  sell 100 @ 120    S2: lot B, 12 000 − 10 000 = +2 000
  //   2025-03-20  b  sell 100 @ 70     S3: lot C, 7 000 − 8 000 = −1 000
  // S3: the only other purchase within its window is lot B, whose 100 shares already replaced S1's 100 shares. One
  // replacement share takes one share's loss (Reg. 1.1091-1(c)-(d); us.ts:396 "not already used"): S3's loss stands.
  const head = [
    tx({ date: "2023-01-02", type: "buy", account: "a", quantity: 100, price: 100 }),
    tx({ date: "2025-03-03", type: "sell", account: "a", quantity: 100, price: 90 }),
    tx({ date: "2025-03-10", type: "buy", account: "a", quantity: 100, price: 90 }),
    tx({ date: "2025-03-11", type: "buy", account: "b", quantity: 100, price: 80 }),
  ];
  const s2 = tx({ date: "2025-03-17", type: "sell", account: "a", quantity: 100, price: 120 });
  const s3 = tx({ date: "2025-03-20", type: "sell", account: "b", quantity: 100, price: 70 });

  it("control: while lot B is still held, the engine does not use it twice", () => {
    expect(rows(2025, [...head, s3])).toEqual([
      ["2025-03-03", "a", 0, 1000],
      ["2025-03-20", "b", -1000, undefined],
    ]);
  });

  it("lot B sold (at a gain) before S3 changes nothing: it was used once already", () => {
    expect(rows(2025, [...head, s2, s3])).toEqual([
      ["2025-03-03", "a", 0, 1000],
      ["2025-03-17", "a", 2000, undefined],
      ["2025-03-20", "b", -1000, undefined],
    ]);
  });

  it("across a year end the second use takes the loss out of the year it was realised in", () => {
    // The same, S1 / B / C / S2 in December 2025 and S3 in January 2026.
    const txs = [
      tx({ date: "2023-01-02", type: "buy", account: "a", quantity: 100, price: 100 }),
      tx({ date: "2025-12-03", type: "sell", account: "a", quantity: 100, price: 90 }),
      tx({ date: "2025-12-10", type: "buy", account: "a", quantity: 100, price: 90 }),
      tx({ date: "2025-12-11", type: "buy", account: "b", quantity: 100, price: 80 }),
      tx({ date: "2025-12-17", type: "sell", account: "a", quantity: 100, price: 120 }),
      tx({ date: "2026-01-05", type: "sell", account: "b", quantity: 100, price: 70 }),
    ];
    expect(rows(2026, txs)).toEqual([["2026-01-05", "b", -1000, undefined]]);
  });
});

describe("a purchase split by an earlier wash sale is never its own replacement", () => {
  //   2023-01-02  buy 60 @ 100      lot Z (outside every window below)
  //   2025-03-03  buy 100 @ 90      purchase P
  //   2025-03-04  sell 60 @ 90      lot Z: loss 600, disallowed against 60 shares of P → P is split: 60 @ 100 (used), 40 @ 90
  //   2025-03-17  sell 40 @ 80      the 40 of P: 3 200 − 3 600 = −400
  //   2025-03-18  sell 60 @ 80      the 60 of P: 4 800 − 6 000 = −1 200
  // Nothing else was bought: P's shares are the shares sold, never their own replacement (us.ts:398-399).
  const p = tx({ date: "2025-03-03", type: "buy", account: "a", quantity: 100, price: 90 });
  const tail = [
    tx({ date: "2025-03-17", type: "sell", account: "a", quantity: 40, price: 80 }),
    tx({ date: "2025-03-18", type: "sell", account: "a", quantity: 60, price: 80 }),
  ];

  it("control: unsplit, selling P at a loss in two sales is no wash sale", () => {
    expect(rows(2025, [p, ...tail])).toEqual([
      ["2025-03-17", "a", -400, undefined],
      ["2025-03-18", "a", -600, undefined],
    ]);
  });

  it("split by the wash sale of lot Z, the two sales of P still are no wash sale of each other", () => {
    const txs = [
      tx({ date: "2023-01-02", type: "buy", account: "a", quantity: 60, price: 100 }),
      p,
      tx({ date: "2025-03-04", type: "sell", account: "a", quantity: 60, price: 90 }),
      ...tail,
    ];
    expect(rows(2025, txs)).toEqual([
      ["2025-03-04", "a", 0, 600],
      ["2025-03-17", "a", -400, undefined],
      ["2025-03-18", "a", -1200, undefined],
    ]);
  });
});

describe("the loss a wash sale postponed is deducted when the replacement shares are sold", () => {
  //   buy 100 @ 100, sell 100 @ 90 three days later (loss 1 000), buy 100 back @ 90 five days later (the replacement
  //   shares: basis 100 a share), sell them @ 85 two days later and buy nothing more.
  //   First sale: loss disallowed, gain 0, code W 1 000, cost 10 000 (what was paid).
  //   Second sale: 8 500 − 10 000 = −1 500, deducted (Pub. 550: postponed "until the disposition of the new stock").
  const pattern = (d: [string, string, string, string]) => [
    tx({ date: d[0], type: "buy", account: "a", quantity: 100, price: 100 }),
    tx({ date: d[1], type: "sell", account: "a", quantity: 100, price: 90 }),
    tx({ date: d[2], type: "buy", account: "a", quantity: 100, price: 90 }),
    tx({ date: d[3], type: "sell", account: "a", quantity: 100, price: 85 }),
  ];

  it("control: with the first purchase outside the second sale's window the engine does exactly that", () => {
    const ev = new UsRegime(2025).realize(input(2025, pattern(["2024-06-03", "2025-01-06", "2025-01-10", "2025-01-13"])));
    expect(ev.map((e) => [e.date, e.cost, e.gain, e.washSaleDisallowed])).toEqual([
      ["2025-01-06", 10000, 0, 1000],
      ["2025-01-13", 10000, -1500, undefined],
    ]);
  });

  it("bought a few days before: the same rows, not a loss moved back onto the first sale", () => {
    const ev = new UsRegime(2025).realize(input(2025, pattern(["2025-01-02", "2025-01-06", "2025-01-10", "2025-01-13"])));
    expect(ev.map((e) => [e.date, e.cost, e.gain, e.washSaleDisallowed])).toEqual([
      ["2025-01-06", 10000, 0, 1000],
      ["2025-01-13", 10000, -1500, undefined],
    ]);
  });

  it("across a year end the 1 500 $ are deducted in the year the replacement shares were sold", () => {
    const txs = pattern(["2025-12-15", "2025-12-19", "2026-01-05", "2026-01-09"]);
    expect(rows(2025, txs)).toEqual([["2025-12-19", "a", 0, 1000]]);
    expect(rows(2026, txs)).toEqual([["2026-01-09", "a", -1500, undefined]]);
  });
});
