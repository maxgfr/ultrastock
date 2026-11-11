// A Paris listing whose ESEF report is in US dollars (the report keeps the
// issuer's reporting currency): the price must be brought to the statements'
// currency before any per-share ratio, or the valuation refused. Every source
// is stubbed: no fixture holds such an issuer.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dataset } from "../src/core/datasets.js";
import type { EvidenceItem } from "../src/core/evidence.js";
import type { Instrument } from "../src/providers/types.js";

const fetchedAt = "2026-11-09T08:00:00.000Z";
const instrument: Instrument = {
  symbol: "DOLR.PA",
  market: "euronext",
  kind: "equity",
  currency: "EUR",
  isin: "NL0000000001",
  mic: "XPAR",
  venueId: "NL0000000001-XPAR",
};

const state = vi.hoisted(() => ({
  statementCurrency: "USD",
  rates: { EUR: 1, USD: 0.8 } as Record<string, number>,
  crible: undefined as undefined | { periods: Array<Record<string, unknown>> },
}));

vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: async () => ({ instrument, notes: [] }),
  getQuote: async () => ({ instrument, price: 20, at: "2026-11-06", provenance: { source: "euronext", fetchedAt, official: true }, notes: [] }),
  getHistory: async () => {
    throw new Error("no history in this test");
  },
}));

vi.mock("../src/providers/fundamentals/esef.js", () => ({
  esefFundamentals: async (): Promise<Dataset> => {
    const year = (fy: number, k: number) =>
      Object.entries({
        revenue: 1000 * k,
        netIncome: 100 * k,
        operatingCashFlow: 150 * k,
        capex: 50 * k,
        assets: 2000 * k,
        liabilities: 800 * k,
        equity: 1200 * k,
        epsDiluted: 1 * k,
      }).map(([id, value]) => ({
        key: `DOLR.PA.fund.${id}.FY${fy}`,
        label: `DOLR.PA ${id} FY${fy}`,
        value,
        unit: state.statementCurrency,
        asOf: `${fy}-12-31`,
      }));
    return {
      kind: "fundamentals",
      title: "DOLR.PA key metrics (ESEF annual report 2025-12-31)",
      subject: "DOLR.PA",
      points: [
        ...year(2025, 1),
        ...year(2024, 0.9),
        { key: "DOLR.PA.fund.weightedAverageShares.FY2025", label: "DOLR.PA shares FY2025", value: 100, unit: "shares", asOf: "2025-12-31" },
      ],
      provenance: { source: "esef", fetchedAt, delay: "filing", official: true, asOf: "2025-12-31" },
      notes: [],
    };
  },
}));

vi.mock("../src/providers/external/crible.js", () => ({
  cribleCompany: async () => {
    if (!state.crible) throw new Error("crible is not installed");
    return state.crible;
  },
  cribleStaleWarning: async () => undefined,
}));

vi.mock("../src/analyze/portfolio/book.js", () => ({
  referenceRates: async (currencies: string[]) => {
    const known = currencies.filter((c) => c !== "EUR" && state.rates[c]);
    const fx: Dataset = {
      kind: "fx",
      title: "ECB reference rates",
      points: known.map((c) => ({ key: `EUR.fx.${c}`, label: `EUR/${c}`, value: 1 / state.rates[c]!, unit: c, asOf: "2026-11-06" })),
      provenance: { source: "ecb", fetchedAt, delay: "eod", official: true, asOf: "2026-11-06" },
      notes: [],
    };
    return { datasets: [fx], rates: Object.fromEntries([["EUR", 1], ...known.map((c) => [c, state.rates[c]!])]), keys: {}, notes: [] };
  },
}));

const down = async () => {
  throw new Error("no curve in this test");
};
vi.mock("../src/providers/macro/ecb.js", () => ({ ecbYieldCurve: down }));
vi.mock("../src/providers/macro/treasury.js", () => ({ treasuryCurve: down }));

const { valuationRun } = await import("../src/analyze/valuation.js");
const { EvidenceStore } = await import("../src/core/evidence.js");

