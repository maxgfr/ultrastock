// US lots across the user's own accounts and the wash-sale rule: a transfer between accounts, replacement shares,
// trades quoted in a crypto-asset. The expected figures are computed by hand in the comments.
import { beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../src/core/profile.js";
import { type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { withCryptoQuotes } from "../src/tax/inputs.js";
import type { TaxEvent, TaxInput } from "../src/tax/regime.js";
import { UsRegime } from "../src/tax/us.js";
import { installTaxTestRules } from "./helpers/tax-rules.js";

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

// The engines hold no tax value: every test computes with TEST rules (tests/helpers/tax-rules.ts), not law.
beforeEach(() => installTaxTestRules());

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

  it("a crypto-asset moved between two platforms keeps its basis whatever each platform quotes it in", () => {
    // The Coinbase importer books a send as a transfer-out of BTCUSD, the Binance importer a deposit as a transfer-in
    // of BTCUSDT (no price): the same bitcoin. Bought 20 000 $ in 2022, sold 100 000 $ in December 2025:
    // gain 80 000 $, long-term.
    const CB: Envelope = { id: "coinbase", type: "CRYPTO", broker: "Coinbase", currency: "USD" };
    const BIN: Envelope = { id: "binance", type: "CRYPTO", broker: "Binance.US", currency: "USD" };
    const txs = [
      tx({ date: "2022-03-02", type: "buy", account: "coinbase", symbol: "BTCUSD", quantity: 1, price: 20_000 }),
      tx({ date: "2025-06-01", type: "transfer-out", account: "coinbase", symbol: "BTCUSD", quantity: 1 }),
      tx({ date: "2025-06-01", type: "transfer-in", account: "binance", symbol: "BTCUSDT", currency: "USDT", quantity: 1 }),
      tx({ date: "2025-12-01", type: "sell", account: "binance", symbol: "BTCUSDT", currency: "USDT", quantity: 1, price: 100_000 }),
    ];
    const ev = disposals(txs, { envelopes: [CB, BIN] });
    expect(ev.map((e) => [e.cost, e.gain, e.term, e.acquired])).toEqual([[20_000, 80_000, "long", "2022-03-02"]]);
  });
});

describe("US: a transfer-in is tied to a transfer-out close to it", () => {
  const BUY = tx({ date: "2020-01-02", type: "buy", account: "a", symbol: "X", quantity: 10, price: 50 });
  const OUT = tx({ date: "2024-01-10", type: "transfer-out", account: "a", symbol: "X", quantity: 10 });
  const SELL = tx({ date: "2025-12-01", type: "sell", account: "b", symbol: "X", quantity: 10, price: 90 });

  it("takes the lots a transfer-out gave up a few days before", () => {
    const IN = tx({ date: "2024-01-13", type: "transfer-in", account: "b", symbol: "X", quantity: 10 });
    const s = new UsRegime(2025).annualSummary(input([BUY, OUT, IN, SELL]));
    expect(s.events.map((e) => [e.cost, e.acquired])).toEqual([[500, "2020-01-02"]]);
    expect(s.warnings.join(" ")).not.toMatch(/without a price/);
  });

  it("does not take lots that left another account long before, and says it has no basis", () => {
    // The shares that left a in January 2024 went somewhere the ledger does not show; 10 X arriving in b 17 months
    // later are not those shares. Without a price their basis is unknown: 0 from the transfer date, said so.
    const IN = tx({ date: "2025-06-01", type: "transfer-in", account: "b", symbol: "X", quantity: 10 });
    const s = new UsRegime(2025).annualSummary(input([BUY, OUT, IN, SELL]));
    expect(s.events.map((e) => [e.cost, e.acquired, e.term])).toEqual([[0, "2025-06-01", "short"]]);
    expect(s.warnings.join(" ")).toMatch(/X transferred into b on 2025-06-01 without a price.*basis 0/);
  });
});

describe("US: shares taken out of an IRA in kind", () => {
  it("do not arrive in the taxable account with the IRA's purchase price and date", () => {
    // IRS Pub. 590-B: property distributed from an IRA takes its fair market value on the distribution date as basis,
    // and its holding period starts then. Without a price on the transfer-in the basis is unknown (said so) — what it
    // can never be is the 150 $ paid inside the IRA in 2022, with a long-term holding period.
    const IRA: Envelope = { id: "ira", type: "IRA", broker: "Schwab", currency: "USD" };
    const txs = [
      tx({ date: "2022-03-02", type: "buy", account: "ira", symbol: "X", quantity: 10, price: 150 }),
      tx({ date: "2025-06-01", type: "transfer-out", account: "ira", symbol: "X", quantity: 10 }),
      tx({ date: "2025-06-01", type: "transfer-in", account: "a", symbol: "X", quantity: 10 }),
      tx({ date: "2025-12-01", type: "sell", account: "a", symbol: "X", quantity: 10, price: 190 }),
    ];
    const s = new UsRegime(2025).annualSummary(input(txs, { envelopes: [A, IRA] }));
    const ev = s.events.filter((e) => e.kind === "securities-disposal");
    expect(ev.map((e) => [e.acquired, e.term])).toEqual([["2025-06-01", "short"]]);
    expect(ev[0]!.cost).not.toBe(1500);
    expect(s.warnings.join(" ")).toMatch(/X .*ira.*fair market value.*590-B/);
    // The value on the distribution date given as the transfer-in's price: 10 × 170 = 1 700, a 200 $ short-term gain.
    const priced = [...txs.slice(0, 2), tx({ ...txs[2]!, price: 170 }), txs[3]!];
    expect(disposals(priced, { envelopes: [A, IRA] }).map((e) => [e.cost, e.gain, e.term])).toEqual([[1700, 200, "short"]]);
  });
});

