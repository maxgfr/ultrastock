// The neutral facts report for a country without a tax engine (here Germany): the ledger's disposals with their cost
// under FIFO AND the weighted average, holding periods, income with withholding, fees — in the base currency at each
// date's rate — beside the researched rules, with no tax computed. The rules stored are TEST data, not law.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { appendTransactions, type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { exportNeutral } from "../src/tax/export.js";
import { chosenMethod, neutralReport } from "../src/tax/neutral.js";
import { loadRules, saveRules } from "../src/tax/rules.js";
import { clearTaxRules, installTaxTestRules, testRulesFile } from "./helpers/tax-rules.js";

const raw = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">) =>
  ({ origin: "manual", currency: "EUR", ...t }) as Omit<Transaction, "id">;
const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const r = raw(t);
  return { ...r, id: transactionId(r) } as Transaction;
};
// 1 $ = 0.90 € every day; a stablecoin is at its peg.
const fx = (c: string) => (c === "EUR" ? 1 : c === "USD" ? 0.9 : undefined);

//   2023-01-10 buy 10 SAP @ 100 €, fee 1 €              lot 1: 10 @ 100.10
//   2024-02-01 buy 0.1 BTC @ 30 000 € (BTCEUR)          BTC lot: 3 000 €
//   2024-06-01 buy 10 SAP @ 120 €                       lot 2: 10 @ 120
//   2025-03-01 sell 15 SAP @ 150 €, fee 2 €             proceeds 2 248; FIFO 1 001 + 5 × 120 = 1 601; average 2 201 / 20 × 15 = 1 650.75
//   2025-05-15 dividend 100 $ AAPL, 15 $ withheld       90 € gross, 13.50 € withheld
//   2025-06-30 custody fee −10 €
//   2025-07-01 sell 0.05 BTC for 3 000 USDT (BTCUSDT)   an exchange: proceeds 2 700 €, cost 1 500 €; 3 000 USDT acquired at 2 700 €
//   2025-08-01 sell 3 000 USDT for 2 760 € (USDTEUR)    proceeds 2 760 €, cost 2 700 €
const LEDGER = [
  raw({ date: "2023-01-10", type: "buy", account: "broker", symbol: "SAP.DE", isin: "DE0007164600", quantity: 10, price: 100, fee: 1 }),
  raw({ date: "2024-02-01", type: "buy", account: "kraken", symbol: "BTCEUR", quantity: 0.1, price: 30_000 }),
  raw({ date: "2024-06-01", type: "buy", account: "broker", symbol: "SAP.DE", isin: "DE0007164600", quantity: 10, price: 120 }),
  raw({ date: "2025-03-01", type: "sell", account: "broker", symbol: "SAP.DE", isin: "DE0007164600", quantity: 15, price: 150, fee: 2 }),
  raw({ date: "2025-05-15", type: "dividend", account: "broker", symbol: "AAPL", amount: 100, currency: "USD" }),
  raw({ date: "2025-05-15", type: "tax", account: "broker", symbol: "AAPL", amount: -15, currency: "USD" }),
  raw({ date: "2025-06-30", type: "fee", account: "broker", amount: -10 }),
  raw({ date: "2025-07-01", type: "sell", account: "kraken", symbol: "BTCUSDT", quantity: 0.05, price: 60_000, currency: "USDT" }),
  raw({ date: "2025-08-01", type: "sell", account: "kraken", symbol: "USDTEUR", quantity: 3000, price: 0.92 }),
];
const deRules = (facts: Record<string, unknown> = { costMethod: "FIFO (first in, first out)", "capitalGains.rates": 0.25 }) =>
  testRulesFile("DE", 2025, facts, "EUR");

beforeEach(() => clearTaxRules());