const now = new Date("2026-11-09T09:00:00Z");
const runDir = () => mkdtempSync(join(tmpdir(), "us-val-ccy-"));
const byKey = (dir: string, key: string): EvidenceItem | undefined => EvidenceStore.load(dir)!.byKey(key);

describe("valuation when the filing and the quote are in different currencies", () => {
  beforeEach(() => {
    state.statementCurrency = "USD";
    state.rates = { EUR: 1, USD: 0.8 };
    state.crible = undefined;
  });

  it("converts the price to the currency of an ESEF report before any per-share ratio", async () => {
    const dir = runDir();
    const v = await valuationRun("DOLR.PA", dir, { now });
    expect(v.currency).toBe("USD");
    const eur = byKey(dir, "DOLR.PA.quote.price")!;
    const usd = byKey(dir, "DOLR.PA.quote.price.USD")!;
    expect(eur).toMatchObject({ value: 20, unit: "EUR" });
    // 1 EUR = 1.25 USD.
    expect(usd).toMatchObject({ value: 25, unit: "USD", source: "ultrastock" });
    expect(usd.derivedFrom).toContain(eur.id);
    // 100 shares at 25 USD against a net income of 100 USD and equity of 1 200 USD.
    expect(byKey(dir, "DOLR.PA.mult.marketCap")).toMatchObject({ value: 2500, unit: "USD" });
    expect(byKey(dir, "DOLR.PA.mult.pe")?.value).toBeCloseTo(25, 9);
    expect(byKey(dir, "DOLR.PA.mult.pb")?.value).toBeCloseTo(2500 / 1200, 9);
    expect(byKey(dir, "DOLR.PA.mult.pe")?.derivedFrom).toContain(usd.id);
    expect(v.notes.join(" ")).toMatch(/reports in USD and trades in EUR: the price is converted to USD/);
  });

  it("changes nothing when the report is in the quote's currency", async () => {
    state.statementCurrency = "EUR";
    const dir = runDir();
    const v = await valuationRun("DOLR.PA", dir, { now });
    expect(v.currency).toBe("EUR");
    expect(byKey(dir, "DOLR.PA.quote.price.USD")).toBeUndefined();
    expect(byKey(dir, "DOLR.PA.mult.pe")?.value).toBeCloseTo(20, 9);
    expect(v.notes.join(" ")).not.toMatch(/converted/);
  });

  it("refuses to value rather than divide a price by statements it has no rate for", async () => {
    state.rates = { EUR: 1 };
    await expect(valuationRun("DOLR.PA", runDir(), { now })).rejects.toThrow(
      /statements in USD, price in EUR, and no EUR\/USD rate to compare them — not valued/,
    );
  });

  it("does not fill a filing's gaps from crible figures held in another currency", async () => {
    state.crible = { periods: [{ period: "2025-12-31", reporting_currency: "EUR", current_assets: 700, current_liabilities: 350 }] };
    const dir = runDir();
    const v = await valuationRun("DOLR.PA", dir, { now });
    expect(byKey(dir, "DOLR.PA.crible.current_assets.2025-12-31")).toBeUndefined();
    expect(byKey(dir, "DOLR.PA.quality.currentRatio")).toBeUndefined();
    expect(v.notes.join(" ")).toMatch(/crible holds DOLR\.PA's statements in EUR, the filing reports in USD: crible is not used/);
  });

  it("still fills the gaps from crible when it reports in the filing's currency", async () => {
    state.crible = { periods: [{ period: "2025-12-31", reporting_currency: "USD", current_assets: 700, current_liabilities: 350 }] };
    const dir = runDir();
    await valuationRun("DOLR.PA", dir, { now });
    expect(byKey(dir, "DOLR.PA.crible.current_assets.2025-12-31")).toMatchObject({ value: 700, unit: "USD" });
    expect(byKey(dir, "DOLR.PA.quality.currentRatio")?.value).toBeCloseTo(2, 9);
  });
});
