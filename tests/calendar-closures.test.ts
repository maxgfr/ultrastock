// One-off closures as researched facts (core/calendar.ts).
//
// 1. A researched closure is history once its day has passed: the key's maxAgeDays (120) bounds how long the list is
//    taken as complete, not how long a recorded closure counts — 121 days after it was verified, the closed day must
//    not count as a session again (every count across it, journal horizons and session ordinals, would move a day).
// 2. A researched list knows the closures announced when it was verified, not a day of mourning still to come: a
//    count reaching past its verification (plus a short horizon) says the later one-off closures are unknown, as
//    the built-in list's rule does — it never assumes none.
// 3. A closure dated outside the file's year (the NYSE announced on 30 December 2024 that it would close on 9 January
//    2025) is either refused or closes its own day — never listed under one year and ignored by the counts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSessions, CALENDAR, holidays, isTradingDay, nextSessions } from "../src/core/calendar.js";
import { installTestFacts } from "./helpers/facts.js";

const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

describe("researched one-off closures", () => {
  beforeEach(() => {
    // A home of its own per test: the calendar caches a facts file by path and modification time.
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "cal-"));
  });
  afterEach(() => vi.useRealTimers());

  it("control: a closure researched the day after it happened closes that day", () => {
    at("2026-12-11T12:00:00Z");
    installTestFacts(CALENDAR, "US", 2026, { "XNYS.specialClosures": ["2026-12-09"] }, { verifiedAt: "2026-12-10" });
    expect(isTradingDay("XNYS", "2026-12-09")).toBe(false);
    expect(addSessions("XNYS", "2026-12-08", 1)).toBe("2026-12-10");
  });

  it("refuses a closure dated outside the file's year, or closes that day — not neither", () => {
    at("2026-12-30T12:00:00Z");
    let stored = true;
    try {
      // Researched on 30 December 2026: a closure announced for Tuesday 5 January 2027, written into the year at hand.
      installTestFacts(CALENDAR, "US", 2026, { "XNYS.specialClosures": ["2027-01-05"] }, { verifiedAt: "2026-12-30" });
    } catch {
      stored = false; // refusing it (with the year to file it under) would be right too
    }
    if (!stored) return;
    // Stored, it is listed with the 2026 facts that hold it…
    expect(holidays("XNYS", 2026).map((h) => h.date)).toContain("2027-01-05");
    // …and it closes its own day all the same: the lists and the counts agree (before the fix, the day was a session).
    expect(isTradingDay("XNYS", "2027-01-05")).toBe(false);
    expect(nextSessions("XNYS", "2027-01-04", 2).map((x) => x.date)).toEqual(["2027-01-04", "2027-01-06"]);
    // …and the list names the file it belongs in.
    expect(holidays("XNYS", 2026).find((h) => h.date === "2027-01-05")?.name).toMatch(/belongs in US-2027\.json/);
  });
});
