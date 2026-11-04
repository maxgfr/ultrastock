import { describe, expect, it } from "vitest";
import { DRIFT_SESSIONS, reactionPoints, resultsDates, resultsReactions } from "../src/analyze/events/earnings.js";
import { morningFlags } from "../src/analyze/morning/run.js";
import type { SecFiling } from "../src/providers/fundamentals/sec.js";

const filing = (filingDate: string, form: string, items: string[]): SecFiling => ({
  accession: `0001-${filingDate}`,
  form,
  filingDate,
  items,
  primaryDocument: "x.htm",
  url: `https://www.sec.gov/${filingDate}`,
  docUrl: "",
});

describe("results dates", () => {
  it("keeps the 8-Ks with item 2.02, newest first, folding a second filing within 5 days", () => {
    const d = resultsDates([
      filing("2026-08-26", "8-K", ["2.02", "9.01"]),
      filing("2026-08-28", "8-K/A", ["2.02"]), // amendment of the same release
      filing("2026-07-01", "8-K", ["5.02"]), // a leadership change, not results
      filing("2026-05-20", "8-K", ["2.02"]),
      filing("2026-05-01", "4", []),
    ]);
    expect(d.map((x) => x.date)).toEqual(["2026-08-26", "2026-05-20"]);
    expect(resultsDates([filing("2026-08-26", "8-K", ["2.02"]), filing("2026-05-20", "8-K", ["2.02"])], 1).map((x) => x.date)).toEqual(["2026-08-26"]);
  });
});

describe("results reactions", () => {
  // 40 sessions from 2026-01-01; the stock jumps 10 % on the session after the 8-K, SPY 1 %.
  const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const stock = Array.from({ length: 40 }, (_, i) => ({ date: day(i), close: i < 6 ? 100 : i < 26 ? 110 : 121 }));
  const spy = Array.from({ length: 40 }, (_, i) => ({ date: day(i), close: i < 6 ? 500 : 505 }));
  const dates = [{ date: day(5), accession: "a", url: "https://www.sec.gov/a" }];

  it("measures close before the filing day → first close after, 5 sessions on, and the excess drift", () => {
    const [r] = resultsReactions(dates, stock, spy);
    expect(r!.move).toBeCloseTo(10, 9);
    expect(r!.bench).toBeCloseTo(1, 9);
    expect(r!.excess).toBeCloseTo(9, 9);
    expect(r!.move5).toBeCloseTo(10, 9);
    // first close after = day 6 (110); 20 sessions later = day 26 (121): +10 %, SPY flat
    expect(DRIFT_SESSIONS).toBe(20);
    expect(r!.drift).toBeCloseTo(10, 9);
  });

  it("leaves out a date before the series starts and summarises the rest", () => {
    const rs = resultsReactions([...dates, { date: "2025-06-01", accession: "b", url: "" }], stock, spy);
    expect(rs[1]!.move).toBeUndefined();
    const pts = reactionPoints("NVDA", [...dates, { date: "2025-06-01", accession: "b", url: "" }], rs);
    const v = (k: string) => pts.find((p) => p.key === `NVDA.results.${k}`)?.value;
    expect(v("n")).toBe(1);
    expect(v("absMedian")).toBe(10);
    expect(v("excessMedian")).toBe(9);
    expect(v("driftMedian")).toBe(10);
    expect(v("driftUp")).toBe(1);
    expect(pts.find((p) => p.key === `NVDA.results.${day(5)}.move`)).toMatchObject({ unit: "%", url: "https://www.sec.gov/a" });
  });

  it("puts the past results' median move on a morning earnings flag", () => {
    const flags = morningFlags({
      today: "2026-10-28",
      end: "2026-11-11",
      origins: { NVDA: ["held"] },
      dates: [{ symbol: "NVDA", kind: "earnings", date: "2026-10-29", source: "nasdaq", key: "NVDA.cat.earnings", sessionsAway: 1 }],
      moves: [],
      stops: [],
      alerts: [],
      theses: [],
      macro: [],
      events: [],
      closures: [],
      pastResults: { NVDA: { n: 12, absMedian: 3.7, keys: ["NVDA.results.absMedian", "NVDA.results.n"] } },
    });
    expect(flags[0]!.text).toMatch(/its last 12 results moved it a median ±3\.7 %/);
    expect(flags[0]!.keys).toEqual(["NVDA.cat.earnings", "NVDA.results.absMedian", "NVDA.results.n"]);
  });
});
