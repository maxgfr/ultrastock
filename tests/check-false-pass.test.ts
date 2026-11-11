// `check` false passes: each answer below states a figure (or a date) that the
// evidence it cites does not hold, and `check` must refuse it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAnswer, NOTE_KINDS } from "../src/check.js";
import { EvidenceStore } from "../src/core/evidence.js";

const READ_AT = "2026-11-10T10:00:00.000Z";
type Item = { key: string; label: string; value: number | string; unit?: string; asOf?: string };

/** A run holding `items` as E1…En, and `doc` (when given) as the document E(n+1). */
function run(items: Item[], doc?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "review-check-"));
  EvidenceStore.update(dir, (s) => {
    for (const i of items) s.add({ ...i, source: "test", fetchedAt: READ_AT, official: true });
    if (doc !== undefined) {
      const id = `E${items.length + 1}`;
      mkdirSync(join(dir, "sources"), { recursive: true });
      writeFileSync(join(dir, "sources", `${id}.md`), doc);
      s.add({
        key: "doc.x",
        label: "page",
        value: "page",
        source: "web",
        fetchedAt: READ_AT,
        official: false,
        doc: { path: `sources/${id}.md`, chars: doc.length, hash: "x" },
      });
    }
  });
  return dir;
}

/** The kinds of the problems that fail the check (notes left out). */
function failing(dir: string, answer: string): string[] {
  const r = checkAnswer(dir, answer, { now: new Date("2026-11-11T10:00:00Z") });
  if ("error" in r) throw new Error(r.error);
  return r.problems.filter((p) => !NOTE_KINDS.has(p.kind)).map((p) => p.kind);
}

// E1 = 450 EUR, E2 = 12.5 %, E3 = 999 (a count), E4 = 104150.37 USD, E5 = "2026-11-17".
const base = () =>
  run([
    { key: "x.close", label: "X close", value: 450, unit: "EUR", asOf: "2026-11-10" },
    { key: "x.chg", label: "X change", value: 12.5, unit: "%" },
    { key: "x.n", label: "X stores", value: 999 },
    { key: "btc.close", label: "BTC close", value: 104150.37, unit: "USD" },
    { key: "x.next", label: "X next earnings", value: "2026-11-17" },
  ]);
// E1 = 450 EUR, E2 = a page that states "0.45 EUR" and "15 stores".
const withPage = () =>
  run([{ key: "x.close", label: "X close", value: 450, unit: "EUR" }], "The board proposes a dividend of 0.45 EUR per share.\nThe group runs 15 stores.\n");

const CASES: Array<[id: string, run: () => string, answer: string]> = [
  // FP1 — src/check.ts:270: a unit the reader does not know, glued to the number, makes the number vanish.
  ["FP1 75bp", base, "The ECB cut rates by 75bp [E2]."],
  ["FP1 3.5pp", base, "The margin rose 3.5pp [E2]."],
  ["FP1 777p", base, "The shares trade at 777p [E1]."],
  ["FP1 $777MM", base, "A buyback of $777MM [E1]."],
  ["FP1 $7.77bln", base, "A buyback of $7.77bln [E1]."],
  // FP2 — src/check.ts:257: the lookbehind drops a number written right after its currency code.
  ["FP2 EUR777bn", base, "Revenue reached EUR777bn [E1]."],
  ["FP2 USD777", base, "The target is USD777 [E1]."],
  // FP3 — src/check.ts:71-76, 257: an unknown scale word is dropped, so 999 thousand / mln / MEUR pass against 999.
  ["FP3 999 thousand", base, "X sold 999 thousand units [E3]."],
  ["FP3 999 mln", base, "X revenue was 999 mln EUR [E3]."],
  ["FP3 999 MEUR", base, "X revenue was 999 MEUR [E3]."],
  // FP4 — src/check.ts:236-237: slash and dash triples are blanked as dates without asking whether they are one.
  ["FP4 85/90/95", base, "Support levels sit at 85/90/95 [E1]."],
  ["FP4 2026-11-31", base, "X reports on 2026-11-31 [E5]."],
  ["FP4 31/11/2026", base, "X reports on 31/11/2026 [E5]."],
  // FP5 — src/check.ts:414: PERIOD_LABEL takes "Q3 45" / "H1 77" as a period, whatever follows the two digits.
  ["FP5 heading", base, "## Q3 45 % gross margin [E1]\n\nThe close is 450 € [E1]."],
  ["FP5 header cell", base, "| Metric | H1 77 % | [E1] |\n|---|---|---|\n| X | 450 € | [E1] |\n"],
  // FP6 — src/check.ts:322: within 0.1 % of the value passes, whatever precision the figure is written at.
  ["FP6 450.45 for 450", base, "X closed at 450.45 € [E1]."],
  ["FP6 104,250.00 for 104150.37", base, "BTC closed at 104,250.00 USD [E4]."],
  // FP7 — src/check.ts:334: every non-percent figure of a document is unitless, hence a fraction a percentage may state.
  ["FP7 0.45 EUR as 45 %", withPage, "The operating margin reached 45 % [E2]."],
  ["FP7 15 stores as 1500 %", withPage, "Sales grew 1500 % [E2]."],
  // FP8 — src/check.ts:257: U+2019 is not a thousands separator, so 1’999 is read as 999.
  ["FP8 1’999", base, "X closed at 1’999 CHF [E3]."],
  // FP9 — src/check.ts:259, 269: "d" + apostrophe reads as the span unit "d" (days).
  ["FP9 777 d'ici", base, "Le titre pourrait atteindre 777 d'ici la fin de l'année [E1]."],
  // FP10 — src/check.ts:436-438: two whole-number cells make a header row "labels", even when the row cites evidence.
  ["FP10 header row citing", base, "| X close | 777 | 888 | [E1] |\n|---|---|---|---|\n| X | 450 € | 12.5 % | [E1] [E2] |\n"],
  // FP11 — src/check.ts:451-452: a figure opening a heading before a capitalised scale word is dropped as a section number.
  ["FP11 ## 4.2 Billion", base, "## 4.2 Billion Buyback Announced [E1]\n\nThe close is 450 € [E1]."],
  ["FP11 ## 77.5 Percent", base, "## 77.5 Percent Dividend Hike [E1]\n\nThe close is 450 € [E1]."],
];

describe("check: a figure the cited evidence does not hold is refused", () => {
  it.each(CASES)("%s", (_id, make, answer) => {
    expect(failing(make(), answer)).toContain("unsupported");
  });
});
