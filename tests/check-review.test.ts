// Answers `check` used to misread: honest ones refused, made-up figures let through, and inputs that cost seconds.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAnswer, NOTE_KINDS } from "../src/check.js";
import { EvidenceStore } from "../src/core/evidence.js";

/** E1 = 383 EUR (close, as of 2026-10-23), E2 = −37.683 %, E3 = 21.5 x (forward P/E), E4 = 84.7 bn EUR (revenue). */
const run = () => {
  const dir = mkdtempSync(join(tmpdir(), "us-check-review-"));
  const s = EvidenceStore.open(dir, { subject: "TEST" });
  const base = { source: "euronext", fetchedAt: "2026-10-23T18:00:00Z", official: true };
  s.add({ ...base, key: "t.close", label: "close", value: 383, unit: "EUR", asOf: "2026-10-23" });
  s.add({ ...base, key: "t.ret", label: "1y", value: -37.683, unit: "%" });
  s.add({ ...base, key: "t.pe", label: "forward P/E", value: 21.5, unit: "x" });
  s.add({ ...base, key: "t.rev", label: "revenue", value: 84_700_000_000, unit: "EUR" });
  s.save();
  return dir;
};
const now = new Date("2026-11-11T10:00:00Z");
const kinds = (answer: string) => {
  const r = checkAnswer(run(), answer, { now });
  return "error" in r ? ["error"] : r.problems.filter((p) => !NOTE_KINDS.has(p.kind)).map((p) => p.kind);
};
const refused = (answer: string) => kinds(answer).length > 0;

describe("brackets", () => {
  it("reads a bare bracketed date or number: only citation tokens and footnote markers are taken out", () => {
    // E1 holds 2026-10-23 only.
    expect(refused("Close 383 € [E1], results on [2026-12-01].\n")).toBe(true);
    expect(refused("Close 383 € [E1], target [450].\n")).toBe(true);
    // A footnote marker, caret or glued to its word, is still no figure.
    expect(kinds("Close 383 € [E1], up from last year[12] [^3] [^note].\n")).toEqual([]);
  });
  it("reads 50 kB of '[' on one line in linear time", () => {
    const t0 = performance.now();
    checkAnswer(run(), `Close 383 € [E1] ${"[".repeat(50_000)}\n`, { now });
    expect(performance.now() - t0).toBeLessThan(1500);
  }, 60_000);
  it("still finds a citation behind an unclosed bracket", () => {
    expect(kinds("Close 383 € [see [E1].\n")).toEqual([]);
  });
});

describe("figures behind markup and other code points", () => {
  it("reads a figure in emphasis, in full-width digits, as entities, as a vulgar fraction, as 'pc' or in superscript", () => {
    expect(refused("Close 383 € [E1]. Target _450_ and up _45 %_.\n")).toBe(true);
    expect(refused("Close 383 € [E1]. Target __450__.\n")).toBe(true);
    expect(refused("Close 383 € [E1], up ４５ %.\n")).toBe(true);
    expect(refused("Close 383 € [E1], up &#x34;&#x35; %.\n")).toBe(true);
    expect(refused("Close 383 € [E1], up &#52;&#53;&nbsp;%.\n")).toBe(true);
    expect(refused("Close 383 € [E1], up 4**5** %.\n")).toBe(true);
    expect(refused("Close 383 € [E1], up 4½ %.\n")).toBe(true);
    expect(refused("Close 383 € [E1], up 45pc.\n")).toBe(true);
    expect(refused("Close 383 € [E1], up ⁴⁵ %.\n")).toBe(true);
  });
  it("matches the evidence once the markup is read", () => {
    expect(kinds("Close **383 €** [E1], down _37.7 %_ [E2].\n")).toEqual([]);
    expect(kinds("Close ３８３ € [E1], down 37.7pc [E2], P/E 21½ [E3].\n")).toEqual([]);
    expect(kinds("Revenue 84.7 bn² [E4].\n")).toEqual([]);
  });
});

describe("month words", () => {
  it("reads the figure next to 'may', 'March', 'mars', 'mai' used as words", () => {
    // E1 is 383 EUR: neither 85 nor 45 % is in it.
    expect(refused("A payout ratio of 85 may not be sustainable [E1].\n")).toBe(true);
    expect(refused("In May 45 % of revenue came from Asia, close 383 € [E1].\n")).toBe(true);
    expect(refused("En mars 45 % du chiffre d'affaires venait d'Asie, cours 383 € [E1].\n")).toBe(true);
    expect(refused("En mai 12 % du chiffre d'affaires venait d'Asie, cours 383 € [E1].\n")).toBe(true);
  });
  it("does not hold an honest figure before 'may' to the evidence as a date", () => {
    // E3 is 21.5: "21" is that value at the written precision.
    expect(kinds("A forward P/E of 21 may look rich [E3].\n")).toEqual([]);
  });
  it("still blanks and checks a real date", () => {
    expect(kinds("Close 383 € [E1] on 23 October 2026.\n")).toEqual([]);
    expect(kinds("Close 383 € [E1] on Oct 23, 2026.\n")).toEqual([]);
    expect(kinds("Close 383 € [E1] on 17.11.26.\n")).toEqual(["unsupported"]);
  });
});

describe("labels: filing forms, indicator settings, index names", () => {
  it("reads a filing form named in a link's text as a label", () => {
    expect(kinds("Revenue was 84.7 bn [E4] ([10-K](https://www.sec.gov/x)).\n")).toEqual([]);
    expect(kinds("Revenue was 84.7 bn [E4], per the 10-Q, the 20-F, the 40-F, an 8-K and a 6-K.\n")).toEqual([]);
  });
  it("reads an indicator or index VALUE after its name as a figure; only the settings form is a label", () => {
    expect(refused("RSI 85, overbought; close 383 € [E1].\n")).toBe(true);
    expect(refused("RSI 72.5 and ADX 45; close 383 € [E1].\n")).toBe(true);
    expect(refused("The Nasdaq 21000 level held; close 383 € [E1].\n")).toBe(true);
    expect(refused("The DAX 18000 level held; close 383 € [E1].\n")).toBe(true);
    expect(refused("Close 383 € [E1], under its SMA 412.\n")).toBe(true);
    // Settings and index names stay labels.
    expect(
      kinds(
        "Close 383 € [E1]: under the SMA 200 and the EMA 50, RSI(14) low, MACD(12,26,9) flat; CAC 40, S&P 500, Nasdaq 100, Euro Stoxx 50, Russell 2000, FTSE 100, Nikkei 225.\n",
      ),
    ).toEqual([]);
  });
});
