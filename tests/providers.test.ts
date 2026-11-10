import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/core/evidence.js";
import { clockNow, FixtureMiss, fetchText, setNetMode } from "../src/core/net.js";
import { changeAgainst } from "../src/providers/types.js";
import { contentHash } from "../src/engine.js";
import { binanceHistory, looksLikeCryptoPair, parseKlines, resolveBinance } from "../src/providers/binance.js";
import { parseEuronextHistory } from "../src/providers/euronext.js";
import { monthDayYear, parseNasdaqHistory } from "../src/providers/nasdaq.js";
import { classifySymbol, getHistory, getQuote, resolveSymbol } from "../src/providers/router.js";

const FIX = join(import.meta.dirname, "..", "assets", "fixtures");
afterEach(() => setNetMode({ kind: "live" }));

describe("parsers", () => {
  it("reads Euronext's historical CSV, newest-first, into oldest-first bars", () => {
    const csv = [
      '﻿"Historical Data"',
      '"From 2026-10-21 to 2026-10-23"',
      "FR0000121014",
      'Date;Open;High;Low;Last;Close;"Number of Shares";"Number of Trades";Turnover;vwap',
      "23/10/2026;387.20;388.20;380.05;383.00;383.00;794428;21286;304279248;383.0168",
      "22/10/2026;387.45;389.20;380.10;387.80;387.80;561780;17236;217190890;386.6119",
    ].join("\n");
    expect(parseEuronextHistory(csv)).toEqual([
      { date: "2026-10-22", open: 387.45, high: 389.2, low: 380.1, close: 387.8, volume: 561780, trades: 17236, vwap: 386.6119 },
      { date: "2026-10-23", open: 387.2, high: 388.2, low: 380.05, close: 383, volume: 794428, trades: 21286, vwap: 383.0168 },
    ]);
    expect(parseEuronextHistory("no header here")).toEqual([]);
  });
  it("reads Nasdaq's dollar-formatted rows", () => {
    expect(parseNasdaqHistory([{ date: "10/23/2026", close: "$210.96", volume: "80,189,770", open: "$210.99", high: "$213.85", low: "$210.18" }])).toEqual([
      { date: "2026-10-23", open: 210.99, high: 213.85, low: 210.18, close: 210.96, volume: 80189770 },
    ]);
    expect(monthDayYear("Oct 22, 2026")).toBe("2026-10-22");
    expect(monthDayYear("Sep 3, 2026 4:00 PM ET")).toBe("2026-09-03");
    expect(monthDayYear("yesterday")).toBeUndefined();
  });
  it("reads Binance klines", () => {
    const bars = parseKlines([[1792800000000, "1", "2", "0.5", "1.5", "10", 1792886399999, "15", 42, "5", "7", "0"]], "1d");
    expect(bars).toEqual([{ date: "2026-10-24", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, trades: 42 }]);
  });
});

