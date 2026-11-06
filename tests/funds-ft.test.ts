import { afterEach, describe, expect, it } from "vitest";
import { setNetMode } from "../src/core/net.js";
import { decodeEntities } from "../src/engine.js";
import { ftFundProfile, parseFtHistory, parseFtTearsheet, percentOf } from "../src/providers/funds/ft.js";
import { getHistory, getQuote, resolveSymbol } from "../src/providers/router.js";
import { withFixture } from "./helpers/fixtures.js";

afterEach(() => setNetMode({ kind: "live" }));

const byKey = (ds: { points: Array<{ key: string; value: unknown }> }, key: string) => ds.points.find((p) => p.key === key)?.value;

describe("FT fund pages — parsing", () => {
  it("reads the tearsheet's label/value table and the charges", () => {
    const html = [
      "<table><tr><th>Fund type</th><td>SICAV</td></tr>",
      '<tr><th class="x">Morningstar category</th><td><span>Europe Flex-Cap</span> Equity</td></tr>',
      "<tr><th>Ongoing charge</th><td>1.83%</td></tr>",
      "<tr><th>Exit charge</th><td>0.00%</td></tr>",
      "<tr><th>IMA sector</th><td>--</td></tr></table>",
    ].join("");
    const rows = parseFtTearsheet(html);
    expect(rows.get("Fund type")).toBe("SICAV");
    expect(rows.get("Morningstar category")).toBe("Europe Flex-Cap Equity");
    expect(percentOf(rows.get("Ongoing charge"))).toBe(1.83);
    expect(percentOf(rows.get("Exit charge"))).toBe(0);
    expect(percentOf(rows.get("IMA sector"))).toBeUndefined();
    expect(decodeEntities("M&amp;G Tr&#233;sorerie")).toBe("M&G Trésorerie");
  });

  it("reads the historical NAVs, every month included, oldest first", () => {
    const row = (long: string, short: string, nav: string) =>
      `<tr><td class="mod-ui-table__cell--text"><span class="mod-ui-hide-small-below">${long}</span><span class="mod-ui-hide-medium-above">${short}</span></td><td>${nav}</td><td>${nav}</td><td>${nav}</td><td>${nav}</td><td><span>0</span></td></tr>`;
    const html = [
      row("Thursday, November 05, 2026", "Thu, Nov 05, 2026", "128.53"),
      row("Wednesday, November 04, 2026", "Wed, Nov 04, 2026", "127.66"),
      row("Friday, May 29, 2026", "Fri, May 29, 2026", "1,120.50"),
    ].join("");
    const bars = parseFtHistory(html);
    expect(bars.map((b) => b.date)).toEqual(["2026-05-29", "2026-11-04", "2026-11-05"]);
    expect(bars[0]!.close).toBe(1120.5);
    expect(bars[2]).toMatchObject({ open: 128.53, high: 128.53, low: 128.53, close: 128.53 });
  });
});

describe("FT fund pages — replay", () => {
  it("routes an ISIN Euronext does not list to the fund's NAV, with its charges", async () => {
    await withFixture("funds-ft-sisf", async () => {
      const r = await resolveSymbol("LU0161305163");
      expect(r.instrument).toMatchObject({ market: "fund", kind: "fund", isin: "LU0161305163", currency: "EUR" });
      expect(r.notes.join(" ")).toMatch(/no Euronext listing/);
      const series = await getHistory(r, { from: new Date("2025-11-01T00:00:00Z"), to: new Date("2026-11-06T00:00:00Z") });
      expect(series.bars.length).toBeGreaterThan(200);
      expect(series.provenance).toMatchObject({ source: "ft", official: false });
      const quote = await getQuote(r, new Date("2026-11-06T18:00:00Z"));
      expect(quote.price).toBe(series.bars.at(-1)!.close);
      const profile = await ftFundProfile("LU0161305163", { wrapperFeePct: 0.96 });
      const ongoing = byKey(profile, "LU0161305163.fund.ongoingCharge") as number;
      expect(ongoing).toBeGreaterThan(0);
      expect(byKey(profile, "LU0161305163.fund.totalYearlyCost")).toBeCloseTo(ongoing + 0.96, 6);
      expect(profile.points.find((p) => p.key === "LU0161305163.fund.category")?.untrusted).toBe(true);
    });
  }, 60_000);
});
