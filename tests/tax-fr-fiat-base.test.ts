// France, a crypto pair whose base is the fiat (GBPUSDT, EURUSDT): the command and form 2086.
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { appendTransactions } from "../src/portfolio/ledger.js";

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
