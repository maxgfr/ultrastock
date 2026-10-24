import { describe, expect, it } from "vitest";
import { breadthSignal, rowsFromScan, shareAbove200 } from "../src/analyze/regime/breadth.js";
import {
  eventClusters,
  MACRO_REGIONS,
  parseNasdaqEarningsDate,
  projectNextExDate,
  sessionOrdinal,
  toChainOptions,
  tvTickerFor,
  tvTiming,
} from "../src/analyze/regime/catalysts.js";
import { alignCloses, closedBars, derivedProvenance, mergeProvenance } from "../src/analyze/regime/common.js";
import { altBreadth, hasVolumes, signalPoints, worstDistribution, worstFtd } from "../src/analyze/regime/market.js";
import { etfVsBenchmark, groupBySector, medianOf, rankSectors, rotationReading, type SectorStat } from "../src/analyze/regime/sectors.js";
import type { Dataset } from "../src/core/datasets.js";
import type { Instrument } from "../src/providers/types.js";
import { fromCloses, randomWalk } from "./helpers/series.js";

const prov = (source: string, official: boolean, fetchedAt: string, asOf?: string) => ({ source, official, fetchedAt, ...(asOf ? { asOf } : {}) });

describe("regime plumbing", () => {
  it("keeps closed sessions only: today's crypto candle never, today's stock bar after the close", () => {
    const bars = [{ date: "2026-10-22" }, { date: "2026-10-23" }, { date: "2026-10-24" }];
    const noon = new Date("2026-10-24T12:00:00Z");
    expect(closedBars(bars, "crypto", noon).map((b) => b.date)).toEqual(["2026-10-22", "2026-10-23"]);
    expect(closedBars(bars, "us", noon)).toHaveLength(2);
    expect(closedBars(bars, "us", new Date("2026-10-24T21:30:00Z"))).toHaveLength(3);
    expect(closedBars(bars, "euronext", new Date("2026-10-24T17:00:00Z"))).toHaveLength(3);
    expect(closedBars(bars, "euronext", new Date("2026-10-23T23:00:00Z"))).toHaveLength(2);
  });

  it("aligns two series on their common dates and merges provenance to the weakest", () => {
    const a = fromCloses([1, 2, 3, 4]);
    const b = fromCloses([10, 20, 30, 40]).filter((_, i) => i !== 1);
    const al = alignCloses(a, b);
    expect(al.a).toEqual([1, 3, 4]);
    expect(al.b).toEqual([10, 30, 40]);
    const m = mergeProvenance([prov("nasdaq", false, "2026-10-24T10:00:00Z", "2026-10-23"), prov("cboe", true, "2026-10-24T09:00:00Z", "2026-10-24")]);
    expect(m).toMatchObject({ source: "nasdaq+cboe", official: false, fetchedAt: "2026-10-24T09:00:00Z", asOf: "2026-10-24" });
    expect(derivedProvenance([prov("ecb", true, "2026-10-24T09:00:00Z")])).toMatchObject({ source: "ultrastock", official: true });
  });
});

describe("regime signals", () => {
  it("registers a signal's value and reason, or only its reason when not computable", () => {
    const pts = signalPoints("US.regime", { id: "trend.SPY", label: "SPY trend", value: 0.4, reason: "r" }, "f", "2026-10-23");
    expect(pts.map((p) => p.key)).toEqual(["US.regime.signal.trend.SPY", "US.regime.signal.trend.SPY.reason"]);
    expect(pts[0]).toMatchObject({ value: 0.4, unit: "score", formula: "f" });
    expect(signalPoints("X", { id: "a", label: "A", reason: "needs 200" }, "f")).toHaveLength(1);
  });

  it("is conservative across indices and needs real volumes for the tape", () => {
    expect(worstDistribution(["normal", "high", "caution"])).toBe("high");
    expect(worstDistribution([])).toBeUndefined();
    expect(worstFtd(["follow-through", "rally-attempt", "uptrend"])).toBe("rally-attempt");
    expect(hasVolumes(randomWalk(40))).toBe(true);
    expect(hasVolumes(randomWalk(40).map((b) => ({ ...b, volume: 0 })))).toBe(false);
    expect(hasVolumes(randomWalk(10))).toBe(false);
  });

  it("maps % above the 200-day to −1…+1 around 50 %", () => {
    expect(breadthSignal(50)).toBe(0);
    expect(breadthSignal(80)).toBe(1);
    expect(breadthSignal(95)).toBe(1);
    expect(breadthSignal(35)).toBeCloseTo(-0.5, 10);
  });

  it("counts alt breadth without BTC or stablecoins", () => {
    const pt = (s: string, ch: number, price = 10) => [
      { key: `${s}.market.change.30d`, label: "", value: ch, unit: "%" },
      { key: `${s}.market.price`, label: "", value: price, unit: "USD" },
    ];
    const ds = {
      points: [...pt("BTC", 5), ...pt("ETH", 3), ...pt("SOL", -2), ...pt("USDT", 0.01, 1), ...pt("NEWUSD", 0.1, 1.0)],
    } as unknown as Dataset;
    expect(altBreadth(ds)).toEqual({ up: 1, total: 2, pct: 50 });
  });
});

