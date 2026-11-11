// A pair written against the dollar (BTC-USD): Binance spot has no USD book and
// prices it against USDT, but Kraken and Coinbase do have one — when they stand
// in they must be asked for the pair as written. The venues are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, PriceSeries, QuoteResult } from "../src/providers/types.js";

const venues = vi.hoisted(() => ({ binanceUp: false, krakenUp: true, asked: [] as string[] }));

const instrumentOf = (venue: string, symbol: string): Instrument => {
  const [base, quote] = symbol.includes("-") ? symbol.split("-") : [symbol.slice(0, 3), symbol.slice(3)];
  return { symbol: `${base}-${quote}`, market: "crypto", kind: "crypto", name: `${base}/${quote}`, currency: quote!, venueId: `${venue}:${base}${quote}` };
};
const quoteOf = (source: string, instrument: Instrument, notes: string[]): QuoteResult => ({
  instrument,
  price: 100_000,
  at: "2026-11-09T09:00:00.000Z",
  provenance: { source, fetchedAt: "2026-11-09T09:00:00.000Z", official: true },
  notes: [...notes],
});
const seriesOf = (source: string, instrument: Instrument, notes: string[]): PriceSeries => ({
  instrument,
  interval: "1d",
  bars: [{ date: "2026-11-08", open: 1, high: 1, low: 1, close: 1 }],
  adjusted: false,
  provenance: { source, fetchedAt: "2026-11-09T09:00:00.000Z", official: true },
  notes: [...notes],
});

vi.mock("../src/providers/binance.js", async (original) => {
  const { ProviderError } = await import("../src/providers/types.js");
  const refuse = () => {
    throw new ProviderError("binance", "Binance refuses requests from this location (HTTP 451)", 451);
  };
  return {
    ...(await original<typeof import("../src/providers/binance.js")>()),
    binanceQuote: async (i: Instrument, notes: string[]) => (venues.binanceUp ? quoteOf("binance", i, notes) : refuse()),
    binanceHistory: async (i: Instrument, _interval: string, _from: Date, _to: Date, notes: string[]) =>
      venues.binanceUp ? seriesOf("binance", i, notes) : refuse(),
  };
});

vi.mock("../src/providers/markets/kraken.js", async () => {
  const { ProviderError } = await import("../src/providers/types.js");
  return {
    resolveKraken: async (symbol: string) => {
      venues.asked.push(`kraken ${symbol}`);
      if (!venues.krakenUp) throw new ProviderError("kraken", "no answer", 0);
      return instrumentOf("kraken", symbol);
    },
    krakenQuote: async (i: Instrument, notes: string[]) => quoteOf("kraken", i, notes),
    krakenHistory: async (i: Instrument, _interval: string, _from: Date, _to: Date, notes: string[]) => seriesOf("kraken", i, notes),
  };
});

vi.mock("../src/providers/markets/coinbase.js", () => ({
  resolveCoinbase: (symbol: string) => {
    venues.asked.push(`coinbase ${symbol}`);
    return instrumentOf("coinbase", symbol);
  },
  coinbaseQuote: async (i: Instrument, notes: string[]) => quoteOf("coinbase", i, notes),
  coinbaseHistory: async (i: Instrument, _interval: string, _from: Date, _to: Date, notes: string[]) => seriesOf("coinbase", i, notes),
}));

const { getHistory, getQuote, resolveSymbol } = await import("../src/providers/router.js");

const window = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-09T00:00:00Z") };

describe("a crypto pair written against the dollar", () => {
  beforeEach(() => {
    venues.binanceUp = false;
    venues.krakenUp = true;
    venues.asked = [];
  });

  it("is priced against USDT on Binance, with the note saying so", async () => {
    venues.binanceUp = true;
    const q = await getQuote(await resolveSymbol("BTC-USD"));
    expect(q.instrument).toMatchObject({ symbol: "BTCUSDT", currency: "USDT" });
    expect(q.notes.join(" ")).toMatch(/BTC-USD priced against USDT: Binance spot has no USD book/);
    expect(venues.asked).toEqual([]);
  });

  it("asks Kraken for the dollar pair when Binance does not answer — a quote", async () => {
    const q = await getQuote(await resolveSymbol("BTC-USD"));
    expect(venues.asked).toEqual(["kraken BTC-USD"]);
    expect(q.instrument).toMatchObject({ symbol: "BTC-USD", currency: "USD" });
    expect(q.provenance).toMatchObject({ source: "kraken", fallbackFrom: "binance" });
    // The price is in dollars: Binance's substitution note would be false here.
    expect(q.notes.join(" ")).not.toMatch(/USDT/);
    expect(q.notes.join(" ")).toMatch(/binance did not answer .* kraken stood in/);
  });

  it("asks Kraken, then Coinbase, for the dollar pair — a history", async () => {
    venues.krakenUp = false;
    const s = await getHistory(await resolveSymbol("eth/usd"), window);
    expect(venues.asked).toEqual(["kraken ETH-USD", "coinbase ETH-USD"]);
    expect(s.instrument).toMatchObject({ symbol: "ETH-USD", currency: "USD" });
    expect(s.provenance).toMatchObject({ source: "coinbase", fallbackFrom: "binance, kraken" });
    expect(s.notes.join(" ")).not.toMatch(/priced against USDT/);
  });

  it("still asks the other venues for the pair as written when it was written against USDT", async () => {
    const q = await getQuote(await resolveSymbol("BTCUSDT"));
    expect(venues.asked).toEqual(["kraken BTCUSDT"]);
    expect(q.instrument.currency).toBe("USDT");
  });

  it("reads a quote from the book the history came from: never a USDT quote beside a USD history", async () => {
    const r = await resolveSymbol("BTC-USD");
    const s = await getHistory(r, window);
    expect(s.instrument).toMatchObject({ symbol: "BTC-USD", currency: "USD" });
    // Binance answers again: its BTCUSDT book is another unit — the quote stays on Kraken's dollar book.
    venues.binanceUp = true;
    const q = await getQuote(r);
    expect(q.instrument).toMatchObject({ symbol: "BTC-USD", currency: "USD" });
    expect(q.provenance.source).toBe("kraken");
  });

  it("asks the other venues for Binance's own pair once Binance gave the history", async () => {
    venues.binanceUp = true;
    const r = await resolveSymbol("BTC-USD");
    expect((await getHistory(r, window)).instrument).toMatchObject({ symbol: "BTCUSDT", currency: "USDT" });
    // Binance stops answering: Kraken is asked for BTC/USDT, the book the history was read on, with Binance's note.
    venues.binanceUp = false;
    const q = await getQuote(r);
    expect(venues.asked).toEqual(["kraken BTCUSDT"]);
    expect(q.instrument).toMatchObject({ symbol: "BTC-USDT", currency: "USDT" });
    expect(q.notes.join(" ")).toMatch(/priced against USDT/);
  });
});
