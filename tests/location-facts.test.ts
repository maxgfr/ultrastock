// Asset location and a sell's tax note state no tax rule of their own: the holding periods, the PEA ceiling and the
// treaty rate are the researched tax facts of the year (TEST facts here), left out — with the command to research
// them — when they are not researched; and nothing French is said to a resident of another country.
import { beforeEach, describe, expect, it } from "vitest";
import { bestEnvelope, locationFacts, locationFactsNote, locationRules } from "../src/analyze/portfolio/location.js";
import { sellTaxNote } from "../src/analyze/portfolio/rebalance.js";
import { clearTaxRules, installTaxTestRules } from "./helpers/tax-rules.js";

const MC = { symbol: "MC.PA", assetClass: "equity", isin: "FR0000121014", envelopes: ["CTO" as const] };

describe("location advice from the researched tax facts", () => {
  beforeEach(() => clearTaxRules());

  it("leaves the holding periods, the ceiling and the treaty rate out when they are not researched", () => {
    const lf = locationFacts(2026);
    expect(lf.missing).toEqual(["pea.ceiling", "pea.minYears", "av.minYears", "us.dividendWithholdingTreaty"]);
    const rules = locationRules(lf);
    const text = Object.values(rules)
      .map((r) => r.why)
      .join(" ");
    expect(text).not.toMatch(/\d+ years|\d+ % US treaty|W-8BEN/);
    expect(rules["eu-share"]!.why).toMatch(/not researched/);
    expect(locationFactsNote(lf)).toMatch(/tax rules template --country FR --year 2026/);
    // The ceiling unknown: the PEA still ranks first, its room is said to be unknown.
    const r = bestEnvelope(MC, new Set(["PEA", "CTO"] as const), undefined, rules);
    expect(r.best).toBe("PEA");
    expect(r.reason).toMatch(/room under the PEA ceiling is unknown/);
  });

  it("writes the advice with the researched facts of the year", () => {
    installTaxTestRules([2026]);
    const lf = locationFacts(2026);
    expect(lf.missing).toEqual([]);
    expect(lf.peaCeiling).toBe(150_000);
    const rules = locationRules(lf);
    expect(rules["eu-share"]!.why).toMatch(/after 5 years/);
    expect(rules["other-fund"]!.why).toMatch(/after 8 years/);
    expect(rules["non-eu-share"]!.why).toMatch(/W-8BEN for the 15 % US treaty rate/);
    expect(rules["eu-share"]!.sources.some((s) => s.url.includes("example.invalid"))).toBe(true);
    expect(locationFactsNote(lf)).toBeUndefined();
    // Another year is not researched: nothing carries over.
    expect(locationFacts(2027).missing).toHaveLength(4);
  });
});

describe("a sell's tax note", () => {
  beforeEach(() => clearTaxRules());

  it("quotes the French flat tax only as researched", () => {
    expect(sellTaxNote("CTO", { residence: "FR", year: 2026 })).toMatch(/not researched for 2026 — `ultrastock tax rules template --country FR --year 2026`/);
    expect(sellTaxNote("CTO", { residence: "FR", year: 2026, pfuIr: 0.128, psCapital: 0.186 })).toMatch(/12\.8 % income tax \+ 18\.6 % social levies/);
    expect(sellTaxNote("CTO", { residence: "FR", year: 2026 })).not.toMatch(/to come/);
  });

  it("says nothing French to another residence, and what to research instead", () => {
    for (const env of ["PEA", "CTO", "CRYPTO", "TAXABLE", "unknown"]) {
      const note = sellTaxNote(env, { residence: "DE", year: 2026 });
      expect(note).not.toMatch(/France|French|PFU|CGI|flat tax|withdrawal/);
      expect(note).toMatch(/DE tax resident is not built in.*tax rules template --country DE --year 2026/);
    }
  });
});
