// `check` false failures: each answer below states only what its cited evidence
// holds, and `check` must accept it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAnswer, NOTE_KINDS } from "../src/check.js";
import { EvidenceStore } from "../src/core/evidence.js";

const READ_AT = "2026-11-10T10:00:00.000Z";
type Item = { key: string; label: string; value: number | string; unit?: string; asOf?: string };

function run(items: Item[]): string {
  const dir = mkdtempSync(join(tmpdir(), "review-check-ff-"));
  EvidenceStore.update(dir, (s) => {
    for (const i of items) s.add({ ...i, source: "test", fetchedAt: READ_AT, official: true });
  });
  return dir;
}

/** The problems that fail the check (notes left out). */
function failing(dir: string, answer: string, opts: { maxAgeMs?: number; now?: Date } = {}): string[] {
  const r = checkAnswer(dir, answer, { now: new Date("2026-11-11T10:00:00Z"), ...opts });
  if ("error" in r) throw new Error(r.error);
  return r.problems.filter((p) => !NOTE_KINDS.has(p.kind)).map((p) => `${p.kind}: ${p.message}`);
}

// E1 = 450 EUR, E2 = 12.5 %, E3 = 45000 employees, E4 = 999 000 000 EUR, E5 = "2026-11-17", E6 = "2026-11-21",
// E7 = 0.25 %, E8 = 1999 CHF.
const base = () =>
  run([
    { key: "x.close", label: "X close", value: 450, unit: "EUR", asOf: "2026-11-10" },
    { key: "x.chg", label: "X change", value: 12.5, unit: "%" },
    { key: "x.emp", label: "X employees", value: 45000 },
    { key: "x.rev", label: "X revenue", value: 999_000_000, unit: "EUR" },
    { key: "x.window.from", label: "X earnings window, first day", value: "2026-11-17" },
    { key: "x.window.to", label: "X earnings window, last day", value: "2026-11-21" },
    { key: "ecb.cut", label: "ECB deposit rate cut", value: 0.25, unit: "%" },
    { key: "x.close.chf", label: "X close in CHF", value: 1999, unit: "CHF" },
    // E9: a headline, as `news --out` registers one.
    { key: "news.1", label: "Reuters headline", value: "LVMH sales rise 12% in third quarter" },
  ]);

const CASES: Array<[id: string, answer: string]> = [
  // FF1 — src/check.ts:237, 251 and src/core/dates.ts:43: a day/month without its year is read as two figures.
  ["FF1 17/11", "Résultats le 17/11 [E5]."],
  // FF2 — src/core/dates.ts:44, 48: the first day of a range of days is read as a figure.
  ["FF2 17–21 November 2026", "Results are due in the week of 17–21 November 2026 [E5] [E6]."],
  ["FF2 November 17-21, 2026", "The earnings window runs November 17-21, 2026 [E5] [E6]."],
  // FF3 — src/check.ts:115: the index's own name, "STOXX Europe 600", is not in the list of index names.
  ["FF3 STOXX Europe 600", "The STOXX Europe 600 rose 12.5 % [E2]."],
  // FF4 — src/check.ts:71-76, 257: the same unknown scale words as FP3, the other way round.
  ["FF4 45 thousand", "X employs 45 thousand people [E3]."],
  ["FF4 999 mln EUR", "X revenue was 999 mln EUR [E4]."],
  ["FF4 999 MEUR", "X revenue was 999 MEUR [E4]."],
  // FF5 — src/check.ts:257, 273: "bp" is not "bps".
  ["FF5 25 bp", "The ECB cut its deposit rate by 25 bp [E7]."],
  // FF6 — src/check.ts:257: the typographic apostrophe of a Swiss amount (what Intl prints for de-CH).
  ["FF6 1’999 CHF", "X closed at 1’999 CHF [E8]."],
  // FF7 — src/check.ts:276: the second half of a fiscal year is read as a figure.
  ["FF7 FY2025/26", "In FY2025/26 X closed at 450 € [E1]."],
  // FF9 — src/check.ts:315: a figure a cited text item (a headline) states is "in none of" it, while its dates are read (535).
  ["FF9 a headline's own figure", "Reuters reports that LVMH sales rose 12 % in the third quarter [E9]."],
];

describe("check: an answer that states only what its evidence holds is accepted", () => {
  it.each(CASES)("%s", (_id, answer) => {
    expect(failing(base(), answer)).toEqual([]);
  });
});

describe("check: what the stricter readers leave alone", () => {
  it.each([
    ["a closed section number in a heading that cites", "## 2. Valuation [E1]\n\nThe close is 450 € [E1]."],
    ["an identifier: letters glued between digits", "Under a Rule 10b5-1 plan, X closed at 450 € [E1]."],
    ["a fiscal year written short", "In FY25/26 X closed at 450 € [E1]."],
    ["an amount in thousands of euros", "X revenue was 999,000 kEUR [E4]."],
  ])("%s", (_id, answer) => {
    expect(failing(base(), answer)).toEqual([]);
  });

  it("holds a unit it does not know to an item stored in that unit: pence in GBp", () => {
    const dir = run([{ key: "x.close", label: "X close", value: 777, unit: "GBp" }]);
    expect(failing(dir, "The shares trade at 777p [E1].")).toEqual([]);
    expect(failing(dir, "The shares trade at 777GB [E1].").map((p) => p.split(":")[0])).toEqual(["unsupported"]);
  });
});
