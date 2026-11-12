import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { JURISDICTION, ruleStatus } from "../src/core/jurisdiction.js";
import { homeDir } from "../src/core/paths.js";
import { saveFacts } from "../src/core/researched.js";
import { type FactsTransport, keyQueries, officialFactsHost, preferredHosts, researchFacts } from "../src/research/facts.js";
import type { Candidate, ReadPage } from "../src/research/ingest.js";
import { jurisdictionKeys } from "../src/core/jurisdiction.js";

const run = () => mkdtempSync(join(tmpdir(), "us-facts-"));

/** A fake transport: canned hits per key, every read answering with a page naming its URL. Never the network. */
function fake(hits: Record<string, string[]>): { transport: FactsTransport; asked: { queries: string[]; read: string[] } } {
  const asked = { queries: [] as string[], read: [] as string[] };
  return {
    asked,
    transport: {
      search: async (queries) => {
        asked.queries.push(...queries.map((q) => q.query));
        const seen = new Set<string>();
        const lists = [];
        for (const q of queries) {
          if (seen.has(q.angle)) continue;
          seen.add(q.angle);
          lists.push((hits[q.angle] ?? []).map((url) => ({ url, angle: q.angle, query: q.query, title: url })));
        }
        return { lists: lists.filter((l) => l.length), notes: ["engine search, test: DuckDuckGo throttled"] };
      },
      read: async (cands: readonly Candidate[]) => {
        asked.read.push(...cands.map((c) => c.url));
        const pages: ReadPage[] = cands.map((c) => ({
          ...c,
          finalUrl: c.url,
          text: `TEST PAGE ${c.url}: what the regulator decided, in a paragraph long enough to be a document.`,
          fetchedAt: "2026-11-01T10:00:00.000Z",
          pdf: c.url.endsWith(".pdf"),
        }));
        return { pages, dropped: [] };
      },
    },
  };
}

describe("facts research", () => {
  it("names the official hosts a key prefers, and searches them by site", () => {
    expect(preferredHosts("the IRS (irs.gov)")).toEqual(["irs.gov"]);
    expect(preferredHosts("the regulation on eur-lex.europa.eu, e.g. the text")).toEqual(["eur-lex.europa.eu"]);
    expect(officialFactsHost("www.impots.gouv.fr")).toBe(true);
    expect(officialFactsHost("www.gov.uk")).toBe(true);
    expect(officialFactsHost("anj.fr")).toBe(true);
    expect(officialFactsHost("blog.example.com")).toBe(false);
    expect(officialFactsHost("help.kalshi.com", ["kalshi.com"])).toBe(true);
    const etf = jurisdictionKeys("FR").find((k) => k.key === "us-domiciled-etf")!;
    expect(keyQueries(etf, "FR", "2026-11-01")).toEqual([etf.query, `${etf.query} site:eur-lex.europa.eu`]);
  });

  it("reads the top official hits per key into the run as [E#], and writes the worklist and the JSON to fill", async () => {
    const dir = run();
    const { transport, asked } = fake({
      polymarket: ["https://anj.fr/polymarket-blocking", "https://news.example.com/polymarket-france", "https://www.youtube.com/watch?v=1"],
      kalshi: ["https://news.example.com/kalshi-europe"],
    });
    const w = await researchFacts({ domain: JURISDICTION, country: "FR", period: "2026-11-01", keys: ["polymarket", "kalshi"], dir, transport });
    // The keyless search ran once per query; the official hit is read for polymarket, the best other one for kalshi.
    expect(asked.queries.some((q) => /Polymarket France/.test(q))).toBe(true);
    expect(asked.read.sort()).toEqual(["https://anj.fr/polymarket-blocking", "https://news.example.com/kalshi-europe"]);
    const poly = w.items.find((i) => i.key === "polymarket")!;
    expect(poly.documents).toMatchObject([{ id: "E1", host: "anj.fr", official: true }]);
    expect(poly.status).toBe("missing");
    const kalshi = w.items.find((i) => i.key === "kalshi")!;
    expect(kalshi.documents[0]!.official).toBe(false);
    expect(w.notes.join(" ")).toMatch(/kalshi: no hit on an official host/);
    expect(w.notes.join(" ")).toMatch(/DuckDuckGo throttled/);
    // Each document is an evidence item with its text in sources/E#.md.
    const store = EvidenceStore.load(dir)!;
    expect(store.get("E1")?.url).toBe("https://anj.fr/polymarket-blocking");
    expect(readFileSync(join(dir, "sources", "E1.md"), "utf8")).toMatch(/TEST PAGE https:\/\/anj\.fr/);
    // The worklist names the documents and the fact to fill; the JSON is a template `facts set` takes once filled.
    const md = readFileSync(w.markdown, "utf8");
    expect(md).toContain("## polymarket");
    expect(md).toContain("**[E1]** anj.fr — official");
    expect(md).toContain(`ultrastock facts set jurisdiction --file ${w.file}`);
    const json = JSON.parse(readFileSync(w.file, "utf8"));
    expect(Object.keys(json.facts)).toEqual(["polymarket", "kalshi"]);
    expect(json.facts.polymarket).toMatchObject({
      value: null,
      values: ["allowed", "restricted", "blocked", "unknown"],
      evidence: ["E1 https://anj.fr/polymarket-blocking"],
    });
    // The model concludes, fills the file and stores it: the gate then reads the conclusion.
    json.researchedAt = json.date;
    json.facts = {
      polymarket: {
        ...json.facts.polymarket,
        value: "blocked",
        note: "TEST: the regulator ordered the site blocked",
        sources: ["https://anj.fr/polymarket-blocking"],
        verifiedAt: json.date,
        confidence: "high",
      },
    };
    saveFacts(JURISDICTION, json);
    expect(ruleStatus("FR", "polymarket")).toBe("blocked");
  });

  it("takes the agent's own hits (angle = the key) and searches with the engines only when asked", async () => {
    const dir = run();
    const { transport, asked } = fake({});
    const w = await researchFacts({
      domain: JURISDICTION,
      country: "FR",
      period: "2026-11-01",
      keys: ["us-domiciled-etf"],
      dir,
      transport,
      lists: [[{ url: "https://eur-lex.europa.eu/eli/reg/2014/1286/oj" }]],
    });
    expect(asked.queries).toEqual([]);
    expect(w.items[0]!.documents).toMatchObject([{ host: "eur-lex.europa.eu", official: true }]);
  });

  it("says what to do when the search finds nothing, and writes the worklist anyway", async () => {
    const dir = run();
    const { transport } = fake({});
    const w = await researchFacts({ domain: JURISDICTION, country: "DE", period: "2026-11-01", keys: ["polymarket"], dir, transport });
    expect(w.items[0]!.documents).toEqual([]);
    expect(w.notes.join(" ")).toMatch(/no search result to read: run your own web search/);
    expect(existsSync(w.file)).toBe(true);
  });

  it("refuses a key the domain does not hold", async () => {
    await expect(
      researchFacts({ domain: JURISDICTION, country: "FR", period: "2026-11-01", keys: ["nope"], dir: run(), transport: fake({}).transport }),
    ).rejects.toThrow(/not a FR jurisdiction key: nope/);
  });
});

