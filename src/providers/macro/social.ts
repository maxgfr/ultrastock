// Retail attention, keyless — how much a name is talked about and looked up,
// not what the crowd thinks of it:
//
//   ApeWisdom   https://apewisdom.io/api/v1.0/filter/all-stocks/page/<n>  (all-crypto for coins)
//               Reddit mentions and upvotes over the last 24 hours, the rank among the
//               tickers it counts, and the same 24 hours earlier (unofficial; undocumented
//               shape; US-listed tickers and coins only). ~100 tickers a page, a handful of pages.
//   Wikidata    https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=haswbstatement:<P>=<id>
//               the item of an issuer from its ISIN (P946) or SEC CIK (P5531, ten digits),
//               then wbgetentities for its Wikipedia article title (official, Wikimedia).
//   Wikimedia   https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/<project>/all-access/user/<title>/daily/<from>/<to>
//               daily human pageviews of that article (official; the last full day is yesterday).
//
// StockTwits, Reddit's own JSON and the AAII survey refuse a keyless client
// (HTTP 403) and are left out. A name the source does not rank is said so,
// never counted as zero mentions.
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow, fetchJson, politeUa } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { isoDate } from "./common.js";

// ─── ApeWisdom ────────────────────────────────────────────────────────────

export interface ApeRow {
  rank: number;
  ticker: string;
  name?: string;
  mentions: number;
  upvotes?: number;
  rank_24h_ago?: number;
  mentions_24h_ago?: number;
}

interface ApeAnswer {
  count?: number;
  pages?: number;
  current_page?: number;
  results?: Array<Record<string, unknown>>;
}

const num = (v: unknown): number | undefined => {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
};

/** One ApeWisdom page as rows; rows without a ticker, rank or mention count are dropped. */
export function parseApewisdom(js: ApeAnswer): { rows: ApeRow[]; pages: number; count: number } {
  const rows: ApeRow[] = [];
  for (const r of js.results ?? []) {
    const ticker = typeof r.ticker === "string" ? r.ticker.trim().toUpperCase() : "";
    const rank = num(r.rank);
    const mentions = num(r.mentions);
    if (!ticker || rank === undefined || mentions === undefined) continue;
    rows.push({
      rank,
      ticker,
      name: typeof r.name === "string" ? r.name.replace(/&amp;/g, "&") : undefined,
      mentions,
      upvotes: num(r.upvotes),
      rank_24h_ago: num(r.rank_24h_ago),
      mentions_24h_ago: num(r.mentions_24h_ago),
    });
  }
  return { rows, pages: num(js.pages) ?? 1, count: num(js.count) ?? rows.length };
}

export interface ApeBoard {
  rows: Map<string, ApeRow>;
  /** Tickers ApeWisdom counts in all (its own total), and how many were read. */
  count: number;
  read: number;
  complete: boolean;
  url: string;
  fetchedAt: string;
}

export const APE_MAX_PAGES = 7;
const boards = new Map<string, Promise<ApeBoard>>();

/** ApeWisdom's ranking (stocks or crypto), up to APE_MAX_PAGES pages, read once per process. */
export function apewisdomBoard(filter: "all-stocks" | "all-crypto"): Promise<ApeBoard> {
  let b = boards.get(filter);
  if (!b) {
    b = readBoard(filter);
    boards.set(filter, b);
    b.catch(() => boards.delete(filter));
  }
  return b;
}

async function readBoard(filter: string): Promise<ApeBoard> {
  const rows = new Map<string, ApeRow>();
  let pages = 1;
  let count = 0;
  let url = "";
  let fetchedAt = "";
  let page = 1;
  for (; page <= Math.min(pages, APE_MAX_PAGES); page++) {
    const u = `https://apewisdom.io/api/v1.0/filter/${filter}/page/${page}`;
    const res = await fetchJson<ApeAnswer>(u, { userAgent: politeUa(), retries: 1 });
    if (!res.ok || !res.data) {
      if (page === 1) throw new ProviderError("apewisdom", `ranking unavailable (HTTP ${res.status})`, res.status);
      break; // a later page failing leaves a shorter board, said in `complete`
    }
    const p = parseApewisdom(res.data);
    if (page === 1) {
      pages = p.pages;
      count = p.count;
      url = res.url;
      fetchedAt = res.fetchedAt;
    }
    for (const r of p.rows) if (!rows.has(r.ticker)) rows.set(r.ticker, r);
  }
  return { rows, count, read: rows.size, complete: page > pages, url, fetchedAt };
}