describe("US: a trade quoted in a crypto-asset", () => {
  it("buying ETH with BTC disposes of the BTC given, at its fair value", async () => {
    // IRS Notice 2014-21 (Q&A 6): a crypto-to-crypto trade disposes of the asset given at fair value.
    //   2023-01-02 buy 1 BTC @ 20 000 $.
    //   2025-02-01 buy 10 ETHBTC @ 0.05 BTC, fee 0.001 BTC, BTC closing at 100 000 $:
    //              0.501 BTC given → proceeds 50 100 $, basis 0.501 × 20 000 = 10 020 $, gain 40 080 $ long-term.
    const CB: Envelope = { id: "cb", type: "CRYPTO", broker: "Coinbase", currency: "USD" };
    const txs = [
      tx({ date: "2023-01-02", type: "buy", account: "cb", symbol: "BTCUSD", quantity: 1, price: 20_000 }),
      tx({ date: "2025-02-01", type: "buy", account: "cb", symbol: "ETHBTC", currency: "BTC", quantity: 10, price: 0.05, fee: 0.001 }),
    ];
    const closes = async () => new Map<string, number>([["2025-02-01", 100_000]]);
    const quoted = await withCryptoQuotes((c) => (c === "USD" ? 1 : undefined), ["BTC"], "2023-01-01", "2025-12-31", closes);
    const us = new UsRegime(2025);
    const s = us.annualSummary(input(txs, { envelopes: [CB], fx: quoted.fx }));
    const btc = s.events.filter((e) => e.kind === "crypto-disposal" && /^BTC/.test(e.symbol ?? ""));
    expect(btc.map((e) => [e.quantity, e.proceeds, e.cost, e.gain, e.term, e.acquired])).toEqual([[0.501, 50_100, 10_020, 40_080, "long", "2023-01-02"]]);
    // What is left: 0.499 BTC of the 2023 lot and the 10 ETH at the 50 100 $ given for them.
    const open = us.replay(input(txs, { envelopes: [CB], fx: quoted.fx })).open;
    expect(open.map((l) => [l.asset, Math.round(l.remaining * 1e6) / 1e6, Math.round(l.basis * l.remaining)])).toEqual([
      ["BTC", 0.499, 9980],
      ["ETH", 10, 50_100],
    ]);
  });

  it("`tax harvest` compares a lot quoted in BTC with its dollar basis in dollars", async () => {
    // 1 ETH bought for 0.03 BTC when BTC closed at 100 000 $ → basis 3 000 $. On 2025-10-01 ETHBTC trades at 0.04 and
    // BTC closes at 120 000 $: the lot is worth 4 800 $, an unrealised GAIN of 1 800 $ — not a harvest candidate.
    const CB: Envelope = { id: "cb", type: "CRYPTO", broker: "Coinbase", currency: "USD" };
    const closes = async () =>
      new Map<string, number>([
        ["2025-02-01", 100_000],
        ["2025-10-01", 120_000],
      ]);
    const quoted = await withCryptoQuotes((c) => (c === "USD" ? 1 : undefined), ["BTC"], "2023-01-01", "2025-12-31", closes);
    const txs = [tx({ date: "2025-02-01", type: "buy", account: "cb", symbol: "ETHBTC", currency: "BTC", quantity: 1, price: 0.03 })];
    const us = new UsRegime(2025);
    expect(us.harvestCandidates(input(txs, { envelopes: [CB], fx: quoted.fx }), { ETHBTC: 0.04 }, "2025-10-01")).toEqual([]);
    // At 0.02 BTC (2 400 $) the lot is 600 $ under water, priced in dollars.
    const [c] = us.harvestCandidates(input(txs, { envelopes: [CB], fx: quoted.fx }), { ETHBTC: 0.02 }, "2025-10-01");
    expect([c?.price, c?.cost, c?.unrealized]).toEqual([2400, 3000, -600]);
    expect(c?.notes.join(" ")).toMatch(/0\.02 BTC/);
  });
});

describe("US: wash sale against a replacement lot partly sold before the loss sale", () => {
  it("a disallowed loss is deferred into shares still held, never dropped", () => {
    //   2024-01-02 buy 10 @ 100 in c                       cost 1 000
    //   2025-02-20 buy 100 @ 90 in a                       cost 9 000
    //   2025-02-25 sell 96 @ 91 in a                       proceeds 8 736 (gain 96)
    //   2025-03-01 sell 10 @ 80 in c                       proceeds 800 (loss 200)
    //   2025-11-01 sell the last 4 @ 95 in a               proceeds 380
    // Only the 4 shares still held can carry the loss: 80 $ disallowed (4 × 20, into their basis), 120 $ allowed.
    // The year's net result is the money made: 8 736 + 800 + 380 − 10 000 = −84.
    const txs = [
      tx({ date: "2024-01-02", type: "buy", account: "c", symbol: "X", quantity: 10, price: 100 }),
      tx({ date: "2025-02-20", type: "buy", account: "a", symbol: "X", quantity: 100, price: 90 }),
      tx({ date: "2025-02-25", type: "sell", account: "a", symbol: "X", quantity: 96, price: 91 }),
      tx({ date: "2025-03-01", type: "sell", account: "c", symbol: "X", quantity: 10, price: 80 }),
      tx({ date: "2025-11-01", type: "sell", account: "a", symbol: "X", quantity: 4, price: 95 }),
    ];
    const ev = disposals(txs);
    expect(ev.map((e) => [e.date, e.cost, e.gain, e.washSaleDisallowed])).toEqual([
      ["2025-02-25", 8640, 96, undefined],
      ["2025-03-01", 1000, -120, 80],
      ["2025-11-01", 440, -60, undefined],
    ]);
    expect(total(ev)).toBe(-84);
  });
});