describe("routing", () => {
  it("classifies symbols by shape", () => {
    expect(classifySymbol("MC.PA")).toBe("euronext");
    expect(classifySymbol("FR0000121014")).toBe("euronext");
    expect(classifySymbol("asml.as")).toBe("euronext");
    expect(classifySymbol("NVDA")).toBe("us");
    expect(classifySymbol("BRK.B")).toBe("us");
    expect(classifySymbol("BTCUSDT")).toBe("crypto");
    expect(classifySymbol("ETH-EUR")).toBe("crypto");
    expect(classifySymbol("US0378331005")).toHaveProperty("unsupported");
    expect(classifySymbol("SAP.DE")).toBe("europe");
    expect(classifySymbol("XYZ.ZZ")).toHaveProperty("unsupported");
  });
  it("gives a quote no change when there is no positive reference price to divide by", () => {
    expect(changeAgainst(110, 100)).toEqual({ previousClose: 100, change: 10, changePct: 10 });
    // A first session's previous close of 0 would give Infinity, which the evidence register refuses: the quote keeps its price alone.
    for (const reference of [0, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(changeAgainst(110, reference)).toEqual({});
    expect(changeAgainst(Number.NaN, 100)).toEqual({});
    const store = EvidenceStore.open(mkdtempSync(join(tmpdir(), "us-quote-")));
    expect(() => store.add({ key: "x", label: "x", value: (110 - 0) / 0, source: "t", fetchedAt: "2026-01-01T00:00:00Z", official: false })).toThrow(
      /not a finite/,
    );
  });
  it("maps a -USD crypto pair to USDT, and says so", () => {
    const r = resolveBinance("btc-usd");
    expect(r.instrument.venueId).toBe("BTCUSDT");
    expect(r.notes[0]).toMatch(/USDT/);
    expect(looksLikeCryptoPair("NVDA")).toBe(false);
    expect(looksLikeCryptoPair("SOL/USDC")).toBe(true);
  });
});

describe("fixtures", () => {
  it("replays a recorded Euronext run: resolution, history and quote", async () => {
    setNetMode({ kind: "fixture", dir: join(FIX, "mc-pa") });
    const now = clockNow();
    const r = await resolveSymbol("MC.PA");
    expect(r.instrument).toMatchObject({ isin: "FR0000121014", mic: "XPAR", currency: "EUR", market: "euronext" });
    const s = await getHistory(r, { from: new Date(now.getTime() - 729 * 86400_000), to: now });
    expect(s.bars.length).toBeGreaterThan(400);
    expect(s.provenance).toMatchObject({ source: "euronext", official: true, delay: "eod" });
    const q = await getQuote(r, now);
    expect(q.price).toBe(s.bars[s.bars.length - 1]!.close);
  });
  it("replays a US and a crypto run", async () => {
    setNetMode({ kind: "fixture", dir: join(FIX, "nvda") });
    const n = await resolveSymbol("NVDA");
    expect(n.instrument).toMatchObject({ market: "us", kind: "equity", currency: "USD" });
    expect((await getQuote(n)).provenance.official).toBe(false);
    setNetMode({ kind: "fixture", dir: join(FIX, "btcusdt") });
    const b = await resolveSymbol("BTCUSDT");
    const now = clockNow();
    const s = await getHistory(b, { from: new Date(now.getTime() - 729 * 86400_000), to: now });
    // Only closed bars: the session still forming at record time is never a bar.
    expect(s.bars[s.bars.length - 1]!.date < now.toISOString().slice(0, 10)).toBe(true);
  });
  it("says so when a Binance history stops at the page cap, short of the window's end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-binance-pages-"));
    mkdirSync(join(dir, "http"));
    const from = Date.parse("2026-01-01T00:00:00Z");
    const to = Date.parse("2026-04-01T00:00:00Z"); // 2160 hourly bars: three pages
    const hour = 3_600_000;
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${from}&endTime=${to}&limit=1000`;
    const rows = Array.from({ length: 1000 }, (_, i) => [from + i * hour, "1", "2", "0.5", "1.5", "10", from + (i + 1) * hour - 1, "15", 3, "5", "7", "0"]);
    writeFileSync(
      join(dir, "http", `${contentHash(`GET ${url} `).slice(0, 20)}.json`),
      JSON.stringify({ response: { ok: true, status: 200, body: JSON.stringify(rows), url, fetchedAt: "2026-04-01T00:00:00.000Z" } }),
    );
    setNetMode({ kind: "fixture", dir });
    const s = await binanceHistory(resolveBinance("BTCUSDT").instrument, "1h", new Date(from), new Date(to), [], 1);
    expect(s.bars).toHaveLength(1000);
    expect(s.notes.join(" ")).toMatch(/more than 1000 1h bars: the series stops at 2026-02-11T15:00:00.000Z, short of 2026-04-01/);
  });
  it("throws on a request the fixture never recorded, instead of going live", async () => {
    setNetMode({ kind: "fixture", dir: join(FIX, "mc-pa") });
    await expect(fetchText("https://example.com/not-recorded")).rejects.toBeInstanceOf(FixtureMiss);
  });
});