describe("TradingView rows", () => {
  const ds = {
    points: [
      { key: "TV.x.scan.matches", label: "", value: 3 },
      { key: "XETR:SAP.tv.close", label: "", value: 110 },
      { key: "XETR:SAP.tv.SMA200", label: "", value: 100 },
      { key: "XETR:SAP.tv.sector", label: "", value: "Technology Services", untrusted: true },
      { key: "XETR:SAP.tv.Perf.3M", label: "", value: 10 },
      { key: "LSE:BT.A.tv.close", label: "", value: 90 },
      { key: "LSE:BT.A.tv.SMA200", label: "", value: 100 },
      { key: "LSE:BT.A.tv.sector", label: "", value: "Communications", untrusted: true },
      { key: "LSE:BT.A.tv.Perf.3M", label: "", value: -4 },
      { key: "EURONEXT:X.tv.close", label: "", value: 5 },
      { key: "EURONEXT:X.tv.sector", label: "", value: "Made Up", untrusted: true },
    ],
  } as unknown as Dataset;

  it("reads rows back from the scan points, dots in tickers and columns kept", () => {
    const rows = rowsFromScan(ds);
    expect(rows.map((r) => r.ticker)).toEqual(["XETR:SAP", "LSE:BT.A", "EURONEXT:X"]);
    expect(rows[0]!.values["Perf.3M"]).toBe(10);
    expect(shareAbove200(rows)).toEqual({ above: 1, total: 2, pct: 50 });
  });

  it("groups by the fixed sector table only, medians relative to the whole screen", () => {
    const { stats, unknown, all } = groupBySector(rowsFromScan(ds));
    expect(unknown).toBe(1);
    expect(all["3m"]).toBe(3);
    const tech = stats.find((s) => s.id === "technologyServices")!;
    expect(tech).toMatchObject({ members: 1, pctAbove200: 100, side: "cyclical" });
    expect(tech.rel["3m"]).toBeCloseTo((1.1 / 1.03 - 1) * 100, 10);
    expect(medianOf([3, 1, 2, 10])).toBe(2.5);
    expect(medianOf([])).toBeUndefined();
  });
});

describe("sectors", () => {
  it("measures an ETF against its benchmark and ranks by the weighted composite", () => {
    const n = 260;
    const bench = Array.from({ length: n }, () => 100);
    const up = Array.from({ length: n }, (_, i) => 100 + i);
    const s = etfVsBenchmark("XLK", up, bench);
    expect(s.perf["1m"]).toBeCloseTo((359 / 338 - 1) * 100, 10);
    expect(s.rel["1m"]).toBeCloseTo(s.perf["1m"]!, 10);
    expect(s).toMatchObject({ above50: true, above200: true, side: "cyclical" });
    const down = etfVsBenchmark("XLU", up.slice().reverse(), bench);
    const ranked = rankSectors([down, s]);
    expect(ranked.map((x) => [x.id, x.rank])).toEqual([
      ["XLK", 1],
      ["XLU", 2],
    ]);
  });

  it("reads rotation from the top four", () => {
    const mk = (id: string, side: SectorStat["side"], rank: number): SectorStat => ({ id, name: id, side, perf: {}, rel: {}, rank });
    expect(rotationReading([mk("a", "defensive", 1), mk("b", "cyclical", 2), mk("c", "defensive", 3), mk("d", "neutral", 4)]).reading).toBe("risk-off");
    expect(rotationReading([mk("a", "cyclical", 1), mk("b", "cyclical", 2), mk("c", "cyclical", 3), mk("d", "defensive", 4)]).reading).toBe("risk-on");
    expect(rotationReading([mk("a", "cyclical", 1), mk("b", "neutral", 2), mk("c", "defensive", 3), mk("d", "neutral", 4)]).reading).toBe("mixed");
  });
});

