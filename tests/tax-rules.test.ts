// ultrastock contains no tax law: the engines read the rules the agent researched (<home>/facts/tax/<CC>-<year>.json)
// and refuse without them. These tests cover the refusals, the template the agent fills, the strict validation and
// the commands; the values they store are TEST data (tests/helpers/tax-rules.ts), not law.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { taxCommand } from "../src/commands/tax.js";
import { UsageError } from "../src/engine.js";
import { FranceRegime } from "../src/tax/fr.js";
import { FR_SPEC, GENERIC_SPEC, loadRules, rulesPath, rulesTemplate, saveRules, US_SPEC, validateRules } from "../src/tax/rules.js";
import { UsRegime } from "../src/tax/us.js";
import { clearTaxRules, frTestValues, installTaxTestRules, testRulesFile, usTestValues } from "./helpers/tax-rules.js";

// Each test starts from no stored rules: what it needs, it installs.
beforeEach(() => clearTaxRules());

const caught = (f: () => unknown): Error => {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
};

describe("the engines refuse without researched rules", () => {
  it("no file for the year: a usage error naming the file and the template command, and no earlier year used", () => {
    installTaxTestRules([2024]);
    const e = caught(() => new FranceRegime(2025));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toContain(rulesPath("FR", 2025));
    expect(e.message).toContain("ultrastock tax rules template --country FR --year 2025");
    expect(e.message).toMatch(/stored for 2024: they are not used for 2025/);
    expect(() => new UsRegime(2025)).toThrow(/no US tax facts for 2025/);
  });

  it("a key the engine reads missing: the file, every missing key and the template command", () => {
    const values = frTestValues(2025);
    delete values["pfu.ir"];
    delete values["crypto.exemptionThreshold"];
    saveRules(testRulesFile("FR", 2025, values));
    const e = caught(() => new FranceRegime(2025));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toContain(rulesPath("FR", 2025));
    expect(e.message).toMatch(/lacks 2 key\(s\) the FR engine reads: pfu\.ir, crypto\.exemptionThreshold/);
    expect(e.message).toContain("tax rules template --country FR --year 2025");
    // costMethod is read by the neutral report only: the engine does not need it.
    const noMethod = usTestValues(2025);
    delete noMethod.costMethod;
    saveRules(testRulesFile("US", 2025, noMethod));
    expect(new UsRegime(2025).rules.year).toBe(2025);
  });

  it("a file holding another year's rules is refused, not read", () => {
    installTaxTestRules([2025]);
    writeFileSync(rulesPath("FR", 2024), JSON.stringify(testRulesFile("FR", 2023, frTestValues(2023))));
    const e = caught(() => new FranceRegime(2024));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toContain(rulesPath("FR", 2024));
    expect(e.message).toMatch(/the file is for year 2023, not 2024/);
  });

  it("`tax report` refuses before any request", async () => {
    installTaxTestRules([2024]);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(taxCommand({ command: "tax", positional: ["report"], values: { country: "FR", year: "2025" }, bools: new Set() }, true)).rejects.toThrow(
        /no FR tax facts for 2025/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the template covers every key the engines read", () => {
  /** The keys a regime's source passes to `param(…)` — string literals in its argument, comparisons excepted. */
  const readKeys = (file: string): Set<string> => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "tax", file), "utf8");
    const keys = new Set<string>();
    for (const m of src.matchAll(/\bparam(?:<[^()]*?>)?\(([^()]*)\)/g))
      for (const k of m[1]!.matchAll(/"([^"]*)"/g)) if (!/[=!]==\s*$/.test(m[1]!.slice(0, k.index))) keys.add(k[1]!);
    return keys;
  };
  for (const [file, spec] of [
    ["fr.ts", FR_SPEC],
    ["us.ts", US_SPEC],
  ] as const) {
    it(`${file}: every param() key has a template entry, and every engine entry is read`, () => {
      const read = readKeys(file);
      expect(read.size).toBeGreaterThan(10);
      const listed = new Set<string>(spec.map((s) => s.key));
      expect([...read].filter((k) => !listed.has(k))).toEqual([]);
      expect(spec.filter((s) => s.usedBy === "engine" && !read.has(s.key)).map((s) => s.key)).toEqual([]);
    });
  }

  it("the skeleton has every key with a null value, a type, a unit, a query for the year and an official source to prefer", () => {
    for (const [c, spec] of [
      ["FR", FR_SPEC],
      ["US", US_SPEC],
      ["DE", GENERIC_SPEC],
    ] as const) {
      const t = rulesTemplate(c, 2025) as { facts: Record<string, Record<string, unknown>>; currency: unknown; formLines?: unknown[] };
      expect(Object.keys(t.facts)).toEqual(spec.map((s) => s.key));
      for (const f of Object.values(t.facts)) {
        expect(f.value).toBeNull();
        expect(f.type).toBeTruthy();
        expect(f.unit).toBeTruthy();
        expect(String(f.query)).toMatch(/2025/);
        expect(f.prefer).toBeTruthy();
      }
      if (c === "DE") {
        expect(t.currency).toBeNull();
        expect(t.formLines).toBeUndefined();
      } else expect(t.formLines?.length).toBeGreaterThan(0);
    }
    expect(Object.keys((rulesTemplate("DE", 2025) as { facts: object }).facts)).toEqual(
      expect.arrayContaining([
        "capitalGains.rates",
        "holdingPeriod.rules",
        "costMethod",
        "crypto.treatment",
        "losses.carryForward",
        "washSale.rule",
        "reporting.forms",
      ]),
    );
    expect(String((rulesTemplate("FR", 2025).facts as Record<string, { prefer: string }>)["pfu.ir"]!.prefer)).toMatch(/service-public\.fr.*BOFiP.*Légifrance/);
    expect(String((rulesTemplate("US", 2025).facts as Record<string, { prefer: string }>)["ltcg.thresholds"]!.prefer)).toMatch(/IRS publication.*Rev\. Proc\./);
  });
});

