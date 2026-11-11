import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { toCsv } from "../src/core/csv.js";
import type { Envelope } from "../src/core/profile.js";
import { appendTransactions, transactionId, type Transaction } from "../src/portfolio/ledger.js";
import { export2086, export8949, exportKoinly } from "../src/tax/export.js";
import { FranceRegime } from "../src/tax/fr.js";
import { regimeFor } from "../src/tax/index.js";
import { cryptoHoldings, withCryptoQuotes } from "../src/tax/inputs.js";
import { brokerIsForeign, envelopeOf, splitPair, type TaxInput, yearsBetween } from "../src/tax/regime.js";
import { param, rulesFor, verifyChecklist } from "../src/tax/rules.js";
import { isLongTerm, UsRegime } from "../src/tax/us.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const raw = { origin: "manual", currency: "EUR", ...t } as Omit<Transaction, "id">;
  return { ...raw, id: transactionId(raw) } as Transaction;
};
const fx =
  (rates: Record<string, number> = {}) =>
  (c: string) =>
    c === "EUR" || c === "USD" ? (rates[c] ?? 1) : rates[c];
const input = (txs: Transaction[], envelopes: Envelope[], extra: Partial<TaxInput> = {}): TaxInput => ({
  year: 2025,
  transactions: txs,
  envelopes,
  fx: fx(),
  ...extra,
});
const fig = (s: { figures: Array<{ key: string; value: unknown }> }, k: string) => s.figures.find((f) => f.key.endsWith(k))?.value;
const box = (s: { forms: Array<{ box: string; value: unknown }> }, b: string) => s.forms.find((f) => f.box === b)?.value;

const CTO: Envelope = { id: "cto", type: "CTO", broker: "Boursorama", currency: "EUR" };
const IBKR: Envelope = { id: "ibkr", type: "CTO", broker: "Interactive Brokers", currency: "EUR" };
const KRAKEN: Envelope = { id: "kraken", type: "CRYPTO", broker: "Kraken", currency: "EUR" };
const PEA: Envelope = { id: "pea", type: "PEA", broker: "Fortuneo", currency: "EUR", openedAt: "2018-01-01" };