afterEach(() => vi.restoreAllMocks());

async function cli(argv: string[]): Promise<{ out: string; err: string; code?: number }> {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    err += String(c);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw Object.assign(new Error("exit"), { exitCode: code });
  }) as never);
  try {
    await main(argv);
    return { out, err };
  } catch (e) {
    return { out, err, code: (e as { exitCode?: number }).exitCode ?? 99 };
  } finally {
    vi.restoreAllMocks();
  }
}

describe("facts template | set | show", () => {
  it("prints the template, stores a filled file, shows it, and keeps tax rules as an alias", async () => {
    rmSync(homeDir(), { recursive: true, force: true });
    const t = JSON.parse((await cli(["facts", "template", "jurisdiction", "--country", "FR", "--key", "kalshi"])).out);
    expect(Object.keys(t.facts)).toEqual(["kalshi"]);
    expect(t.facts.kalshi.value).toBeNull();
    t.researchedAt = t.date;
    t.facts.kalshi = {
      ...t.facts.kalshi,
      value: "restricted",
      note: "TEST: not offered to residents",
      sources: ["https://example.invalid/ultrastock-test-data-not-law"],
      verifiedAt: t.date,
      confidence: "low",
    };
    const file = join(run(), "f.json");
    writeFileSync(file, JSON.stringify(t));
    const set = await cli(["facts", "set", "jurisdiction", "--file", file]);
    expect(set.out).toMatch(/stored .*jurisdiction\/FR-\d{4}-\d{2}-\d{2}\.json — 1 researched fact/);
    expect(set.out).toMatch(/not researched yet .*polymarket/);
    const show = (await cli(["facts", "show", "jurisdiction", "--country", "FR"])).out;
    expect(show).toMatch(/kalshi: RESTRICTED — TEST: not offered to residents/);
    expect(show).toMatch(/polymarket: UNKNOWN — not researched for FR/);
    expect((await cli(["facts", "show", "nope"])).code).toBe(2);
    // Tax keeps its own commands: facts template tax is tax rules template.
    const tax = JSON.parse((await cli(["facts", "template", "tax", "--country", "DE", "--year", "2025"])).out);
    expect(tax).toMatchObject({ country: "DE", year: 2025 });
  });
});
