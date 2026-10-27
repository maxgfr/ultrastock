import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { followUpAngles, MIN_ANGLE_SOURCES, type ResearchSubject, researchAngles } from "../src/research/angles.js";
import {
  angleCoverage,
  issuerDomain,
  type RegisteredDoc,
  type ResearchTodo,
  readTodo,
  registrableDomain,
  researchFiles,
  researchTags,
  writeDossier,
  writeTodo,
} from "../src/research/dossier.js";
import { pendingQueries } from "../src/research/run.js";
import { researchCommand } from "../src/commands/research.js";
import { EvidenceStore } from "../src/core/evidence.js";

const LVMH: ResearchSubject = { subject: "MC.PA", symbol: "MC.PA", name: "LVMH", kind: "equity", focus: "results", year: 2026 };

const todoOf = (s: ResearchSubject, searched: string[]): ResearchTodo => ({
  schema: 1,
  ...s,
  createdAt: "2026-10-27T00:00:00Z",
  round: 1,
  angles: researchAngles(s),
  searched,
});

function doc(id: string, host: string, angles: string[]): RegisteredDoc {
  return {
    id,
    host,
    official: false,
    page: {
      url: `https://${host}/${id}`,
      finalUrl: `https://${host}/${id}`,
      text: "LVMH revenue",
      fetchedAt: "2026-10-27T00:00:00Z",
      pdf: false,
      angles,
      score: 1,
    },
  };
}

describe("the second round follows the angles, not the template words", () => {
  const todo = todoOf(LVMH, ["results-release", "results-call", "results-filing"]);
  const docs = [doc("E1", "www.lvmh.com", ["results-release"]), doc("E2", "reuters.com", ["results-release"]), doc("E3", "boursorama.com", ["results-call"])];

  it("calls an angle under-covered below two kept sources, and an unsearched one missing, not under-covered", () => {
    const { coverage, under } = angleCoverage(todo, docs, new Set(todo.searched));
    expect(MIN_ANGLE_SOURCES).toBe(2);
    expect(coverage).toEqual([
      { id: "results-release", title: "Results release", sources: 2 },
      { id: "results-filing", title: "The filing itself", sources: 0 },
      { id: "results-call", title: "Earnings call", sources: 1 },
    ]);
    expect(under.map((u) => [u.angle.id, u.sources])).toEqual([
      ["results-filing", 0],
      ["results-call", 1],
    ]);
  });

  it("rephrases the angle's own queries: pdf for a document, the issuer's site, the English query with the name quoted", () => {
    const { under } = angleCoverage(todo, docs, new Set(todo.searched));
    const asked = new Set(todo.angles.flatMap((a) => a.queries));
    const domain = issuerDomain(docs, "LVMH");
    expect(domain).toBe("lvmh.com");
    const next = followUpAngles(LVMH, under, { issuerDomain: domain, asked });
    expect(next.map((a) => a.id)).toEqual(["more-results-filing", "more-results-call"]);
    const call = next[1]!;
    expect(call.title).toBe("More on: Earnings call");
    expect(call.queries).toEqual([
      "LVMH conférence résultats 2026 transcription pdf",
      "LVMH 2026 earnings call transcript pdf",
      "2026 earnings call transcript site:lvmh.com",
    ]);
    expect(call.langs).toEqual(["fr-FR", "en-US", "en-US"]);
    // The filing's queries already ask for a PDF: the site and the quoted name are what is left.
    expect(next[0]!.queries).toEqual(["2026 annual report 10-K 10-Q filing pdf site:lvmh.com", '"LVMH" 2026 annual report 10-K 10-Q filing pdf']);
    // Never a bare template word.
    for (const a of next) for (const q of a.queries) expect(q).toMatch(/LVMH|lvmh\.com/);
    // Without an issuer page: no site: query.
    expect(
      followUpAngles(LVMH, under, { asked })
        .flatMap((a) => a.queries)
        .some((q) => q.includes("site:")),
    ).toBe(false);
  });

  it("counts an angle's second round toward it, and never follows a second round up", () => {
    const t2: ResearchTodo = { ...todo, angles: [...todo.angles, { id: "more-results-call", title: "More on: Earnings call", queries: ["x"] }] };
    const more = [...docs, doc("E4", "ft.com", ["more-results-call"])];
    const { coverage, under } = angleCoverage(t2, more, new Set([...todo.searched!, "more-results-call"]));
    expect(coverage.find((c) => c.id === "results-call")!.sources).toBe(2);
    expect(under.map((u) => u.angle.id)).toEqual(["results-filing"]);
    expect(followUpAngles(LVMH, [{ angle: t2.angles.at(-1)!, sources: 0 }])).toEqual([]);
  });

  it("searches a second round's queries in the language each one is in", () => {
    const t: ResearchTodo = {
      ...todo,
      searched: todo.angles.map((a) => a.id),
      angles: [...todo.angles, { id: "more-results-call", title: "M", queries: ["fr pdf", "en pdf", "site"], langs: ["fr-FR", "en-US", null] }],
    };
    expect(pendingQueries(t)).toEqual([
      { angle: "more-results-call", query: "fr pdf", lang: "fr-FR" },
      { angle: "more-results-call", query: "en pdf", lang: "en-US" },
      { angle: "more-results-call", query: "site" },
    ]);
  });

  it("reads registrable domains, two-level country suffixes included", () => {
    expect(registrableDomain("investors.lvmh.com")).toBe("lvmh.com");
    expect(registrableDomain("www.bhp.com.au")).toBe("bhp.com.au");
    expect(registrableDomain("ir.toyota.co.jp")).toBe("toyota.co.jp");
  });

  it("writes DOSSIER.md's coverage by angle, the term statistic only for information", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-rounds-"));
    const store = EvidenceStore.open(dir, { subject: "MC.PA" });
    store.save();
    const { coverage, under } = angleCoverage(todo, [], new Set(todo.searched));
    writeDossier(dir, todo, [], [], { notes: [], angles: coverage, under, terms: [{ term: "transcription", sources: 0 }] });
    const md = readFileSync(join(dir, "DOSSIER.md"), "utf8");
    expect(md).toMatch(/Sources kept per angle searched \(an angle needs at least 2/);
    expect(md).toMatch(/Under-covered angles: results-release \(0 sources\), results-filing \(0 sources\), results-call \(0 sources\)/);
    expect(md).toMatch(/Term statistic, for information \(not searched\)/);
    expect(md).not.toMatch(/Under-covered: transcription/);
  });
});

