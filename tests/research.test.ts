import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { calcFromDocument } from "../src/calc.js";
import { checkAnswer } from "../src/check.js";
import { EvidenceStore, readDocText } from "../src/core/evidence.js";
import { setNetMode } from "../src/core/net.js";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../src/core/untrusted.js";
import { contentHash } from "../src/engine.js";
import { researchAngles, type ResearchSubject } from "../src/research/angles.js";
import { officialHost } from "../src/research/dossier.js";
import { fuseHits, notADocument, parseWebResults, readCandidate } from "../src/research/ingest.js";
import { searchName } from "../src/commands/research.js";

const run = () => mkdtempSync(join(tmpdir(), "us-research-"));

/** A run holding one document item E1 whose text is `text`. */
function withDoc(text: string, extra: Array<{ key: string; value: number; unit?: string }> = []): string {
  const dir = run();
  const store = EvidenceStore.open(dir, { subject: "MC.PA" });
  const id = store.add({
    key: "doc.abc",
    label: "lvmh.com document",
    value: "Half-year results",
    source: "lvmh.com",
    url: "https://www.lvmh.com/en/publications/h1",
    fetchedAt: "2026-10-26T10:00:00.000Z",
    official: true,
    untrusted: true,
    doc: { path: "sources/E1.md", chars: text.length, hash: contentHash(text) },
  });
  for (const e of extra) store.add({ ...e, label: e.key, source: "t", fetchedAt: "2026-10-26T10:00:00.000Z", official: true });
  store.save();
  mkdirSync(join(dir, "sources"), { recursive: true });
  writeFileSync(join(dir, "sources", `${id}.md`), `# [${id}] lvmh.com\n\n- url: x\n\n${UNTRUSTED_OPEN} source=lvmh.com\n${text}\n${UNTRUSTED_CLOSE}\n`);
  return dir;
}

