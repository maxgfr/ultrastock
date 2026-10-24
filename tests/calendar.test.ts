import { describe, expect, it } from "vitest";
import { addSessions, easterSunday, holidays, isTradingDay, marketForMic, nextSessions } from "../src/core/calendar.js";

const closed = (m: Parameters<typeof holidays>[0], y: number) =>
  holidays(m, y)
    .filter((h) => h.kind === "closed")
    .map((h) => h.date);

describe("calendar", () => {
  it("computes Easter", () => {
    expect(["2024", "2025", "2026", "2027", "2038"].map((y) => easterSunday(Number(y)).toISOString().slice(0, 10))).toEqual([
      "2024-03-31",
      "2025-04-20",
      "2026-04-05",
      "2027-03-28",
      "2038-04-25",
    ]);
  });
  it("matches the NYSE's published 2026 holidays", () => {
    expect(closed("XNYS", 2026)).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-03",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03",
      "2026-09-07",
      "2026-11-26",
      "2026-12-25",
    ]);
    expect(
      holidays("XNYS", 2026)
        .filter((h) => h.kind === "early-close")
        .map((h) => h.date),
    ).toEqual(["2026-11-27", "2026-12-24"]);
  });
  it("applies the NYSE observance rules and one-off closures", () => {
    expect(closed("XNYS", 2022)).not.toContain("2021-12-31"); // New Year on a Saturday is not observed
    expect(closed("XNYS", 2022)).toContain("2022-06-20"); // Juneteenth on a Sunday → Monday
    expect(closed("XNYS", 2025)).toContain("2025-01-09");
    expect(holidays("XNYS", 2023).find((h) => h.date === "2023-07-03")?.kind).toBe("early-close");
  });
  it("matches Euronext's harmonised calendar", () => {
    expect(closed("XPAR", 2026)).toEqual(["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-01", "2026-12-25"]);
    expect(
      holidays("XPAR", 2026)
        .filter((h) => h.kind === "early-close")
        .map((h) => [h.date, h.closeAt]),
    ).toEqual([
      ["2026-12-24", "14:05"],
      ["2026-12-31", "14:05"],
    ]);
    expect(closed("XPAR", 2025)).toContain("2025-12-26");
  });
  it("finds sessions and counts them", () => {
    expect(isTradingDay("XPAR", "2026-04-06")).toBe(false);
    expect(isTradingDay("XPAR", "2026-10-24")).toBe(false);
    expect(isTradingDay("CRYPTO", "2026-10-24")).toBe(true);
    expect(nextSessions("XPAR", "2026-04-02", 2).map((s) => s.date)).toEqual(["2026-04-02", "2026-04-07"]);
    expect(addSessions("XNYS", "2026-11-25", 2)).toBe("2026-11-30");
    expect(marketForMic("ETFP")).toBe("XPAR");
    expect(marketForMic("MTAA")).toBe("XMIL");
    expect(marketForMic("NASDAQ-GS")).toBe("XNYS");
  });
});
