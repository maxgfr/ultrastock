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
