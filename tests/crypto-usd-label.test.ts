// The pair a crypto figure is labelled with is the book that answered (router: Kraken and Coinbase stand in for BTC-USD).
// When Binance refuses (HTTP 451) and Kraken stands in for BTC-USD, the answer is now a DOLLAR price on the BTC-USD
// book. Every figure must carry that book's key and unit: never "BTCUSDT … USDT" for a dollar price, and a quote and a
// history read for one analysis come from the same pair. The venues are stubbed.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Instrument, PriceSeries, QuoteResult } from "../src/providers/types.js";
import { randomWalk } from "./helpers/series.js";

const fetchedAt = "2026-11-09T09:00:00.000Z";
const asked = vi.hoisted(() => [] as string[]);

vi.mock("../src/providers/binance.js", async (original) => {
  const { ProviderError } = await import("../src/providers/types.js");
  const refuse = async () => {
    throw new ProviderError("binance", "Binance refuses requests from this location (HTTP 451)", 451);
  };
  return { ...(await original<typeof import("../src/providers/binance.js")>()), binanceQuote: refuse, binanceHistory: refuse };
});

vi.mock("../src/providers/markets/kraken.js", () => {
  const instrumentOf = (symbol: string): Instrument => {
    const [base, quote] = symbol.includes("-") ? symbol.split("-") : [symbol.slice(0, 3), symbol.slice(3)];
    return { symbol: `${base}-${quote}`, market: "crypto", kind: "crypto", name: `${base}/${quote}`, currency: quote!, venueId: `X${base}Z${quote}` };
  };
  return {
    resolveKraken: async (symbol: string) => {
      asked.push(symbol);
      return instrumentOf(symbol);
    },
    krakenQuote: async (instrument: Instrument, notes: string[]): Promise<QuoteResult> => ({
      instrument,
      price: 100_000,
      at: fetchedAt,
      provenance: { source: "kraken", fetchedAt, official: true },
      notes: [...notes],
    }),
    krakenHistory: async (instrument: Instrument, _i: string, _f: Date, _t: Date, notes: string[]): Promise<PriceSeries> => ({
      instrument,
      interval: "1d",
      bars: randomWalk(400, 7, 100_000),
      adjusted: false,
      provenance: { source: "kraken", fetchedAt, official: true },
      notes: [...notes],
    }),
  };
});

const { analyzeSymbol } = await import("../src/analyze/pack.js");
const { EvidenceStore } = await import("../src/core/evidence.js");

describe("a dollar price from Kraken's BTC-USD book", () => {
  it("is not registered as a USDT price of BTCUSDT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-btcusd-label-"));
    await analyzeSymbol("BTC-USD", dir, { now: new Date("2026-11-09T09:00:00Z") });
    // Kraken was asked for the dollar book (the commit's intent) …
    expect(asked[0]).toBe("BTC-USD");
    const items = EvidenceStore.load(dir)!.items;
    const price = items.find((i) => /\.quote\.price$/.test(i.key))!;
    const close = items.find((i) => /\.close$/.test(i.key))!;
    // … so the two figures are dollars: 100 000 USD on BTC-USD, never "USDT" under the key of the BTCUSDT pair.
    expect(price.value).toBe(100_000);
    expect([price.key, price.unit]).toEqual(["BTC-USD.quote.price", "USD"]);
    expect(close.unit).toBe("USD");
  });
});
