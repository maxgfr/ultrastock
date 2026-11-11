// France, a crypto pair whose base is the fiat (GBPUSDT, EURUSDT): the command and form 2086.
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { Envelope } from "../src/core/profile.js";
import { parseStatement } from "../src/portfolio/import/index.js";
import { appendTransactions, type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { FranceRegime } from "../src/tax/fr.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FR: a fiat-base pair in another fiat than the euro (GBPUSDT)", () => {
  it("`tax report --regime fr` asks the ECB for the rate of the pair's base currency", async () => {
    // 1 000 £ paid for USDT on 2025-02-03 (a Monday), £ at 1.20 € → 1 200 € of acquisition price. The row's currency
    // is USDT: the pound is the pair's base, and the ECB must be asked for it too, or the report fails on
    // "no GBP→EUR rate".
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      const symbols = (/symbols=([A-Z,]+)/.exec(url)?.[1] ?? "").split(",").filter(Boolean);
      // Frankfurter: units of the currency per one euro. 1 £ = 1.20 €, 1 $ = 0.90 €.
      const perEuro: Record<string, number> = { GBP: 1 / 1.2, USD: 1 / 0.9 };
      const day = Object.fromEntries(symbols.filter((s) => perEuro[s]).map((s) => [s, perEuro[s]]));
      return new Response(JSON.stringify({ base: "EUR", rates: { "2025-01-27": day, "2025-02-03": day, "2025-03-03": day } }), {
        headers: { "content-type": "application/json" },
      });
    });
    await appendTransactions(
      [
        { date: "2025-02-03", type: "sell", account: "binance", symbol: "GBPUSDT", quantity: 1000, price: 1.25, currency: "USDT", origin: "import:binance" },
        // 1 250 USDT sold for 1 125 € a month later (1 USDT = 0.90 €): the whole portfolio.
        { date: "2025-03-03", type: "sell", account: "binance", symbol: "USDTEUR", quantity: 1250, price: 0.9, currency: "EUR", origin: "import:binance" },
      ],
      "zzgbp",
    );
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out += String(c);
      return true;
    });
    let err = "";
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      err += String(c);
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    let failure: unknown;
    try {
      await main(["tax", "lots", "--regime", "fr", "--year", "2025", "--book", "zzgbp", "--json"]);
    } catch (e) {
      failure = e;
    }
    vi.restoreAllMocks();
    expect(asked.some((u) => /frankfurter/.test(u))).toBe(true);
    expect(asked.filter((u) => /frankfurter/.test(u)).join(" ")).toMatch(/GBP/);
    expect(`${err} ${String((failure as Error | undefined)?.message ?? "")}`).not.toMatch(/no GBP→EUR rate/);
    expect(failure).toBeUndefined();
    // 1 125 − 1 200 × 1 125 / 1 125 = −75.
    const rows = JSON.parse(out) as Array<{ kind: string; gain?: number; lines?: Record<string, number> }>;
    expect(rows.filter((r) => r.kind === "crypto-disposal").map((r) => [r.lines?.["220"], r.gain])).toEqual([[1200, -75]]);
  });
});

describe("FR: cashing out through EURUSDT with Binance's fee taken in euros", () => {
  it("form 2086 takes the gross price for lines 213 and 217 and the fee for line 214", () => {
    // Binance Trade History, as the importer reads it (fee of a BUY charged in the coin received, here the euro):
    //   SELL EURUSDT 10 000 EUR → 10 000 USDT, fee 10 USDT           acquisition price 10 000 €
    //   BUY  EURUSDT  9 990 EUR ←  9 990 USDT, fee 9.99 EUR          the whole portfolio (9 990 USDT at 1 €)
    // Form 2086 (notice 2086-NOT, art. 150 VH bis III): 213 price 9 990, 214 fees 9.99, 215 = 9 980.01,
    // 217 = 9 990, 212 portfolio value 9 990, 223 = 10 000;
    // gain = 218 − 223 × 217 / 212 = 9 980.01 − 10 000 × 9 990 / 9 990 = −19.99 — the 10 000 € put in less the
    // 9 980.01 € taken out, the portfolio being empty.
    // The importer nets the fee from the quantity (9 980.01 €) and books its USDT value as the row's fee (9.99).
    const BINANCE: Envelope = { id: "binance", type: "CRYPTO", broker: "Binance", currency: "EUR" };
    const csv =
      "Date(UTC),Pair,Side,Price,Executed,Amount,Fee\n" +
      "2025-01-10 10:00:00,EURUSDT,SELL,1,10000EUR,10000USDT,10USDT\n" +
      "2025-06-01 10:00:00,EURUSDT,BUY,1,9990EUR,9990USDT,9.99EUR\n";
    const txs = parseStatement("binance", csv, { account: "binance" }).transactions.map((t) => ({ ...t, id: transactionId(t) }) as Transaction);
    const ev = new FranceRegime(2025)
      .realize({ year: 2025, transactions: txs, envelopes: [BINANCE], fx: () => 1, cryptoValue: () => 9_990 })
      .filter((e) => e.kind === "crypto-disposal");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.lines).toMatchObject({ "213": 9990, "214": 9.99, "215": 9980.01, "217": 9990, "223": 10000, "224": -19.99 });
  });
});