describe("several subjects in one run", () => {
  it("tag each subject's worklist, dossier and index", () => {
    expect(researchFiles()).toEqual({ todo: "RESEARCH.todo.json", dossier: "DOSSIER.md", index: "research.json" });
    expect(researchFiles("7203.T")).toEqual({ todo: "RESEARCH.7203.T.todo.json", dossier: "DOSSIER.7203.T.md", index: "research.7203.T.json" });
    const dir = mkdtempSync(join(tmpdir(), "us-tags-"));
    writeTodo(dir, { ...todoOf(LVMH, []), tag: "MC.PA" });
    writeTodo(dir, { ...todoOf({ ...LVMH, symbol: "7203.T", name: "Toyota" }, []), tag: "7203.T" });
    writeFileSync(join(dir, "RESEARCH.todo.json.bak"), "{}");
    expect(researchTags(dir)).toEqual(["7203.T", "MC.PA"]);
    expect(readTodo(dir, "7203.T")!.name).toBe("Toyota");
    expect(readTodo(dir)).toBeUndefined();
  });

  it("make a round on such a run name its subject with --for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-tags-"));
    writeTodo(dir, { ...todoOf(LVMH, []), tag: "MC.PA" });
    writeTodo(dir, { ...todoOf({ ...LVMH, symbol: "7203.T", name: "Toyota" }, []), tag: "7203.T" });
    const run = (values: Record<string, string>) =>
      researchCommand({ command: "research", positional: [], values: { out: dir, "web-results": join(dir, "none.json"), ...values }, bools: new Set() }, true);
    writeFileSync(join(dir, "none.json"), "[]");
    await expect(run({})).rejects.toThrow(/several subjects \(7203\.T, MC\.PA\): pick one with --for <tag>/);
    await expect(run({ for: "ZZZ" })).rejects.toThrow(/no RESEARCH\.ZZZ\.todo\.json — tags here: 7203\.T, MC\.PA/);
    // The right worklist is picked; with no hit to read the round stops there.
    await expect(run({ for: "7203.T" })).rejects.toThrow(/no search result with a url to read/);
  });
});
