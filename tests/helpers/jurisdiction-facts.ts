// TEST DATA — NOT LAW.
//
// ultrastock holds no jurisdiction rule: its gates read the conclusions the
// agent researched and stored (<home>/facts/jurisdiction/<CC>-<date>.json).
// Tests that exercise a gate need a conclusion to read, so this helper writes
// TEST jurisdiction facts into the throwaway home of tests/setup.ts. The
// statuses below are fixtures chosen for what each test checks — not a
// statement of any country's law — and they are never shipped: every label
// says so and every source points to a test placeholder.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { clockNow } from "../../src/core/net.js";
import { saveFacts } from "../../src/core/researched.js";
import { JURISDICTION } from "../../src/core/jurisdiction.js";

const SOURCE = "https://example.invalid/ultrastock-test-data-not-law";

type Values = Record<string, string>;

/** The TEST conclusions the gate tests were written against: FR blocks Polymarket and restricts US ETFs, US allows Kalshi. */
export const TEST_JURISDICTIONS: Record<string, Values> = {
  FR: {
    polymarket: "blocked",
    kalshi: "unknown",
    "us-domiciled-etf": "restricted",
    "crypto-casp": "restricted",
    "crypto-register": "esma-mica",
    "foreign-accounts": "restricted",
  },
  US: {
    polymarket: "unknown",
    kalshi: "allowed",
    "us-domiciled-etf": "allowed",
    "crypto-casp": "allowed",
    "crypto-register": "none",
    "foreign-accounts": "restricted",
    pfic: "restricted",
  },
};

/** A TEST facts file as `facts set jurisdiction` takes it, dated today (by the suite's clock) unless `date` is given. */
export function testJurisdictionFile(country: string, values: Values, date?: string) {
  const day = date ?? clockNow().toISOString().slice(0, 10);
  return {
    country,
    date: day,
    researchedAt: day,
    note: "TEST DATA — not law; written by the test suite",
    facts: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [
        k,
        { value: v, label: `TEST DATA, not law — ${k}`, sources: [SOURCE], verifiedAt: day, confidence: "low", note: `TEST conclusion for ${country}: ${v}` },
      ]),
    ),
  };
}

/** Install TEST jurisdiction facts (FR and US by default, or `values` for the given countries) in the throwaway home. */
export function installJurisdictionTestFacts(values: Record<string, Values> = TEST_JURISDICTIONS, date?: string): void {
  if (!process.env.ULTRASTOCK_HOME) throw new Error("installJurisdictionTestFacts: ULTRASTOCK_HOME is not set — call it in a beforeEach, after tests/setup.ts");
  for (const [c, v] of Object.entries(values)) saveFacts(JURISDICTION, testJurisdictionFile(c, v, date));
}

/** Remove every stored jurisdiction facts file of the throwaway home. */
export function clearJurisdictionFacts(): void {
  if (!process.env.ULTRASTOCK_HOME) throw new Error("clearJurisdictionFacts: ULTRASTOCK_HOME is not set");
  rmSync(join(process.env.ULTRASTOCK_HOME, "facts", "jurisdiction"), { recursive: true, force: true });
}
