// TEST DATA — NOT TAX LAW.
//
// ultrastock contains no tax value: its engines read the rules the agent
// researched and stored (<home>/facts/tax/<CC>-<year>.json). The suite needs
// rules to compute anything, so this helper writes TEST rules files into the
// throwaway home of tests/setup.ts. The numbers below are what the tests'
// expected figures were worked out with (close to the published figures at the
// time they were written) — they are fixtures, not a statement of the law, and
// they are never shipped: every label says so and every source points to a
// test placeholder.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { saveRules } from "../../src/tax/rules.js";

const SOURCE = "https://example.invalid/ultrastock-test-data-not-law";
const VERIFIED = "2024-01-01";

type Values = Record<string, unknown>;

const fact = (key: string, value: unknown) => ({
  value,
  label: `TEST DATA, not law — ${key}`,
  sources: [SOURCE],
  verifiedAt: VERIFIED,
  confidence: "low",
  note: "written by tests/helpers/tax-rules.ts for the test suite",
});

export function frTestValues(year: number): Values {
  return {
    "pfu.ir": 0.128,
    "ps.capital": year >= 2026 ? 0.186 : 0.172,
    "ps.assuranceVie": 0.172,
    "csg.deductible": 0.068,
    "dividend.abattement": 0.4,
    "losses.carryforwardYears": 10,
    "securities.allowanceAcquiredBefore": "2018-01-01",
    "pea.ceiling": 150_000,
    "peaPme.ceilingCombined": 225_000,
    "pea.minYears": 5,
    "crypto.exemptionThreshold": 305,
    "av.reducedRate": 0.075,
    "av.premiumThreshold": 150_000,
    "av.minYears": 8,
    "av.abattement.single": 4600,
    "av.abattement.couple": 9200,
    "us.dividendWithholdingTreaty": 0.15,
    "us.dividendWithholdingStatutory": 0.3,
    "div2778.dueDay": 15,
    "pfnl.exemptionDeadline": "30 November of the previous year",
    "penalty.3916": 1500,
    "penalty.3916bis": { standard: 750, aboveThreshold: 1500, threshold: 50_000 },
    costMethod: "average",
  };
}

export function usTestValues(year: number): Values {
  return {
    "ltcg.thresholds":
      year >= 2026
        ? {
            singleLow: 49_450,
            singleMid: 545_500,
            jointLow: 98_900,
            jointMid: 613_700,
            separateLow: 49_450,
            separateMid: 306_850,
            headLow: 66_200,
            headMid: 579_600,
          }
        : {
            singleLow: 48_350,
            singleMid: 533_400,
            jointLow: 96_700,
            jointMid: 600_050,
            separateLow: 48_350,
            separateMid: 300_000,
            headLow: 64_750,
            headMid: 566_700,
          },
    "ltcg.rates": { low: 0, mid: 0.15, high: 0.2 },
    "capitalLoss.ordinaryLimit": 3000,
    "capitalLoss.separateLimit": 1500,
    "longTerm.holdingYears": 1,
    "washSale.windowDays": 30,
    "washSale.appliesToCrypto": false,
    "qualifiedDividend.holdingDays": 60,
    "niit.rate": 0.038,
    "niit.thresholds": { single: 200_000, joint: 250_000, separate: 125_000, head: 200_000 },
    "ftc.directLimit": { single: 300, joint: 600 },
    "backupWithholding.rate": 0.24,
    "fbar.threshold": 10_000,
    "fbar.deadline": "due 15 April, automatic extension to 15 October",
    "fbar.cryptoOnlyAccounts": false,
    "f8938.thresholds": { singleEnd: 50_000, singleAny: 75_000, jointEnd: 100_000, jointAny: 150_000 },
    "ira.earlyWithdrawalPenalty": 0.1,
    "ira.penaltyFreeAge": 59.5,
    "roth.qualifiedYears": 5,
    costMethod: "fifo",
  };
}

/** A TEST rules file as `tax rules set` takes it. */
export function testRulesFile(country: string, year: number, values: Values, currency?: string) {
  return {
    country,
    year,
    currency: currency ?? (country === "US" ? "USD" : "EUR"),
    researchedAt: VERIFIED,
    note: "TEST DATA — not tax law; written by the test suite",
    facts: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, fact(k, v)])),
  };
}

/** Install TEST rules for FR and US over `years` in the current (throwaway) ULTRASTOCK_HOME. */
export function installTaxTestRules(years: readonly number[] = [2022, 2023, 2024, 2025, 2026]): void {
  if (!process.env.ULTRASTOCK_HOME) throw new Error("installTaxTestRules: ULTRASTOCK_HOME is not set — call it in a beforeEach, after tests/setup.ts");
  for (const y of years) {
    saveRules(testRulesFile("FR", y, frTestValues(y)));
    saveRules(testRulesFile("US", y, usTestValues(y)));
  }
}

/** Remove every stored tax rules file of the current (throwaway) ULTRASTOCK_HOME. */
export function clearTaxRules(): void {
  if (!process.env.ULTRASTOCK_HOME) throw new Error("clearTaxRules: ULTRASTOCK_HOME is not set");
  rmSync(join(process.env.ULTRASTOCK_HOME, "facts", "tax"), { recursive: true, force: true });
}
