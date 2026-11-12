// EU, EEA and euro-area membership: read from the researched "geo" facts, else from one dated, sourced built-in
// list — and every output says which. The lists keep the order recorded requests were made with.
import { afterEach, describe, expect, it } from "vitest";
import { eventExposure } from "../src/analyze/events/run.js";
import { peerCountries } from "../src/analyze/peers.js";
import { locationRule } from "../src/analyze/portfolio/location.js";
import { euEeaTradingViewCountries, tvPreset } from "../src/analyze/screen/presets.js";
import { peaEligible, valueRegion } from "../src/analyze/value/styles.js";
import { euEeaMembers, euroAreaMembers, europeCountries, GEO, isEuEea, membershipNote } from "../src/core/geo.js";
import { clearTestFacts, installTestFacts } from "./helpers/facts.js";

afterEach(() => clearTestFacts(GEO));

describe("membership (built-in fallback)", () => {
  it("counts Bulgaria in the euro area since 1 January 2026", () => {
    const ea = euroAreaMembers();
    expect(ea.codes).toContain("BG");
    expect(ea.codes).toHaveLength(21);
    expect(ea.origin).toBe("built-in");
    expect(membershipNote(ea, "euro area")).toMatch(/built-in list as of 2026-01-01.*facts research geo/);
  });

  it("writes the lists in the order the recorded requests used", () => {
    expect(euEeaMembers().codes).toEqual([..."AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "), "IS", "LI", "NO"]);
    expect(euEeaTradingViewCountries().slice(0, 6)).toEqual(["Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czech Republic"]);
    expect(euEeaTradingViewCountries().slice(-3)).toEqual(["Iceland", "Liechtenstein", "Norway"]);
    expect(europeCountries().codes).toEqual([...europeCountries().codes].sort());
    expect(europeCountries().codes).toHaveLength(32);
    expect(peerCountries("FR")).toEqual(europeCountries().codes);
    expect(valueRegion("europe").countries).toEqual([...euEeaMembers().codes, "GB", "CH"]);
  });

  it("feeds the PEA first pass, the PEA screen and the value region from the one list", () => {
    expect(isEuEea("BG")).toBe(true);
    expect(isEuEea("GB")).toBe(false);
    expect(locationRule({ symbol: "X", assetClass: "equity", isin: "BG1100003166", envelopes: [] }).basis).toMatch(/EU\/EEA/);
    const pea = tvPreset("pea-candidates")!;
    expect(pea.filter[0]!.right).toEqual(euEeaTradingViewCountries());
    expect(pea.approximations?.join(" ")).toMatch(/built-in list as of 2026-01-01/);
    expect(peaEligible({ country: "BG", isin: "BG1100003166" })).toBe(true);
  });

  it("counts a Bulgarian holding in the exposure to an ECB decision", () => {
    const bg = { key: "BG" } as unknown as Parameters<typeof eventExposure>[1] extends Map<string, infer E> ? E : never;
    const ecb = { id: "ecb:2026-12-17", date: "2026-12-17", type: "central-bank", iso: "EU", title: "ECB", source: "ecb" } as Parameters<
      typeof eventExposure
    >[0];
    expect(eventExposure(ecb, new Map([["BG", bg]]), new Map())).toEqual([bg]);
  });
});

describe("membership (researched)", () => {
  it("reads a current stored list and drops the fallback note", () => {
    const today = new Date().toISOString().slice(0, 10);
    installTestFacts(GEO, "EU", today, {
      "eu.members": ["FR", "DE", "AT"],
      "eea.nonEuMembers": ["NO"],
      "euroArea.members": ["FR", "DE", "AT", "XK"],
    });
    expect(euroAreaMembers().codes).toEqual(["AT", "DE", "FR", "XK"]);
    expect(euroAreaMembers().origin).toBe("researched");
    expect(membershipNote(euroAreaMembers())).toBeUndefined();
    expect(euEeaMembers().codes).toEqual(["AT", "FR", "DE", "NO"]);
    expect(isEuEea("BG")).toBe(false);
  });

  it("falls back to the built-in list, with its note, when the stored one is over a year old", () => {
    installTestFacts(GEO, "EU", "2024-01-01", { "eu.members": ["FR"], "eea.nonEuMembers": ["NO"], "euroArea.members": ["FR"] });
    expect(euroAreaMembers().origin).toBe("built-in");
    expect(euroAreaMembers().codes).toContain("BG");
  });
});
