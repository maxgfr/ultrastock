import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { toCsv } from "../src/core/csv.js";
import type { Envelope } from "../src/core/profile.js";
import { appendTransactions, transactionId, type Transaction } from "../src/portfolio/ledger.js";
import { export2086, export8949, exportKoinly } from "../src/tax/export.js";
import { FranceRegime } from "../src/tax/fr.js";
import { regimeFor } from "../src/tax/index.js";
import { cryptoHoldings } from "../src/tax/inputs.js";
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
