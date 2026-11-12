// TEST DATA — NOT ANY VENUE'S FEES.
//
// ultrastock holds no fee schedule: paper fills, backtests and the Kalshi
// readings read the venue fees the agent researched and stored
// (<home>/facts/venues/<CC>-<date>.json). The suite needs fees to fill
// anything, so this helper writes TEST venue facts into the throwaway home of
// tests/setup.ts. The numbers are what the tests' expected figures were worked
// out with — fixtures, not a statement of any venue's schedule: every label
// says so and every source points to a test placeholder.
import { KALSHI_QUADRATIC, saveVenueFacts } from "../../src/trading/venue-facts.js";

const SOURCE = "https://example.invalid/ultrastock-test-data-not-a-fee-schedule";

/** On or before every recorded fixture's clock (the earliest is 2026-10-24): readable inside a replay. */
export const FIXTURE_SAFE_DATE = "2026-10-01";

/** A day before the wall clock: current (not stale) outside a fixture replay. */
export const yesterday = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** The fee values the tests were written with. */
export const TEST_VENUE_VALUES: Record<string, unknown> = {
  "binance.spot.fees": { maker: 0.001, taker: 0.001 },
  "binance.usdm.fees": { maker: 0.0002, taker: 0.0005 },
  "kraken.spot.fees": { maker: 0.0025, taker: 0.004 },
  "coinbase.spot.fees": { maker: 0.004, taker: 0.006 },
  "ibkr.fees": { maker: 0, taker: 0 },
  "ibkr.perUnit": 0.005,
  "ibkr.minimum": 1,
  "kalshi.feeFormula": KALSHI_QUADRATIC,
  "kalshi.fees": { taker: 0.07, maker: 0.0175 },
  // The tests' own accounts, as `account.<id>` brokers.
  "account.cto.fees": { maker: 0.001, taker: 0.001 },
  "account.cto.perUnit": 0,
  "account.cto.minimum": 2,
  "account.pea.fees": { maker: 0.001, taker: 0.001 },
  "account.pea.perUnit": 0,
  "account.pea.minimum": 2,
};

/** Write TEST venue facts for `country`, dated `date` (default: yesterday), with `values` (default: all of the above). */
export function installTestVenueFacts(opts: { country?: string; date?: string; values?: Record<string, unknown> } = {}) {
  const date = opts.date ?? yesterday();
  const values = opts.values ?? TEST_VENUE_VALUES;
  return saveVenueFacts({
    country: opts.country ?? "FR",
    date,
    researchedAt: date,
    note: "TEST DATA written by tests/helpers/venue-facts.ts — not any venue's fee schedule",
    facts: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        { value, label: `TEST DATA, not a fee schedule — ${key}`, sources: [SOURCE], verifiedAt: date, confidence: "low" },
      ]),
    ),
  });
}
