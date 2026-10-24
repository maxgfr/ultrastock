// Polymarket cannot be reached from where this suite was written (its domains
// are DNS-blocked in France by ANJ order, and the jurisdiction gate refuses it
// for French residents), so nothing here was recorded. Every input below is
// SYNTHETIC — hand-written to the documented Gamma, CLOB and Data API response
// shapes — and exercises the parsers only; no test touches the network.
import { describe, expect, it } from "vitest";
import {
  gammaList,
  parseClobBook,
  parseGammaMarket,
  polymarketBook,
  polymarketEventPoints,
  polymarketFailure,
  polymarketMarketPoints,
  polymarketTrades,
  summarizeTrades,
} from "../src/providers/prediction/polymarket.js";
import { ProviderError } from "../src/providers/types.js";

// SYNTHETIC: a Gamma /markets row (documented shape, invented values).
const SYNTHETIC_GAMMA_MARKET = {
  id: "500001",
  question: "Synthetic question: will X happen by 2027?",
  slug: "synthetic-x-2027",
  conditionId: `0x${"ab".repeat(32)}`,
  description: "Synthetic resolution criteria.",
  endDate: "2027-01-01T00:00:00Z",
  active: true,
  closed: false,
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.62", "0.38"]',
  clobTokenIds: '["1111", "2222"]',
  bestBid: 0.61,
  bestAsk: 0.63,
  lastTradePrice: 0.62,
  volume: "125000.5",
  volume24hr: 3200,
  liquidityNum: 41000,
};

describe("Polymarket parsers (synthetic inputs)", () => {
  it("decodes Gamma's JSON-encoded list fields", () => {
    expect(gammaList('["Yes", "No"]')).toEqual(["Yes", "No"]);
    expect(gammaList(["0.5", 0.5])).toEqual(["0.5", "0.5"]);
    expect(gammaList("not json")).toEqual([]);
    expect(gammaList(undefined)).toEqual([]);
  });
  it("reads a binary Gamma market into points, external text untrusted", () => {
    const m = parseGammaMarket(SYNTHETIC_GAMMA_MARKET);
    expect(m.outcomes).toEqual([
      { name: "Yes", price: 0.62, tokenId: "1111" },
      { name: "No", price: 0.38, tokenId: "2222" },
    ]);
    expect(m).toMatchObject({ volume: 125000.5, volume24h: 3200, liquidity: 41000, bestBid: 0.61 });
    const pts = polymarketMarketPoints(m);
    expect(pts.find((p) => p.key === "POLYMARKET.500001.yes.price")).toMatchObject({ value: 0.62, unit: "USDC" });
    expect(pts.find((p) => p.key === "POLYMARKET.500001.no.prob")!.value).toBeCloseTo(38);
    for (const k of ["question", "slug", "criteria"]) expect(pts.find((p) => p.key === `POLYMARKET.500001.${k}`)!.untrusted).toBe(true);
    expect(pts.find((p) => p.key === "POLYMARKET.500001.endDate")!.value).toBe("2027-01-01");
  });
  it("keeps non-binary outcome names out of keys", () => {
    const pts = polymarketMarketPoints(parseGammaMarket({ id: 7, outcomes: '["Team A", "Team B"]', outcomePrices: '["0.7", "0.3"]' }));
    expect(pts.find((p) => p.key === "POLYMARKET.7.outcome.0.name")).toMatchObject({ value: "Team A", untrusted: true });
    expect(pts.find((p) => p.key === "POLYMARKET.7.outcome.1.price")!.value).toBe(0.3);
  });
  it("reads an event with nested markets", () => {
    // SYNTHETIC: a Gamma /events row.
    const pts = polymarketEventPoints({
      id: 900,
      title: "Synthetic event",
      volume: "5000",
      endDate: "2027-01-01T00:00:00Z",
      markets: [SYNTHETIC_GAMMA_MARKET],
    });
    expect(pts.find((p) => p.key === "POLYMARKET.event.900.title")!.untrusted).toBe(true);
    expect(pts.find((p) => p.key === "POLYMARKET.event.900.markets")!.value).toBe(1);
    expect(pts.some((p) => p.key === "POLYMARKET.500001.yes.price")).toBe(true);
  });
  it("sorts a CLOB book best-first", () => {
    // SYNTHETIC: a CLOB /book answer, levels deliberately out of order.
    const book = parseClobBook({
      bids: [
        { price: "0.58", size: "100" },
        { price: "0.61", size: "40" },
      ],
      asks: [
        { price: "0.66", size: "10" },
        { price: "0.63", size: "75" },
      ],
    });
    expect(book.bids[0]).toEqual({ price: 0.61, size: 40 });
    expect(book.asks[0]).toEqual({ price: 0.63, size: 75 });
  });
  it("summarises Data-API trades", () => {
    // SYNTHETIC: Data API /trades rows (timestamps in seconds).
    const s = summarizeTrades([
      { side: "BUY", size: 10, price: 0.6, timestamp: 1792800000, outcomeIndex: 0 },
      { side: "SELL", size: "30", price: "0.64", timestamp: 1792800600, outcomeIndex: 0 },
      { side: "BUY", size: 5, price: 0.37, timestamp: 1792800300, outcomeIndex: 1 },
    ]);
    expect(s).toMatchObject({ count: 3, buyVolume: 15, sellVolume: 30, lastPrice: 0.64, lastOutcomeIndex: 0 });
    expect(s.vwap[0]).toBeCloseTo((10 * 0.6 + 30 * 0.64) / 40);
    expect(s.lastAt).toBe("2026-10-24T00:10:00.000Z");
  });
});

describe("Polymarket failures", () => {
  it("names a DNS block as transient and never retries around it", () => {
    const e = polymarketFailure({ status: 0, error: "getaddrinfo ENOTFOUND gamma-api.polymarket.com" }, "market list");
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.status).toBe(0);
    expect(e.transient).toBe(true);
    expect(e.message).toMatch(/DNS-blocked.*ANJ.*not circumvented/);
    expect(polymarketFailure({ status: 451 }, "book").transient).toBe(false);
    expect(polymarketFailure({ status: 404 }, "book").message).toMatch(/not found/);
    expect(polymarketFailure({ status: 503 }, "book").transient).toBe(true);
  });
  it("refuses malformed identifiers before any request", async () => {
    await expect(polymarketBook("abc")).rejects.toMatchObject({ status: 400 });
    await expect(polymarketTrades("0x1234")).rejects.toMatchObject({ status: 400 });
  });
});
