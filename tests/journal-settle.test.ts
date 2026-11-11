import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Decision, journalDir, recordDecision } from "../src/analyze/decision.js";
import { settleDecisions } from "../src/journal/settle.js";
import type { Bar } from "../src/providers/types.js";
import { bar } from "./helpers/series.js";

// The price histories the provider answers with, by symbol: a US listing, benchmarked on SPY.
const histories = vi.hoisted(() => ({ bars: {} as Record<string, Bar[]> }));
vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: async (symbol: string) => ({ instrument: { symbol, market: "us", mic: "XNAS" }, notes: [] }),
  getHistory: async (r: { instrument: { symbol: string } }) => ({ bars: histories.bars[r.instrument.symbol] ?? [] }),
}));

/** A flat close on every weekday from `from` to `to`. */
const weekdays = (from: string, to: string, close: number): Bar[] => {
  const out: Bar[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() % 6) out.push(bar(d.toISOString().slice(0, 10), close, close, close, close));
  }
  return out;
};

// A hold decided on Monday 2 March 2026: its horizons end on 9 March (+5), 30 March (+20) and 27 May (+60).
const decide = (symbol: string) =>
  recordDecision(
    {
      schema: 1,
      symbol,
      run: "x",
      decidedAt: "2026-03-02T15:00:00.000Z",
      rating: "hold",
      horizon: "months",
      conviction: 3,
      thesis: "A fair price for a steady business, nothing to do.",
      evidence: ["E1"],
      falsifiers: ["a close below 90"],
      risks: [],
      portfolioContext: "flat",
    } satisfies Decision,
    mkdtempSync(join(tmpdir(), "us-settle-")),
  ).id;
const now = new Date("2026-06-30T12:00:00Z");

describe("journal settle", () => {
  beforeEach(() => rmSync(journalDir(), { recursive: true, force: true }));

  it("leaves a horizon pending while the history stops before its end, and settles it once the history reaches it", async () => {
    // The provider's history stops on the decision day: a 0 % return, and a hold scored right, for good.
    histories.bars = { STALE: weekdays("2026-02-16", "2026-03-02", 100), SPY: weekdays("2026-02-16", "2026-06-30", 500) };
    const id = decide("STALE");
    const r = await settleDecisions(now);
    expect(r.settled).toEqual([]);
    expect(r.waiting.map((w) => [w.decisionId, w.horizon, w.endDate, w.series, w.lastBar])).toEqual([
      [id, 5, "2026-03-09", "STALE", "2026-03-02"],
      [id, 20, "2026-03-30", "STALE", "2026-03-02"],
      [id, 60, "2026-05-27", "STALE", "2026-03-02"],
    ]);
    // The history catches up: each horizon is scored on its own end session.
    histories.bars.STALE = weekdays("2026-02-16", "2026-06-30", 100);
    const later = await settleDecisions(now);
    expect(later.settled.map((s) => [s.horizon, s.endDate])).toEqual([
      [5, "2026-03-09"],
      [20, "2026-03-30"],
      [60, "2026-05-27"],
    ]);
    expect(later.waiting).toEqual([]);
  });

  it("waits for the benchmark's history too, then settles on the raw return once it never comes", async () => {
    histories.bars = { LAG: weekdays("2026-02-16", "2026-06-30", 100), SPY: weekdays("2026-02-16", "2026-03-20", 500) };
    decide("LAG");
    // On 10 April the +20 horizon (30 March) is fewer than ten sessions old: it waits; +60 has not matured.
    const r = await settleDecisions(new Date("2026-04-10T12:00:00Z"));
    expect(r.settled.map((s) => s.horizon)).toEqual([5]);
    expect(r.settled[0]).not.toHaveProperty("partial");
    expect(r.waiting.map((w) => [w.horizon, w.series, w.lastBar])).toEqual([[20, "SPY", "2026-03-20"]]);
    // Ten sessions past each end and still no benchmark: scored on the symbol's own return, said partial.
    const later = await settleDecisions(now);
    expect(later.waiting).toEqual([]);
    expect(later.settled.map((s) => [s.horizon, s.endDate, s.partial, s.benchmarkReturnPct, s.alphaPct])).toEqual([
      [20, "2026-03-30", true, undefined, undefined],
      [60, "2026-05-27", true, undefined, undefined],
    ]);
  });

  it("settles a name no longer quoted on its last close, ten sessions after the horizon's end", async () => {
    // Quoted at 100 up to the decision, 120 after it, delisted after 15 April: the +60 horizon ends on 27 May.
    const gone = [...weekdays("2026-02-16", "2026-03-02", 100), ...weekdays("2026-03-03", "2026-04-15", 120)];
    histories.bars = { GONE: gone, SPY: weekdays("2026-02-16", "2026-06-30", 500) };
    const id = decide("GONE");
    // 5 June is seven sessions after 27 May: +5 and +20 settle as usual, +60 still waits for a bar.
    const r = await settleDecisions(new Date("2026-06-05T12:00:00Z"));
    expect(r.settled.map((s) => [s.horizon, s.endDate, s.partial])).toEqual([
      [5, "2026-03-09", undefined],
      [20, "2026-03-30", undefined],
    ]);
    expect(r.waiting.map((w) => [w.decisionId, w.horizon, w.lastBar])).toEqual([[id, 60, "2026-04-15"]]);
    // 30 June: past 10 June, the tenth session after the end. Settled on 15 April's close, against SPY to the same day.
    const later = await settleDecisions(now);
    expect(later.waiting).toEqual([]);
    expect(later.settled).toHaveLength(1);
    expect(later.settled[0]).toMatchObject({
      horizon: 60,
      partial: true,
      endDate: "2026-04-15",
      endClose: 120,
      returnPct: 20,
      benchmarkReturnPct: 0,
      alphaPct: 20,
    });
    // Settled once: the next run finds nothing to do.
    expect((await settleDecisions(now)).settled).toEqual([]);
  });
});