describe("catalysts", () => {
  it("parses Nasdaq's earnings date, timing and projection mark", () => {
    expect(
      parseNasdaqEarningsDate({
        reportText: "Apple Inc. is expected* to report earnings on  11/02/2026 after market close.",
        announcement: "Earnings announcement* for AAPL: Nov 02, 2026",
      }),
    ).toEqual({ date: "2026-11-02", timing: "after market close", projected: true });
    expect(parseNasdaqEarningsDate({ announcement: "Earnings announcement for KO: Oct 27, 2026" })).toEqual({
      date: "2026-10-27",
      timing: "not supplied",
      projected: false,
    });
    expect(parseNasdaqEarningsDate({ reportText: "no date" })).toBeUndefined();
    expect(parseNasdaqEarningsDate(null)).toBeUndefined();
  });

  it("maps TradingView's codes and tickers", () => {
    expect(tvTiming(1)).toBe("after market close");
    expect(tvTiming(-1)).toBe("before market open");
    expect(tvTiming(0)).toBe("not supplied");
    const i = (o: Partial<Instrument>): Instrument => ({ symbol: "X", market: "us", kind: "equity", currency: "USD", venueId: "X", ...o });
    expect(tvTickerFor(i({ symbol: "AAPL", mic: "NASDAQ-GS" }))).toBe("NASDAQ:AAPL");
    expect(tvTickerFor(i({ symbol: "KO", mic: "NYSE" }))).toBe("NYSE:KO");
    expect(tvTickerFor(i({ symbol: "SPY", mic: "NYSE ARCA" }))).toBe("AMEX:SPY");
    expect(tvTickerFor(i({ symbol: "XLU", mic: "PSE" }))).toBe("AMEX:XLU");
    expect(tvTickerFor(i({ symbol: "MC.PA", market: "euronext" }))).toBe("EURONEXT:MC");
    expect(tvTickerFor(i({ symbol: "BTCUSDT", market: "crypto" }))).toBeUndefined();
  });

  it("projects the next ex-date from the median gap, and needs three", () => {
    expect(projectNextExDate(["2026-02-09", "2026-05-11", "2026-08-10"])).toEqual({ date: "2026-11-09", gapDays: 91 });
    expect(projectNextExDate(["2026-05-11", "2026-08-10"])).toBeUndefined();
  });

  it("maps chain contracts for the analytics: IV from percent to a fraction, time in years", () => {
    const [c] = toChainOptions(
      [{ contract: "X", root: "X", expiry: "2026-11-27", right: "call", strike: 100, iv: 40, bid: 1, ask: 2, openInterest: 5, volume: 1 }],
      new Date("2026-10-24T21:00:00Z"),
    );
    expect(c!.iv).toBeCloseTo(0.4, 10);
    expect(c!.t).toBeCloseTo(34 / 365, 10);
  });

  it("counts sessions on the venue's calendar and flags catalysts within three", () => {
    // 2026-11-26 is Thanksgiving: Wed 25 → Fri 27 is one session on the NYSE.
    expect(sessionOrdinal("2026-11-27", "2026-11-25", "XNYS")).toBe(1);
    expect(sessionOrdinal("2026-11-27", "2026-11-25", undefined)).toBe(2);
    const c = (date: string, kind: "earnings" | "ex-dividend" | "macro") => ({ date, kind, key: `${date}.${kind}` });
    const clusters = eventClusters(
      [c("2026-11-02", "earnings"), c("2026-10-29", "macro"), c("2026-10-29", "macro"), c("2026-11-20", "ex-dividend")],
      "2026-10-26",
      "XNYS",
    );
    expect(clusters).toEqual([[c("2026-10-29", "macro"), c("2026-11-02", "earnings")]]);
    expect(eventClusters([c("2026-10-27", "macro"), c("2026-10-30", "earnings")], "2026-10-26", "XNYS")).toEqual([]);
  });

  it("keeps headline releases and leaves sub-indices out", () => {
    const us = MACRO_REGIONS.USD!.events;
    for (const e of [
      "Fed Interest Rate Decision",
      "FOMC Statement",
      "CPI",
      "Core PCE Price Index",
      "Nonfarm Payrolls",
      "ISM Manufacturing PMI",
      "GDP Growth Rate",
    ])
      expect(us.test(e), e).toBe(true);
    for (const e of ["ISM Manufacturing Prices", "Atlanta Fed GDPNow", "Redbook", "3-Month Bill Auction"]) expect(us.test(e), e).toBe(false);
    const eu = MACRO_REGIONS.EUR!.events;
    expect(eu.test("HICP ex Energy & Food")).toBe(true);
    expect(eu.test("Spanish PPI")).toBe(false);
    expect(MACRO_REGIONS.EUR!.countries).not.toContain("Spain");
  });
});
