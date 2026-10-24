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
  it("ignores dates, times, years, parameters, identifiers and citation tokens", () => {
    expect(values("au 23/10/2026, le 2026-10-23 à 17:35, le 23 oct. 2026, on Oct 23, 2026")).toEqual([]);
    expect(values("RSI(14), MACD(12,26,9), SMA 200, MM50, EMA20 and the CAC 40 or S&P 500")).toEqual([]);
    expect(values("over 52 weeks, 3 mois, a 5-day window, J+5, Q3, FY2025, the 2e quartile")).toEqual([]);
    expect(values("in 2028 [E5] with 3 positions")).toEqual([]);
    expect(values("see [E12] and `price = 99.5`")).toEqual([]);
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
  it("refuses a directory with no evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-empty-"));
    writeFileSync(join(dir, "x.md"), "");
    expect(checkAnswer(dir, "x")).toHaveProperty("error");
  });
});
