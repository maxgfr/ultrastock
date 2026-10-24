import { describe, expect, it } from "vitest";
import { complementArbitrage, orderbookImbalance, sortBook } from "../src/providers/prediction/common.js";
import {
  kalshiEvents,
  kalshiMarket,
  kalshiMarketPoints,
  kalshiMarkets,
  kalshiOrderbook,
  parseKalshiMarket,
  parseKalshiOrderbook,
} from "../src/providers/prediction/kalshi.js";
import { withFixture } from "./helpers/fixtures.js";

describe("binary-market helpers", () => {
  it("prices a YES+NO pair against its 1-unit payout", () => {
    const over = complementArbitrage(0.56, 0.47);
    expect(over.cost).toBeCloseTo(1.03);
    expect(over.edge).toBeCloseTo(-0.03);
    expect(over.arbitrage).toBe(false);
    const arb = complementArbitrage(0.45, 0.5, 0.01);
    expect(arb.fees).toBeCloseTo(0.0095);
    expect(arb.edge).toBeCloseTo(0.0405);
    expect(arb.edgePct).toBeCloseTo((0.0405 / 0.9595) * 100);
    expect(arb.arbitrage).toBe(true);
    expect(() => complementArbitrage(1.2, 0.1)).toThrow(RangeError);
    expect(() => complementArbitrage(0.5, 0.5, -1)).toThrow(RangeError);
  });
  it("measures book imbalance over the best levels", () => {
    const book = sortBook(
      [
        { price: 0.4, size: 100 },
        { price: 0.45, size: 300 },
      ],
      [{ price: 0.5, size: 100 }],
    );
    expect(book.bids[0]!.price).toBe(0.45);
    expect(orderbookImbalance(book)).toBeCloseTo((400 - 100) / 500);
    expect(orderbookImbalance(book, 1)).toBeCloseTo((300 - 100) / 400);
    expect(orderbookImbalance({ bids: [], asks: [] })).toBeUndefined();
  });
});

describe("Kalshi parsers", () => {
  it("reads dollar-string prices and fixed-point sizes", () => {
    const m = parseKalshiMarket({
      ticker: "KXFED-27APR-T6.00",
      title: "Will the upper bound be above 6.00%?",
      yes_bid_dollars: "0.0100",
      yes_ask_dollars: "0.5600",
      no_bid_dollars: "0.4400",
      no_ask_dollars: "0.9900",
      last_price_dollars: "0.0000",
      volume_fp: "12.00",
      open_interest_fp: "3.00",
      close_time: "2027-04-28T17:55:00Z",
    });
    expect(m).toMatchObject({ yesBid: 0.01, yesAsk: 0.56, noBid: 0.44, noAsk: 0.99, volume: 12, openInterest: 3 });
    const pts = kalshiMarketPoints(m);
    expect(pts.find((p) => p.key === "KALSHI.KXFED-27APR-T6.00.title")).toMatchObject({ untrusted: true });
    expect(pts.find((p) => p.key === "KALSHI.KXFED-27APR-T6.00.prob.mid")!.value).toBeCloseTo(28.5);
    expect(pts.find((p) => p.key === "KALSHI.KXFED-27APR-T6.00.overround")!.value).toBeCloseTo(0.55);
    // No resting bid (0) means no two-sided quote: no mid probability.
    expect(kalshiMarketPoints({ ...m, yesBid: 0 }).some((p) => p.key.endsWith(".prob.mid"))).toBe(false);
  });
  it("turns NO bids into YES asks", () => {
    const book = parseKalshiOrderbook({
      orderbook_fp: {
        yes_dollars: [
          ["0.0100", "100.00"],
          ["0.0500", "20.00"],
        ],
        no_dollars: [
          ["0.4400", "1694.00"],
          ["0.3300", "5692.00"],
        ],
      },
    });
    expect(book.bids[0]).toEqual({ price: 0.05, size: 20 });
    expect(book.asks[0]).toEqual({ price: 0.56, size: 1694 });
    expect(book.asks[1]!.price).toBeCloseTo(0.67);
    expect(parseKalshiOrderbook({ orderbook_fp: { yes_dollars: null, no_dollars: [] } })).toEqual({ bids: [], asks: [] });
  });
});

describe("Kalshi fixture", () => {
  it("replays a series' markets, one market, its book and the series' events", async () => {
    await withFixture("prediction-kalshi", async () => {
      const list = await kalshiMarkets({ seriesTicker: "KXFED", limit: 3 });
      expect(list.provenance).toMatchObject({ source: "kalshi", official: true });
      const titles = list.points.filter((p) => p.key.endsWith(".title"));
      expect(titles.length).toBe(3);
      expect(titles.every((p) => p.untrusted)).toBe(true);
      const ticker = titles[0]!.key.replace(/^KALSHI\./, "").replace(/\.title$/, "");
      const one = await kalshiMarket(ticker);
      expect(one.points.some((p) => p.key === `KALSHI.${ticker}.yes.ask`)).toBe(true);
      const { book, dataset } = await kalshiOrderbook(ticker);
      expect(book.bids.length + book.asks.length).toBeGreaterThan(0);
      expect(dataset.points.some((p) => p.key === `KALSHI.${ticker}.book.depth.bid`)).toBe(true);
      const events = await kalshiEvents({ seriesTicker: "KXFED", limit: 2 });
      expect(events.points.filter((p) => p.key.endsWith(".category")).length).toBe(2);
    });
  });
});
