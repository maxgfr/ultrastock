// Stablecoins left out of alt breadth: CoinGecko's own stablecoins category, read live; a replay or an outage falls
// back to the built-in list with a note that it may be incomplete.
import { afterEach, describe, expect, it, vi } from "vitest";
import { altBreadth, STABLE_SYMBOLS_FALLBACK, stablecoinSymbols } from "../src/analyze/regime/market.js";
import type { Dataset } from "../src/core/datasets.js";
import { withFixture } from "./helpers/fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const markets = (rows: Array<[string, number, number]>): Dataset => ({
  kind: "crypto-market",
  title: "t",
  subject: "CRYPTO",
  points: rows.flatMap(([s, ch, price]) => [
    { key: `${s}.market.change.30d`, label: `${s} 30d`, value: ch, unit: "%" },
    { key: `${s}.market.price`, label: `${s} price`, value: price, unit: "USD" },
  ]),
  provenance: { source: "coingecko", fetchedAt: "2026-11-12T00:00:00Z", official: false },
  notes: [],
});

describe("stablecoins", () => {
  it("reads CoinGecko's stablecoins category live", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      return new Response(
        JSON.stringify([
          { id: "tether", symbol: "usdt" },
          { id: "new-dollar", symbol: "nusd" },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    });
    const r = await stablecoinSymbols();
    expect(asked[0]).toMatch(/\/coins\/markets\?vs_currency=usd&category=stablecoins&/);
    expect(r.live).toBe(true);
    expect([...r.symbols]).toEqual(["USDT", "NUSD"]);
    expect(r.note).toMatch(/CoinGecko's stablecoins category \(2 coins/);
    // A stablecoin the fallback list never knew is left out — even one that moved more than the flat-price test allows.
    const ds = markets([
      ["ETH", 5, 3000],
      ["NUSD", 0.8, 1.0],
      ["SOL", -3, 150],
    ]);
    expect(altBreadth(ds, r.symbols)).toEqual({ up: 1, total: 2, pct: 50 });
    expect(altBreadth(ds)).toEqual({ up: 2, total: 3, pct: (2 / 3) * 100 });
  });

  it("falls back to the built-in list, saying it may be incomplete, when the category is not recorded", async () => {
    const r = await withFixture("crypto-coingecko", () => stablecoinSymbols());
    expect(r.live).toBe(false);
    expect(r.symbols).toBe(STABLE_SYMBOLS_FALLBACK);
    expect(r.note).toMatch(/fallback list .* may be incomplete/);
  });
});
