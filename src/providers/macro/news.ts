// Headlines from three keyless sources, merged, deduplicated and newest first
// (all unofficial: aggregators, not the publishers):
//
//   Google News RSS   https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en   (fr: hl=fr&gl=FR&ceid=FR:fr)
//                     up to 100 items; each title ends with " - <publisher>"; links are Google redirects.
//   GDELT DOC 2.0     https://api.gdeltproject.org/api/v2/doc/doc?query=…&mode=artlist&format=json&maxrecords=N&timespan=7d
//                     one request per 5 seconds (paced here); a 429 is a plain-text "please limit requests".
//   Yahoo Finance     https://feeds.finance.yahoo.com/rss/2.0/headline?s=<SYM>   per-ticker; answers an identified
//                     client (politeUa) and often 429s a browser User-Agent.
//
// Feeds are fetched with fetchText and parsed with the engine's parseFeed so a
// fixture replays them (the engine's fetchFeed would bypass net.ts). Every
// headline and publisher name is external text: one untrusted point per
// article, its URL attached.
import type { Dataset, Point } from "../../core/datasets.js";
import { parseFeed } from "../../engine.js";
import { FixtureMiss, fetchText, politeUa } from "../../core/net.js";
import { ProviderError } from "../types.js";

export interface Article {
  title: string;
  /** Publisher or domain, as the source names it. */
  source?: string;
  /** ISO timestamp (UTC), when the source dates the article. */
  published?: string;
  url: string;
  via: "google-news" | "gdelt" | "yahoo";
}

const toIso = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  // GDELT: 20261024T120000Z
  const g = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s.trim());
  if (g) return `${g[1]}-${g[2]}-${g[3]}T${g[4]}:${g[5]}:${g[6]}Z`;
  // RSS dates carry their zone (RFC 822 "GMT" / "+0000"), so Date.parse does not guess one.
  if (!/(GMT|UTC|Z|[+-]\d{2}:?\d{2})\s*$/i.test(s.trim())) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().replace(/\.000Z$/, "Z");
};

/** Google News RSS as articles; the trailing " - Publisher" of each title becomes `source`. */
export function parseGoogleNews(xml: string, baseUrl?: string): Article[] {
  const feed = parseFeed(xml, baseUrl);
  if (!feed) return [];
  return feed.items.flatMap((it) => {
    if (!it.title || !it.url) return [];
    const m = /^(.*\S)\s+-\s+([^-]{2,80})$/.exec(it.title.trim());
    return [{ title: m ? m[1]! : it.title.trim(), source: m?.[2]?.trim(), published: toIso(it.published), url: it.url, via: "google-news" as const }];
  });
}

/** A Yahoo Finance headline RSS as articles. */
export function parseYahooRss(xml: string, baseUrl?: string): Article[] {
  const feed = parseFeed(xml, baseUrl);
  return (feed?.items ?? []).flatMap((it) =>
    it.title && it.url ? [{ title: it.title.trim(), published: toIso(it.published), url: it.url, via: "yahoo" as const }] : [],
  );
}

/** GDELT's artlist JSON as articles. */
export function parseGdelt(js: { articles?: Array<{ url?: string; title?: string; seendate?: string; domain?: string }> }): Article[] {
  return (js.articles ?? []).flatMap((a) =>
    a.title && a.url ? [{ title: a.title.trim(), source: a.domain, published: toIso(a.seendate), url: a.url, via: "gdelt" as const }] : [],
  );
}

const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 1),
  );

/** Word-set Jaccard similarity of two titles, 0–1. */
export function titleSimilarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Newest first, near-duplicate titles (similarity ≥ `threshold`) collapsed onto the newest copy. */
export function dedupeArticles(articles: readonly Article[], threshold = 0.75): Article[] {
  const sorted = [...articles].sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
  const kept: Article[] = [];
  for (const a of sorted) if (!kept.some((k) => k.url === a.url || titleSimilarity(k.title, a.title) >= threshold)) kept.push(a);
  return kept;
}

export type NewsLang = "en" | "fr";
const GN_LOCALE: Record<NewsLang, string> = { en: "hl=en-US&gl=US&ceid=US:en", fr: "hl=fr&gl=FR&ceid=FR:fr" };

export async function googleNewsArticles(query: string, lang: NewsLang = "en", days = 7): Promise<{ articles: Article[]; url: string; fetchedAt: string }> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${days}d`)}&${GN_LOCALE[lang]}`;
  const res = await fetchText(url, { accept: "application/rss+xml, application/xml" });
  if (!res.ok) throw new ProviderError("google-news", `search unavailable (HTTP ${res.status})`, res.status);
  return { articles: parseGoogleNews(res.body, res.url), url: res.url, fetchedAt: res.fetchedAt };
}

