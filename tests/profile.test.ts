import { describe, expect, it } from "vitest";
import { checkMica, ruleStatus, rulesFor, verifyChecklist } from "../src/core/jurisdiction.js";
import { defaultProfile, loadProfile, saveProfile, setProfileField, upsertEnvelope } from "../src/core/profile.js";
import { applySuitability, QUESTIONS, scoreSuitability } from "../src/core/suitability.js";
import { withFixture } from "./helpers/fixtures.js";

const base = {
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

describe("profile", () => {
  it("starts conservative, saves privately and records every change", () => {
    const p = defaultProfile("fr", "eur", new Date("2026-10-24T00:00:00Z"));
    expect(p).toMatchObject({ jurisdiction: "FR", baseCurrency: "EUR", constraints: { allowLeverage: false, allowShort: false } });
    expect(setProfileField(p, "limits.maxPositionPct", "8")).toBe(5);
    expect(p.limits.maxPositionPct).toBe(8);
    setProfileField(p, "constraints.exclusions", "tobacco, weapons");
    expect(p.constraints.exclusions).toEqual(["tobacco", "weapons"]);
    upsertEnvelope(p, { id: "pea", type: "PEA", currency: "EUR" });
    expect(p.history.map((h) => h.path)).toEqual(["limits.maxPositionPct", "constraints.exclusions", "envelopes.pea"]);
    saveProfile(p);
    expect(loadProfile()!.envelopes).toHaveLength(1);
  });
  it("refuses unknown fields and out-of-range values", () => {
    const p = defaultProfile();
    expect(() => setProfileField(p, "limits.yolo", "1")).toThrow(/not a profile field/);
    expect(() => setProfileField(p, "limits.maxPositionPct", "500")).toThrow(/between/);
    expect(() => setProfileField(p, "jurisdiction", "France")).toThrow(/ISO/);
    expect(() => setProfileField(p, "constraints.allowShort", "maybe")).toThrow(/true or false/);
  });
});

describe("suitability", () => {
  it("scores answers deterministically with reasons, and sets limits", () => {
    const r = scoreSuitability(base);
    expect(r.score).toBe(5);
    expect(r.points).toBe(13);
    expect(r.maxPoints).toBe(18);
    const p = defaultProfile();
    applySuitability(p, r);
    expect(p.riskScore).toBe(5);
    expect(p.limits.maxPositionPct).toBe(10);
    expect(p.constraints.allowOptions).toBe(false);
  });
  it("caps the score on the weakest link and warns without an emergency fund", () => {
    expect(scoreSuitability({ ...base, horizon: "lt2" }).score).toBe(2);
    expect(scoreSuitability({ ...base, drop: "sell-all" }).score).toBeLessThanOrEqual(3);
    const r = scoreSuitability({ ...base, emergencyFundMonths: 1 });
    expect(r.score).toBeLessThanOrEqual(2);
    expect(r.warnings[0]).toMatch(/emergency fund/);
    expect(scoreSuitability({ ...base, "experience.crypto": "none" }).limits.maxCryptoPct).toBeLessThanOrEqual(2);
  });
  it("refuses a missing or invalid answer", () => {
    expect(() => scoreSuitability({ ...base, drop: undefined as never })).toThrow(/missing/);
    expect(() => scoreSuitability({ ...base, goal: "moon" })).toThrow(/one of/);
    expect(QUESTIONS.every((q) => q.textFr && q.text)).toBe(true);
  });
});

describe("jurisdiction", () => {
  it("knows France's rules and fails closed elsewhere", () => {
    expect(ruleStatus("FR", "polymarket")).toBe("blocked");
    expect(ruleStatus("FR", "us-domiciled-etf")).toBe("restricted");
    expect(ruleStatus("DE", "polymarket")).toBe("unknown");
    expect(rulesFor("FR").rules.every((r) => r.sources.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.verifiedAt))).toBe(true);
    expect(verifyChecklist("FR").length).toBe(rulesFor("FR").rules.length);
  });
  it("reads ESMA's MiCA registers", async () => {
    await withFixture("jurisdiction-esma", async () => {
      const kraken = await checkMica("kraken", "FR");
      expect(kraken.authorised.length).toBeGreaterThan(0);
      expect(kraken.authorised[0]!.homeState).toBe("IE");
      const binance = await checkMica("binance", "FR");
      expect(binance.authorised).toEqual([]);
    });
  });
});
