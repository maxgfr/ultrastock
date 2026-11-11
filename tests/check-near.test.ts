import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Count how often `check` tokenises text: a cited document must be tokenised once per check, not once per figure.
const tokenized = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/engine.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/engine.js")>();
  return {
    ...real,
    bm25Tokenize: (...args: Parameters<typeof real.bm25Tokenize>) => {
      tokenized.calls++;
      return real.bm25Tokenize(...args);
    },
  };
});

const { checkAnswer, NOTE_KINDS } = await import("../src/check.js");
const { EvidenceStore } = await import("../src/core/evidence.js");

describe("check against a long cited document", () => {
  it("tokenises the document once, however many of its figures the answer states", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-near-"));
    const lines = Array.from({ length: 2000 }, (_, i) => `Line ${i}: segment ${i} revenue of ${1000 + i} million euros, filler words here.`);
    const text = `${lines.join("\n")}\n`;
    mkdirSync(join(dir, "sources"), { recursive: true });
    writeFileSync(join(dir, "sources", "E1.md"), text);
    const s = EvidenceStore.open(dir);
    s.add({
      key: "doc.x",
      label: "annual report",
      value: "annual report",
      source: "web",
      fetchedAt: "2026-10-23T18:00:00Z",
      official: true,
      doc: { path: "sources/E1.md", chars: text.length, hash: "x" },
    });
    s.save();
    const answer = Array.from({ length: 30 }, (_, i) => `Segment ${i} revenue was ${1000 + i} million [E1].`).join("\n\n");
    tokenized.calls = 0;
    const started = performance.now();
    const r = checkAnswer(dir, answer);
    const ms = performance.now() - started;
    expect("error" in r ? r.error : r.problems.filter((p) => !NOTE_KINDS.has(p.kind))).toEqual([]);
    // One pass over the 2000 lines, plus a few calls per claim for its own words.
    expect(tokenized.calls).toBeLessThan(lines.length + 30 * 5);
    expect(ms).toBeLessThan(5000);
  });
});
