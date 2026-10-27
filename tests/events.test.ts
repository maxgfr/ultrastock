import { describe, expect, it } from "vitest";
import { eventExposure, type Exposure, type MarketEvent } from "../src/analyze/events/run.js";
import { holdingCountry } from "../src/analyze/events/markets.js";
import { eventReaction, reactionStats } from "../src/analyze/events/study.js";
import { parseEcbCalendar, parseFomc } from "../src/providers/macro/central-banks.js";
import { countryIso, electionKind, parseElectionCalendar } from "../src/providers/macro/elections.js";

const CALENDAR = `Intro text.
==October==
* 3 October: [[Elections in Latvia|Latvia]], [[2026 Latvian parliamentary election|Parliament]]<ref>{{Cite web |title=x}}</ref>
* 4 October:
** [[Elections in Bosnia and Herzegovina|Bosnia and Herzegovina]], [[2026 Bosnian general election|Presidency and House of Representatives]]
** [[Elections in Brazil|Brazil]], [[2026 Brazilian general election|President (1st round), Chamber of Deputies and Senate]]
* 9–10 October: [[Elections in the Czech Republic|Czech Republic]], [[2026 Czech Senate election|Senate (1st round)]]
* 11 October: [[Elections in Slovenia|Slovenia]], [[2026 Slovenian referendum|Referendums]]
* 25 October:
** [[Elections in Brazil|Brazil]], [[2026 Brazilian general election|President (2nd round)]]
==November==
* 3 November:
** [[Elections in Guam|''Guam'']], [[2026 Guam gubernatorial election|''Governor'']]
** [[Elections in the United States|United States]], [[2026 United States Senate elections|Senate]] and [[2026 United States House of Representatives elections|House of Representatives]]
`;

describe("electoral calendar", () => {
  const events = parseElectionCalendar(CALENDAR, 2026);
  it("reads dated entries, nested and inline, and leaves dependent territories out", () => {
    expect(events.map((e) => `${e.date} ${e.iso} ${e.kind}${e.round ? ` r${e.round}` : ""}`)).toEqual([
      "2026-10-03 LV legislative",
      "2026-10-04 BA general",
      "2026-10-04 BR general r1",
      "2026-10-09 CZ legislative r1",
      "2026-10-11 SI referendum",
      "2026-10-25 BR presidential r2",
      "2026-11-03 US legislative",
    ]);
    expect(events[3]!.endDate).toBe("2026-10-10");
    expect(events[5]!.article).toBe("2026 Brazilian general election");
    expect(events.some((e) => e.country === "Guam")).toBe(false);
  });
  it("maps country names to ISO codes, aliases included", () => {
    expect(countryIso("Brazil")).toBe("BR");
    expect(countryIso("Czech Republic")).toBe("CZ");
    expect(countryIso("Bosnia and Herzegovina")).toBe("BA");
    expect(countryIso("Myanmar")).toBe("MM");
    expect(countryIso("Côte d'Ivoire")).toBe("CI");
  });
  it("classifies offices", () => {
    expect(electionKind("President (2nd round)")).toBe("presidential");
    expect(electionKind("Mayors and municipal councils")).toBe("local");
    expect(electionKind("Constitutional referendum")).toBe("referendum");
  });
});

describe("central-bank calendars", () => {
  it("reads the FOMC page, the decision on the meeting's last day", () => {
    const html = `<h4><a id="1">2026 FOMC Meetings</a></h4>
      <div class="fomc-meeting__month col-xs-5"><strong>January</strong></div><div class="fomc-meeting__date col-xs-4">27-28</div>
      <div class="fomc-meeting__month col-xs-5"><strong>March</strong></div><div class="fomc-meeting__date col-xs-4">17-18*</div>
      <div class="fomc-meeting__month col-xs-5"><strong>Apr/May</strong></div><div class="fomc-meeting__date col-xs-4">30-1</div>
      <h4><a id="2">2025 FOMC Meetings</a></h4>
      <div class="fomc-meeting__month col-xs-5"><strong>December</strong></div><div class="fomc-meeting__date col-xs-4">9-10*</div>`;
    expect(parseFomc(html).map((m) => `${m.date} ${m.label}`)).toEqual([
      "2025-12-10 FOMC rate decision (with economic projections)",
      "2026-01-28 FOMC rate decision",
      "2026-03-18 FOMC rate decision (with economic projections)",
      "2026-05-01 FOMC rate decision",
    ]);
  });
  it("keeps the ECB's monetary-policy decisions, not its other meetings", () => {
    const html = `<dt>28/10/2026</dt><dd>Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 1)</dd>
      <dt>29/10/2026</dt><dd>Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference</dd>
      <dt>25/11/2026</dt><dd>Governing Council of the ECB: non-monetary policy meeting</dd>`;
    expect(parseEcbCalendar(html).map((m) => m.date)).toEqual(["2026-10-29"]);
  });
});

