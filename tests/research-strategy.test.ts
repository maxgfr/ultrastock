import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAnswer } from "../src/check.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { setNetMode } from "../src/core/net.js";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../src/core/untrusted.js";
import { contentHash } from "../src/engine.js";
import { researchAngles } from "../src/research/angles.js";
import type { RegisteredDoc } from "../src/research/dossier.js";
import { startResearch } from "../src/research/run.js";
import {
  citationQueries,
  citedDois,
  citedSourceAngle,
  citedStudiesAngle,
  describeWork,
  evidenceTier,
  paperIdentifier,
  parseOpenAlexWork,
  scholarlyCheck,
  scholarlyHost,
  sourceHost,
  strategySources,
} from "../src/research/scholarly.js";

const root = join(import.meta.dirname, "..");
const tmp = () => mkdtempSync(join(tmpdir(), "us-strategy-"));

/** The answer a fixture recorded for a URL: OpenAlex's body as it came. */
function recordedBody(fixture: string, urlPart: string): unknown {
  const dir = join(root, "assets/fixtures", fixture, "http");
  for (const f of readdirSync(dir)) {
    const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as { request: { url: string }; response: { body: string } };
    if (rec.request.url.includes(urlPart)) return JSON.parse(rec.response.body);
  }
  throw new Error(`no recorded answer for ${urlPart} in ${fixture}`);
}

const doc = (id: string, url: string, text: string, host = new URL(url).hostname.replace(/^www\./, "")): RegisteredDoc => ({
  id,
  host,
  official: false,
  page: { url, finalUrl: url, text, fetchedAt: "2026-11-23T13:55:00.000Z", pdf: false, angles: [], score: 1 },
});

afterEach(() => setNetMode({ kind: "live" }));

describe("research --kind strategy: the angles", () => {
  it("searches a strategy's literature in French and English, the working-paper series by site", () => {
    const angles = researchAngles({ subject: "fed put", name: "fed put", kind: "strategy", focus: "general", year: 2026 });
    expect(angles.map((a) => a.id)).toEqual(["original-paper", "working-papers", "review", "out-of-sample", "costs-critique", "institutional", "fr-evidence"]);
    expect(angles.every((a) => a.queries.length === 2)).toBe(true);
    expect(angles.find((a) => a.id === "working-papers")!.queries[1]).toBe("fed put site:ssrn.com OR site:nber.org OR site:arxiv.org");
    expect(angles.find((a) => a.id === "out-of-sample")!.queries[1]).toMatch(/McLean Pontiff/);
    expect(angles.find((a) => a.id === "fr-evidence")!.queries[0]).toBe("étude scientifique fed put AMF Banque de France");
  });

  it("reads the literature ultrastock's own preset cites first, from its source string", () => {
    const a = citedSourceAngle(["Momentum"])!;
    expect(a.id).toBe("cited-source");
    expect(a.title).toBe('What ultrastock\'s screen preset "momentum" cites');
    expect(a.queries[0]).toBe("Jegadeesh Titman 1993 Journal of Finance pdf");
    expect(a.langs?.every((l) => l === "en-US")).toBe(true);
    expect(citedSourceAngle(["fed put"])).toBeUndefined();
  });

  it("finds a rule by its id or title, case, accents and dashes aside, across presets, styles, strategies and allocations", () => {
    expect(strategySources(["Magic Formula"]).map((s) => `${s.origin}:${s.id}`)).toEqual(["screen preset:magic-formula", "value style:magic-formula"]);
    expect(strategySources(["dual momentum"]).map((s) => s.id)).toEqual(["dual-momentum"]);
    expect(strategySources(["sma-cross"]).map((s) => s.origin)).toEqual(["backtest strategy"]);
    expect(strategySources(["tendance"])).toEqual([]);
  });

  it("turns a source string's citations into queries", () => {
    expect(
      citationQueries("the size and value premia (Banz, 1981; Fama & French, 'The Cross-Section of Expected Stock Returns', Journal of Finance, 1992)"),
    ).toEqual(["Banz 1981", "Fama French 1992 The Cross-Section of Expected Stock Returns Journal of Finance pdf"]);
    expect(citationQueries("Greenblatt's earnings yield and return on capital, Piotroski (2000), Altman (1968); Novy-Marx (2013) on quality")).toEqual([
      "Piotroski 2000",
      "Altman 1968",
      "Novy-Marx 2013",
    ]);
    expect(citationQueries("Mark Minervini, Trade Like a Stock Market Wizard (2013), the trend template")).toEqual(["Trade Like a Stock Market Wizard 2013"]);
    // A backtest strategy's description cites nothing: its head words are searched.
    expect(citationQueries("Turtle Trading — 200-period breakout entry, 10-period trailing stop exit")).toEqual(["Turtle Trading backtest study"]);
  });

  it("starts a strategy's worklist without resolving a ticker: no network, the cited source first", async () => {
    // A replay of an empty fixture: any read would throw.
    const fx = tmp();
    setNetMode({ kind: "fixture", dir: fx });
    const { todo } = await startResearch("momentum", { kind: "strategy", out: join(tmp(), "run") });
    expect(todo.symbol).toBeUndefined();
    expect(todo.angles.map((a) => a.id).slice(0, 2)).toEqual(["cited-source", "original-paper"]);
  });
});

