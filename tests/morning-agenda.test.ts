import { describe, expect, it, vi } from "vitest";
import { macroAgenda } from "../src/analyze/regime/catalysts.js";
import type { EconEvent } from "../src/providers/macro/calendars.js";

// The two calendars the brief reads, answering for 12 November 2026: ForexFactory's high-impact week names a release
// its own way ("CPI m/m", "Federal Funds Rate"), Nasdaq's day calendar another ("CPI (MoM)", "Fed Interest Rate Decision").
vi.mock("../src/providers/macro/calendars.js", async (importActual) => {
  const real = await importActual<typeof import("../src/providers/macro/calendars.js")>();
  const meta = (source: string) => ({ title: source, url: `https://${source}.test/`, fetchedAt: "2026-11-12T06:00:00.000Z", source });
  const ev = (source: EconEvent["source"], country: string, event: string, at = "2026-11-12T13:30:00.000Z"): EconEvent => ({ at, country, event, source });
  return {
    ...real,
    forexFactoryCalendar: async () =>
      real.econEventsToDataset(
        [
          ev("forexfactory", "USD", "CPI m/m"),
          ev("forexfactory", "USD", "CPI y/y"),
          ev("forexfactory", "USD", "Core CPI m/m"),
          ev("forexfactory", "USD", "Federal Funds Rate", "2026-11-12T19:00:00.000Z"),
        ],
        meta("forexfactory"),
      ),
    nasdaqEconomicCalendar: async () =>
      real.econEventsToDataset(
        [
          ev("nasdaq", "United States", "CPI (MoM) (Oct)"),
          ev("nasdaq", "United States", "CPI (YoY) (Oct)"),
          ev("nasdaq", "United States", "Core CPI (MoM) (Oct)"),
          ev("nasdaq", "United States", "Fed Interest Rate Decision", "2026-11-12T19:00:00.000Z"),
          ev("nasdaq", "United States", "Initial Jobless Claims"),
        ],
        meta("nasdaq"),
      ),
  };
});

describe("the macro agenda of the morning brief", () => {
  it("lists a release once when both calendars carry it", async () => {
    const a = await macroAgenda(["USD"], "2026-11-12", "2026-11-12", new Date("2026-11-12T06:00:00Z"), "MORNING");
    // Four releases from ForexFactory; of Nasdaq's five, only the jobless claims are new — not eight "high-impact USD releases".
    expect(a.items.map((i) => i.text)).toEqual([
      "USD | CPI m/m",
      "USD | CPI y/y",
      "USD | Core CPI m/m",
      "USD | Federal Funds Rate",
      "United States | Initial Jobless Claims",
    ]);
    // What is registered is what is listed.
    expect(a.datasets.flatMap((d) => d.points.map((p) => p.key)).sort()).toEqual(a.items.map((i) => i.key).sort());
  });
});
