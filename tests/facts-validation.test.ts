// validateFacts: what passes for a sourced, researched value.
//
// 1. A source URL was `^https?://\S+$` plus `new URL()`: "https://." (no host name at all), "http://localhost" and a
//    bare word such as "https://TODO" were accepted as "the URL of the text the value was read from".
// 2. An `any` key (the generic tax list's capitalGains.rates and allowances.annual, every free key of a country
//    without an engine) accepted "" and {} as its value: only null was "not researched". The key then left `missing`
//    and `tax report` printed it as a researched rule.
// 3. A number counted in whole years or days accepted a fraction, rates and thresholds that rise with income were
//    not checked for their order, and a tax year any number of years ahead was stored.
import { describe, expect, it } from "vitest";
import { validateRules } from "../src/tax/rules.js";

const today = new Date().toISOString().slice(0, 10);
const file = (value: unknown, sources: string[]) => ({
  country: "DE",
  year: 2025,
  currency: "EUR",
  researchedAt: today,
  facts: { "capitalGains.rates": { value, label: "TEST DATA — not law", sources, verifiedAt: today, confidence: "high" } },
});

describe("review: a source that is no web address", () => {
  it("control: a page of an official site is accepted, a word is refused", () => {
    expect(() => validateRules(file(0.25, ["https://www.gesetze-im-internet.de/estg/__20.html"]))).not.toThrow();
    expect(() => validateRules(file(0.25, ["see the tax code"]))).toThrow(/not an http\(s\) URL/);
  });
  for (const url of ["https://.", "http://localhost", "https://TODO"])
    it(`refuses ${url}`, () => {
      expect(() => validateRules(file(0.25, [url]))).toThrow(/sources/);
    });
});

describe("review: an empty value stored as researched", () => {
  it("control: null is refused as not researched", () => {
    expect(() => validateRules(file(null, ["https://www.gesetze-im-internet.de/estg/__20.html"]))).toThrow(/not researched/);
  });
  for (const [name, value] of [
    ["an empty string", ""],
    ["an empty object", {}],
  ] as const)
    it(`refuses ${name}`, () => {
      expect(() => validateRules(file(value, ["https://www.gesetze-im-internet.de/estg/__20.html"]))).toThrow();
    });
});

describe("a whole number, an order, a year", () => {
  const thisYear = new Date().getUTCFullYear();
  const usFile = (key: string, value: unknown, year = 2025) => ({
    country: "US",
    year,
    currency: "USD",
    researchedAt: today,
    facts: { [key]: { value, label: "TEST DATA — not law", sources: ["https://www.irs.gov/taxtopics/tc409"], verifiedAt: today, confidence: "high" } },
  });

  it("refuses a fraction for a key counted in whole years or days", () => {
    expect(() => validateRules(usFile("longTerm.holdingYears", 1))).not.toThrow();
    expect(() => validateRules(usFile("longTerm.holdingYears", 1.5))).toThrow(/whole number/);
    expect(() => validateRules(usFile("washSale.windowDays", 30.5))).toThrow(/whole number/);
    // An age may be a half year (59 ½).
    expect(() => validateRules(usFile("ira.penaltyFreeAge", 59.5))).not.toThrow();
  });

  it("refuses rates or thresholds out of order", () => {
    expect(() => validateRules(usFile("ltcg.rates", { low: 0, mid: 0.15, high: 0.2 }))).not.toThrow();
    expect(() => validateRules(usFile("ltcg.rates", { low: 0, mid: 0.2, high: 0.15 }))).toThrow(/low ≤ mid ≤ high must not decrease/);
    const t = {
      singleLow: 48_350,
      singleMid: 533_400,
      jointLow: 96_700,
      jointMid: 600_050,
      separateLow: 48_350,
      separateMid: 300_000,
      headLow: 64_750,
      headMid: 566_700,
    };
    expect(() => validateRules(usFile("ltcg.thresholds", t))).not.toThrow();
    expect(() => validateRules(usFile("ltcg.thresholds", { ...t, jointMid: 90_000 }))).toThrow(/jointLow ≤ jointMid/);
  });

  it("accepts next year's rules and refuses a later year", () => {
    expect(() => validateRules(usFile("longTerm.holdingYears", 1, thisYear + 1))).not.toThrow();
    expect(() => validateRules(usFile("longTerm.holdingYears", 1, thisYear + 2))).toThrow(/after next year/);
  });
});
