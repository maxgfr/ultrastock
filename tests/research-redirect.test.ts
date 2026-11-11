import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type ResearchSubject, researchAngles } from "../src/research/angles.js";
import type { ResearchTodo } from "../src/research/dossier.js";
import type { Candidate, ReadPage } from "../src/research/ingest.js";
import { researchRound } from "../src/research/run.js";
import { EvidenceStore } from "../src/core/evidence.js";

// Every page read is a redirect: the search hit names https://lvmh.com/…, the page lives at https://www.lvmh.com/en/….
const reads = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock("../src/research/ingest.js", async (importActual) => {
  const real = await importActual<typeof import("../src/research/ingest.js")>();
  return {
    ...real,
    readCandidates: async (cands: readonly Candidate[]) => {
      reads.asked.push(...cands.map((c) => c.url));
      const pages: ReadPage[] = cands.map((c) => ({
        ...c,
        finalUrl: c.url.replace("https://lvmh.com/", "https://www.lvmh.com/en/"),
        title: "LVMH results",
        text: `LVMH revenue rose 4 % to 20.1 bn in the first half (${c.url}).`,
        fetchedAt: "2026-11-03T00:00:00.000Z",
        pdf: false,
      }));
      return { pages, dropped: [] };
    },
  };
});

// No symbol: the round does not ask crible for a cross-check.
const SUBJECT: ResearchSubject = { subject: "LVMH", name: "LVMH", kind: "equity", focus: "results", year: 2026 };
const todo: ResearchTodo = { schema: 1, ...SUBJECT, createdAt: "2026-11-03T00:00:00Z", round: 1, angles: researchAngles(SUBJECT), searched: [] };

describe("a research round after one that read through a redirect", () => {
  it("does not read the page again, asked by the URL before the redirect or after it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-redirect-"));
    EvidenceStore.open(dir, { subject: "LVMH" }).save();
    const hit = { url: "https://lvmh.com/results-h1", angle: "results-release" };
    await researchRound(dir, todo, [], { lists: [[hit]] });
    expect(reads.asked).toEqual(["https://lvmh.com/results-h1"]);
    const second = await researchRound(dir, { ...todo, round: 2 }, [], {
      lists: [[hit, { url: "https://www.lvmh.com/en/results-h1", angle: "results-release" }, { url: "https://lvmh.com/new", angle: "results-call" }]],
    });
    // Only the page never read is read; the one already registered stays one document.
    expect(reads.asked).toEqual(["https://lvmh.com/results-h1", "https://lvmh.com/new"]);
    expect(second.total).toBe(2);
  });
});