/** The ticker ApeWisdom uses: the US symbol as is, a coin as "<BASE>.X"; undefined for a listing it does not rank. */
export function apeTicker(symbol: string, market: string, base?: string): string | undefined {
  if (market === "crypto") {
    const b = (base ?? symbol.replace(/(USDT|USDC|USD|EUR|BTC)$/i, "")).toUpperCase();
    return b ? `${b}.X` : undefined;
  }
  if (market === "us") return symbol.split("|")[0]!.toUpperCase();
  return undefined;
}

export function redditDataset(subject: string, ticker: string, board: ApeBoard, filter: string): Dataset {
  const r = board.rows.get(ticker);
  const k = `${subject}.social.reddit`;
  const points: Point[] = [];
  const notes = ["ApeWisdom counts Reddit mentions over the last 24 hours (unofficial, undocumented); a count of attention, not of opinion"];
  if (r) {
    const among = `among ${board.count} tickers ApeWisdom ranks`;
    points.push(
      { key: `${k}.rank`, label: `${subject} Reddit mentions rank (1 = most discussed, ${among})`, value: r.rank, unit: "rank" },
      { key: `${k}.mentions`, label: `${subject} Reddit mentions, last 24 hours`, value: r.mentions, unit: "count" },
    );
    if (r.mentions_24h_ago !== undefined)
      points.push({ key: `${k}.mentions_prev`, label: `${subject} Reddit mentions, the 24 hours before`, value: r.mentions_24h_ago, unit: "count" });
    if (r.rank_24h_ago !== undefined)
      points.push({ key: `${k}.rank_prev`, label: `${subject} Reddit mentions rank 24 hours earlier`, value: r.rank_24h_ago, unit: "rank" });
    if (r.upvotes !== undefined)
      points.push({ key: `${k}.upvotes`, label: `${subject} upvotes on the posts mentioning it, last 24 hours`, value: r.upvotes, unit: "count" });
  } else {
    notes.push(
      `${ticker} is not among the ${board.read} tickers read from ApeWisdom's ranking${board.complete ? "" : ` (the first ${APE_MAX_PAGES} pages of ${board.count})`}: too few Reddit mentions to rank, not zero`,
    );
  }
  return {
    kind: "social",
    title: `${subject} — Reddit attention (ApeWisdom)`,
    subject,
    points,
    provenance: {
      source: "apewisdom",
      url: board.url || `https://apewisdom.io/api/v1.0/filter/${filter}/page/1`,
      fetchedAt: board.fetchedAt,
      official: false,
      delay: "24h window",
    },
    notes,
  };
}

// ─── Wikipedia pageviews ──────────────────────────────────────────────────

export interface Pageview {
  date: string;
  views: number;
}

/** The Wikidata item holding `prop` = `value`, or undefined. */
export async function wikidataItem(prop: "P946" | "P5531", value: string): Promise<string | undefined> {
  const url = `https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:${prop}=${value}`)}&srlimit=2&format=json`;
  const res = await fetchJson<{ query?: { search?: Array<{ title?: string }> } }>(url, { userAgent: politeUa(), retries: 1 });
  if (!res.ok) throw new ProviderError("wikidata", `search unavailable (HTTP ${res.status})`, res.status);
  const hits = res.data?.query?.search ?? [];
  // Two items sharing an identifier is an ambiguity, not a match.
  return hits.length === 1 && /^Q\d+$/.test(hits[0]!.title ?? "") ? hits[0]!.title : undefined;
}

/** The item's article title on enwiki, else frwiki. */
export async function wikipediaTitle(qid: string): Promise<{ project: string; title: string } | undefined> {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki|frwiki&format=json`;
  const res = await fetchJson<{ entities?: Record<string, { sitelinks?: Record<string, { title?: string }> }> }>(url, { userAgent: politeUa(), retries: 1 });
  if (!res.ok) throw new ProviderError("wikidata", `entity unavailable (HTTP ${res.status})`, res.status);
  const links = res.data?.entities?.[qid]?.sitelinks ?? {};
  for (const [site, project] of [
    ["enwiki", "en.wikipedia"],
    ["frwiki", "fr.wikipedia"],
  ] as const) {
    const t = links[site]?.title;
    if (t) return { project, title: t };
  }
  return undefined;
}

