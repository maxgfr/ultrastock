// `journal settle` measures alpha against `defaultBenchmark()`: the profile's own benchmark when it sets one
// (`profile set benchmark <symbol>`).
//
// 1. A benchmark the router refuses — a typo, or the S&P 500 ETF by its ISIN, US78462F1030, which `profile set
//    benchmark` used to accept and a profile edited by hand may still hold ("a US ISIN — use the ticker") — must not
//    put the whole decision in `errors` on every run: the module's rule for "a benchmark that cannot be read" is to
//    wait out the grace and settle on the raw return, marked partial.
// 2. A decision ON the benchmark itself has an alpha of exactly 0, and `judge` scores a buy right only when
//    alpha > 0: every buy (or sell) of the user's own benchmark was recorded wrong, whatever the price did.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Decision, recordDecision } from "../src/analyze/decision.js";
import { defaultProfile, parseProfileValue, saveProfile } from "../src/core/profile.js";
import { settleDecisions } from "../src/journal/settle.js";
import type { Bar } from "../src/providers/types.js";
import { bar } from "./helpers/series.js";

const histories = vi.hoisted(() => ({ bars: {} as Record<string, Bar[]> }));
vi.mock("../src/providers/router.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/providers/router.js")>();
  return {
    ...real,
    // The router's own refusals, without the network: what `classifySymbol` calls unsupported is thrown, as
    // `resolveSymbol` does before it asks any provider (a US ISIN, a suffix no provider covers).
    resolveSymbol: async (symbol: string) => {
      const kind = real.classifySymbol(symbol);
      if (typeof kind === "object") throw new Error(kind.unsupported);
      return { instrument: { symbol, market: "us", mic: "XNAS" }, notes: [] };
    },
    getHistory: async (r: { instrument: { symbol: string } }) => ({ bars: histories.bars[r.instrument.symbol] ?? [] }),
  };
});

const weekdays = (from: string, to: string, close: (day: string) => number): Bar[] => {
  const out: Bar[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const d = new Date(t);
    const day = d.toISOString().slice(0, 10);
    if (d.getUTCDay() % 6) out.push(bar(day, close(day), close(day), close(day), close(day)));
  }
  return out;
};

// Decided on Monday 2 March 2026: the horizons end on 9 March (+5), 30 March (+20) and 27 May (+60).
const decide = (symbol: string, rating: Decision["rating"]) =>
  recordDecision(
    {
      schema: 1,
      symbol,
      run: "x",
      decidedAt: "2026-03-02T15:00:00.000Z",
      rating,
      horizon: "months",
      conviction: 3,
      thesis: "TEST DATA — a thesis long enough to be recorded by the journal.",
      evidence: ["E1"],
      falsifiers: ["a close below 90"],
      risks: [],
      portfolioContext: "flat",
    } satisfies Decision,
    mkdtempSync(join(tmpdir(), "settle-run-")),
  );
const now = new Date("2026-06-30T12:00:00Z");
const benchmark = (raw: string) => saveProfile({ ...defaultProfile("US", "USD"), benchmark: parseProfileValue("benchmark", raw) as string });

describe("journal settle against the profile's benchmark", () => {
  beforeEach(() => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "settle-"));
  });

  it("control: a benchmark whose history cannot be read settles on the raw return, marked partial", async () => {
    benchmark("nohist"); // resolves, has no bars
    histories.bars = { LAG: weekdays("2026-02-16", "2026-06-30", () => 100) };
    decide("LAG", "hold");
    const r = await settleDecisions(now);
    expect(r.errors).toEqual([]);
    expect(r.settled.map((s) => [s.horizon, s.partial, s.alphaPct])).toEqual([
      [5, true, undefined],
      [20, true, undefined],
      [60, true, undefined],
    ]);
  });

  it("a profile benchmark the router refuses does the same — it does not block every settlement", async () => {
    // `profile set benchmark` now refuses it, with the router's own words…
    expect(() => parseProfileValue("benchmark", "US78462F1030")).toThrow(/a US ISIN — use the ticker/);
    // …but a profile saved before that check, or edited by hand, still holds it: resolveSymbol refuses it.
    saveProfile({ ...defaultProfile("US", "USD"), benchmark: "US78462F1030" });
    histories.bars = { LAG: weekdays("2026-02-16", "2026-06-30", () => 100) };
    decide("LAG", "hold");
    const r = await settleDecisions(now);
    // Before the fix: errors = ["LAG: US78462F1030 is a US ISIN — use the ticker (`resolve` finds it)"], settled = []
    // — on this run and every later one.
    expect(r.errors).toEqual([]);
    expect(r.settled.map((s) => s.horizon)).toEqual([5, 20, 60]);
    expect(r.notes.join("\n")).toMatch(/benchmark US78462F1030 could not be read/);
  });

  it("does not score a buy of the benchmark itself wrong for having no alpha against itself", async () => {
    benchmark("wld");
    // WLD closes at 100 up to the decision day and at 120 from the next session on: the buy made 20 %.
    histories.bars = { WLD: weekdays("2026-02-16", "2026-06-30", (day) => (day <= "2026-03-02" ? 100 : 120)) };
    decide("WLD", "buy");
    const r = await settleDecisions(now);
    expect(r.settled.map((s) => s.returnPct)).toEqual([20, 20, 20]);
    // Actual at HEAD: benchmark "WLD", alphaPct 0, hit false on all three horizons.
    expect(r.settled.map((s) => s.hit)).toEqual([true, true, true]);
    expect(r.settled.map((s) => [s.alphaPct, s.benchmark, s.benchmarkItself])).toEqual(Array(3).fill([undefined, undefined, true]));
    expect(r.notes.join("\n")).toMatch(/WLD is the benchmark itself: judged on its raw return/);
  });
});
