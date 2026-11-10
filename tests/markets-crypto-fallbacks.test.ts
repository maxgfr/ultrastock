import { describe, expect, it } from "vitest";
import { clockNow } from "../src/core/net.js";
import { coinbaseHistory, coinbaseQuote, parseCoinbaseCandles, resolveCoinbase, splitCryptoPair } from "../src/providers/markets/coinbase.js";
import { krakenFailure, krakenHistory, krakenQuote, parseKrakenOhlc, resolveKraken } from "../src/providers/markets/kraken.js";
import { withFixture } from "./helpers/fixtures.js";

describe("crypto fallback parsers", () => {
  it("splits user pairs and names Coinbase products", () => {
    expect(splitCryptoPair("btc-eur")).toEqual({ base: "BTC", quote: "EUR" });
    expect(splitCryptoPair("ETHUSDT")).toEqual({ base: "ETH", quote: "USDT" });
    expect(splitCryptoPair("SOL/USD")).toEqual({ base: "SOL", quote: "USD" });
    expect(splitCryptoPair("NVDA")).toBeUndefined();
    expect(resolveCoinbase("BTCUSD")).toMatchObject({ venueId: "BTC-USD", currency: "USD", market: "crypto" });
  });
  it("reads Coinbase candles newest-first and Kraken OHLC rows", () => {
    expect(
      parseCoinbaseCandles(
        [
          [1792886400, 1, 3, 2, 2.5, 10],
          [1792800000, 0.5, 2, 1, 1.5, 20],
        ],
        "1d",
      ),
    ).toEqual([
      { date: "2026-10-24", open: 1, high: 2, low: 0.5, close: 1.5, volume: 20 },
      { date: "2026-10-25", open: 2, high: 3, low: 1, close: 2.5, volume: 10 },
    ]);
    expect(parseKrakenOhlc([[1792800000, "1", "2", "0.5", "1.5", "1.2", "10", 42]], "1d")).toEqual([
      { date: "2026-10-24", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, vwap: 1.2, trades: 42 },
    ]);
  });
  it("reads Kraken's in-body errors", () => {
    expect(krakenFailure(200, ["EQuery:Unknown asset pair"], "NOPEEUR")).toMatchObject({ status: 404 });
    expect(krakenFailure(200, ["EGeneral:Too many requests"], "XXBTZEUR").transient).toBe(true);
    expect(krakenFailure(200, ["EService:Unavailable"], "XXBTZEUR").transient).toBe(true);
  });
});

describe("crypto fallback fixtures", () => {
  it("replays Coinbase BTC-EUR history and quote, closed bars only", async () => {
    await withFixture("markets-coinbase-btceur", async () => {
      const now = clockNow();
      const inst = resolveCoinbase("BTC-EUR");
      const s = await coinbaseHistory(inst, "1d", new Date(now.getTime() - 400 * 86400_000), now);
      expect(s.bars.length).toBeGreaterThan(390);
      expect(s.bars[s.bars.length - 1]!.date < now.toISOString().slice(0, 10)).toBe(true);
      expect(s.provenance).toMatchObject({ source: "coinbase", official: true });
      expect(s.notes).toEqual([]);
      // A window longer than the page cap stops short of its end: the series must say so, not pass for the whole window.
      const cut = await coinbaseHistory(inst, "1d", new Date(now.getTime() - 400 * 86400_000), now, [], 1);
      expect(cut.bars.length).toBeLessThanOrEqual(300);
      expect(cut.bars[cut.bars.length - 1]!.date < s.bars[s.bars.length - 1]!.date).toBe(true);
      expect(cut.notes.join(" ")).toMatch(/more than 300 1d candles: the series stops at \d{4}-\d{2}-\d{2}/);
      const q = await coinbaseQuote(inst);
      expect(q.price).toBeGreaterThan(0);
    });
  });
  it("replays Kraken BTC-EUR: pair mapping, history and quote", async () => {
    await withFixture("markets-kraken-btceur", async () => {
      const now = clockNow();
      const inst = await resolveKraken("BTC-EUR");
      expect(inst).toMatchObject({ venueId: "XXBTZEUR", symbol: "BTC-EUR", currency: "EUR" });
      const s = await krakenHistory(inst, "1d", new Date(now.getTime() - 60 * 86400_000), now);
      expect(s.bars.length).toBeGreaterThanOrEqual(59);
      expect(s.bars[s.bars.length - 1]!.date < now.toISOString().slice(0, 10)).toBe(true);
      const q = await krakenQuote(inst);
      expect(q.price).toBeGreaterThan(0);
    });
  });
});
