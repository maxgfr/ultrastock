import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAnswer, extractFigures, figureMatches, NOTE_KINDS, normalizeEvidenceCitations } from "../src/check.js";
import { EvidenceStore } from "../src/core/evidence.js";

const values = (t: string) => extractFigures(t).map((f) => f.value);

describe("extractFigures", () => {
  it("reads French and English number formats, signs, units and scales", () => {
    expect(values("Dernier cours : 383,00 €")).toEqual([383]);
    expect(values("en baisse de −1,24 %")).toEqual([-1.24]);
    expect(values("a 1,234.5 USD print and 39,539,690 shares")).toEqual([1234.5, 39539690]);
    expect(values("1 234,5 € et 1.234.567 titres")).toEqual([1234.5, 1234567]);
    expect(values("market cap of $1.6 trillion, revenue 188,6 Md€")).toEqual([1.6e12, 188.6e9]);
    expect(values("a 31.4x multiple, +12 bps")).toEqual([31.4, 0.12]);
    expect(extractFigures("up 12.34%")[0]).toMatchObject({ percent: true, decimals: 2 });
  });
  it("reads a decimal with more than three digits whole, not as a thousands group", () => {
    expect(values("HHI 0.775886, correlation 0.1349")).toEqual([0.775886, 0.1349]);
    expect(values("le real a perdu 5,8741 %, à 15,1923 % du plus haut")).toEqual([5.8741, 15.1923]);
    expect(values("1 234,5678 € et 1,234.5678 USD")).toEqual([1234.5678, 1234.5678]);
  });
  it("ignores dates, times, years, parameters, identifiers and citation tokens", () => {
    expect(values("au 23/10/2026, le 2026-10-23 à 17:35, le 23 oct. 2026, on Oct 23, 2026")).toEqual([]);
    expect(values("RSI(14), MACD(12,26,9), SMA 200, MM50, EMA20 and the CAC 40 or S&P 500")).toEqual([]);
    expect(values("over 52 weeks, 3 mois, a 5-day window, J+5, Q3, FY2025, the 2e quartile")).toEqual([]);
    expect(values("in 2028 [E5] with 3 positions")).toEqual([]);
    expect(values("see [E12] and `price = 99.5`")).toEqual([]);
  });
  it("reads a chart timeframe before an indicator as a label, not a scale", () => {
    expect(values("the 15m RSI, the 1m MACD, the 5m EMA20, the 4h ATR, the 1h VWAP and the 1d SMA 200")).toEqual([]);
    expect(values("15m RSI at 72.5")).toEqual([72.5]);
    expect(values("revenue of 15m EUR")).toEqual([15e6]);
  });
  it("reads a week number and an allocation split as labels", () => {
    expect(values("Week 46 review, semaine 46, wk 12")).toEqual([]);
    expect(values("a 60/40 portfolio, a 70/20/10 split, 50/50")).toEqual([]);
    expect(values("383/400 of the target, 12 weeks")).toEqual([383, 400]);
  });
});

describe("figureMatches", () => {
  const item = (value: number, unit?: string) => ({
    id: "E1",
    key: "k",
    label: "l",
    value,
    unit,
    source: "t",
    fetchedAt: new Date().toISOString(),
    official: true,
  });
  const f = (t: string) => extractFigures(t)[0]!;
  it("accepts the evidence value at the written precision", () => {
    expect(figureMatches(f("383,00 €"), [item(383)])).toBe(true);
    expect(figureMatches(f("12.3%"), [item(12.3456, "%")])).toBe(true);
    expect(figureMatches(f("12.4%"), [item(12.3456, "%")])).toBe(false);
    expect(figureMatches(f("41,5 %"), [item(-41.4999, "%")])).toBe(true);
    expect(figureMatches(f("188.6 bn"), [item(188_576_644_501)])).toBe(true);
    expect(figureMatches(f("189 bn"), [item(188_576_644_501)])).toBe(true);
    expect(figureMatches(f("190 bn"), [item(188_576_644_501)])).toBe(false);
  });
  it("converts between a fraction and a percentage", () => {
    expect(figureMatches(f("27.3%"), [item(0.2733, "ratio")])).toBe(true);
    expect(figureMatches(f("0.27"), [item(27.33, "%")])).toBe(true);
    expect(figureMatches(f("27.3%"), [item(0.2733)])).toBe(true);
    expect(figureMatches(f("145 %"), [item(1.45, "x")])).toBe(true);
  });
  it("reads a percentage as a fraction only for a unitless or ratio item, not a price or a count", () => {
    expect(figureMatches(f("45 %"), [item(0.45, "USD")])).toBe(false);
    expect(figureMatches(f("45 %"), [item(0.45, "price")])).toBe(false);
    expect(figureMatches(f("45 %"), [item(0.45, "index")])).toBe(false);
    expect(figureMatches(f("45 %"), [item(0.45, "count")])).toBe(false);
    expect(figureMatches(f("45 %"), [item(45, "index")])).toBe(true);
  });
});