export async function gdeltArticles(query: string, days = 7, max = 50): Promise<{ articles: Article[]; url: string; fetchedAt: string }> {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=${max}&timespan=${days}d&sort=datedesc`;
  const res = await fetchText(url, { hostIntervalMs: 5200, retries: 0 });
  if (!res.ok) throw new ProviderError("gdelt", `DOC API unavailable (HTTP ${res.status})`, res.status);
  // An empty result is "{}" or nothing; a refused query is a plain-text sentence.
  if (!res.body.trim()) return { articles: [], url: res.url, fetchedAt: res.fetchedAt };
  let js: Parameters<typeof parseGdelt>[0];
  try {
    js = JSON.parse(res.body);
  } catch {
    throw new ProviderError("gdelt", `query refused: ${res.body.slice(0, 120)}`, /limit requests/i.test(res.body) ? 429 : 400);
  }
  return { articles: parseGdelt(js), url: res.url, fetchedAt: res.fetchedAt };
}

export async function yahooArticles(symbol: string): Promise<{ articles: Article[]; url: string; fetchedAt: string }> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const res = await fetchText(url, { accept: "application/rss+xml, application/xml", retries: 0, userAgent: politeUa() });
  if (!res.ok) throw new ProviderError("yahoo", `headline feed unavailable (HTTP ${res.status})`, res.status);
  return { articles: parseYahooRss(res.body, res.url), url: res.url, fetchedAt: res.fetchedAt };
}

/** Articles as a dataset: one untrusted point per article ("title | source"), its URL attached. */
export function articlesToDataset(
  articles: readonly Article[],
  meta: { subject: string; title: string; source: string; url: string; fetchedAt: string; notes: string[] },
): Dataset {
  const points: Point[] = articles.map((a, i) => ({
    key: `${meta.subject}.news.${i + 1}`,
    label: `headline ${i + 1}${a.published ? ` (${a.published.slice(0, 16).replace("T", " ")} UTC)` : ""}`,
    value: a.source ? `${a.title} | ${a.source}` : a.title,
    untrusted: true,
    url: a.url,
    asOf: a.published?.slice(0, 10),
  }));
  return {
    kind: "news",
    title: meta.title,
    subject: meta.subject,
    points,
    provenance: { source: meta.source, url: meta.url, fetchedAt: meta.fetchedAt, official: false },
    notes: meta.notes,
  };
}

/**
 * Headlines about `query` over the last `days` days from Google News and GDELT,
 * merged, deduplicated by title and newest first. Yahoo Finance's ticker feed
 * (a broad market feed more than a per-ticker one) stands in only when a ticker
 * is given and the others returned nothing. A source that fails is named in the
 * notes; all failing throws.
 */
export async function newsSearch(
  query: string,
  opts: { lang?: NewsLang; days?: number; limit?: number; symbol?: string; sources?: ReadonlyArray<"google-news" | "gdelt" | "yahoo"> } = {},
): Promise<Dataset> {
  const days = opts.days ?? 7;
  const sources: Array<"google-news" | "gdelt" | "yahoo"> = [...(opts.sources ?? ["google-news", "gdelt"])];
  const all: Article[] = [];
  const notes: string[] = [];
  const used: Array<{ source: string; url: string; fetchedAt: string }> = [];
  const errors: ProviderError[] = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!;
    try {
      const r =
        s === "google-news"
          ? await googleNewsArticles(query, opts.lang ?? "en", days)
          : s === "gdelt"
            ? await gdeltArticles(query, days)
            : await yahooArticles(opts.symbol ?? query);
      all.push(...r.articles);
      used.push({ source: s, url: r.url, fetchedAt: r.fetchedAt });
      notes.push(`${s}: ${r.articles.length} articles`);
    } catch (e) {
      // A source missing from a fixture is one that did not answer while recording.
      const err = e instanceof FixtureMiss ? new ProviderError(s, "did not answer when the fixture was recorded", 0) : e;
      if (!(err instanceof ProviderError)) throw err;
      errors.push(err);
      notes.push(`${s} unavailable: ${err.message}`);
    }
    if (i === sources.length - 1 && !all.length && opts.symbol && !sources.includes("yahoo")) sources.push("yahoo");
  }
  if (!used.length) throw errors[0] ?? new ProviderError("news", "no source answered");
  const kept = dedupeArticles(all).slice(0, opts.limit ?? 25);
  const subject = (opts.symbol ?? "NEWS").toUpperCase();
  return articlesToDataset(kept, {
    subject,
    title: `News — last ${days} days (${used.map((u) => u.source).join(" + ")})`,
    source: used.map((u) => u.source).join("+"),
    url: used[0]!.url,
    fetchedAt: used[0]!.fetchedAt,
    notes: [...notes, `${kept.length} kept after merging and removing near-duplicate titles; aggregator links, not publisher pages.`],
  });
}