export function parsePageviews(js: { items?: Array<{ timestamp?: string; views?: number }> }): Pageview[] {
  return (js.items ?? [])
    .flatMap((i) => {
      const m = /^(\d{4})(\d{2})(\d{2})/.exec(i.timestamp ?? "");
      return m && typeof i.views === "number" ? [{ date: `${m[1]}-${m[2]}-${m[3]}`, views: i.views }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const RECENT_DAYS = 7;
export const BASELINE_DAYS = 90;
export const SPIKE_RATIO = 2;

/**
 * The last RECENT_DAYS days' mean daily views against the mean of the
 * BASELINE_DAYS before them. Undefined when either window is under half full.
 */
export function attention(
  views: readonly Pageview[],
): { recent: number; baseline: number; ratio: number; recentDays: number; baselineDays: number; last: string } | undefined {
  if (!views.length) return undefined;
  const recent = views.slice(-RECENT_DAYS);
  const base = views.slice(-(RECENT_DAYS + BASELINE_DAYS), -RECENT_DAYS);
  if (recent.length < RECENT_DAYS / 2 || base.length < BASELINE_DAYS / 2) return undefined;
  const mean = (xs: readonly Pageview[]) => xs.reduce((s, x) => s + x.views, 0) / xs.length;
  const r = mean(recent);
  const b = mean(base);
  if (b <= 0) return undefined;
  return { recent: r, baseline: b, ratio: r / b, recentDays: recent.length, baselineDays: base.length, last: recent[recent.length - 1]!.date };
}

const ymd = (d: Date) => isoDate(d).replace(/-/g, "");

/** An issuer's Wikipedia attention, found from its ISIN or SEC CIK; undefined with the reason when no article is found. */
export async function wikipediaAttention(
  subject: string,
  ids: { isin?: string; cik?: number },
  now: Date = clockNow(),
): Promise<{ dataset?: Dataset; note?: string }> {
  let qid: string | undefined;
  if (ids.isin) qid = await wikidataItem("P946", ids.isin);
  if (!qid && ids.cik) qid = await wikidataItem("P5531", String(ids.cik).padStart(10, "0"));
  if (!qid)
    return {
      note: `Wikipedia attention: no Wikidata item carries ${subject}'s ${[ids.isin && `ISIN ${ids.isin}`, ids.cik && `CIK ${ids.cik}`].filter(Boolean).join(" or ") || "identifiers"}`,
    };
  const article = await wikipediaTitle(qid);
  if (!article) return { note: `Wikipedia attention: Wikidata ${qid} has no English or French article` };
  const end = new Date(now.getTime() - 86_400_000);
  const start = new Date(end.getTime() - (RECENT_DAYS + BASELINE_DAYS + 2) * 86_400_000);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${article.project}/all-access/user/${encodeURIComponent(article.title.replace(/ /g, "_"))}/daily/${ymd(start)}/${ymd(end)}`;
  const res = await fetchJson<{ items?: Array<{ timestamp?: string; views?: number }> }>(url, { userAgent: politeUa(), retries: 1 });
  if (!res.ok || !res.data) throw new ProviderError("wikimedia", `pageviews unavailable (HTTP ${res.status})`, res.status);
  const a = attention(parsePageviews(res.data));
  if (!a) return { note: `Wikipedia attention: too few days of pageviews for "${article.title}"` };
  const k = `${subject}.social.wiki`;
  const where = `"${article.title}" on ${article.project}`;
  return {
    dataset: {
      kind: "social",
      title: `${subject} — Wikipedia attention (Wikimedia pageviews)`,
      subject,
      points: [
        {
          key: `${k}.recent`,
          label: `${subject} mean daily Wikipedia views, last ${a.recentDays} days (${where})`,
          value: a.recent,
          unit: "count",
          asOf: a.last,
        },
        {
          key: `${k}.baseline`,
          label: `${subject} mean daily Wikipedia views, the ${a.baselineDays} days before`,
          value: a.baseline,
          unit: "count",
          asOf: a.last,
        },
        {
          key: `${k}.ratio`,
          label: `${subject} Wikipedia attention: last ${a.recentDays} days vs the ${a.baselineDays} before`,
          value: a.ratio,
          unit: "x",
          formula: `mean views last ${a.recentDays} days / mean views the ${a.baselineDays} days before`,
          asOf: a.last,
        },
        { key: `${k}.spike`, label: `${subject} Wikipedia attention spike (ratio ≥ ${SPIKE_RATIO})`, value: a.ratio >= SPIKE_RATIO, asOf: a.last },
      ],
      provenance: { source: "wikimedia", url: res.url, fetchedAt: res.fetchedAt, official: true, delay: "1 day", asOf: a.last },
      notes: [
        `Wikidata ${qid} → ${where}; human views only (agent=user), all platforms`,
        "attention is not sentiment: a spike follows bad news as often as good",
      ],
    },
  };
}
