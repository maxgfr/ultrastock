// Trading hours and one-off closures are researched calendar facts (TEST facts here); the holiday rules stay computed.
// Session times follow the exchange's own clock, daylight saving included; a session count that reaches past the
// closures checked says so instead of assuming none.
import { afterEach, describe, expect, it } from "vitest";
import { settlementAt } from "../src/analyze/quant/options.js";
import { closedBars, sessionFinalAt } from "../src/analyze/regime/common.js";
import {
  addSessions,
  CALENDAR,
  CLOSURES_CHECKED_THROUGH,
  holidays,
  hoursNote,
  isTradingDay,
  localTimeToUtc,
  marketHours,
  nextSessions,
  sessionCountCaveat,
} from "../src/core/calendar.js";
import { factsTemplate } from "../src/core/researched.js";
import { clearTestFacts, installTestFacts } from "./helpers/facts.js";

afterEach(() => clearTestFacts(CALENDAR));

describe("local time to UTC", () => {
  it("follows each zone's daylight saving, on both sides of the change", () => {
    // New York: EDT until 1 November 2026, EST after.
    expect(localTimeToUtc("2026-10-30", "16:00", "America/New_York").toISOString()).toBe("2026-10-30T20:00:00.000Z");
    expect(localTimeToUtc("2026-11-02", "16:00", "America/New_York").toISOString()).toBe("2026-11-02T21:00:00.000Z");
    // Paris: CEST until 25 October 2026; spring forward on 29 March 2026.
    expect(localTimeToUtc("2026-10-23", "17:30", "Europe/Paris").toISOString()).toBe("2026-10-23T15:30:00.000Z");
    expect(localTimeToUtc("2026-10-26", "17:30", "Europe/Paris").toISOString()).toBe("2026-10-26T16:30:00.000Z");
    expect(localTimeToUtc("2026-03-27", "17:30", "Europe/Paris").toISOString()).toBe("2026-03-27T16:30:00.000Z");
    expect(localTimeToUtc("2026-03-30", "17:30", "Europe/Paris").toISOString()).toBe("2026-03-30T15:30:00.000Z");
  });

  it("finalises today's bar an hour apart across the US and European changes", () => {
    const bars = [{ date: "2026-10-29" }, { date: "2026-10-30" }];
    // 30 October: Paris already on CET (16:30 UTC close), New York still on EDT (20:00 UTC close).
    expect(sessionFinalAt("euronext", "2026-10-30")!.toISOString()).toBe("2026-10-30T16:50:00.000Z");
    expect(sessionFinalAt("us", "2026-10-30")!.toISOString()).toBe("2026-10-30T20:15:00.000Z");
    expect(sessionFinalAt("us", "2026-11-02")!.toISOString()).toBe("2026-11-02T21:15:00.000Z");
    expect(closedBars(bars, "us", new Date("2026-10-30T20:20:00Z"))).toHaveLength(2);
    expect(closedBars([{ date: "2026-11-02" }], "us", new Date("2026-11-02T20:20:00Z"))).toHaveLength(0);
    expect(sessionFinalAt("crypto", "2026-10-30")).toBeUndefined();
  });

  it("settles US options at the New York close, Deribit at 08:00 UTC", () => {
    expect(settlementAt("cboe", "2026-07-17").toISOString()).toBe("2026-07-17T20:00:00.000Z");
    expect(settlementAt("cboe", "2026-12-18").toISOString()).toBe("2026-12-18T21:00:00.000Z");
    expect(settlementAt("deribit", "2026-12-18").toISOString()).toBe("2026-12-18T08:00:00.000Z");
  });
});

describe("hours and one-off closures as researched facts", () => {
  it("uses the dated built-in hours, and says so, until the year's hours are researched", () => {
    const h = marketHours("XNYS", 2026);
    expect([h.open, h.close, h.origin]).toEqual(["09:30", "16:00", "built-in"]);
    expect(hoursNote("XNYS", h)).toMatch(/built-in.*facts research calendar --country US/);
    installTestFacts(CALENDAR, "US", 2026, { "XNYS.open": "09:30", "XNYS.close": "15:00", "XNYS.specialClosures": ["2026-12-28"] });
    const r = marketHours("XNYS", 2026);
    expect([r.close, r.origin]).toEqual(["15:00", "researched"]);
    expect(hoursNote("XNYS", r)).toBeUndefined();
    // The researched close moves the instant today's bar is final; the researched closure closes the day.
    expect(sessionFinalAt("us", "2026-12-21")!.toISOString()).toBe("2026-12-21T20:15:00.000Z");
    expect(nextSessions("XNYS", "2026-12-21", 1)[0]!.closeAt).toBe("15:00");
    expect(isTradingDay("XNYS", "2026-12-28")).toBe(false);
    expect(holidays("XNYS", 2026).map((x) => x.date)).toContain("2026-12-28");
    expect(addSessions("XNYS", "2026-12-24", 1)).toBe("2026-12-29");
  });

  it("keeps the past closures recorded, and says a count past them assumes none it does not know", () => {
    expect(isTradingDay("XNYS", "2025-01-09")).toBe(false);
    expect(sessionCountCaveat("XNYS", "2025-01-02", "2025-03-01")).toBeUndefined();
    expect(sessionCountCaveat("XNYS", "2026-11-02", "2027-01-15")).toMatch(
      new RegExp(`after ${CLOSURES_CHECKED_THROUGH} are not researched for 2026, 2027 .*facts research calendar --country US`),
    );
    expect(sessionCountCaveat(undefined, "2026-11-02", "2027-01-15")).toBeUndefined();
    expect(sessionCountCaveat("CRYPTO", "2026-11-02", "2027-01-15")).toBeUndefined();
    installTestFacts(CALENDAR, "US", 2026, { "XNYS.specialClosures": [] });
    expect(sessionCountCaveat("XNYS", "2026-11-02", "2026-12-31")).toBeUndefined();
  });

  it("lists, per exchange country, the keys to research", () => {
    const t = factsTemplate(CALENDAR, "FR", 2027) as { facts: Record<string, { type: string; prefer: string }> };
    expect(Object.keys(t.facts)).toEqual(["XPAR.open", "XPAR.close", "XPAR.specialClosures"]);
    expect(t.facts["XPAR.specialClosures"]!.type).toBe("dates");
    expect(t.facts["XPAR.close"]!.prefer).toMatch(/euronext\.com/);
  });
});
