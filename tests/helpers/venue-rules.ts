// A fake venue's grid for the live-path tests: fine enough that the tests' own
// orders (prices in cents, fractional quantities) are on it. TEST DATA, not any
// venue's rules — the real ones are read live (src/trading/brokers/rules.ts).
import type { InstrumentRules } from "../../src/trading/brokers/rules.js";

export const testGrid = async (symbol: string): Promise<InstrumentRules> => ({
  venue: "kraken",
  symbol,
  ticks: [{ from: 0, tick: 0.01 }],
  step: 0.00000001,
  tradable: true,
  source: "test grid (tests/helpers/venue-rules.ts)",
  at: new Date().toISOString(),
});
