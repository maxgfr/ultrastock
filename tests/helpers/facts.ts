// TEST DATA — NOT RESEARCH.
//
// Writes researched-facts files (core/researched.ts) into the throwaway home of
// tests/setup.ts, for any domain: every label says TEST and every source is a
// placeholder, so a value here is never mistaken for a researched one.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Domain, saveFacts } from "../../src/core/researched.js";

const SOURCE = "https://example.invalid/ultrastock-test-data-not-research";

/** Store TEST facts for a domain, a country and a period; `verifiedAt` defaults to the period's start (or today for a date). */
export function installTestFacts(
  d: Domain,
  country: string,
  period: number | string,
  values: Record<string, unknown>,
  opts: { verifiedAt?: string; meta?: Record<string, string> } = {},
) {
  if (!process.env.ULTRASTOCK_HOME) throw new Error("installTestFacts: ULTRASTOCK_HOME is not set — call it in a test, after tests/setup.ts");
  const verifiedAt = opts.verifiedAt ?? (typeof period === "string" ? period : new Date().toISOString().slice(0, 10));
  return saveFacts(d, {
    country,
    [d.period]: period,
    ...(opts.meta ?? {}),
    researchedAt: verifiedAt,
    note: "TEST DATA — written by the test suite, not research",
    facts: Object.fromEntries(
      Object.entries(values).map(([k, value]) => [k, { value, label: `TEST DATA — ${k}`, sources: [SOURCE], verifiedAt, confidence: "low" }]),
    ),
  });
}

/** Remove a domain's stored facts from the throwaway home. */
export function clearTestFacts(d: Domain): void {
  if (!process.env.ULTRASTOCK_HOME) throw new Error("clearTestFacts: ULTRASTOCK_HOME is not set");
  rmSync(join(process.env.ULTRASTOCK_HOME, "facts", d.name), { recursive: true, force: true });
}
