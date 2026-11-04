import { describe, expect, it } from "vitest";
import { CREDIT_SPREADS, HY_WIDENING_BP, SPREAD_LOOKBACK, spreadContext } from "../src/analyze/regime/market.js";
import type { Dataset } from "../src/core/datasets.js";

const fred = (sid: string, values: number[]): Dataset => ({
  kind: "macro",
  title: sid,
  subject: "US",
  points: [
    { key: `US.fred.${sid}`, label: sid, value: values[values.length - 1]!, unit: "%" },
    ...values.map((v, i) => ({
      key: `US.fred.${sid}.${new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10)}`,
      label: sid,
      value: v,
      unit: "%",
    })),
  ],
  provenance: { source: "fred", fetchedAt: "2026-11-04T00:00:00Z", official: true },
  notes: [],
});

describe("credit spreads in the regime", () => {
  const [hy, ig] = CREDIT_SPREADS;

  it("reads the level, the change over the lookback in bp and flags a high-yield widening", () => {
    const values = [...Array.from({ length: SPREAD_LOOKBACK }, () => 3.0), 3.6];
    const r = spreadContext("US.regime", hy, fred(hy.sid, values));
    expect(r.level).toBe(3.6);
    expect(r.changeBp).toBe(60);
    expect(r.widening).toBe(true);
    expect(HY_WIDENING_BP).toBe(50);
    expect(r.points.map((p) => p.key)).toEqual(["US.regime.credit.oas.hy", "US.regime.credit.oas.hy.chg20", "US.regime.credit.oas.hy.widening"]);
  });

  it("does not flag investment grade, and needs the full lookback for a change", () => {
    const values = [...Array.from({ length: SPREAD_LOOKBACK }, () => 0.8), 1.5];
    const r = spreadContext("US.regime", ig, fred(ig.sid, values));
    expect(r.changeBp).toBe(70);
    expect(r.widening).toBeUndefined();
    const short = spreadContext("US.regime", hy, fred(hy.sid, [3.0, 3.9]));
    expect(short.level).toBe(3.9);
    expect(short.changeBp).toBeUndefined();
    expect(short.points).toHaveLength(1);
  });
});
