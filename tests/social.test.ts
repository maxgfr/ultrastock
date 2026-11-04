import { describe, expect, it } from "vitest";
import { cryptoBase } from "../src/analyze/social.js";
import { apeTicker, attention, type ApeBoard, parseApewisdom, parsePageviews, redditDataset } from "../src/providers/macro/social.js";

describe("ApeWisdom", () => {
  it("parses a page and drops rows without a ticker, rank or mention count", () => {
    const p = parseApewisdom({
      count: 664,
      pages: 7,
      results: [
        { rank: 1, ticker: "AMD", name: "AMD", mentions: 319, upvotes: 8285, rank_24h_ago: 2, mentions_24h_ago: 187 },
        { rank: 3, ticker: "SPY", name: "SPDR S&amp;P 500 ETF Trust", mentions: "47", upvotes: 370, rank_24h_ago: 5, mentions_24h_ago: null },
        { rank: 4, ticker: "", mentions: 3 },
        { ticker: "X", mentions: 2 },
      ],
    });
    expect(p.pages).toBe(7);
    expect(p.count).toBe(664);
    expect(p.rows.map((r) => r.ticker)).toEqual(["AMD", "SPY"]);
    expect(p.rows[1]).toMatchObject({ name: "SPDR S&P 500 ETF Trust", mentions: 47, mentions_24h_ago: undefined });
  });

  it("maps US listings and coins to its tickers, nothing else", () => {
    expect(apeTicker("NVDA", "us")).toBe("NVDA");
    expect(apeTicker("BTCUSDT", "crypto")).toBe("BTC.X");
    expect(apeTicker("ETHEUR", "crypto", "ETH")).toBe("ETH.X");
    expect(apeTicker("MC.PA", "euronext")).toBeUndefined();
    expect(cryptoBase({ symbol: "SOLUSDT", name: "SOL/USDT" })).toBe("SOL");
    expect(cryptoBase({ symbol: "ADAUSDT" })).toBe("ADA");
  });

  it("states a name it does not rank as unranked, never as zero mentions", () => {
    const board: ApeBoard = {
      rows: new Map([["AMD", { rank: 1, ticker: "AMD", mentions: 319, mentions_24h_ago: 187, rank_24h_ago: 2, upvotes: 8285 }]]),
      count: 664,
      read: 600,
      complete: false,
      url: "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1",
      fetchedAt: "2026-11-04T10:00:00Z",
    };
    const hit = redditDataset("AMD", "AMD", board, "all-stocks");
    expect(hit.points.find((p) => p.key === "AMD.social.reddit.mentions")?.value).toBe(319);
    expect(hit.points.find((p) => p.key === "AMD.social.reddit.mentions_prev")?.value).toBe(187);
    expect(hit.provenance.official).toBe(false);
    const miss = redditDataset("KO", "KO", board, "all-stocks");
    expect(miss.points).toEqual([]);
    expect(miss.notes.join(" ")).toMatch(/not among the 600 tickers.*first 7 pages of 664.*not zero/);
  });
});

describe("Wikipedia attention", () => {
  const day = (i: number) => new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const series = (base: number, recent: number) => [
    ...Array.from({ length: 90 }, (_, i) => ({ date: day(i), views: base })),
    ...Array.from({ length: 7 }, (_, i) => ({ date: day(90 + i), views: recent })),
  ];

  it("parses pageviews oldest first", () => {
    const v = parsePageviews({
      items: [
        { timestamp: "2026100200", views: 4992 },
        { timestamp: "2026100100", views: 5277 },
        { timestamp: "bad", views: 1 },
      ],
    });
    expect(v).toEqual([
      { date: "2026-10-01", views: 5277 },
      { date: "2026-10-02", views: 4992 },
    ]);
  });

  it("compares the last 7 days with the 90 before", () => {
    const a = attention(series(1000, 3000))!;
    expect(a.recent).toBe(3000);
    expect(a.baseline).toBe(1000);
    expect(a.ratio).toBe(3);
    expect(a.recentDays).toBe(7);
    expect(a.baselineDays).toBe(90);
    expect(a.last).toBe(day(96));
  });

  it("refuses a window under half full or a zero baseline", () => {
    expect(attention(series(1000, 3000).slice(-40))).toBeUndefined();
    expect(attention(series(0, 10))).toBeUndefined();
    expect(attention([])).toBeUndefined();
  });
});
