import { afterEach, describe, expect, it } from "vitest";
import { setNetMode } from "../src/core/net.js";
import {
  type Article,
  dedupeArticles,
  newsSearch,
  parseGdelt,
  parseGoogleNews,
  parseYahooRss,
  titleSimilarity,
  yahooArticles,
} from "../src/providers/macro/news.js";
import {
  cleanWikitext,
  fetchConstituents,
  indexId,
  indexUniverse,
  parseConstituentTable,
  parseNamesList,
  parseNamesTable,
  wikiTables,
} from "../src/providers/macro/universe.js";
import { ProviderError } from "../src/providers/types.js";
import { withFixture } from "./helpers/fixtures.js";

afterEach(() => setNetMode({ kind: "live" }));

describe("news", () => {
  it("parses Google News, Yahoo and GDELT answers", () => {
    const gn = parseGoogleNews(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><item><title>Nvidia beats estimates - Reuters</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Sat, 24 Oct 2026 15:10:07 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item></channel></rss>',
    );
    expect(gn).toEqual([
      {
        title: "Nvidia beats estimates",
        source: "Reuters",
        published: "2026-10-24T15:10:07Z",
        url: "https://news.google.com/rss/articles/abc",
        via: "google-news",
      },
    ]);
    const yh = parseYahooRss(
      '<?xml version="1.0"?><rss version="2.0"><channel><item><title>ETF A vs ETF B</title><link>https://www.fool.com/x</link><pubDate>Sat, 24 Oct 2026 14:31:00 +0000</pubDate></item></channel></rss>',
    );
    expect(yh[0]).toMatchObject({ title: "ETF A vs ETF B", published: "2026-10-24T14:31:00Z", via: "yahoo" });
    expect(parseGdelt({ articles: [{ url: "https://x.com/a", title: "A headline", seendate: "20261024T120000Z", domain: "x.com" }] })).toEqual([
      { title: "A headline", source: "x.com", published: "2026-10-24T12:00:00Z", url: "https://x.com/a", via: "gdelt" },
    ]);
  });
  it("deduplicates near-identical titles, newest first", () => {
    const a = (title: string, published: string, url: string): Article => ({ title, published, url, via: "google-news" });
    expect(titleSimilarity("Nvidia beats Q3 estimates", "Nvidia beats Q3 estimates!")).toBe(1);
    const out = dedupeArticles([
      a("Nvidia beats third-quarter estimates as AI demand surges", "2026-10-23T10:00:00Z", "u1"),
      a("Nvidia beats third-quarter estimates as AI demand surges again", "2026-10-24T10:00:00Z", "u2"),
      a("Fed holds rates steady", "2026-10-22T10:00:00Z", "u3"),
    ]);
    expect(out.map((x) => x.url)).toEqual(["u2", "u3"]);
  });
  it("replays a merged search as untrusted, URL-carrying points", async () => {
    const [ds, yahoo] = await withFixture(
      "macro-news",
      async () => [await newsSearch("Nvidia", { symbol: "NVDA", sources: ["google-news"], limit: 15 }), await yahooArticles("NVDA")] as const,
    );
    expect(yahoo.articles.length).toBeGreaterThan(0);
    expect(ds.title).toContain("google-news");
    expect(ds.provenance.official).toBe(false);
    expect(ds.points.length).toBe(15);
    for (const p of ds.points) {
      expect(p.untrusted).toBe(true);
      expect(p.url).toMatch(/^https?:\/\//);
      expect(p.key).toMatch(/^NVDA\.news\.\d+$/);
      expect(p.label).toMatch(/^headline \d+( \(.* UTC\))?$/);
    }
    const dates = ds.points.map((p) => p.asOf ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
  }, 60_000);
});

describe("universe", () => {
  it("cleans wikitext cells and reads tables", () => {
    expect(cleanWikitext("{{NyseSymbol|MMM}}")).toBe("MMM");
    expect(cleanWikitext("{{FWB link|ADS.DE}}")).toBe("ADS.DE");
    expect(cleanWikitext("{{Flagicon|Germany}} {{FWB|ADS}}")).toBe("ADS");
    expect(cleanWikitext("[[Aegon N.V.|Aegon]]<ref>{{cite web|url=x}}</ref>")).toBe("Aegon");
    expect(cleanWikitext("[[Honeywell|Honeywell Technologies Inc.]] †<br />{{small|(formerly X)}}")).toBe("Honeywell Technologies Inc.");
    const wt = [
      '{| class="wikitable sortable"',
      "|-",
      "! Ticker !! Company !! [[Industry Classification Benchmark|ICB]] Sector !! Index weighting (%)",
      "|-",
      "| ABN.AS || [[ABN AMRO]] || Financials || 0.78",
      "|-",
      '| ADYEN.AS || [[Adyen]] || style="color:red" | Industrials || 4.82',
      "|}",
    ].join("\n");
    expect(wikiTables(wt)[0]![0]).toEqual({ header: true, cells: ["Ticker", "Company", "ICB Sector", "Index weighting (%)"] });
    const sp = [
      "{|",
      "|-",
      "![[Ticker symbol|Symbol]]",
      "! Security !! GICS Sector !! GICS Sub-Industry",
      "|-",
      "|| {{NyseSymbol|MMM}}",
      "|| [[3M]]",
      "|| Industrials ",
      "|| Conglomerates",
      "|}",
    ].join("\n");
    expect(wikiTables(sp)[0]![1]!.cells).toEqual(["MMM", "3M", "Industrials", "Conglomerates"]);
    expect(parseNamesList("{{colonnes|taille=14|\n#[[Accor]]\n#[[Aéroports de Paris|ADP]]<ref name=x/>\n}}\n#[[Not this]]")).toEqual([
      { name: "Accor" },
      { name: "ADP" },
    ]);
    expect(
      parseNamesTable(
        "{| class=\"wikitable\"\n| [[3M|3M Company]]\n| [[Nike, Inc.]]\n|-\n|colspan=\"3\" | '''Dropped from Average'''\n|-\n| [[Verizon]] ↓\n|}",
      ),
    ).toEqual([{ name: "3M Company" }, { name: "Nike, Inc." }]);
    expect(indexId("S&P 500")).toBe("SPX");
    expect(indexId("cac40")).toBe("CAC40");
    expect(parseConstituentTable("no table")).toEqual([]);
  });
  it("replays US and French index members", async () => {
    await withFixture("macro-universe", async () => {
      const spx = await fetchConstituents("SPX");
      expect(spx.constituents.length).toBeGreaterThan(495);
      expect(spx.constituents.find((c) => c.ticker === "MMM")).toMatchObject({ name: "3M", sector: "Industrials" });
      expect(spx.notes[0]).toMatch(/SURVIVORSHIP/);
      const ndx = await fetchConstituents("NDX");
      expect(ndx.constituents.length).toBeGreaterThanOrEqual(100);
      expect(ndx.constituents.find((c) => c.ticker === "ADBE")?.sector).toBe("Technology");
      const dji = await fetchConstituents("DJI");
      expect(dji.constituents.length).toBe(30);
      const cac = await indexUniverse("CAC40");
      expect(cac.points[0]).toMatchObject({ key: "CAC40.universe.count", value: 40 });
      expect(cac.points.slice(1).every((p) => p.untrusted)).toBe(true);
      expect(cac.points.some((p) => p.value === "AI.PA | Air Liquide | Basic Materials")).toBe(true);
      const sbf = await fetchConstituents("SBF120");
      expect(sbf.constituents.length).toBeGreaterThan(110);
    });
    await expect(fetchConstituents("NIKKEI")).rejects.toBeInstanceOf(ProviderError);
  }, 60_000);
  it("replays European index members", async () => {
    await withFixture("macro-universe-eu", async () => {
      const dax = await fetchConstituents("DAX");
      expect(dax.constituents.length).toBe(40);
      expect(dax.constituents.find((c) => c.ticker === "ADS.DE")?.name).toBe("Adidas");
      const sx5e = await fetchConstituents("SX5E");
      expect(sx5e.constituents.length).toBe(50);
      expect(sx5e.constituents.find((c) => c.ticker === "ADYEN.AS")?.name).toBe("Adyen");
      const aex = await fetchConstituents("AEX");
      expect(aex.constituents.length).toBeGreaterThanOrEqual(25);
      const ukx = await fetchConstituents("FTSE 100");
      expect(ukx.constituents.length).toBeGreaterThanOrEqual(99);
      expect(ukx.constituents.find((c) => c.ticker === "III")?.name).toBe("3i");
    });
  }, 60_000);
});
