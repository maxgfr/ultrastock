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

// ─── the pulse: how much coverage, and in what tone ──────────────────────
//
//   GDELT DOC 2.0 timelines   …/doc/doc?query=…&mode=timelinevolraw|timelinetone&timespan=30d&format=json
//   {"timeline":[{"series":"Article Count"|"Average Tone","data":[{"date":"20261006T000000Z","value":12,…}]}]}
//   A day with no article is absent from both series. Tone is GDELT's machine
//   score of each article's wording, about −10 to +10 in practice (−100…+100 in
//   theory), averaged over the day's articles.

export interface DayValue {
  date: string;
  value: number;
}

/** The first series of a GDELT timeline answer as day values, oldest first. */
export function parseGdeltTimeline(js: { timeline?: Array<{ data?: Array<{ date?: string; value?: number }> }> }): DayValue[] {
  return (js.timeline?.[0]?.data ?? [])
    .flatMap((d) => {
      const m = /^(\d{4})(\d{2})(\d{2})/.exec(d.date ?? "");
      return m && typeof d.value === "number" && Number.isFinite(d.value) ? [{ date: `${m[1]}-${m[2]}-${m[3]}`, value: d.value }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const PULSE_DAYS = 30;
export const PULSE_RECENT_VOLUME = 3;
export const PULSE_RECENT_TONE = 7;

export interface NewsPulse {
  /** The last full day (yesterday, UTC). */
  last: string;
  volume: { recent: number; base: number; ratio?: number; recentDays: number; baseDays: number };
  tone?: { recent?: number; base?: number; recentDays: number; baseDays: number };
}

/**
 * Coverage over the last full days against the rest of the window: daily
 * article counts (a day GDELT does not list is zero articles) and the
 * article-weighted mean tone. Today, still filling, is left out.
 */
export function newsPulse(volume: readonly DayValue[], tone: readonly DayValue[], now: Date, days = PULSE_DAYS): NewsPulse {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayAt = (i: number) => new Date(midnight - i * 86_400_000).toISOString().slice(0, 10);
  const window = Array.from({ length: days - 1 }, (_, i) => dayAt(days - 1 - i)); // oldest → yesterday
  const vol = new Map(volume.map((d) => [d.date, d.value]));
  const tn = new Map(tone.map((d) => [d.date, d.value]));
  const counts = window.map((d) => vol.get(d) ?? 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const rv = counts.slice(-PULSE_RECENT_VOLUME);
  const bv = counts.slice(0, -PULSE_RECENT_VOLUME);
  const base = mean(bv);
  const out: NewsPulse = {
    last: window[window.length - 1]!,
    volume: { recent: mean(rv), base, ...(base > 0 ? { ratio: mean(rv) / base } : {}), recentDays: rv.length, baseDays: bv.length },
  };
  if (tn.size) {
    const weighted = (ds: string[]) => {
      let w = 0;
      let s = 0;
      for (const d of ds) {
        const t = tn.get(d);
        if (t === undefined) continue;
        const n = vol.get(d) ?? 1;
        w += n;
        s += t * n;
      }
      return w > 0 ? s / w : undefined;
    };
    const rt = window.slice(-PULSE_RECENT_TONE);
    const bt = window.slice(0, -PULSE_RECENT_TONE);
    out.tone = { recent: weighted(rt), base: weighted(bt), recentDays: rt.length, baseDays: bt.length };
  }
  return out;
}

async function gdeltTimeline(
  query: string,
  mode: "timelinevolraw" | "timelinetone",
  days: number,
): Promise<{ data: DayValue[]; url: string; fetchedAt: string }> {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=${mode}&timespan=${days}d&format=json`;
  const res = await fetchText(url, { hostIntervalMs: 5200, retries: 0 });
  if (!res.ok) throw new ProviderError("gdelt", `timeline unavailable (HTTP ${res.status})`, res.status);
  if (!res.body.trim()) return { data: [], url: res.url, fetchedAt: res.fetchedAt };
  let js: Parameters<typeof parseGdeltTimeline>[0];
  try {
    js = JSON.parse(res.body);
  } catch {
    throw new ProviderError("gdelt", `query refused: ${res.body.slice(0, 120)}`, /limit requests/i.test(res.body) ? 429 : 400);
  }
  return { data: parseGdeltTimeline(js), url: res.url, fetchedAt: res.fetchedAt };
}

/** GDELT's coverage volume and tone for `query` over the last `days` days, as a dataset. */
export async function gdeltPulse(query: string, opts: { symbol?: string; days?: number; now?: Date } = {}): Promise<Dataset> {
  const days = opts.days ?? PULSE_DAYS;
  const vol = await gdeltTimeline(query, "timelinevolraw", days);
  let tone: DayValue[] = [];
  const notes: string[] = [];
  try {
    tone = (await gdeltTimeline(query, "timelinetone", days)).data;
  } catch (e) {
    const err = e instanceof FixtureMiss ? new ProviderError("gdelt", "did not answer when the fixture was recorded", 0) : e;
    if (!(err instanceof ProviderError)) throw err;
    notes.push(`GDELT tone unavailable: ${err.message}`);
  }
  const p = newsPulse(vol.data, tone, opts.now ?? new Date(vol.fetchedAt), days);
  const S = (opts.symbol ?? "NEWS").toUpperCase();
  const k = `${S}.news.pulse`;
  const v = p.volume;
  const points: Point[] = [
    { key: `${k}.volume.recent`, label: `${S} articles a day in GDELT, last ${v.recentDays} full days`, value: v.recent, unit: "count", asOf: p.last },
    { key: `${k}.volume.base`, label: `${S} articles a day in GDELT, the ${v.baseDays} days before`, value: v.base, unit: "count", asOf: p.last },
  ];
  if (v.ratio !== undefined)
    points.push({
      key: `${k}.volume.ratio`,
      label: `${S} news coverage: last ${v.recentDays} days vs the ${v.baseDays} before`,
      value: v.ratio,
      unit: "x",
      formula: `mean daily articles last ${v.recentDays} days / mean daily articles the ${v.baseDays} days before`,
      asOf: p.last,
    });
  const t = p.tone;
  if (t?.recent !== undefined)
    points.push({
      key: `${k}.tone.recent`,
      label: `${S} mean news tone, last ${t.recentDays} days (GDELT, machine-scored; below 0 negative)`,
      value: t.recent,
      unit: "index",
      asOf: p.last,
    });
  if (t?.base !== undefined)
    points.push({ key: `${k}.tone.base`, label: `${S} mean news tone, the ${t.baseDays} days before (GDELT)`, value: t.base, unit: "index", asOf: p.last });
  if (t?.recent !== undefined && t.base !== undefined)
    points.push({
      key: `${k}.tone.change`,
      label: `${S} news tone change: last ${t.recentDays} days minus the ${t.baseDays} before`,
      value: t.recent - t.base,
      unit: "index",
      formula: "mean tone recent − mean tone before (article-weighted)",
      asOf: p.last,
    });
  return {
    kind: "news",
    title: `News pulse — coverage and tone over ${days} days (GDELT)`,
    subject: S,
    points,
    provenance: { source: "gdelt", url: vol.url, fetchedAt: vol.fetchedAt, official: false, asOf: p.last },
    notes: [
      `GDELT monitors news sites worldwide; "${query}" matches article text, so a common word inflates the count`,
      "tone is GDELT's machine score of the wording (about −10 to +10 in practice), averaged per article: a reading of the coverage, not of the facts",
      ...notes,
    ],
  };
}
