// The researched-facts store: a domain registers its keys, a file per country and period holds the agent's research
// (every value sourced and dated), validation is strict, and a stale fact reads as unknown.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineDomain,
  type FactSpec,
  factsChecklist,
  factsPath,
  factQuery,
  factsTemplate,
  loadLatestFacts,
  loadFacts,
  saveFacts,
  specsFor,
  storedPeriods,
  validateFacts,
} from "../src/core/researched.js";
import { UsageError } from "../src/engine.js";

const KEYS: FactSpec[] = [
  {
    key: "fee.rate",
    label: "a venue's taker fee",
    type: "rate",
    unit: "fraction of 1",
    query: "{country} venue taker fee {period}",
    prefer: "the venue's fee page",
  },
  {
    key: "closures",
    label: "market closures",
    type: "amounts",
    unit: "days",
    fields: ["full", "half"],
    query: "{country} market holidays {period}",
    prefer: "the exchange's calendar",
    maxAgeDays: 30,
  },
];
const DEMO = defineDomain({
  name: "demo",
  period: "year",
  keysFor: (c) => (c === "XX" ? KEYS : []),
  strict: (c) => c === "XX",
  templateCommand: (c, p) => `demo template ${c} ${p}`,
  setCommand: "demo set",
  about: (c, p) => `research ${c} ${p}`,
});
const fact = (value: unknown, extra: Record<string, unknown> = {}) => ({
  value,
  label: "TEST",
  sources: ["https://example.invalid/test"],
  verifiedAt: "2025-01-02",
  confidence: "high",
  ...extra,
});
const file = (facts: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  country: "XX",
  year: 2025,
  researchedAt: "2025-01-02",
  facts,
  ...extra,
});

