import { describe, expect, it } from "vitest";
import { defaultProfile, loadProfile, loosens, requestProfileChange, saveProfile } from "../src/core/profile.js";
import { applySuitability, scoreSuitability } from "../src/core/suitability.js";

const answers = {
  horizon: "gt10",
  drop: "hold",
  maxLoss: "20",
  share: "25to50",
  income: "stable",
  goal: "growth",
  emergencyFundMonths: 6,
  "experience.stocks": "basic",
  "experience.etfs": "experienced",
  "experience.crypto": "basic",
};

describe("profile ratchet", () => {
  it("applies any change at once while live trading has never been switched on", () => {
    const p = defaultProfile("FR");
    expect(requestProfileChange(p, "limits.maxDailyLossPct", 20, { ratchet: false })).toMatchObject({ applied: true });
    expect(p.limits.maxDailyLossPct).toBe(20);
  });

  it("once live: tightens at once, holds a loosening without a code, delays an approved one 24 hours", () => {
    const now = new Date("2026-11-10T10:00:00Z");
    const p = defaultProfile("FR");
    expect(requestProfileChange(p, "limits.maxDailyLossPct", 1, { ratchet: true, now })).toMatchObject({ applied: true });
    expect(p.limits.maxDailyLossPct).toBe(1);
    // Widening the breaker, moving to another country, lifting a constraint, spending the cash buffer: guards lowered.
    for (const [path, to] of [
      ["limits.maxDailyLossPct", 50],
      ["jurisdiction", "US"],
      ["constraints.allowLeverage", true],
      ["limits.cashBufferPct", 0],
    ] as const)
      expect(requestProfileChange(p, path, to, { ratchet: true, now }), path).toMatchObject({ applied: false, reason: expect.stringMatching(/approval code/) });
    expect(p).toMatchObject({ jurisdiction: "FR", limits: { maxDailyLossPct: 1, cashBufferPct: 5 }, constraints: { allowLeverage: false } });
    expect(requestProfileChange(p, "jurisdiction", "US", { ratchet: true, approved: true, now })).toMatchObject({
      applied: false,
      effectiveAt: "2026-11-11T10:00:00.000Z",
    });
    saveProfile(p);
    expect(loadProfile(new Date("2026-11-11T09:59:00Z"))!.jurisdiction).toBe("FR");
    expect(loadProfile(new Date("2026-11-11T10:00:01Z"))!.jurisdiction).toBe("US");
    // A tightening of the same field cancels the loosening still waiting.
    requestProfileChange(p, "limits.maxPositionPct", 9, { ratchet: true, approved: true, now });
    requestProfileChange(p, "limits.maxPositionPct", 3, { ratchet: true, now });
    expect(p.pending?.some((c) => c.path === "limits.maxPositionPct")).toBeFalsy();
    expect(p.limits.maxPositionPct).toBe(3);
  });

  it("tells a loosening from a tightening for every guarded field", () => {
    expect(loosens("limits.maxPositionPct", 5, 6)).toBe(true);
    expect(loosens("limits.maxPositionPct", 5, 4)).toBe(false);
    expect(loosens("limits.cashBufferPct", 5, 4)).toBe(true);
    expect(loosens("constraints.allowShort", false, true)).toBe(true);
    expect(loosens("constraints.allowShort", true, false)).toBe(false);
    expect(loosens("constraints.exclusions", ["tobacco"], ["tobacco", "coal"])).toBe(false);
    expect(loosens("constraints.exclusions", ["tobacco", "coal"], ["coal"])).toBe(true);
    expect(loosens("jurisdiction", "FR", "BE")).toBe(true);
    expect(loosens("horizonYears", 5, 30)).toBe(false);
  });

  it("puts a questionnaire's limits through the same ratchet: answering again is no way round it", () => {
    const p = defaultProfile();
    const r = scoreSuitability(answers);
    const before = p.limits.maxPositionPct;
    expect(r.limits.maxPositionPct).toBeGreaterThan(before);
    const { held } = applySuitability(p, r, new Date(), { ratchet: true });
    expect(p.limits.maxPositionPct).toBe(before);
    expect(held.map((h) => h.path)).toContain("limits.maxPositionPct");
    expect(p.riskScore).toBe(r.score);
    // Without the ratchet the answers apply whole, as before.
    const q = defaultProfile();
    expect(applySuitability(q, r).held).toEqual([]);
    expect(q.limits).toEqual(r.limits);
  });
});