describe("event study", () => {
  const closes = (pairs: Array<[string, number]>) => pairs.map(([date, close]) => ({ date, close }));
  // A Sunday run-off: priced on Monday's close.
  const index = closes([
    ["2022-10-27", 100],
    ["2022-10-28", 100],
    ["2022-10-31", 90],
    ["2022-11-01", 92],
    ["2022-11-02", 93],
    ["2022-11-03", 94],
    ["2022-11-04", 95],
  ]);
  const eurbrl = closes([
    ["2022-10-28", 5.0],
    ["2022-10-31", 5.5],
    ["2022-11-01", 5.4],
    ["2022-11-02", 5.3],
    ["2022-11-03", 5.2],
    ["2022-11-04", 5.1],
  ]);
  it("measures the index and the currency from the close before to the first close after, in the base currency", () => {
    const r = eventReaction({ date: "2022-10-30", label: "run-off" }, index, eurbrl);
    expect(r.index1d).toBeCloseTo(-10, 9);
    // EURBRL 5.0 → 5.5: the real lost 1/11 against the euro
    expect(r.fx1d).toBeCloseTo((5 / 5.5 - 1) * 100, 9);
    expect(r.base1d).toBeCloseTo((0.9 * (5 / 5.5) - 1) * 100, 9);
    expect(r.index5d).toBeCloseTo(-5, 9);
  });
  it("prices a rate decision on its own day, and has no FX leg in the base currency", () => {
    const r = eventReaction({ date: "2022-10-31", label: "decision" }, index, undefined, { sameDay: true });
    expect(r.index1d).toBeCloseTo(-10, 9);
    expect(r.base1d).toBeCloseTo(-10, 9);
  });
  it("summarises the reactions", () => {
    expect(reactionStats([2, -4, undefined, 1])).toEqual({ n: 3, median: 1, mean: -1 / 3, worst: -4, best: 2, meanAbs: 7 / 3 });
    expect(reactionStats([])).toEqual({ n: 0 });
  });
});

describe("exposure", () => {
  it("attributes a holding to a country by ISIN, listing or single-country fund — never a world fund", () => {
    expect(holdingCountry({ symbol: "PETR4.SA" }).iso).toBe("BR");
    expect(holdingCountry({ symbol: "MC.PA", isin: "FR0000121014" })).toEqual({ iso: "FR", how: "isin" });
    expect(holdingCountry({ symbol: "NVDA" }).iso).toBe("US");
    expect(holdingCountry({ symbol: "EWZ", assetClass: "etf", name: "iShares MSCI Brazil ETF" }).iso).toBe("BR");
    expect(holdingCountry({ symbol: "CW8.PA", assetClass: "etf", name: "Amundi MSCI World Swap UCITS ETF" }).multi).toBe(true);
    expect(holdingCountry({ symbol: "BTCUSDT", market: "crypto" }).iso).toBeUndefined();
  });
  it("ties an event to the country and to its currency, the ECB to the euro area", () => {
    const x = (iso: string, w: number): Exposure => ({ iso, weightPct: w, symbols: ["S"], key: `k.${iso}` });
    const byCountry = new Map([
      ["BR", x("BR", 30)],
      ["FR", x("FR", 10)],
      ["DE", x("DE", 5)],
    ]);
    const byCurrency = new Map([["BRL", x("BRL", 30)]]);
    const ev = (iso: string): MarketEvent => ({ id: iso, date: "2026-10-25", type: "election", kind: "presidential", iso, title: "t", source: "s", url: "u" });
    expect(eventExposure(ev("BR"), byCountry, byCurrency).map((e) => e.iso)).toEqual(["BR", "BRL"]);
    expect(eventExposure({ ...ev("EU"), type: "central-bank", kind: "rate-decision" }, byCountry, byCurrency).map((e) => e.iso)).toEqual(["DE", "FR"]);
    expect(eventExposure(ev("JP"), byCountry, byCurrency)).toEqual([]);
  });
});
