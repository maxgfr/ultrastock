// A `date` domain's file dated in the future: validateFacts refused a future `researchedAt` and a future `verifiedAt`
// but checked the `date` period for its format only, and loadLatestFacts took the file with the latest date as the
// newest research. Its callers for the jurisdiction and funds domains pass no `upTo` (geo and venues do), so one file
// dated ahead (a typo in the year, a local date ahead of UTC) outranked every later research until that date was
// reached: an old "allowed" kept being read while the newer file said "blocked".
import { beforeEach, describe, expect, it } from "vitest";
import { JURISDICTION, ruleStatus } from "../src/core/jurisdiction.js";
import { loadLatestFacts, saveFacts } from "../src/core/researched.js";
import { clearTestFacts } from "./helpers/facts.js";
import { clearTaxRules } from "./helpers/tax-rules.js";

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const today = day();
const fact = (value: unknown, verifiedAt = today) => ({
  value,
  label: "TEST DATA — not research",
  note: "TEST DATA",
  sources: ["https://example.invalid/ultrastock-review-test"],
  verifiedAt,
  confidence: "high",
});

beforeEach(() => {
  clearTestFacts(JURISDICTION);
  clearTaxRules();
});

describe("a facts file dated in the future", () => {
  it("is refused like a future researchedAt or verifiedAt", () => {
    const ahead = { country: "FR", date: day(400), researchedAt: today, facts: { polymarket: fact("allowed") } };
    expect(() => saveFacts(JURISDICTION, ahead)).toThrow(/future/);
  });

  it("never outranks the research stored after it", () => {
    // Researched today, the file's date typed a year ahead: Polymarket "allowed".
    try {
      saveFacts(JURISDICTION, { country: "FR", date: day(400), researchedAt: today, facts: { polymarket: fact("allowed") } });
    } catch {
      // Refusing the file is a fix too.
    }
    // Researched again (the regulator blocked it): stored under today's date.
    saveFacts(JURISDICTION, { country: "FR", date: today, researchedAt: today, facts: { polymarket: fact("blocked") } });
    expect(loadLatestFacts(JURISDICTION, "FR").current.polymarket?.value).toBe("blocked");
    expect(ruleStatus("FR", "polymarket")).toBe("blocked");
  });
});
