// Piotroski in `valuation`: piotroski() takes the year before `prev` to use the paper's beginning-of-year assets, and
// otherwise says "on end-of-year assets (no third year for beginning-of-year)" in the criterion's reason, registered as
// the evidence's formula. With three fiscal years on file, the third must be passed. Every source is stubbed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Dataset } from "../src/core/datasets.js";
import type { Instrument } from "../src/providers/types.js";

const fetchedAt = "2026-11-09T08:00:00.000Z";
const instrument: Instrument = {
  symbol: "TRI.PA",
  market: "euronext",
  kind: "equity",
  currency: "EUR",
  isin: "FR0000000001",
  mic: "XPAR",
  venueId: "FR0000000001-XPAR",
};

vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: async () => ({ instrument, notes: [] }),
  getQuote: async () => ({ instrument, price: 20, at: "2026-11-06", provenance: { source: "euronext", fetchedAt, official: true }, notes: [] }),
  getHistory: async () => {
    throw new Error("no history in this test");
  },
}));

// Three fiscal years. Assets: FY2023 500, FY2024 1 000, FY2025 2 000 (an acquisition each year).
// Net income: FY2024 80, FY2025 110. Revenue: FY2024 1 000, FY2025 1 150.
//   beginning-of-year (the paper): ROA 80/500 = 0.160 → 110/1000 = 0.110 ; turnover 1000/500 = 2.000 → 1150/1000 = 1.150
//   end-of-year (two periods):     ROA 80/1000 = 0.080 → 110/2000 = 0.055 ; turnover 1.000 → 0.575
vi.mock("../src/providers/fundamentals/esef.js", () => ({
  esefFundamentals: async (): Promise<Dataset> => {
    const year = (fy: number, v: Record<string, number>) =>
      Object.entries(v).map(([id, value]) => ({ key: `TRI.PA.fund.${id}.FY${fy}`, label: `TRI.PA ${id} FY${fy}`, value, unit: "EUR", asOf: `${fy}-12-31` }));
    return {
      kind: "fundamentals",
      title: "TRI.PA key metrics",
      subject: "TRI.PA",
      points: [
        ...year(2025, { revenue: 1150, netIncome: 110, operatingCashFlow: 150, capex: 50, assets: 2000, liabilities: 800, equity: 1200 }),
        ...year(2024, { revenue: 1000, netIncome: 80, operatingCashFlow: 120, capex: 40, assets: 1000, liabilities: 400, equity: 600 }),
        ...year(2023, { revenue: 900, netIncome: 70, operatingCashFlow: 100, capex: 30, assets: 500, liabilities: 200, equity: 300 }),
        { key: "TRI.PA.fund.weightedAverageShares.FY2025", label: "TRI.PA shares FY2025", value: 100, unit: "shares", asOf: "2025-12-31" },
      ],
      provenance: { source: "esef", fetchedAt, delay: "filing", official: true, asOf: "2025-12-31" },
      notes: [],
    };
  },
}));
vi.mock("../src/providers/external/crible.js", () => ({
  cribleCompany: async () => {
    throw new Error("crible is not installed");
  },
  cribleStaleWarning: async () => undefined,
}));
const down = async () => {
  throw new Error("no curve in this test");
};
vi.mock("../src/providers/macro/ecb.js", () => ({ ecbYieldCurve: down }));
vi.mock("../src/providers/macro/treasury.js", () => ({ treasuryCurve: down }));

const { valuationRun } = await import("../src/analyze/valuation.js");
const { EvidenceStore } = await import("../src/core/evidence.js");

describe("Piotroski in `valuation` with three fiscal years on file", () => {
  it("does not register 'no third year' as the reason when FY2023 assets are in the evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-valuation-pio-"));
    await valuationRun("TRI.PA", dir, { now: new Date("2026-11-09T09:00:00Z") });
    const store = EvidenceStore.load(dir)!;
    expect(store.byKey("TRI.PA.fund.assets.FY2023")?.value).toBe(500);
    const droa = store.byKey("TRI.PA.score.piotroski.droa")!;
    expect(droa.formula).not.toMatch(/no third year/);
    // With the third year the paper's convention applies: ROA 110 / 1 000 (start-of-year assets) = 0.110.
    expect(droa.value).toBeCloseTo(0.11, 12);
  });
});