describe("tax rules", () => {
  it("has sourced, dated parameters and falls back with a staleness warning", () => {
    const r = rulesFor("fr", 2026);
    expect(param(r.rules, "ps.capital")).toBe(0.186);
    expect(param(r.rules, "ps.assuranceVie")).toBe(0.172);
    expect(param(rulesFor("fr", 2025).rules, "ps.capital")).toBe(0.172);
    for (const p of Object.values(r.rules.params)) {
      expect(p.sources.length).toBeGreaterThan(0);
      expect(p.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const later = rulesFor("us", 2031);
    expect(later.rules.year).toBe(2026);
    expect(later.stale).toMatch(/tax verify/);
    expect(() => rulesFor("fr", 1990)).toThrow(/no FR tax rules/);
    expect(() => param(r.rules, "nope")).toThrow(/not defined/);
    const check = verifyChecklist("fr", 2027);
    expect(check[0]!.key).toBe("_year");
    expect(check.find((c) => c.key === "pfu.ir")!.query).toMatch(/2027/);
    expect(() => regimeFor("de", 2025)).toThrow(/no tax regime/);
  });

  it("helpers: pairs, envelopes, brokers, anniversaries", () => {
    expect(splitPair("BTCUSDT")).toEqual({ base: "BTC", quote: "USDT" });
    expect(splitPair("XBTEUR", "EUR")).toEqual({ base: "BTC", quote: "EUR" });
    expect(splitPair("ETH-EUR")).toEqual({ base: "ETH", quote: "EUR" });
    expect(splitPair("SOL").base).toBe("SOL");
    expect(envelopeOf("pea", []).type).toBe("PEA");
    expect(envelopeOf("binance", []).type).toBe("CRYPTO");
    expect(envelopeOf("x", [], "ETHUSDT").type).toBe("CRYPTO");
    expect(envelopeOf("x", [], "MC.PA")).toMatchObject({ type: "CTO", guessed: true });
    expect(brokerIsForeign("Interactive Brokers")).toBe(true);
    expect(brokerIsForeign("BoursoBank")).toBe(false);
    expect(brokerIsForeign("Acme")).toBeUndefined();
    expect(yearsBetween("2020-06-15", "2025-06-14")).toBe(4);
    expect(yearsBetween("2020-06-15", "2025-06-15")).toBe(5);
    expect(toCsv([["a,b", 'q"x', 1]])).toBe('"a,b","q""x",1\r\n');
  });
});

describe("France", () => {
  it("securities at the weighted average cost, carryforward imputation, 3VG", () => {
    const txs = [
      tx({ date: "2025-01-10", type: "buy", account: "cto", symbol: "MC.PA", quantity: 10, price: 100, fee: 5 }),
      tx({ date: "2025-02-10", type: "buy", account: "cto", symbol: "MC.PA", quantity: 10, price: 120, fee: 5 }),
      tx({ date: "2025-06-01", type: "sell", account: "cto", symbol: "MC.PA", quantity: 5, price: 130, fee: 3 }),
    ];
    const fr = new FranceRegime(2025);
    const ev = fr.realize(input(txs, [CTO]));
    // PMP = (1000 + 5 + 1200 + 5) / 20 = 110.5; proceeds 650 − 3 = 647; cost 552.5.
    expect(ev[0]).toMatchObject({ kind: "securities-disposal", proceeds: 647, cost: 552.5, gain: 94.5 });
    const s = fr.annualSummary(input(txs, [CTO], { carryforward: { byYear: { "2014": 50, "2020": 30 } } }));
    expect(box(s, "3VG")).toBe(64.5);
    expect(s.warnings.join(" ")).toMatch(/2014 loss carryforward.*lost/);
    expect(fig(s, "pfu.incomeTax")).toBe(8.26);
  });

  it("pools the cost by security (ISIN), whatever symbol each account books it under", () => {
    const MC = "FR0000121014";
    const txs = [
      tx({ date: "2025-01-10", type: "buy", account: "cto", symbol: "MC.PA", isin: MC, quantity: 10, price: 100 }),
      // The same share at IBKR, kept as its ISIN when the listing could not be placed.
      tx({ date: "2025-02-10", type: "buy", account: "ibkr", symbol: MC, isin: MC, quantity: 10, price: 120 }),
      // A row typed by hand without the ISIN: its symbol was seen with one.
      tx({ date: "2025-03-10", type: "sell", account: "cto", symbol: "MC.PA", quantity: 20, price: 130 }),
      // Another security stays its own pool.
      tx({ date: "2025-01-10", type: "buy", account: "cto", symbol: "AI.PA", isin: "FR0000120073", quantity: 1, price: 150 }),
    ];
    const s = new FranceRegime(2025).annualSummary(input(txs, [CTO, IBKR]));
    const d = s.events.filter((e) => e.kind === "securities-disposal");
    expect(d.map((e) => [e.symbol, e.cost, e.gain])).toEqual([["MC.PA", 2200, 400]]);
    expect(s.warnings.join(" ")).not.toMatch(/no cost|no recorded purchase/);
    const h = new FranceRegime(2025).harvestCandidates(input(txs, [CTO, IBKR]), { "AI.PA": 140 }, "2025-12-01");
    expect(h.map((c) => [c.symbol, c.unrealized])).toEqual([["AI.PA", -10]]);
  });

  it("a net loss goes to 3VH and is carried forward with its year", () => {
    const txs = [
      tx({ date: "2025-01-10", type: "buy", account: "cto", symbol: "AI.PA", quantity: 10, price: 200 }),
      tx({ date: "2025-03-10", type: "sell", account: "cto", symbol: "AI.PA", quantity: 10, price: 150 }),
    ];
    const s = new FranceRegime(2025).annualSummary(input(txs, [CTO], { carryforward: { byYear: { "2023": 100 } } }));
    expect(box(s, "3VH")).toBe(500);
    expect(fig(s, "carryforwardOut")).toBe("2023: 100, 2025: 500");
  });

  it("crypto: the 2086 notice's own example (450 − 1000 × 450 / 1200 = 75, then 675)", () => {
    const txs = [
      tx({ date: "2025-01-10", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 0.1, price: 10_000 }),
      tx({ date: "2025-03-10", type: "sell", account: "kraken", symbol: "BTCEUR", quantity: 0.0375, price: 12_000 }),
      tx({ date: "2025-04-01", type: "sell", account: "kraken", symbol: "BTCUSDT", currency: "USDT", quantity: 0.01, price: 12_000 }),
      tx({ date: "2025-08-10", type: "sell", account: "kraken", symbol: "BTCEUR", quantity: 0.0625, price: 20_800 }),
    ];
    const values: Record<string, number> = { "2025-03-10": 1200, "2025-08-10": 1300 };
    const fr = new FranceRegime(2025);
    const s = fr.annualSummary(input(txs, [KRAKEN], { cryptoValue: (d) => values[d] }));
    const cd = s.events.filter((e) => e.kind === "crypto-disposal");
    expect(cd.map((e) => e.gain)).toEqual([75, 675]);
    expect(cd[1]!.lines).toMatchObject({ "220": 1000, "221": 375, "223": 625, "224": 675 });
    expect(s.events.some((e) => e.kind === "crypto-exchange")).toBe(true);
    expect(box(s, "3AN")).toBe(750);
    expect(s.obligations.join(" ")).toMatch(/3916-bis.*kraken/);
    expect(export2086(s.events).split("\r\n")[1]).toMatch(/^kraken,BTCEUR,2025-03-10,1200,450/);
    // The holdings replay counts the quote currency of a crypto pair.
    const h = cryptoHoldings(txs, [KRAKEN]);
    expect(h.get("USDT")).toBeCloseTo(120);
  });

  it("crypto: the holdings before each disposal are the same asked once or for every disposal of a report", () => {
    const txs = [
      tx({ date: "2025-01-10T09:00:00", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 0.1, price: 10_000 }),
      tx({ date: "2025-02-01T09:00:00", type: "buy", account: "kraken", symbol: "ETHBTC", currency: "BTC", quantity: 1, price: 0.03, fee: 0.0001 }),
      tx({ date: "2025-03-10T09:00:00", type: "sell", account: "kraken", symbol: "BTCEUR", quantity: 0.02, price: 12_000 }),
      tx({ date: "2025-03-10T15:00:00", type: "transfer-out", account: "kraken", symbol: "ETH", currency: "ETH", quantity: 0.25 }),
      tx({ date: "2025-04-01T09:00:00", type: "sell", account: "kraken", symbol: "ETHEUR", quantity: 0.5, price: 2_000 }),
      tx({ date: "2025-04-02", type: "buy", account: "cto", symbol: "MC.PA", quantity: 1, price: 500 }),
    ];
    const envelopes = [KRAKEN, CTO];
    const asObject = (t?: Transaction) => Object.fromEntries([...cryptoHoldings(txs, envelopes, t)].map(([k, v]) => [k, Number(v.toFixed(8))]));
    // Before the first sale: 0.1 BTC less the 0.03 and the 0.0001 fee that bought 1 ETH.
    expect(asObject(txs[2])).toEqual({ BTC: 0.0699, ETH: 1 });
    // Before the second: the day's later transfer has gone out, the first sale too.
    expect(asObject(txs[4])).toEqual({ BTC: 0.0499, ETH: 0.75 });
    // Asked again, and in the other order, the answers do not move.
    expect(asObject(txs[2])).toEqual({ BTC: 0.0699, ETH: 1 });
    expect(asObject()).toEqual({ BTC: 0.0499, ETH: 0.25 });
    // A ledger that grows is read again: nothing worked out on the shorter one is reused.
    txs.push(tx({ date: "2025-05-01", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 1, price: 20_000 }));
    expect(asObject()).toEqual({ BTC: 1.0499, ETH: 0.25 });
    // Another set of accounts is another reading: without the Kraken envelope the rows are still crypto by their name.
    expect([...cryptoHoldings(txs, [CTO]).keys()].sort()).toEqual(["BTC", "ETH"]);
  });

  it("crypto: rows quoted in another crypto-asset do not stop the report for want of a euro rate", () => {
    const BINANCE: Envelope = { id: "binance", type: "CRYPTO", broker: "Binance", currency: "EUR" };
    // What a Binance statement holds: a pair quoted in BTC with its fee in BTC, and a fee taken in BNB. The test's rate
    // table knows the euro and the dollar only, like the ECB's.
    const txs = [
      tx({ date: "2025-01-10", type: "buy", account: "binance", symbol: "BTCEUR", quantity: 0.1, price: 50_000, fee: 5 }),
      tx({ date: "2025-02-01", type: "buy", account: "binance", symbol: "ETHBTC", currency: "BTC", quantity: 1, price: 0.03, fee: 0.00003 }),
      tx({ date: "2025-02-01", type: "fee", account: "binance", currency: "BNB", amount: -0.001 }),
      tx({ date: "2025-02-02", type: "transfer-out", account: "binance", symbol: "ETH", currency: "ETH", quantity: 0.5 }),
    ];
    const s = new FranceRegime(2025).annualSummary(input(txs, [BINANCE]));
    expect(s.events.filter((e) => e.kind === "crypto-exchange")).toHaveLength(1);
    expect(s.events.some((e) => e.kind === "crypto-disposal")).toBe(false);
  });

  it("crypto: a Coinbase convert is an exchange between crypto-assets, not a disposal", () => {
    const COINBASE: Envelope = { id: "coinbase", type: "CRYPTO", broker: "Coinbase", currency: "EUR" };
    const cb = (t: Partial<Transaction> & Pick<Transaction, "date" | "type">) => tx({ account: "coinbase", origin: "import:coinbase", ...t });
    // 1 ETH bought 1 000 €, converted to BTC when it is worth 3 000 €: the statement books the convert as a sale and a
    // purchase priced in euros, but no euro changed hands.
    const txs = [
      cb({ date: "2025-01-10T09:00:00", type: "buy", symbol: "ETHEUR", quantity: 1, price: 1_000 }),
      cb({ date: "2025-06-01T09:00:00", type: "sell", symbol: "ETHEUR", quantity: 1, price: 3_000, fee: 30, note: "convert to BTC" }),
      cb({ date: "2025-06-01T09:00:00", type: "buy", symbol: "BTCEUR", quantity: 0.0495, price: 60_000, note: "convert from ETH" }),
    ];
    const fr = new FranceRegime(2025);
    const s = fr.annualSummary(input(txs, [COINBASE], { cryptoValue: () => 3_000 }));
    expect(s.events.filter((e) => e.kind === "crypto-disposal")).toEqual([]);
    expect(s.events.filter((e) => e.kind === "crypto-exchange").map((e) => e.symbol)).toEqual(["ETHEUR", "BTCEUR"]);
    expect(box(s, "3AN")).toBeUndefined();
    expect(s.warnings.join(" ")).not.toMatch(/portfolio's total value/);
    // The acquisition price is still the 1 000 € paid: a later sale of the BTC for euros is computed on it.
    const later = [...txs, cb({ date: "2025-09-01T09:00:00", type: "sell", symbol: "BTCEUR", quantity: 0.0495, price: 80_000 })];
    const sold = fr.annualSummary(input(later, [COINBASE], { cryptoValue: () => 3_960 })).events.filter((e) => e.kind === "crypto-disposal");
    expect(sold).toHaveLength(1);
    expect(sold[0]!.lines).toMatchObject({ "220": 1000, "221": 0, "223": 1000, "224": 2960 });
    // The same two rows typed by hand are a sale and a purchase in euros: only the statement's convert is deferred.
    const manual = txs.map((t) => tx({ ...t, origin: "manual" }));
    expect(fr.realize(input(manual, [COINBASE], { cryptoValue: () => 3_000 })).filter((e) => e.kind === "crypto-disposal")).toHaveLength(1);
    // The United States tax a convert: a disposal at fair value.
    const us = new UsRegime(2025).realize(input(txs, [{ ...COINBASE, currency: "USD" }]));
    expect(us.filter((e) => e.kind === "crypto-disposal")).toHaveLength(1);
  });

  it("crypto: a pair whose base is the fiat (EURUSDT) is a purchase when sold and a cash-out when bought", () => {
    const BINANCE: Envelope = { id: "binance", type: "CRYPTO", broker: "Binance", currency: "EUR" };
    const b = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "symbol">) => tx({ account: "binance", currency: "USDT", ...t });
    const txs = [
      // 9 000 € become 9 000 USDT: euros paid for a crypto-asset.
      b({ date: "2025-01-10", type: "sell", symbol: "EURUSDT", quantity: 9_000, price: 1 }),
      b({ date: "2025-01-11", type: "buy", symbol: "BTCUSDT", quantity: 0.1, price: 90_000 }),
      b({ date: "2025-09-01", type: "sell", symbol: "BTCUSDT", quantity: 0.1, price: 132_000 }),
      // 13 200 USDT become 12 000 €: a crypto-asset given for euros.
      b({ date: "2025-09-10", type: "buy", symbol: "EURUSDT", quantity: 12_000, price: 1.1 }),
    ];
    const s = new FranceRegime(2025).annualSummary(input(txs, [BINANCE], { cryptoValue: (d) => (d === "2025-09-10" ? 12_000 : undefined) }));
    const cd = s.events.filter((e) => e.kind === "crypto-disposal");
    expect(cd).toHaveLength(1);
    expect(cd[0]).toMatchObject({ date: "2025-09-10", proceeds: 12_000, cost: 9_000, gain: 3_000 });
    expect(cd[0]!.lines).toMatchObject({ "213": 12_000, "220": 9_000, "223": 9_000, "224": 3_000 });
    expect(s.events.filter((e) => e.kind === "crypto-exchange")).toHaveLength(2);
    expect(box(s, "3AN")).toBe(3_000);
    // The euros of the pair are not a crypto holding: the portfolio is the USDT about to be sold, and nothing after.
    expect(Object.fromEntries(cryptoHoldings(txs, [BINANCE], txs[3]))).toEqual({ USDT: 13_200 });
    const after = cryptoHoldings(txs, [BINANCE]);
    expect(after.has("EUR")).toBe(false);
    expect(after.get("USDT") ?? 0).toBeCloseTo(0, 6);
    // Another fiat as the base is converted at its own rate: 1 000 £ at 1.2 € paid for USDT.
    const gbp = [
      b({ date: "2025-02-01", type: "sell", symbol: "GBPUSDT", quantity: 1_000, price: 1.25, fee: 1.25 }),
      b({ date: "2025-03-01", type: "sell", symbol: "USDTEUR", currency: "EUR", quantity: 1_248.75, price: 1 }),
    ];
    const g = new FranceRegime(2025).realize(input(gbp, [BINANCE], { fx: fx({ GBP: 1.2 }), cryptoValue: () => 1_248.75 }));
    expect(g.find((e) => e.kind === "crypto-disposal")!.lines).toMatchObject({ "220": 1_200, "224": 48.75 });
  });

  it("crypto held at a stockbroker is taxed as crypto, not as a security", () => {
    // IBKR books crypto in the same account as the shares: a CTO in the profile.
    const k = (t: Partial<Transaction> & Pick<Transaction, "date" | "type">) =>
      tx({ account: "ibkr", currency: "USD", symbol: "BTCUSD", origin: "import:ibkr-flex", assetClass: "crypto", ...t });
    const txs = [
      k({ date: "2025-01-10", type: "buy", quantity: 0.1, price: 50_000 }),
      k({ date: "2025-06-10", type: "sell", quantity: 0.1, price: 60_000 }),
      tx({ date: "2025-01-10", type: "buy", account: "ibkr", currency: "USD", symbol: "AAPL", isin: "US0378331005", quantity: 10, price: 200 }),
      tx({ date: "2025-06-10", type: "sell", account: "ibkr", currency: "USD", symbol: "AAPL", isin: "US0378331005", quantity: 10, price: 210 }),
    ];
    const kinds = (rows: Transaction[]) =>
      new FranceRegime(2025)
        .realize(input(rows, [IBKR], { cryptoValue: () => 6_000 }))
        .map((e) => [e.kind, e.symbol, e.gain])
        .sort();
    const expected = [
      ["crypto-disposal", "BTCUSD", 1_000],
      ["securities-disposal", "AAPL", 100],
    ];
    expect(kinds(txs)).toEqual(expected);
    // A ledger imported before the marker existed: a well-known coin against a fiat, with no ISIN, reads as crypto too.
    const legacy = txs.map(({ assetClass: _, ...t }) => t as Transaction);
    expect(kinds(legacy)).toEqual(expected);
    // The United States: crypto rules too — a disposal of a digital asset, no wash sale on the repurchase.
    const us = new UsRegime(2025).realize(
      input(
        [
          k({ date: "2025-01-10", type: "buy", quantity: 1, price: 100 }),
          k({ date: "2025-02-01", type: "sell", quantity: 1, price: 80 }),
          k({ date: "2025-02-02", type: "buy", quantity: 1, price: 81 }),
        ],
        [{ ...IBKR, type: "TAXABLE", currency: "USD" }],
      ),
    );
    expect(us.map((e) => [e.kind, e.gain, e.washSaleDisallowed])).toEqual([["crypto-disposal", -20, undefined]]);
  });

  it("crypto: 305 € or less of disposals in the year is exempt; an unknown portfolio value is named", () => {
    const txs = [
      tx({ date: "2025-01-10", type: "buy", account: "kraken", symbol: "ETHEUR", quantity: 1, price: 200 }),
      tx({ date: "2025-05-10", type: "sell", account: "kraken", symbol: "ETHEUR", quantity: 0.5, price: 600 }),
    ];
    const fr = new FranceRegime(2025);
    const s = fr.annualSummary(input(txs, [KRAKEN], { cryptoValue: () => 600 }));
    expect(fig(s, "crypto.exempt")).toBe("yes");
    expect(box(s, "3AN")).toBeUndefined();
    const u = fr.annualSummary(input(txs, [KRAKEN]));
    expect(u.warnings.join(" ")).toMatch(/total value at that moment is unknown/);
  });

  it("crypto: a gain computed after a disposal of unknown portfolio value is flagged as understated", () => {
    // The 2086 notice's example with the first disposal's portfolio value missing: the second is then computed on the
    // whole 1 000 € of acquisitions (1 300 − 1 000 × 1 300 / 1 300 = 300) where the notice finds 675.
    const txs = [
      tx({ date: "2025-01-10", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 0.1, price: 10_000 }),
      tx({ date: "2025-03-10", type: "sell", account: "kraken", symbol: "BTCEUR", quantity: 0.0375, price: 12_000 }),
      tx({ date: "2025-08-10", type: "sell", account: "kraken", symbol: "BTCEUR", quantity: 0.0625, price: 20_800 }),
    ];
    const values: Record<string, number> = { "2025-08-10": 1300 };
    const s = new FranceRegime(2025).annualSummary(input(txs, [KRAKEN], { cryptoValue: (d) => values[d] }));
    const second = s.events.filter((e) => e.kind === "crypto-disposal")[1]!;
    expect(second.gain).toBe(300);
    expect(second.notes.join(" ")).toMatch(/disposal of 2025-03-10.*this gain is understated/);
    expect(s.warnings.filter((w) => /every later gain is understated/.test(w))).toHaveLength(1);
    // With every value known, nothing is flagged.
    const full = new FranceRegime(2025).annualSummary(input(txs, [KRAKEN], { cryptoValue: (d) => ({ ...values, "2025-03-10": 1200 })[d] }));
    expect(full.warnings.join(" ")).not.toMatch(/understated/);
    expect(full.events.filter((e) => e.kind === "crypto-disposal").map((e) => e.gain)).toEqual([75, 675]);
  });

  it("PEA withdrawal after 5 years: social levies on the gain share only", () => {
    const txs = [
      tx({ date: "2018-01-05", type: "deposit", account: "pea", amount: 100_000 }),
      tx({ date: "2025-06-02", type: "withdrawal", account: "pea", amount: -20_000 }),
    ];
    const fr = new FranceRegime(2025);
    const s = fr.annualSummary(input(txs, [PEA], { envelopeValues: { "pea|2025-06-02": 150_000 } }));
    const w = s.events.find((e) => e.kind === "envelope-withdrawal")!;
    expect(w.gain).toBeCloseTo(6666.67, 2);
    expect(Number(s.figures.find((f) => f.key.includes("envelope.pea"))!.value)).toBeCloseTo(1146.67, 2);
    const missing = fr.annualSummary(input(txs, [PEA]));
    expect(missing.warnings.join(" ")).toMatch(/--envelope-value pea:2025-06-02/);
    // Before 5 years the plan closes and 12.8 % is added.
    const young = { ...PEA, openedAt: "2022-01-01" };
    const e = fr.annualSummary(input(txs, [young], { envelopeValues: { "pea|2025-06-02": 150_000 } }));
    expect(e.events.find((x) => x.kind === "envelope-withdrawal")!.notes.join(" ")).toMatch(/plan closes/);
  });

  it("dividends: PFU vs the progressive scale, foreign withholding credit, 2778-DIV and 3916 at a foreign broker", () => {
    const txs = [
      tx({ date: "2025-03-14", type: "dividend", account: "ibkr", symbol: "KO", isin: "US1912161007", currency: "USD", amount: 100 }),
      tx({ date: "2025-03-14", type: "tax", account: "ibkr", symbol: "KO", isin: "US1912161007", currency: "USD", amount: -15 }),
      tx({ date: "2025-05-20", type: "dividend", account: "cto", symbol: "TTE.PA", isin: "FR0000120271", amount: 910 }),
    ];
    const fr = new FranceRegime(2025);
    const s = fr.annualSummary({ ...input(txs, [IBKR, CTO]), fx: fx({ USD: 0.9 }), marginalRate: 0.11 });
    expect(box(s, "2DC")).toBe(1000);
    // Credit = min(13.5, 90 × 12.8 %) = 11.52.
    expect(box(s, "2AB")).toBe(11.52);
    expect(box(s, "2CK")).toBeCloseTo(116.48, 2);
    expect(box(s, "—")).toBeDefined();
    // Scale: 1000 × 0.6 × 0.11 = 66 − CSG saving 1000 × 0.068 × 0.11 = 7.48 → better than 128.
    expect(fig(s, "scale.incomeTax")).toBe(66);
    expect(fig(s, "option.better")).toMatch(/progressive scale/);
    expect(s.obligations.join(" ")).toMatch(/2778-DIV.*2025-03/);
    expect(s.obligations.join(" ")).toMatch(/form 3916: declare the account "ibkr"/);
    const rules = fr.envelopeRules().map((r) => r.envelope);
    expect(rules).toEqual(expect.arrayContaining(["PEA", "CTO", "AV", "CRYPTO"]));
    expect(fr.withholdingRules()[0]).toMatch(/15 %/);
  });

  it("a withholding reversed and taken again on the statement counts once", () => {
    const ko = { account: "ibkr", symbol: "KO", isin: "US1912161007", currency: "USD" };
    const txs = [
      tx({ date: "2025-03-14", type: "dividend", ...ko, amount: 100 }),
      // The broker withholds, reverses its own entry, and withholds again: 15 was withheld, not 45.
      tx({ date: "2025-03-14", type: "tax", ...ko, amount: -15 }),
      tx({ date: "2025-03-20", type: "tax", ...ko, amount: 15 }),
      tx({ date: "2025-03-21", type: "tax", ...ko, amount: -15 }),
    ];
    const s = new FranceRegime(2025).annualSummary({ ...input(txs, [IBKR]), fx: fx({ USD: 0.9 }) });
    expect(fig(s, "withholding.foreign")).toBe(13.5);
    // 13.5 € on 90 € of income is the 15 % treaty rate: no call to file a W-8BEN and claim an excess.
    expect(s.warnings.join(" ")).not.toMatch(/above the 15 % treaty rate/);
    const us = new UsRegime(2025).annualSummary({ ...input(txs, [{ id: "ibkr", type: "TAXABLE", broker: "Interactive Brokers", currency: "USD" }]) });
    expect(us.forms.find((f) => f.box === "foreign tax credit")).toMatchObject({ value: 15 });
  });

  it("harvest: positions under the PMP offset the year's gains", () => {
    const txs = [
      tx({ date: "2025-01-10", type: "buy", account: "cto", symbol: "AAA.PA", quantity: 10, price: 100 }),
      tx({ date: "2025-02-10", type: "sell", account: "cto", symbol: "AAA.PA", quantity: 10, price: 150 }),
      tx({ date: "2025-03-10", type: "buy", account: "cto", symbol: "BBB.PA", quantity: 10, price: 100 }),
    ];
    const c = new FranceRegime(2025).harvestCandidates(input(txs, [CTO]), { "BBB.PA": 70 }, "2025-10-01");
    expect(c[0]).toMatchObject({ symbol: "BBB.PA", unrealized: -300 });
    expect(c[0]!.saving).toBeCloseTo(300 * (0.128 + 0.172), 2);
  });
});

describe("United States", () => {
  const BROKER: Envelope = { id: "schwab", type: "TAXABLE", broker: "Schwab", currency: "USD" };
  const IRA: Envelope = { id: "ira", type: "IRA", broker: "Schwab", currency: "USD" };
  const usIn = (txs: Transaction[], extra: Partial<TaxInput> = {}): TaxInput => ({ ...input(txs, [BROKER, IRA]), ...extra });
  const u = (t: Partial<Transaction> & Pick<Transaction, "date" | "type">) => tx({ account: "schwab", currency: "USD", ...t });

  it("long-term means sold after the first anniversary", () => {
    expect(isLongTerm("2024-01-10", "2025-01-10")).toBe(false);
    expect(isLongTerm("2024-01-10", "2025-01-11")).toBe(true);
    expect(isLongTerm("2024-02-29", "2025-03-01")).toBe(true);
  });

  it("FIFO lots, holding periods and the 8949 export", () => {
    const txs = [
      u({ date: "2024-01-10", type: "buy", symbol: "NVDA", quantity: 10, price: 100, fee: 1 }),
      u({ date: "2024-06-10", type: "buy", symbol: "NVDA", quantity: 10, price: 200 }),
      u({ date: "2025-03-01", type: "sell", symbol: "NVDA", quantity: 15, price: 300, fee: 1.5 }),
    ];
    const us = new UsRegime(2025);
    const ev = us.realize(usIn(txs));
    expect(ev.map((e) => [e.term, e.cost, e.gain])).toEqual([
      ["long", 1001, 1998],
      ["short", 1000, 499.5],
    ]);
    const hifo = us.realize(usIn(txs, { lotMethod: "hifo" }));
    expect(hifo[0]!.cost).toBe(2000);
    expect(export8949(ev).split("\r\n")).toHaveLength(4);
  });

  it("replays a day's trades in the order of their time, whatever order the statement lists them in", () => {
    // A statement exported newest-first: the sale of 15:00 is listed before the purchase of 10:00.
    const txs = [
      u({ date: "2025-03-03T15:00:00", type: "sell", symbol: "NVDA", quantity: 10, price: 110 }),
      u({ date: "2025-03-03T10:00:00", type: "buy", symbol: "NVDA", quantity: 10, price: 100 }),
    ];
    const ev = new UsRegime(2025).realize(usIn(txs)).filter((e) => e.kind === "securities-disposal");
    // Sold before it was bought, the sale had no lot: a basis of 0 and a gain of the whole proceeds.
    expect(ev.map((e) => [e.proceeds, e.cost, e.gain])).toEqual([[1100, 1000, 100]]);
    // The French crypto formula reads the same order: the purchase is in the acquisition cost when the sale is computed.
    const fr = new FranceRegime(2025).realize(
      input(
        [
          tx({ date: "2025-03-03T15:00:00", type: "sell", account: "kraken", symbol: "BTCEUR", quantity: 0.1, price: 51_000 }),
          tx({ date: "2025-03-03T10:00:00", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 0.1, price: 50_000 }),
        ],
        [KRAKEN],
        { cryptoValue: () => 5_100 },
      ),
    );
    expect(fr.find((e) => e.kind === "crypto-disposal")?.gain).toBeCloseTo(100, 6);
  });

  it("a transfer between own accounts keeps the lots' basis and holding period", () => {
    const FIDELITY: Envelope = { id: "fidelity", type: "TAXABLE", broker: "Fidelity", currency: "USD" };
    const txs = [
      u({ date: "2022-03-02", type: "buy", symbol: "AAPL", quantity: 10, price: 150 }),
      u({ date: "2025-06-01", type: "transfer-out", symbol: "AAPL", quantity: 10 }),
      tx({ date: "2025-06-01", type: "transfer-in", account: "fidelity", currency: "USD", symbol: "AAPL", quantity: 10 }),
      tx({ date: "2025-12-01", type: "sell", account: "fidelity", currency: "USD", symbol: "AAPL", quantity: 10, price: 190 }),
    ];
    const run = (rows: Transaction[]) => new UsRegime(2025).realize(input(rows, [BROKER, FIDELITY])).filter((e) => e.kind === "securities-disposal");
    expect(run(txs).map((e) => [e.account, e.cost, e.gain, e.term, e.acquired])).toEqual([["fidelity", 1500, 400, "long", "2022-03-02"]]);
    // Listed in the other order on the statement, the day's two legs still meet.
    expect(run([txs[0]!, txs[2]!, txs[1]!, txs[3]!]).map((e) => [e.gain, e.term])).toEqual([[400, "long"]]);
    // Moved in two lots: each keeps its own date and basis.
    const two = [
      u({ date: "2022-03-02", type: "buy", symbol: "AAPL", quantity: 4, price: 150 }),
      u({ date: "2025-05-02", type: "buy", symbol: "AAPL", quantity: 6, price: 170 }),
      ...txs.slice(1),
    ];
    expect(run(two).map((e) => [e.quantity, e.cost, e.term])).toEqual([
      [4, 600, "long"],
      [6, 1020, "short"],
    ]);
    // Nothing transferred out: as before, no basis and a holding period from the transfer.
    expect(run(txs.slice(2)).map((e) => [e.cost, e.gain, e.term])).toEqual([[0, 1900, "short"]]);
  });

  it("judges a dividend's holding period on the shares still held, not on lots sold long ago", () => {
    const txs = [
      u({ date: "2020-01-10", type: "buy", symbol: "KO", quantity: 10, price: 50 }),
      u({ date: "2021-02-01", type: "sell", symbol: "KO", quantity: 10, price: 55 }),
      u({ date: "2025-03-01", type: "buy", symbol: "KO", quantity: 10, price: 60 }),
      u({ date: "2025-03-14", type: "dividend", symbol: "KO", amount: 5 }),
      u({ date: "2025-09-15", type: "dividend", symbol: "KO", amount: 5 }),
    ];
    const divs = new UsRegime(2025).realize(usIn(txs)).filter((e) => e.kind === "dividend");
    // Held 13 days at the first payment (the 2020 lot is gone), 198 at the second.
    expect(divs.map((e) => e.lines?.qualified)).toEqual(["false", "true"]);
  });

  it("wash sale: the loss moves into the replacement's basis; an IRA replacement loses it", () => {
    const txs = [
      u({ date: "2025-01-02", type: "buy", symbol: "AAPL", quantity: 10, price: 100 }),
      u({ date: "2025-02-01", type: "sell", symbol: "AAPL", quantity: 10, price: 80 }),
      u({ date: "2025-02-15", type: "buy", symbol: "AAPL", quantity: 10, price: 85 }),
      u({ date: "2025-12-01", type: "sell", symbol: "AAPL", quantity: 10, price: 110 }),
    ];
    const us = new UsRegime(2025);
    const ev = us.realize(usIn(txs));
    expect(ev[0]).toMatchObject({ gain: 0, washSaleDisallowed: 200 });
    expect(ev[1]).toMatchObject({ cost: 1050, gain: 50 });
    expect(export8949(ev)).toMatch(/,W,200,0,/);
    const ira = us.realize(
      usIn([txs[0]!, txs[1]!, tx({ date: "2025-02-15", type: "buy", account: "ira", currency: "USD", symbol: "AAPL", quantity: 10, price: 85 })]),
    );
    expect(ira[0]!.notes.join(" ")).toMatch(/lost for good/);
    // Crypto: no wash-sale rule applied.
    const c = us.realize({
      ...input(
        [
          tx({ date: "2025-01-02", type: "buy", account: "cb", currency: "USD", symbol: "BTCUSD", quantity: 1, price: 100 }),
          tx({ date: "2025-02-01", type: "sell", account: "cb", currency: "USD", symbol: "BTCUSD", quantity: 1, price: 80 }),
          tx({ date: "2025-02-02", type: "buy", account: "cb", currency: "USD", symbol: "BTCUSD", quantity: 1, price: 81 }),
        ],
        [{ id: "cb", type: "CRYPTO", broker: "Coinbase", currency: "USD" }],
      ),
    });
    expect(c[0]).toMatchObject({ kind: "crypto-disposal", gain: -20 });
  });

  it("wash sale: only the replacement shares take the loss and the holding period", () => {
    const txs = [
      u({ date: "2024-01-02", type: "buy", symbol: "AAPL", quantity: 10, price: 100 }),
      u({ date: "2024-12-01", type: "sell", symbol: "AAPL", quantity: 10, price: 80 }),
      u({ date: "2024-12-10", type: "buy", symbol: "AAPL", quantity: 100, price: 85 }),
      u({ date: "2025-02-01", type: "sell", symbol: "AAPL", quantity: 100, price: 90 }),
    ];
    const ev = new UsRegime(2025).realize(usIn(txs)).filter((e) => e.kind === "securities-disposal");
    // 10 replacement shares: 85 + 20 of disallowed loss each, held since 2024-12-10 less the 334 days of the shares sold.
    // The other 90: their own price and date.
    expect(ev.map((e) => [e.quantity, e.cost, e.term, e.acquired]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [10, 1050, "long", "2024-01-11"],
      [90, 7650, "short", "2024-12-10"],
    ]);
    // A second loss sale within the window finds no replacement left in the 10 already used: nothing moves twice.
    const again = [
      ...txs.slice(0, 3),
      u({ date: "2024-12-12", type: "buy", symbol: "AAPL", quantity: 10, price: 70 }),
      u({ date: "2024-12-20", type: "sell", symbol: "AAPL", quantity: 10, price: 60 }),
    ];
    const lots = new UsRegime(2025).replay(usIn(again)).open.map((l) => [l.quantity, l.basis, l.acquired]);
    expect(lots).toContainEqual([10, 105, "2024-01-11"]);
    expect(lots.filter((l) => l[2] === "2024-01-11")).toHaveLength(1);
  });

  it("the $3,000 limit, carryforward, LTCG brackets and NIIT", () => {
    const loss = [
      u({ date: "2025-01-02", type: "buy", symbol: "X", quantity: 100, price: 100 }),
      u({ date: "2025-06-02", type: "sell", symbol: "X", quantity: 100, price: 50 }),
    ];
    const s = new UsRegime(2025).annualSummary(usIn(loss));
    expect(fig(s, "loss.deductible")).toBe(3000);
    expect(fig(s, "carryforward.out")).toBe("2000, 0");
    const sep = new UsRegime(2025).annualSummary(usIn(loss, { filingStatus: "separate" }));
    expect(fig(sep, "loss.deductible")).toBe(1500);
    const gain = [
      u({ date: "2024-01-02", type: "buy", symbol: "Y", quantity: 100, price: 100 }),
      u({ date: "2026-02-02", type: "sell", symbol: "Y", quantity: 100, price: 300 }),
    ];
    const us26 = new UsRegime(2026);
    const b = us26.annualSummary({ ...usIn(gain), year: 2026, ordinaryIncome: 40_000 });
    // 9 450 at 0 %, 10 550 at 15 %.
    expect(fig(b, "ltcg.tax")).toBe(1582.5);
    const n = us26.annualSummary({ ...usIn(gain), year: 2026, ordinaryIncome: 250_000, marginalRate: 0.35 });
    expect(fig(n, "niit")).toBe(760);
    expect(fig(n, "total.estimate")).toBeDefined();
  });

  it("a trade quoted in a crypto-asset (ETHBTC) is converted at that asset's daily close", async () => {
    const CB: Envelope = { id: "cb", type: "CRYPTO", broker: "Coinbase", currency: "USD" };
    const c = (t: Partial<Transaction> & Pick<Transaction, "date" | "type">) => tx({ account: "cb", symbol: "ETHBTC", currency: "BTC", ...t });
    const txs = [
      c({ date: "2025-02-01", type: "buy", quantity: 1, price: 0.03 }),
      // A Sunday: the close of the Saturday before is the last known.
      c({ date: "2025-06-01", type: "sell", quantity: 1, price: 0.035 }),
    ];
    const us = new UsRegime(2025);
    expect(() => us.realize(input(txs, [CB]))).toThrow(/no BTC→USD rate/);
    const closes = vi.fn(
      async (asset: string) =>
        new Map<string, number>(
          asset === "BTC"
            ? [
                ["2025-02-01", 100_000],
                ["2025-05-31", 80_000],
              ]
            : [],
        ),
    );
    const quoted = await withCryptoQuotes(fx(), ["USD", "BTC", "USDT"], "2025-01-01", "2025-12-31", closes);
    expect(closes).toHaveBeenCalledTimes(1);
    expect(quoted.notes.join(" ")).toMatch(/BTC.*daily close/);
    const ev = us.realize(input(txs, [CB], { fx: quoted.fx }));
    expect(ev.map((e) => [e.kind, e.proceeds, e.cost, e.gain])).toEqual([["crypto-disposal", 2800, 3000, -200]]);
    // In euros, the close is converted at the day's USD rate.
    const eur = await withCryptoQuotes(fx({ USD: 0.9 }), ["BTC"], "2025-01-01", "2025-12-31", closes);
    expect(eur.fx("BTC", "2025-02-01")).toBeCloseTo(90_000, 6);
    expect(eur.fx("BTC", "2025-01-10")).toBeUndefined();
    expect(eur.fx("USD", "2025-01-10")).toBe(0.9);
  });

  it("harvest flags a recent purchase as a wash-sale risk", () => {
    const txs = [
      u({ date: "2025-01-02", type: "buy", symbol: "Z", quantity: 10, price: 100 }),
      u({ date: "2025-09-20", type: "buy", symbol: "Z", quantity: 1, price: 90 }),
    ];
    const c = new UsRegime(2025).harvestCandidates(usIn(txs), { Z: 60 }, "2025-10-01");
    expect(c[0]!.notes.join(" ")).toMatch(/WASH-SALE RISK/);
    expect(c[0]!.term).toBe("short");
  });

  it("Koinly export", () => {
    const k = exportKoinly([tx({ date: "2025-01-02", type: "buy", account: "cb", currency: "EUR", symbol: "ETHEUR", quantity: 2, price: 1000 })], () => true);
    expect(k.split("\r\n")[1]).toMatch(/^2025-01-02 00:00 UTC,2000,EUR,2,ETH,/);
  });
});

describe("tax command", () => {
  afterEach(() => vi.restoreAllMocks());
  async function cli(argv: string[]) {
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out += String(c);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await main(argv);
    } finally {
      vi.restoreAllMocks();
    }
    return out;
  }

  it("report, lots, rules, verify and export on a euro ledger (no network)", async () => {
    await appendTransactions(
      [
        { date: "2025-01-10", type: "buy", account: "cto", symbol: "MC.PA", quantity: 2, price: 600, fee: 2, currency: "EUR", origin: "manual" },
        { date: "2025-09-10", type: "sell", account: "cto", symbol: "MC.PA", quantity: 2, price: 650, fee: 2, currency: "EUR", origin: "manual" },
      ],
      "taxtest",
    );
    const r = JSON.parse(await cli(["tax", "report", "--regime", "fr", "--year", "2025", "--book", "taxtest", "--json"]));
    const pts = r.datasets[0].points as Array<{ key: string; value: unknown }>;
    expect(pts.find((p) => p.key === "TAX.FR.2025.securities.taxable")!.value).toBe(96);
    expect(await cli(["tax", "lots", "--regime", "fr", "--year", "2025", "--book", "taxtest"])).toMatch(/securities-disposal.*→ 96 EUR/);
    expect(await cli(["tax", "rules", "--regime", "fr", "--year", "2026"])).toMatch(/PEA: .*150000/);
    expect(await cli(["tax", "verify", "--regime", "us", "--year", "2026"])).toMatch(/ltcg.thresholds/);
    expect(await cli(["tax", "export", "--regime", "fr", "--year", "2025", "--book", "taxtest", "--format", "2074"])).toMatch(/MC\.PA,2,1298,2,1202,96/);
  });
});