describe("levels of evidence", () => {
  it("knows journals, working-paper series, preprint servers, central banks and universities", () => {
    for (const h of [
      "academic.oup.com",
      "www.sciencedirect.com",
      "papers.ssrn.com",
      "www.nber.org",
      "arxiv.org",
      "www.federalreserve.gov",
      "newyorkfed.org",
      "www.bis.org",
      "economics.mit.edu",
      "lse.ac.uk",
    ])
      expect(scholarlyHost(h), h).toBe(true);
    for (const h of ["www.aqr.com", "www.lemonde.fr", "seekingalpha.com", "nber.org.example.com"]) expect(scholarlyHost(h), h).toBe(false);
  });

  it("ranks a source by its host, or by what OpenAlex says the paper is", () => {
    expect(evidenceTier("academic.oup.com")).toBe("peer-reviewed");
    expect(evidenceTier("www.nber.org")).toBe("working-paper");
    expect(evidenceTier("arxiv.org")).toBe("preprint");
    expect(evidenceTier("www.banque-france.fr")).toBe("institutional");
    expect(evidenceTier("www.aqr.com")).toBe("practitioner");
    expect(evidenceTier("www.lesechos.fr")).toBe("press");
    // OpenAlex outranks the host: an NBER page of a paper since published, an SSRN "preprint" that is a working paper.
    expect(evidenceTier("www.nber.org", { type: "article", venue: "Review of Financial Studies", venueType: "journal" })).toBe("peer-reviewed");
    expect(evidenceTier("doi.org", { type: "preprint", venue: "SSRN Electronic Journal", venueType: "repository" })).toBe("working-paper");
    expect(evidenceTier("doi.org", { type: "preprint", venue: "arXiv (Cornell University)", venueType: "repository" })).toBe("preprint");
  });

  it("ranks a Wayback copy by the page it copied", () => {
    expect(sourceHost("web.archive.org", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3563962")).toBe("papers.ssrn.com");
    expect(sourceHost("www.nber.org", "https://www.nber.org/papers/w26894")).toBe("www.nber.org");
  });
});

describe("a paper's identifier", () => {
  it("reads the DOI or arXiv id in the URL, else at the head of the text", () => {
    expect(paperIdentifier("https://doi.org/10.1093/RFS/hhaa116", "")).toBe("10.1093/rfs/hhaa116");
    expect(paperIdentifier("https://academic.oup.com/rfs/article/34/9/4045/6043476", "")).toBeUndefined();
    expect(paperIdentifier("https://arxiv.org/abs/2106.09685v2", "")).toBe("10.48550/arxiv.2106.09685");
    expect(paperIdentifier("https://www.nber.org/papers/w26894", "The Economics of the Fed Put\nDOI 10.3386/w26894.\n")).toBe("10.3386/w26894");
  });

  it("lists the DOIs a text cites, once each, trailing punctuation off", () => {
    expect(citedDois("See (doi: 10.1093/rfs/hhaa116). Also https://doi.org/10.3386/w26894, and 10.1093/rfs/hhaa116 again.")).toEqual([
      "10.1093/rfs/hhaa116",
      "10.3386/w26894",
    ]);
  });
});

describe("OpenAlex", () => {
  it("parses a real record: the Fed put paper in the Review of Financial Studies", () => {
    const w = parseOpenAlexWork(recordedBody("research-strategy-fed-put", "doi:10.1093/rfs/hhaa116"))!;
    expect(w).toMatchObject({
      doi: "10.1093/rfs/hhaa116",
      title: "The Economics of the Fed Put",
      venue: "Review of Financial Studies",
      type: "article",
      retracted: false,
    });
    expect(evidenceTier("", w)).toBe("peer-reviewed");
    expect(describeWork(w)).toBe("Review of Financial Studies, 2020, journal-article, cited 224 times, not retracted");
    const wp = parseOpenAlexWork(recordedBody("research-strategy-fed-put", "doi:10.3386/w26894"))!;
    expect(evidenceTier("", wp)).toBe("working-paper");
  });

  it("parses a real retracted record", () => {
    const w = parseOpenAlexWork(recordedBody("research-openalex-retracted", "doi:10.1007/s00500-023-08305-7"))!;
    expect(w.retracted).toBe(true);
    expect(describeWork(w)).toMatch(/RETRACTED$/);
    expect(parseOpenAlexWork({ id: "x" })).toBeUndefined();
  });

  it("registers a working paper's record and its published version, citable at doi.org (replayed)", async () => {
    setNetMode({ kind: "fixture", dir: join(root, "assets/fixtures/research-strategy-fed-put") });
    const dir = tmp();
    const nber = doc("E1", "https://www.nber.org/papers/w26894", "The Economics of the Fed Put\nDOI 10.3386/w26894\nPublished Versions\n10.1093/rfs/hhaa116\n");
    const press = doc("E2", "https://www.example-news.com/fed-put", "A study (https://doi.org/10.1111/jofi.12345) says the Fed reacts to stocks.");
    const r = await scholarlyCheck(dir, "fed put", [nber, press]);
    expect(r.rows[0]).toMatchObject({ doc: "E1", tier: "working-paper", doi: "10.3386/w26894" });
    expect(r.rows[0]!.works.map((w) => [w.doi, w.tier, !!w.published])).toEqual([
      ["10.3386/w26894", "working-paper", false],
      ["10.1093/rfs/hhaa116", "peer-reviewed", true],
    ]);
    const store = EvidenceStore.load(dir)!;
    const rfs = store.byKey("openalex.10.1093/rfs/hhaa116")!;
    expect(rfs.url).toBe("https://doi.org/10.1093/rfs/hhaa116");
    expect(rfs.value).toBe("Review of Financial Studies, 2020, journal-article, cited 224 times, not retracted");
    // The press page cites a study no source of the run is: the next round searches its DOI.
    expect(r.cites).toEqual([{ doc: "E2", doi: "10.1111/jofi.12345" }]);
    expect(r.notes.join("\n")).toMatch(/cites 10\.1111\/jofi\.12345: read the study/);
    expect(citedStudiesAngle(r)).toEqual({ id: "gap-cited-studies", title: "The studies the sources cite", queries: ['"10.1111/jofi.12345"'], langs: [null] });
  });

  it("flags a retracted paper (replayed)", async () => {
    setNetMode({ kind: "fixture", dir: join(root, "assets/fixtures/research-openalex-retracted") });
    const r = await scholarlyCheck(tmp(), "x", [doc("E1", "https://link.springer.com/article/10.1007/s00500-023-08305-7", "x")]);
    expect(r.retracted.map((x) => x.doi)).toEqual(["10.1007/s00500-023-08305-7"]);
  });

  it("falls back to the domain when OpenAlex fails, and says so", async () => {
    // A live read that fails: no figure invented, the tier comes from the host.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    try {
      const r = await scholarlyCheck(tmp(), "x", [doc("E1", "https://doi.org/10.1093/rfs/hhaa116", "x")]);
      expect(r.rows[0]).toMatchObject({ tier: "peer-reviewed", works: [] });
      expect(r.notes.join("\n")).toMatch(/OpenAlex unavailable .*inferred from its domain/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("check against a paper", () => {
  it("refuses 50 bps when the paper states 32 bps, even next to an R² of 0.50", () => {
    const dir = tmp();
    const text = [
      "A 10% stock market decline predicts a reduction in the FFR target of 32 bps at the next meeting and 127 bps after one year.",
      "Past intermeeting returns forecast stock market mentions with an R2 around 0.50.",
    ].join("\n");
    const store = EvidenceStore.open(dir, { subject: "fed put" });
    const id = store.add({
      key: "doc.w26894",
      label: "nber.org document (PDF), working-paper",
      value: "The Economics of the Fed Put",
      source: "nber.org",
      url: "https://www.nber.org/system/files/working_papers/w26894/w26894.pdf",
      fetchedAt: "2026-11-23T13:55:00.000Z",
      official: true,
      untrusted: true,
      doc: { path: "sources/E1.md", chars: text.length, hash: contentHash(text) },
    });
    store.save();
    mkdirSync(join(dir, "sources"), { recursive: true });
    writeFileSync(join(dir, "sources", `${id}.md`), `# [${id}] nber.org\n\n${UNTRUSTED_OPEN} source=nber.org\n${text}\n${UNTRUSTED_CLOSE}\n`);
    const fails = (answer: string) => {
      const r = checkAnswer(dir, answer);
      if ("error" in r) throw new Error(r.error);
      return r.problems.filter((p) => !["inert", "unsourced", "distant"].includes(p.kind)).map((p) => p.message);
    };
    expect(fails("A 10% decline predicts a cut of 32 bps at the next meeting and 127 bps after one year [E1].")).toEqual([]);
    expect(fails("A 10% decline predicts a cut of 50 bps at the next meeting [E1].")).toEqual([
      "50 bps is not in the document [E1] (https://www.nber.org/system/files/working_papers/w26894/w26894.pdf) — state the figure as the source writes it, or cite the evidence that holds it",
    ]);
  });
});