describe("validation", () => {
  const good = () => testRulesFile("FR", 2025, frTestValues(2025)) as Record<string, unknown> & { facts: Record<string, Record<string, unknown>> };
  it("refuses an unknown key for an engine country, a value of the wrong type, an unsourced or undated value, the wrong currency", () => {
    const f = good();
    f.facts["pfu.flat"] = { ...f.facts["pfu.ir"]! };
    f.facts["pfu.ir"]!.value = 12.8;
    f.facts["ps.capital"]!.sources = [];
    f.facts["pea.ceiling"]!.verifiedAt = "yesterday";
    f.facts["penalty.3916bis"]!.value = { standard: 750 };
    f.facts["securities.allowanceAcquiredBefore"]!.value = "2018";
    f.currency = "USD";
    const e = caught(() => validateRules(f));
    expect(e).toBeInstanceOf(UsageError);
    for (const re of [
      /pfu\.flat.*not a FR tax key/,
      /pfu\.ir.*between 0 and 1/,
      /ps\.capital.*at least one URL/,
      /pea\.ceiling.*verifiedAt/,
      /penalty\.3916bis.*missing field\(s\) aboveThreshold, threshold/,
      /allowanceAcquiredBefore.*YYYY-MM-DD/,
      /currency.*computes in EUR, not USD/,
    ])
      expect(e.message).toMatch(re);
  });
  it("pins the country and the year asked for", () => {
    expect(() => validateRules(good(), { year: 2026 })).toThrow(/for year 2025, not 2026/);
    expect(() => validateRules(good(), { country: "US" })).toThrow(/for FR, not US/);
  });
  it("keeps free keys for a country without an engine, still sourced", () => {
    const de = testRulesFile("DE", 2025, { "capitalGains.rates": 0.25, "solidaritySurcharge.rate": 0.055, costMethod: "fifo" });
    expect(validateRules(de).rules.facts["solidaritySurcharge.rate"]!.value).toBe(0.055);
    (de.facts as Record<string, { sources: string[] }>)["solidaritySurcharge.rate"]!.sources = ["§ 4 SolzG"];
    expect(() => validateRules(de)).toThrow(/"§ 4 SolzG" is not an http\(s\) URL/);
  });
});

describe("tax rules template | set | show, tax verify", () => {
  afterEach(() => vi.restoreAllMocks());
  async function cli(argv: string[]) {
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out += String(c);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await main(argv);
    } finally {
      vi.restoreAllMocks();
    }
    return out;
  }
  beforeEach(() => installTaxTestRules([2026]));

  it("template → fill → set → show → verify, for a country without an engine", async () => {
    const t = JSON.parse(await cli(["tax", "rules", "template", "--country", "DE", "--year", "2025", "--currency", "EUR"]));
    expect(t.currency).toBe("EUR");
    expect(t._about).toMatch(/contains no tax law/);
    // The agent fills what its research found, with sources.
    t.researchedAt = "2025-03-01";
    for (const [k, f] of Object.entries(t.facts as Record<string, Record<string, unknown>>)) {
      if (k === "costMethod" || k === "capitalGains.rates") {
        f.value = k === "costMethod" ? "fifo" : 0.25;
        f.sources = ["https://example.invalid/test-research"];
        f.verifiedAt = "2025-03-01";
        f.confidence = "medium";
      } else delete (t.facts as Record<string, unknown>)[k];
    }
    const file = join(process.env.ULTRASTOCK_HOME!, "de-2025.json");
    writeFileSync(file, JSON.stringify(t));
    const set = await cli(["tax", "rules", "set", "--file", file]);
    expect(set).toMatch(/stored .*DE-2025\.json — 2 researched fact\(s\) for DE 2025/);
    expect(set).toMatch(/not researched yet.*holdingPeriod\.rules/);
    expect(loadRules("DE", 2025).rules.facts.costMethod!.value).toBe("fifo");
    expect(await cli(["tax", "rules", "show", "--country", "DE", "--year", "2025"])).toMatch(/capitalGains\.rates = 0\.25/);
    const v = JSON.parse(await cli(["tax", "verify", "--country", "DE", "--year", "2025", "--json"]));
    expect(v.items.find((i: { key: string }) => i.key === "costMethod").status).toBe("researched");
    expect(v.items.find((i: { key: string }) => i.key === "crypto.treatment").status).toBe("missing");
    // --year pins the file's year.
    await expect(taxCommand({ command: "tax", positional: ["rules", "set"], values: { file, year: "2024" }, bools: new Set() }, false)).rejects.toThrow(
      /for year 2025, not 2024/,
    );
  });

  it("show and verify for an engine country", async () => {
    expect(await cli(["tax", "rules", "--regime", "fr", "--year", "2026"])).toMatch(/PEA: .*150000/);
    const v = await cli(["tax", "verify", "--country", "US", "--year", "2026"]);
    expect(v).toMatch(/ltcg\.thresholds \[researched\]/);
    expect(v).toMatch(/search: ".*2026/);
    expect(v).toMatch(/Schedule D/);
    expect(await cli(["tax", "verify", "--country", "US", "--year", "2025"])).toMatch(/not stored yet[\s\S]*washSale\.windowDays \[missing\]/);
  });
});