const RELEASE = [
  "LVMH Moët Hennessy Louis Vuitton recorded revenue of 4.2 billion euros in its wines division over the half.",
  "Profit from recurring operations came to €8.7 billion, a margin of 22.5%.",
  "",
  ...Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i} about boutiques, craftsmanship and heritage across the Maisons of the group.`),
  "Elsewhere the group employs 215 000 people across its seventy-five Maisons.",
].join("\n");

const failing = (r: ReturnType<typeof checkAnswer>) =>
  "error" in r ? [r.error] : r.problems.filter((p) => !["inert", "unsourced", "distant"].includes(p.kind)).map((p) => p.message);

describe("check against a cited document", () => {
  it("accepts 4,2 Md€ against « 4.2 billion euros » and 22,5 % against 22.5%", () => {
    const dir = withDoc(RELEASE);
    const r = checkAnswer(dir, "Les vins pèsent 4,2 Md€ [E1], pour une marge courante de 22,5 % [E1].");
    expect(failing(r)).toEqual([]);
  });

  it("refuses a figure the document does not state, naming the document", () => {
    const dir = withDoc(RELEASE);
    const msgs = failing(checkAnswer(dir, "Les vins pèsent 4,9 Md€ [E1]."));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/4,9 Md€ is not in the document \[E1\] \(https:\/\/www\.lvmh\.com/);
  });

  it("notes a figure the document holds only far from the claim's words", () => {
    const dir = withDoc(RELEASE);
    const r = checkAnswer(dir, "The wines margin reached 215 000 [E1].");
    if ("error" in r) throw new Error(r.error);
    expect(r.problems.map((p) => p.kind)).toContain("distant");
    expect(failing(r)).toEqual([]);
    // A claim sharing no word with the page (another language): nearness is not judged.
    const fr = checkAnswer(dir, "La marge des vins atteint 215 000 [E1].");
    if ("error" in fr) throw new Error(fr.error);
    expect(fr.problems.map((p) => p.kind)).not.toContain("distant");
  });

  it("still reads numeric evidence cited next to a document", () => {
    const dir = withDoc(RELEASE, [{ key: "x.close", value: 512.4, unit: "EUR" }]);
    expect(failing(checkAnswer(dir, "Le titre cote 512,4 € [E2] après des ventes de 4,2 Md€ [E1]."))).toEqual([]);
  });

  it("reports a document whose text left the run, and never reads outside it", () => {
    const dir = withDoc(RELEASE);
    const store = EvidenceStore.load(dir)!;
    const item = store.get("E1")!;
    expect(readDocText(dir, { ...item, doc: { ...item.doc!, path: "../../etc/passwd" } })).toBeUndefined();
    expect(readDocText(dir, { ...item, doc: { ...item.doc!, path: "/etc/passwd" } })).toBeUndefined();
    item.doc!.path = "sources/gone.md";
    store.save();
    const r = checkAnswer(dir, "Les vins pèsent 4,2 Md€ [E1].");
    if ("error" in r) throw new Error(r.error);
    expect(r.problems.some((p) => p.kind === "dangling" && /missing from the run/.test(p.message))).toBe(true);
  });
});

describe("calc --from", () => {
  it("registers a figure the document states, with its provenance", () => {
    const dir = withDoc(RELEASE);
    const r = calcFromDocument(dir, "E1", "4,2 milliards d'euros", { label: "LVMH wines revenue H1" });
    expect(r.item).toMatchObject({ value: 4.2e9, unit: "EUR", source: "lvmh.com", official: true, derivedFrom: ["E1"] });
    expect(failing(checkAnswer(dir, `Les vins pèsent 4,2 Md€ [${r.id}].`))).toEqual([]);
  });

  it("refuses a figure the document does not state, and a non-document", () => {
    const dir = withDoc(RELEASE, [{ key: "x.close", value: 512.4 }]);
    expect(() => calcFromDocument(dir, "E1", "6,1 Md€", { label: "x" })).toThrow(/not in E1/);
    expect(() => calcFromDocument(dir, "E2", "512,4", { label: "x" })).toThrow(/not a document/);
    expect(() => calcFromDocument(dir, "E1", "4,2 Md€ et 8,7 Md€", { label: "x" })).toThrow(/exactly one figure/);
  });
});

describe("web results", () => {
  it("reads the shapes harnesses produce", () => {
    const nested = parseWebResults([
      { angle: "risks", query: "q1", results: [{ url: "https://a.test/1", title: "A" }, { link: "https://b.test/2" }, { title: "no url" }] },
      { angle: "results", query: "q2", results: [{ url: "https://a.test/1?utm_source=x", snippet: "again" }] },
    ]);
    expect(nested.lists).toHaveLength(2);
    expect(nested.skipped).toBe(1);
    expect(parseWebResults({ results: [{ url: "https://c.test" }] }).lists).toEqual([
      [{ url: "https://c.test", angle: undefined, query: undefined, title: undefined, snippet: undefined }],
    ]);
    expect(parseWebResults([{ url: "https://c.test" }, { href: "https://d.test" }]).lists[0]).toHaveLength(2);
  });

  it("fuses on the canonical URL and keeps every angle that surfaced a page", () => {
    const { lists } = parseWebResults([
      { angle: "risks", results: [{ url: "https://a.test/1" }, { url: "https://www.youtube.com/watch?v=1" }] },
      { angle: "results", results: [{ url: "https://a.test/1?utm_source=x" }, { url: "https://b.test/2" }] },
    ]);
    const fused = fuseHits(lists, notADocument);
    expect(fused.map((c) => c.url)).toEqual(["https://a.test/1", "https://b.test/2"]);
    expect(fused[0]!.angles).toEqual(["results", "risks"]);
    expect(fused[0]!.meta?.foundBy).toBe(2);
  });
});

describe("reading a page", () => {
  afterEach(() => setNetMode({ kind: "live" }));
  /** A fixture directory answering GET `url` with `body`. */
  function fixtureWith(url: string, body: string): string {
    const dir = run();
    mkdirSync(join(dir, "http"), { recursive: true });
    const key = contentHash(`GET ${url} `).slice(0, 20);
    writeFileSync(join(dir, "http", `${key}.json`), JSON.stringify({ response: { ok: true, status: 200, body, url, fetchedAt: "2026-10-26T10:00:00.000Z" } }));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ recordedAt: "2026-10-26T10:00:00.000Z" }));
    return dir;
  }
  const candidate = (url: string) => ({ url, score: 1, angles: ["results"] });

  it("keeps an article with its text, title and publication date", async () => {
    const url = "https://news.test/lvmh-h1";
    const html = `<html><head><title>LVMH H1</title><meta property="article:published_time" content="2026-07-27T18:00:00Z"></head><body><article><h1>LVMH H1</h1>${"<p>LVMH reported first-half revenue of €38.6 billion, with organic growth of 2% and recurring operating profit of €8.7 billion over the period.</p>".repeat(4)}</article></body></html>`;
    setNetMode({ kind: "fixture", dir: fixtureWith(url, html) });
    const r = await readCandidate(candidate(url));
    expect(r.dropped).toBeUndefined();
    expect(r.page?.text).toMatch(/€38\.6 billion/);
    expect(r.page?.publishedAt).toBe("2026-07-27T18:00:00Z");
  });

  it("drops a cookie wall and an anti-bot page, with the reason", async () => {
    const url = "https://pubmed.test/1";
    setNetMode({
      kind: "fixture",
      dir: fixtureWith(
        url,
        "<html><body><h1>Cookies must be enabled.</h1><p>Enable cookies for pubmed.test and reload this page to continue.</p></body></html>",
      ),
    });
    expect((await readCandidate(candidate(url))).dropped?.reason).toBe("cookie wall");
    const bot = "https://bot.test/1";
    setNetMode({ kind: "fixture", dir: fixtureWith(bot, "<html><head><title>Captcha</title></head><body>verify</body></html>") });
    expect((await readCandidate(candidate(bot))).dropped?.reason).toMatch(/anti-bot|challenge/);
  });

  it("drops a page the fixture never recorded instead of failing the run", async () => {
    setNetMode({ kind: "fixture", dir: fixtureWith("https://other.test", "x") });
    expect((await readCandidate(candidate("https://missing.test/1"))).dropped?.reason).toMatch(/not in the recorded fixture/);
  });
});

describe("angles", () => {
  const subject = (over: Partial<ResearchSubject>): ResearchSubject => ({
    subject: "MC.PA",
    name: "LVMH",
    kind: "equity",
    focus: "general",
    year: 2026,
    ...over,
  });

  it("follow the subject's kind, in French then English", () => {
    const eq = researchAngles(subject({}));
    expect(eq.map((a) => a.id)).toEqual(expect.arrayContaining(["business-model", "results-guidance", "litigation", "short-sellers", "analysts"]));
    expect(eq.every((a) => a.queries.length === 2 && a.queries.every((q) => q.includes("LVMH")))).toBe(true);
    expect(researchAngles(subject({ kind: "etf", name: "Amundi MSCI World" })).map((a) => a.id)).toEqual(
      expect.arrayContaining(["factsheet-kid", "holdings", "replication", "pea", "tracking", "distributions"]),
    );
    expect(researchAngles(subject({ kind: "crypto", name: "Solana" })).map((a) => a.id)).toEqual(["tokenomics", "incidents", "regulation"]);
  });

  it("narrow to the latest publication with --focus results, a private company included", () => {
    const res = researchAngles(subject({ focus: "results" }));
    expect(res.map((a) => a.id)).toEqual(expect.arrayContaining(["results-release", "results-filing", "results-call"]));
    expect(res[0]!.queries[1]).toBe("LVMH 2026 results press release");
    const priv = researchAngles(subject({ kind: "company", name: "Anthropic", focus: "results" }));
    expect(priv.map((a) => a.id)).toContain("results-revenue");
  });

  it("turn a precise question into its own angles", () => {
    const ask = researchAngles(subject({ ask: "pourquoi LVMH est-il bon marché ?" }));
    expect(ask[0]).toEqual({ id: "ask", title: "The question", queries: ["pourquoi LVMH est-il bon marché ?"] });
    expect(ask.map((a) => a.id)).toContain("ask-primary");
  });
});

describe("sources", () => {
  it("call regulators and the issuer's own site official", () => {
    expect(officialHost("sec.gov", "Apple")).toBe(true);
    expect(officialHost("amf-france.org", "LVMH")).toBe(true);
    expect(officialHost("lvmh.com", "LVMH")).toBe(true);
    expect(officialHost("investor.apple.com", "Apple Inc.")).toBe(true);
    expect(officialHost("pulse2.com", "LVMH")).toBe(false);
    expect(officialHost("ab.com", "AB")).toBe(false);
  });

  it("search with a short company name", () => {
    expect(searchName("LVMH Moët Hennessy - Louis Vuitton, Société Européenne")).toBe("LVMH Moët Hennessy");
    expect(searchName("Apple Inc.")).toBe("Apple");
  });
});

describe("recorded plumbing", () => {
  afterEach(() => setNetMode({ kind: "live" }));

  it("replays a crible call by the hash of its arguments, and refuses an unrecorded one", async () => {
    const { cribleScreen } = await import("../src/providers/external/crible.js");
    const dir = run();
    const call = ["cli", "screen", "symbol = 'MC.PA'", "--format", "json", "--limit", "50", "--offset", "0"];
    mkdirSync(join(dir, "crible"), { recursive: true });
    writeFileSync(
      join(dir, "crible", `${contentHash(JSON.stringify(call)).slice(0, 20)}.json`),
      JSON.stringify({ call, value: '{"total": 1, "rows": [{"symbol": "MC.PA"}]}' }),
    );
    setNetMode({ kind: "fixture", dir });
    expect(await cribleScreen("symbol = 'MC.PA'")).toEqual({ total: 1, rows: [{ symbol: "MC.PA" }] });
    await expect(cribleScreen("symbol = 'OR.PA'")).rejects.toThrow(/no recorded crible call/);
  });

  it("replays bytes stored in base64", async () => {
    const { fetchBytes } = await import("../src/core/net.js");
    const dir = run();
    const url = "https://issuer.test/kid.pdf";
    mkdirSync(join(dir, "http"), { recursive: true });
    const bytes = Buffer.from("%PDF-1.4 fake");
    writeFileSync(
      join(dir, "http", `${contentHash(`BYTES ${url}`).slice(0, 20)}.json`),
      JSON.stringify({
        response: {
          ok: true,
          status: 200,
          body: "",
          url,
          fetchedAt: "2026-10-26T10:00:00.000Z",
          bodyBase64: bytes.toString("base64"),
          contentType: "application/pdf",
        },
      }),
    );
    setNetMode({ kind: "fixture", dir });
    const r = await fetchBytes(url);
    expect(r.bytes.equals(bytes)).toBe(true);
    expect(r.contentType).toBe("application/pdf");
  });
});

describe("crible in a fixture replay", () => {
  afterEach(() => setNetMode({ kind: "live" }));
  it("is available and bootstrapped without uvx or a dataset: its calls are replayed", async () => {
    const { cribleAvailable, cribleBootstrapped } = await import("../src/providers/external/crible.js");
    const prev = process.env.ULTRASTOCK_CRIBLE_CMD;
    process.env.ULTRASTOCK_CRIBLE_CMD = "definitely-not-installed-crible";
    try {
      expect(cribleAvailable()).toBe(false);
      setNetMode({ kind: "fixture", dir: run() });
      expect(cribleAvailable()).toBe(true);
      expect(cribleBootstrapped("/nonexistent")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ULTRASTOCK_CRIBLE_CMD;
      else process.env.ULTRASTOCK_CRIBLE_CMD = prev;
    }
  });
});