describe("neutral facts report (DE: no engine)", () => {
  it("each disposal with its cost under FIFO and under the weighted average, its lots and holding period, in the base currency", () => {
    saveRules(deRules());
    const r = neutralReport({ year: 2025, transactions: LEDGER.map((t) => tx(t)), envelopes: [], fx, currency: "EUR", rules: loadRules("DE", 2025).rules });
    expect(r.costMethod).toEqual({ researched: "FIFO (first in, first out)", chosen: "fifo" });
    expect(
      r.disposals.map((d) => [d.date, d.asset, d.quantity, d.proceeds, d.costFifo, d.costAverage, d.gainFifo, d.gainAverage, d.exchange, d.received]),
    ).toEqual([
      ["2025-03-01", "DE0007164600", 15, 2248, 1601, 1650.75, 647, 597.25, false, "EUR"],
      ["2025-07-01", "BTC", 0.05, 2700, 1500, 1500, 1200, 1200, true, "USDT"],
      ["2025-08-01", "USDT", 3000, 2760, 2700, 2700, 60, 60, false, "EUR"],
    ]);
    const sap = r.disposals[0]!;
    expect(sap.lots).toEqual([
      { acquired: "2023-01-10", quantity: 10, cost: 1001, heldDays: 781 },
      { acquired: "2024-06-01", quantity: 5, cost: 600, heldDays: 273 },
    ]);
    expect([sap.acquiredFirst, sap.acquiredLast, sap.heldDaysMin, sap.heldDaysMax, sap.fees]).toEqual(["2023-01-10", "2024-06-01", 273, 781, 2]);
    expect(r.disposals[1]!.heldDaysMin).toBe(516);
    expect(r.income).toEqual([
      { date: "2025-05-15", account: "broker", envelope: "CTO", kind: "dividend", symbol: "AAPL", amount: 90, withheld: 13.5, notes: [] },
    ]);
    expect(r.charges.map((c) => [c.kind, c.amount])).toEqual([
      ["withholding", 13.5],
      ["account fee", 10],
    ]);
    expect(r.totals).toMatchObject({
      disposals: 3,
      exchanges: 1,
      proceeds: 7708,
      costFifo: 5801,
      costAverage: 5850.75,
      gainFifo: 1907,
      gainAverage: 1857.25,
      tradeFees: 2,
    });
    // No tax is computed: nothing in the report is a tax amount.
    expect(JSON.stringify(r)).not.toMatch(/"tax(Due)?"\s*:/);
    // The researched rules stand beside the facts.
    expect(r.rules?.facts["capitalGains.rates"]?.value).toBe(0.25);
    const csv = exportNeutral(r).split("\r\n");
    expect(csv[0]).toMatch(/^section,date,account,envelope,asset,symbol,kind,quantity,proceeds \(EUR\),cost FIFO \(EUR\),cost average \(EUR\)/);
    expect(csv[1]).toMatch(/^disposal,2025-03-01,broker,CTO,DE0007164600,SAP\.DE,sale,15,2248,1601,1650\.75,647,597\.25,fifo,2,/);
    expect(csv.some((l) => l.startsWith("income,2025-05-15,broker,CTO,,AAPL,dividend"))).toBe(true);
  });

  it("without a researched costMethod both costs are shown and neither is chosen", () => {
    saveRules(deRules({ "capitalGains.rates": 0.25 }));
    const r = neutralReport({ year: 2025, transactions: LEDGER.map((t) => tx(t)), envelopes: [], fx, currency: "EUR", rules: loadRules("DE", 2025).rules });
    expect(r.costMethod.chosen).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/costMethod is not researched/);
    expect(chosenMethod("gleitender Durchschnitt (weighted average)")).toBe("average");
    expect(chosenMethod("specific identification")).toBeUndefined();
  });
});

describe("tax report / export for a country without an engine, and --neutral for an engine country", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function cli(argv: string[]) {
    // Frankfurter: units of the currency per one euro.
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ base: "EUR", rates: { "2022-12-30": { USD: 1 / 0.9 } } }), { headers: { "content-type": "application/json" } }),
    );
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

  it("DE: the facts and the researched rules, nothing computed", async () => {
    saveRules(deRules());
    await appendTransactions(LEDGER, "zzde");
    const r = JSON.parse(await cli(["tax", "report", "--country", "DE", "--year", "2025", "--book", "zzde", "--json"]));
    expect(r.country).toBe("DE");
    expect(r.currency).toBe("EUR");
    expect(r.totals).toMatchObject({ costFifo: 5801, costAverage: 5850.75 });
    expect(r.disclaimer).toMatch(/contains no tax law/);
    expect(r.warnings.join(" ")).toMatch(/not researched yet.*holdingPeriod\.rules/);
    const text = await cli(["tax", "report", "--country", "DE", "--year", "2025", "--book", "zzde"]);
    expect(text).toMatch(/No tax is computed here/);
    expect(text).toMatch(/cost FIFO\* 1601 \/ average 1650\.75/);
    expect(text).toMatch(/capitalGains\.rates = 0\.25/);
    expect(await cli(["tax", "export", "--country", "DE", "--year", "2025", "--book", "zzde"])).toMatch(/^section,date/);
    expect(JSON.parse(await cli(["tax", "export", "--country", "DE", "--year", "2025", "--book", "zzde", "--format", "neutral-json"])).totals.proceeds).toBe(
      7708,
    );
  });

  it("FR --neutral: the same facts, the FR engine not run", async () => {
    installTaxTestRules([2025]);
    await appendTransactions(LEDGER, "zzfrn");
    const r = JSON.parse(await cli(["tax", "report", "--country", "FR", "--neutral", "--year", "2025", "--book", "zzfrn", "--json"]));
    // The TEST FR rules name the weighted average.
    expect(r.costMethod.chosen).toBe("average");
    expect(r.totals.gainAverage).toBe(1857.25);
  });
});
