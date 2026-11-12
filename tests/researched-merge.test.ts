// saveFacts replaced the whole <CC>-<period>.json. `facts research <domain> --key k` writes a JSON holding only the
// keys asked, and every "not researched" / "stale" message names that per-key command. Storing the filled file
// dropped every other key of the same period: for a `year` domain (tax, calendar) always, for a `date` domain when it
// is the same day.
import { beforeEach, describe, expect, it } from "vitest";
import { JURISDICTION, ruleStatus } from "../src/core/jurisdiction.js";
import { factsTemplate, mergeLines, saveFacts } from "../src/core/researched.js";
import { FranceRegime } from "../src/tax/fr.js";
import { loadRules, saveRules, TAX } from "../src/tax/rules.js";
import { clearTestFacts } from "./helpers/facts.js";
import { clearTaxRules, frTestValues, testRulesFile } from "./helpers/tax-rules.js";

const today = new Date().toISOString().slice(0, 10);
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

describe("storing the file `facts research --key` writes keeps the period's other researched keys", () => {
  /** The JSON `facts research <domain> --key <k>` writes (research/facts.ts: factsTemplate with the asked keys), filled. */
  const oneKeyFile = (d: typeof JURISDICTION | typeof TAX, country: string, period: number | string, key: string, value: unknown) => {
    const t = factsTemplate(d, country, period, { keys: [key] }) as { facts: Record<string, Record<string, unknown>> } & Record<string, unknown>;
    return { ...t, researchedAt: today, facts: { [key]: { ...t.facts[key], ...fact(value) } } };
  };

  it("jurisdiction: two keys researched one after the other on the same day are both kept", () => {
    saveFacts(JURISDICTION, oneKeyFile(JURISDICTION, "FR", today, "polymarket", "blocked"));
    expect(ruleStatus("FR", "polymarket")).toBe("blocked");
    // The gate then refuses Kalshi and names `facts research jurisdiction --country FR --key kalshi`.
    saveFacts(JURISDICTION, oneKeyFile(JURISDICTION, "FR", today, "kalshi", "allowed"));
    expect(ruleStatus("FR", "kalshi")).toBe("allowed");
    expect(ruleStatus("FR", "polymarket")).toBe("blocked");
  });

  it("says which stored keys were kept and which were replaced", () => {
    saveFacts(JURISDICTION, oneKeyFile(JURISDICTION, "FR", today, "polymarket", "blocked"));
    saveFacts(JURISDICTION, oneKeyFile(JURISDICTION, "FR", today, "kalshi", "allowed"));
    const v = saveFacts(JURISDICTION, oneKeyFile(JURISDICTION, "FR", today, "kalshi", "blocked"));
    expect(v.merge).toEqual({ kept: ["polymarket"], replaced: ["kalshi"] });
    expect(mergeLines(v.merge).join("\n")).toMatch(/replaced the stored fact\(s\): kalshi\n.*kept .*: polymarket/);
  });

  it("tax: a stored year in another currency is replaced whole, and says so", () => {
    // A country without an engine: its file names the currency its amounts are in.
    saveRules(testRulesFile("DE", 2025, { "capitalGains.rates": 0.25, "allowances.annual": 1000 }));
    const v = saveRules(testRulesFile("DE", 2025, { "capitalGains.rates": 0.25 }, "CHF"));
    expect(v.merge.kept).toEqual([]);
    expect(Object.keys(v.rules.facts)).toEqual(["capitalGains.rates"]);
    expect(v.merge.discarded).toMatch(/currency EUR/);
  });

  it("tax: re-researching one key of a year keeps the 22 others, and the engine still starts", () => {
    saveRules(testRulesFile("FR", 2025, frTestValues(2025)));
    expect(() => new FranceRegime(2025)).not.toThrow();
    // `tax verify` flags one key; `facts research tax --country FR --key pfu.ir --year 2025` writes this file.
    saveRules(oneKeyFile(TAX, "FR", 2025, "pfu.ir", 0.128));
    expect(loadRules("FR", 2025).missing).toEqual([]);
    expect(() => new FranceRegime(2025)).not.toThrow();
  });
});
