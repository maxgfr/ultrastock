import { describe, expect, it, vi } from "vitest";
import { addRule, loadRules, removeRule, runAlerts } from "../src/alerts/alerts.js";
import type { PriceSeries } from "../src/providers/types.js";
import { ramp } from "./helpers/series.js";

// The price history is the network call a run waits on: held open here, so the
// test can edit the rules while a run is in flight.
let release: (() => void) | undefined;
vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: async (raw: string) => ({ symbol: raw }),
  getHistory: () =>
    new Promise<PriceSeries>((resolve) => {
      release = () => resolve({ bars: ramp(60, 1) } as unknown as PriceSeries);
    }),
}));

describe("watch run", () => {
  it("keeps a rule added, and drops a rule removed, while a run is in flight", async () => {
    for (const r of loadRules()) removeRule(r.id);
    const watched = addRule({ kind: "expr", symbol: "X", expr: "close > sma20" }, new Date("2026-10-01T00:00:00Z"));
    const doomed = addRule({ kind: "stops" }, new Date("2026-10-01T00:00:01Z"));

    const run = runAlerts(new Date("2026-10-02T00:00:00Z"));
    await vi.waitFor(() => expect(release).toBeDefined()); // the run has read its rules and waits on the history
    const added = addRule({ kind: "stops" }, new Date("2026-10-01T00:00:02Z"));
    expect(removeRule(doomed.id)).toBe(true);
    release!();
    const { events, errors } = await run;

    expect(errors).toEqual([]);
    expect(events.map((e) => e.rule)).toEqual([watched.id]);
    const after = loadRules();
    expect(after.map((r) => r.id)).toEqual([watched.id, added.id]);
    // What the run learnt about its rule is saved.
    expect(after[0]).toMatchObject({ last: true, firedAt: "2026-10-02T00:00:00.000Z" });
  });
});
