// EU / EEA / euro-area membership (core/geo.ts).
//
// core/geo.ts: "when nothing current is stored the readers fall back to ONE built-in list, dated and sourced below,
// and say so: every caller passes `membershipNote()` on to its output."
//
// 1. `profile init` derives the base currency from the euro-area list and states "<CC> is in the euro area" — from
//    the built-in list: it must carry the note, as every other caller does.
// 2. A stored list verified BEFORE the built-in list's own date (a membership researched in December 2025, without
//    Bulgaria) must not silently override the built-in list of 1 January 2026: the newer one wins, and the note says
//    the stored one was set aside.
import { afterEach, describe, expect, it, vi } from "vitest";
import { initResidence } from "../src/commands/profile.js";
import { BUILT_IN_MEMBERSHIP, euroAreaMembers, GEO, membershipNote } from "../src/core/geo.js";
import { clearTestFacts, installTestFacts } from "./helpers/facts.js";

afterEach(() => {
  vi.useRealTimers();
  clearTestFacts(GEO);
});

describe("membership fallback", () => {
  it("profile init says its euro-area reading comes from the built-in list", () => {
    const ea = euroAreaMembers();
    expect(ea.origin).toBe("built-in");
    expect(membershipNote(ea)).toBeDefined(); // there is something to say…
    const r = initResidence("BG", undefined);
    expect(r.currency).toBe("EUR");
    // …and profile init says it. Before the fix: "BG is in the euro area; --currency to change it".
    expect(r.currencyWhy).toMatch(/built-in list as of 2026-01-01/);
  });

  it("does not let a list verified before the built-in list's date override it in silence", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    // TEST DATA: the euro area as it stood on 20 December 2025, before Bulgaria joined.
    installTestFacts(GEO, "EU", "2025-12-20", { "euroArea.members": BUILT_IN_MEMBERSHIP.euroArea.filter((c) => c !== "BG") });
    const ea = euroAreaMembers();
    // The stored list is older than the built-in one (before the fix, the list used: Bulgaria out, origin
    // "researched", no note).
    expect("2025-12-20" < BUILT_IN_MEMBERSHIP.asOf).toBe(true);
    // Either the newer list wins, or the output is told the list predates the built-in one.
    expect(ea.codes.includes("BG") || membershipNote(ea) !== undefined).toBe(true);
    // The newer one wins, and the note says the stored one was set aside.
    expect([ea.origin, ea.asOf, ea.codes.includes("BG")]).toEqual(["built-in", BUILT_IN_MEMBERSHIP.asOf, true]);
    expect(membershipNote(ea)).toMatch(/the stored list, verified 2025-12-20, is older and set aside/);
  });

  it("…so `profile init --jurisdiction BG` still finds the euro", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    installTestFacts(GEO, "EU", "2025-12-20", { "euroArea.members": BUILT_IN_MEMBERSHIP.euroArea.filter((c) => c !== "BG") });
    // Before the fix: throws "no base currency known for BG".
    expect(initResidence("BG", undefined).currency).toBe("EUR");
  });
});