describe("normalizeEvidenceCitations", () => {
  it("splits grouped ids and drops link targets", () => {
    expect(normalizeEvidenceCitations("x [E3, E5] y [E7; E8] z [E1](http://a)")).toBe("x [E3] [E5] y [E7] [E8] z [E1]");
  });
});

describe("checkAnswer", () => {
  const run = () => {
    const dir = mkdtempSync(join(tmpdir(), "us-check-"));
    const s = EvidenceStore.open(dir, { subject: "TEST" });
    s.add({
      key: "t.close",
      label: "close",
      value: 383,
      unit: "EUR",
      source: "euronext",
      fetchedAt: "2026-10-23T18:00:00Z",
      official: true,
      asOf: "2026-10-23",
    });
    s.add({ key: "t.ret", label: "1y", value: -37.683, unit: "%", source: "euronext", fetchedAt: "2026-10-23T18:00:00Z", official: true });
    s.save();
    return dir;
  };
  const failing = (r: ReturnType<typeof checkAnswer>) => ("error" in r ? [] : r.problems.filter((p) => !NOTE_KINDS.has(p.kind)).map((p) => p.kind));

  it("passes an answer whose every figure is cited and found", () => {
    const r = checkAnswer(run(), "# T\n\nLe titre cote 383,00 € [E1] après −37,7 % sur un an [E2].\n");
    expect(failing(r)).toEqual([]);
  });
  it("refuses a minus sign written on a figure the evidence holds as positive, and nothing else about signs", () => {
    // E1 is +383 EUR, E2 is −37.683 %.
    const kinds = (answer: string) => failing(checkAnswer(run(), answer));
    expect(kinds("Le titre a pris -383,00 € [E1].\n")).toEqual(["unsupported"]);
    expect(kinds("Le titre a pris −383,00 € [E1].\n")).toEqual(["unsupported"]);
    // The direction said in words, an unsigned magnitude, and a plus sign are all left alone.
    expect(kinds("Le titre recule de 37,7 % sur un an [E2].\n")).toEqual([]);
    expect(kinds("Down 37.7 % over a year [E2], at 383.00 € [E1].\n")).toEqual([]);
    expect(kinds("Variation sur un an : −37,7 % [E2].\n")).toEqual([]);
    // A dash set apart by a space is punctuation, not a sign.
    expect(kinds("Cours de clôture - 383,00 € [E1].\n")).toEqual([]);
    expect(kinds("Cours de clôture – 383,00 € [E1].\n")).toEqual([]);
  });
  it("checks a figure after a word that merely starts like a month (margin, decline, marge)", () => {
    // E1 is 383 EUR: none of these figures is in it.
    const kinds = (answer: string) => failing(checkAnswer(run(), answer));
    expect(kinds("Operating margin 45 % [E1].\n")).toEqual(["unsupported"]);
    expect(kinds("Revenue declined 12 % [E1].\n")).toEqual(["unsupported"]);
    expect(kinds("Une marge 45 % [E1].\n")).toEqual(["unsupported"]);
    expect(kinds("Revenue decreased 4.5 % [E1].\n")).toEqual(["unsupported"]);
    // Real dates are still not figures.
    expect(kinds("Close 383 € [E1] on Oct 23, 2026.\n")).toEqual([]);
    expect(kinds("Clôture à 383 € [E1] le 23 octobre 2026.\n")).toEqual([]);
    expect(kinds("Close 383 € [E1] on 23 Oct.\n")).toEqual([]);
  });
  it("checks figures and dates written as a link's text or in brackets", () => {
    // E1 is 383 EUR as of 2026-10-23: neither 45 % nor 1 December is in it.
    const kinds = (answer: string) => failing(checkAnswer(run(), answer));
    expect(kinds("LVMH [rose 45 %](https://example.com/a) this year, closing at 383 € [E1].\n")).toEqual(["unsupported"]);
    expect(kinds("LVMH ![up 45 %](chart.png) closing at 383 € [E1].\n")).toEqual(["unsupported"]);
    expect(kinds("LVMH [up 45 %] closing at 383 € [E1].\n")).toEqual(["unsupported"]);
    expect(kinds("Closing at 383 € [E1], results on [2026-12-01](https://example.com/cal).\n")).toEqual(["unsupported"]);
    // Citations, cited links and footnote markers are still not figures.
    expect(kinds("Closing at [383 €](https://example.com/q) [E1](https://example.com/e) [12] [^3].\n")).toEqual([]);
  });
  it("checks a figure written in a heading or in a table's header row", () => {
    // E1 is 383 EUR: neither 450 € nor 45 % nor 2.3 bn is in it.
    const kinds = (answer: string) => failing(checkAnswer(run(), answer));
    expect(kinds("## Buy, target 450 €\n\nClose 383 € [E1].\n")).toEqual(["uncited"]);
    expect(kinds("## Buy, target 450 € [E1]\n\nClose 383 € [E1].\n")).toEqual(["unsupported"]);
    expect(kinds("| LVMH up 45 % | x |\n|---|---|\n| close | 383 € [E1] |\n")).toEqual(["uncited"]);
    expect(kinds("### 2.3 bn of revenue\n\nClose 383 € [E1].\n")).toEqual(["uncited"]);
    // A heading or a header row citing the evidence that holds its figure passes, and its [E#] grounds it.
    const r = checkAnswer(run(), "## Close 383 € [E1]\n\nThe rest of the answer.\n");
    expect(failing(r)).toEqual([]);
    if (!("error" in r)) expect(r.problems.map((p) => p.kind)).not.toContain("inert");
    expect(kinds("| Close 383 € [E1] | 1y |\n|---|---|\n| a | b |\n")).toEqual([]);
    // Labels are not figures: section numbers, periods, index names, indicator settings, ordinals, a dated title.
    const headings =
      "# LVMH — Q3 2026 results, FY2025\n\n## 1. Thesis\n\n### 2.3 Risks\n\n#### 2.3.1 Detail\n\n## 10) CAC 40, S&P 500, RSI(14), SMA 200\n\n## The 2nd quarter, the week of 2099-12-07\n";
    expect(kinds(`${headings}\nClose 383 € [E1].\n`)).toEqual([]);
    expect(kinds("## Week 46 — a 60/40 book\n\nClose 383 € [E1].\n")).toEqual([]);
    // Nor are horizons and years heading the columns.
    expect(
      kinds("| Horizon | +5 | +20 | +60 | 5 d | 20 sessions | J+20 | 2026 |\n|---|---|---|---|---|---|---|---|\n| close | 383 € [E1] | | | | | | |\n"),
    ).toEqual([]);
  });
  it("fails uncited, dangling and unsupported figures, each on its line", () => {
    const r = checkAnswer(run(), "A 383 € close [E1].\n\nTarget 450 € soon.\n\nPE of 22.5 [E9].\n\nUp 12% [E2].\n");
    expect(failing(r)).toEqual(["uncited", "dangling", "unsupported", "unsupported"]);
    if (!("error" in r)) expect(r.problems.find((p) => p.kind === "uncited")!.line).toBe(3);
  });
  it("fails an answer that states nothing, and notes long unsourced claims without failing", () => {
    expect(failing(checkAnswer(run(), "# Title\n\n```\n383 [E1]\n```\n"))).toEqual(["empty"]);
    const r = checkAnswer(run(), "Close 383 € [E1].\n\nThis is a long sentence with no figure and no citation at all in it here.\n");
    expect(failing(r)).toEqual([]);
    if (!("error" in r)) expect(r.problems.map((p) => p.kind)).toContain("unsourced");
  });
  it("sets aside a closing sources list, and reports ids that only appear there", () => {
    const r = checkAnswer(run(), "Close 383 € [E1].\n\n## Sources\n\n- [E2] euronext\n");
    expect(failing(r)).toEqual([]);
    if (!("error" in r)) expect(r.problems.map((p) => p.kind)).toContain("inert");
  });
  it("fails figures read longer ago than --max-age", () => {
    const r = checkAnswer(run(), "Close 383 € [E1].\n", { maxAgeMs: 3600_000, now: new Date("2026-10-25T00:00:00Z") });
    expect(failing(r)).toEqual(["stale"]);
  });
  it("holds a date to an item's value, label and as-of day, not to the day it was read", () => {
    // E1 is a close as of 2026-10-22, read on 2026-10-23.
    const dir = mkdtempSync(join(tmpdir(), "us-check-"));
    const s = EvidenceStore.open(dir);
    s.add({
      key: "t.close",
      label: "close",
      value: 383,
      unit: "EUR",
      source: "euronext",
      fetchedAt: "2026-10-23T18:00:00Z",
      official: true,
      asOf: "2026-10-22",
    });
    s.save();
    expect(failing(checkAnswer(dir, "Close 383 € [E1] on 2026-10-22.\n"))).toEqual([]);
    expect(failing(checkAnswer(dir, "Close 383 € [E1] on 2026-10-23.\n"))).toEqual(["unsupported"]);
  });
  it("refuses a directory with no evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-empty-"));
    writeFileSync(join(dir, "x.md"), "");
    expect(checkAnswer(dir, "x")).toHaveProperty("error");
  });
});