describe("researched facts", () => {
  it("stores a valid file atomically under <home>/facts/<domain>/ and reads it back", () => {
    const today = new Date().toISOString().slice(0, 10);
    const v = saveFacts(DEMO, file({ "fee.rate": fact(0.001), closures: fact({ full: 9, half: 2 }, { verifiedAt: today }) }));
    expect(v.path).toBe(factsPath(DEMO, "XX", 2025));
    expect(v.path).toMatch(/facts[\\/]demo[\\/]XX-2025\.json$/);
    expect(existsSync(v.path)).toBe(true);
    const back = loadFacts(DEMO, "xx", 2025);
    expect(back.current["fee.rate"]!.value).toBe(0.001);
    expect(back.missing).toEqual([]);
    expect(storedPeriods(DEMO, "XX")).toEqual([2025]);
    // The stored file holds the research only: no template field.
    expect(Object.keys(JSON.parse(readFileSync(v.path, "utf8")))).toEqual(["country", "year", "researchedAt", "facts"]);
  });

  it("refuses, in one usage error, every value that is not sourced, dated and of its key's type", () => {
    let err: unknown;
    try {
      validateFacts(
        DEMO,
        file({
          "fee.rate": fact(12, { sources: [] }),
          closures: fact({ full: 9 }, { verifiedAt: "2999-01-01", confidence: "sure" }),
          "made.up": fact(1),
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    const m = (err as Error).message;
    expect(m).toMatch(/fee\.rate.*between 0 and 1/);
    expect(m).toMatch(/fee\.rate.*at least one URL/);
    expect(m).toMatch(/closures.*missing field\(s\) half/);
    expect(m).toMatch(/closures.*verifiedAt.*future/);
    expect(m).toMatch(/closures.*confidence/);
    expect(m).toMatch(/made\.up.*not a XX demo key/);
    expect(() => validateFacts(DEMO, file({ "fee.rate": fact(null) }))).toThrow(/not researched \(value is null\)/);
    expect(() => validateFacts(DEMO, file({ "fee.rate": fact(0.1, { sources: ["see the venue's site"] }) }))).toThrow(/not an http\(s\) URL/);
    expect(() => validateFacts(DEMO, file({ "fee.rate": fact(0.1) }, { extra: 1 }))).toThrow(/unknown top-level field "extra"/);
    expect(() => validateFacts(DEMO, file({ "fee.rate": fact(0.1, { comment: "x" }) }))).toThrow(/unknown field "comment"/);
    // The period asked for is the period of the file: another year's facts are never read for it.
    expect(() => validateFacts(DEMO, file({ "fee.rate": fact(0.1) }), { period: 2026 })).toThrow(/for year 2025, not 2026/);
    // A country whose domain is not strict keeps free keys.
    expect(validateFacts(DEMO, { ...file({ "any.thing": fact("text") }), country: "YY" }).current["any.thing"]!.value).toBe("text");
  });

  it("a fact past its expiresAt, or older than its key's maxAgeDays, reads as unknown — listed as stale, never current", () => {
    const v = validateFacts(DEMO, file({ "fee.rate": fact(0.001, { expiresAt: "2025-02-01" }), closures: fact({ full: 9, half: 2 }) }));
    expect(v.stale.map((s) => s.key).sort()).toEqual(["closures", "fee.rate"]);
    expect(v.current).toEqual({});
    expect(v.missing).toEqual(["fee.rate", "closures"]);
    // The stored file keeps them: their sources are where to re-check.
    expect(Object.keys(v.file.facts)).toEqual(["fee.rate", "closures"]);
  });

  it("a missing file, or one that is not JSON, is a usage error naming the file and what to do", () => {
    expect(() => loadFacts(DEMO, "XX", 2024)).toThrow(/no XX demo facts for 2024: .*XX-2024\.json does not exist .*demo template XX 2024.*demo set/);
    saveFacts(DEMO, file({ "fee.rate": fact(0.001) }));
    expect(() => loadFacts(DEMO, "XX", 2024)).toThrow(/files are stored for 2025: they are not used for 2024/);
    writeFileSync(factsPath(DEMO, "XX", 2023), "{ not json");
    expect(() => loadFacts(DEMO, "XX", 2023)).toThrow(/not valid JSON/);
  });

  it("the template lists every registered key with a null value, its type, unit, query and preferred source", () => {
    const t = factsTemplate(DEMO, "xx", 2026) as { country: string; year: number; facts: Record<string, Record<string, unknown>> };
    expect(t.country).toBe("XX");
    expect(t.year).toBe(2026);
    expect(Object.keys(t.facts)).toEqual(["fee.rate", "closures"]);
    expect(t.facts.closures).toMatchObject({
      value: null,
      type: "amounts",
      fields: ["full", "half"],
      query: "XX market holidays 2026",
      prefer: "the exchange's calendar",
    });
    // A filled template validates as it is: its descriptive fields are dropped when stored.
    const filled = { ...t, researchedAt: "2025-01-02", facts: { "fee.rate": { ...t.facts["fee.rate"], ...fact(0.002) } } };
    expect(validateFacts(DEMO, filled).current["fee.rate"]!.value).toBe(0.002);
    const c = factsChecklist(DEMO, "XX", 2026);
    expect(c.stored).toBe(false);
    expect(c.items.map((i) => [i.key, i.status])).toEqual([
      ["fee.rate", "missing"],
      ["closures", "missing"],
    ]);
  });
});

// A `date` domain with an enumerated text key and per-venue keys, as the jurisdiction domain uses them.
const DATED = defineDomain<FactSpec>({
  name: "dated",
  period: "date",
  keysFor: () => [
    {
      key: "access",
      label: "access",
      type: "text",
      unit: "status",
      values: ["allowed", "blocked"],
      query: "{country} access",
      prefer: "the regulator",
      maxAgeDays: 90,
    },
    { key: "other", label: "other", type: "text", unit: "text", query: "{country} other", prefer: "the regulator" },
  ],
  strict: () => true,
  extraKey: (k) => (/^venue\.[a-z]+$/.test(k) ? { key: k, label: k, type: "boolean", unit: "", query: `${k} {country}`, prefer: "the register" } : undefined),
  templateCommand: (c) => `dated template ${c}`,
  setCommand: "dated set",
  about: (c, p) => `research ${c} ${p}`,
});
const dated = (date: string, facts: Record<string, unknown>) => ({ country: "XX", date, researchedAt: date, facts });
const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("researched facts — enumerated values, extra keys, the newest fact per key", () => {
  it("accepts only an enumerated value, and a key the domain's extraKey accepts with its own type", () => {
    expect(() => validateFacts(DATED, dated(ago(1), { access: fact("maybe", { verifiedAt: ago(1) }) }))).toThrow(/one of "allowed", "blocked"/);
    expect(() => validateFacts(DATED, dated(ago(1), { "venue.x": fact("yes", { verifiedAt: ago(1) }) }))).toThrow(/true or false/);
    expect(validateFacts(DATED, dated(ago(1), { "venue.x": fact(true, { verifiedAt: ago(1) }) })).current["venue.x"]?.value).toBe(true);
    expect(() => validateFacts(DATED, dated(ago(1), { unknown: fact("x", { verifiedAt: ago(1) }) }))).toThrow(/not a XX dated key/);
  });
  it("prints a template for the keys asked only, with their values, and refuses a key it does not hold", () => {
    const t = factsTemplate(DATED, "XX", "2026-01-01", { keys: ["access", "venue.y"] }) as { facts: Record<string, Record<string, unknown>> };
    expect(Object.keys(t.facts)).toEqual(["access", "venue.y"]);
    expect(t.facts.access!.values).toEqual(["allowed", "blocked"]);
    expect(specsFor(DATED, "XX", ["access"]).map((s) => s.key)).toEqual(["access"]);
    expect(() => specsFor(DATED, "XX", ["nope"])).toThrow(/not a XX dated key: nope — the keys are access, other/);
    expect(factQuery(KEYS[0]!, "FR", 2025)).toBe("FR venue taker fee 2025");
  });
  it("reads each key's newest fact across the stored dates, each with its own age check", () => {
    expect(loadLatestFacts(DATED, "XX")).toMatchObject({ facts: {}, missing: ["access", "other"], paths: [] });
    saveFacts(DATED, dated(ago(100), { access: fact("allowed", { verifiedAt: ago(100) }), other: fact("old", { verifiedAt: ago(100) }) }));
    let l = loadLatestFacts(DATED, "XX");
    expect(l.stale).toEqual([{ key: "access", reason: expect.stringMatching(/older than 90 days/) }]);
    expect(l.current.other?.value).toBe("old");
    saveFacts(DATED, dated(ago(2), { access: fact("blocked", { verifiedAt: ago(2), evidence: ["E1 https://x.invalid"] }) }));
    l = loadLatestFacts(DATED, "XX");
    expect(l.current.access).toMatchObject({ value: "blocked", period: ago(2) });
    expect(l.current.other).toMatchObject({ value: "old", period: ago(100) });
    expect(l.stale).toEqual([]);
    expect(l.paths).toHaveLength(2);
    // The template's helper fields (evidence) are accepted and not stored.
    expect(JSON.parse(readFileSync(l.current.access!.path, "utf8")).facts.access.evidence).toBeUndefined();
  });
});
