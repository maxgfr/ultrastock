// From the agent's search hits to readable documents.
//
// The host agent searched (RESEARCH.todo.json); its hits come back as a JSON
// file, one ranked list per query — or an agent CLI searched for us
// (delegate.ts), or the engine's search cascade did (a local SearXNG first,
// keyless engines after). The lists are fused by reciprocal rank on the
// canonical URL, then each page is read — HTML through the engine's extractor,
// PDFs through its extraction ladder — and a page that is a wall (consent,
// anti-bot, a JavaScript shell, next to no prose) or refused (403, 429…) goes
// down a rescue ladder: the Wayback Machine's copy, then (opt-in) a render in a
// separate browser. What still fails is dropped with its reason. From an
// official page, the reports it links to (a press release PDF, the financial
// report, the presentation) are read too, one hop and a few at most.
//
// Plain reads go through core/net.ts; the engine's own I/O (search cascade,
// Wayback, browser) goes through `recordedCall` — so a research run records
// and replays like any other. Pages are read concurrently; what is kept is
// returned in a fixed order, so the evidence they become is numbered the same
// way on every replay.
import {
  canonicalizeUrl,
  closeBrowserReads,
  dedupeNearDuplicates,
  domainOf,
  extractFromHtml,
  extractPdf,
  fuse,
  looksLikeChallenge,
  looksLikePdfUrl,
  looksLikeWall,
  mapLimit,
  pageMetadata,
  readRenderedPage,
  rescueViaWayback,
  search as engineSearchCascade,
  sniffDocument,
} from "../engine.js";
import { FixtureMiss, fetchBytes, fetchText, recordedCall } from "../core/net.js";
import { officialHost } from "./dossier.js";

/** One search hit, as the agent's web search (or an engine) returned it. */
export interface WebHit {
  url: string;
  title?: string;
  snippet?: string;
  /** The angle (RESEARCH.todo.json id) whose query surfaced it. */
  angle?: string;
  query?: string;
}

/** A fused candidate: a hit plus its fusion score and every angle that surfaced it. */
export interface Candidate {
  url: string;
  title?: string;
  snippet?: string;
  score: number;
  text?: string;
  meta?: Record<string, unknown>;
  angles: string[];
}

/** A page read in full. */
export interface ReadPage extends Candidate {
  finalUrl: string;
  text: string;
  fetchedAt: string;
  publishedAt?: string;
  pdf: boolean;
  /** How it was read when not directly: "Wayback copy of 2026-07-28", "rendered in a browser", "linked from <url>". */
  via?: string;
}

/** How hard to try on a page that refuses a plain read. */
export interface ReadOptions {
  /** The Wayback Machine's latest copy (default on). */
  wayback?: boolean;
  /** A render in a separate browser — opens a window; off unless asked. */
  browser?: boolean;
}

export interface Dropped {
  url: string;
  reason: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function toHit(raw: unknown, angle?: string, query?: string): WebHit | undefined {
  if (typeof raw === "string") return /^https?:\/\//i.test(raw.trim()) ? { url: raw.trim(), angle, query } : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const url = str(r.url) ?? str(r.link) ?? str(r.href);
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return {
    url,
    title: str(r.title) ?? str(r.name),
    snippet: str(r.snippet) ?? str(r.description) ?? str(r.excerpt) ?? str(r.page_age),
    angle: str(r.angle) ?? angle,
    query: str(r.query) ?? query,
  };
}

/**
 * The ranked lists in an agent's web-results file. Accepted shapes, so any
 * harness's search output fits: `[{angle, query, results: [hit…]}]`, a flat
 * `[hit…]`, or `{results: […]}` / `{queries: […]}` wrapping either. A hit is
 * `{url, title?, snippet?}` (`link`/`href`, `description` read too) or a bare
 * URL string.
 */
export function parseWebResults(raw: unknown): { lists: WebHit[][]; skipped: number } {
  const lists: WebHit[][] = [];
  let skipped = 0;
  const flat: WebHit[] = [];
  const visit = (v: unknown, angle?: string, query?: string) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x, angle, query);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const nested = Array.isArray(o.results) ? o.results : Array.isArray(o.queries) ? o.queries : Array.isArray(o.hits) ? o.hits : undefined;
    if (nested) {
      const a = str(o.angle) ?? angle;
      const q = str(o.query) ?? query;
      if (Array.isArray(o.results) || Array.isArray(o.hits)) {
        const list = (nested as unknown[]).map((h) => toHit(h, a, q));
        skipped += list.filter((h) => !h).length;
        const kept = list.filter((h): h is WebHit => !!h);
        if (kept.length) lists.push(kept);
      } else visit(nested, a, q);
      return;
    }
    const hit = toHit(o, angle, query);
    if (hit) flat.push(hit);
    else skipped++;
  };
  // A bare string at the top of a list is a URL the agent pasted.
  const visitAll = (v: unknown) => {
    if (Array.isArray(v))
      for (const x of v) {
        if (typeof x === "string") {
          const h = toHit(x);
          if (h) flat.push(h);
          else skipped++;
        } else visit(x);
      }
    else visit(v);
  };
  visitAll(raw);
  if (flat.length) lists.push(flat);
  return { lists, skipped };
}

/** Fuse the lists into one ranking, remembering every angle that surfaced each URL. */
export function fuseHits(lists: readonly WebHit[][], excluded: (url: string) => boolean = () => false): Candidate[] {
  const anglesOf = new Map<string, Set<string>>();
  const ranked = lists.map((list) =>
    list
      .filter((h) => !excluded(h.url))
      .map((h) => {
        const key = canonicalizeUrl(h.url);
        if (h.angle) anglesOf.set(key, (anglesOf.get(key) ?? new Set()).add(h.angle));
        return { url: h.url, title: h.title, snippet: h.snippet, score: 0, meta: h.query ? { query: h.query } : {} };
      }),
  );
  return fuse(ranked).map((c) => ({ ...c, angles: [...(anglesOf.get(canonicalizeUrl(c.url)) ?? [])].sort() }));
}

// Hosts whose pages are no document to cite: video, social feeds, search pages.
const NOT_A_DOCUMENT =
  /(?:^|\.)(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|pinterest\.com|google\.[a-z.]+|bing\.com|duckduckgo\.com)$/i;

export function notADocument(url: string): boolean {
  const host = domainOf(url);
  return !host || NOT_A_DOCUMENT.test(host);
}

/**
 * The engine's search cascade over the worklist's queries — a local SearXNG
 * (`webindex stack up`, or ULTRASTOCK_SEARXNG) first, then the keyless engines
 * (DuckDuckGo, Mojeek), which throttle quickly: an amplifier next to the
 * agent's own search, never a replacement. One list per query; recorded.
 */
export async function engineSearch(
  queries: readonly { query: string; angle: string; lang?: string }[],
  opts: { perQuery?: number } = {},
): Promise<{ lists: WebHit[][]; notes: string[] }> {
  const notes: string[] = [];
  const lists: WebHit[][] = [];
  for (const { query, angle, lang } of queries) {
    let r: { hits: Array<{ url: string; title: string; snippet: string; via: string }>; notes: string[] };
    try {
      r = await recordedCall(
        "engine-search",
        [query, lang ?? null],
        async () => {
          const got = await engineSearchCascade(query, { limit: opts.perQuery ?? 8, lang, timeoutMs: 25_000 });
          return { hits: got.hits, notes: got.notes };
        },
        (x) => x.hits.length > 0,
      );
    } catch (e) {
      notes.push(`engine search failed for "${query}": ${(e as Error).message.split("\n")[0]!.slice(0, 160)}`);
      continue;
    }
    for (const n of r.notes) notes.push(`engine search, "${query}": ${n}`);
    const hits = r.hits.map((h) => ({ url: h.url, title: h.title, snippet: h.snippet, angle, query }));
    if (hits.length) lists.push(hits);
  }
  return { lists, notes: [...new Set(notes)].slice(0, 12) };
}

const PAGE_TIMEOUT_MS = 20_000;

/** Read one candidate in full: its text, title and publication date — or why it is no document, after the rescue ladder. */
export async function readCandidate(c: Candidate, opts: ReadOptions = {}): Promise<{ page?: ReadPage; dropped?: Dropped }> {
  const first = await readPlain(c);
  if (first.page || !first.dropped || !rescuable(first.dropped.reason)) return first;
  const tried: string[] = [first.dropped.reason];
  if (opts.wayback !== false) {
    const w = await waybackCopy(c);
    if (w.page) return w;
    tried.push(w.why);
  }
  if (opts.browser) {
    const b = await renderedCopy(c);
    if (b.page) return b;
    tried.push(b.why);
  }
  return { dropped: { url: c.url, reason: tried.join("; then ") } };
}

/**
 * A refusal or a wall can be got round; a 404 or an empty PDF cannot. A page
 * missing from a fixture is one that did not answer while recording — the
 * rescue rungs ran then, so their recorded answers are tried on replay too.
 */
function rescuable(reason: string): boolean {
  if (/PDF without|^HTTP 404|^HTTP 410/.test(reason)) return false;
  return /^HTTP|wall|challenge|anti-bot|near-empty|shell|consent|timed? ?out|abort|not in the recorded fixture/i.test(reason);
}

async function waybackCopy(c: Candidate): Promise<{ page?: ReadPage; why: string }> {
  try {
    const got = await recordedCall("wayback", c.url, async () => {
      const w = await rescueViaWayback(c.url);
      return w ? { ...w, fetchedAt: new Date().toISOString() } : null;
    });
    if (!got?.text?.trim()) return { why: "no Wayback copy" };
    const wall = looksLikeWall(got.text);
    if (wall) return { why: `the Wayback copy is a ${wall}` };
    const day = /^(\d{4})(\d{2})(\d{2})/.exec(got.timestamp);
    const when = day ? `${day[1]}-${day[2]}-${day[3]}` : got.timestamp;
    return {
      page: {
        ...c,
        title: got.title || c.title,
        finalUrl: got.snapshotUrl,
        text: got.text.trim(),
        fetchedAt: got.fetchedAt,
        pdf: false,
        via: `Wayback copy of ${when} (the live page refused)`,
      },
      why: "",
    };
  } catch (e) {
    return { why: e instanceof FixtureMiss ? "no Wayback copy recorded" : `Wayback failed (${(e as Error).message.slice(0, 80)})` };
  }
}

async function renderedCopy(c: Candidate): Promise<{ page?: ReadPage; why: string }> {
  try {
    const got = await recordedCall(
      "browser",
      c.url,
      async () => {
        const r = await readRenderedPage(c.url, { format: "markdown", stripConsent: true, timeoutMs: 30_000 });
        return { text: r.text ?? "", title: r.title, finalUrl: r.finalUrl || c.url, status: r.status, fetchedAt: new Date().toISOString() };
      },
      (x) => !!x.text.trim(),
    );
    const wall = got.text.trim() ? looksLikeWall(got.text) : "an empty page";
    if (wall) return { why: `the browser render is ${wall.startsWith("an ") ? wall : `a ${wall}`}` };
    return {
      page: {
        ...c,
        title: got.title || c.title,
        finalUrl: got.finalUrl,
        text: got.text.trim(),
        fetchedAt: got.fetchedAt,
        pdf: false,
        via: "rendered in a browser",
      },
      why: "",
    };
  } catch (e) {
    return { why: e instanceof FixtureMiss ? "no browser render recorded" : `the browser render failed (${(e as Error).message.slice(0, 80)})` };
  }
}

async function readPlain(c: Candidate): Promise<{ page?: ReadPage; dropped?: Dropped }> {
  const drop = (reason: string) => ({ dropped: { url: c.url, reason } });
  try {
    let pdfBytes: Buffer | undefined;
    let finalUrl = c.url;
    let fetchedAt: string;
    let html: string | undefined;
    if (looksLikePdfUrl(c.url)) {
      const r = await fetchBytes(c.url, { userAgent: "browser", timeoutMs: PAGE_TIMEOUT_MS, retries: 1, maxBytes: 40 * 1024 * 1024, hostIntervalMs: 1000 });
      if (!r.ok) return drop(`HTTP ${r.status}${r.error ? ` (${r.error})` : ""}`);
      ({ fetchedAt } = r);
      finalUrl = r.url;
      if (sniffDocument(r.bytes) === "pdf") pdfBytes = r.bytes;
      else html = r.bytes.toString("utf8");
    } else {
      const r = await fetchText(c.url, {
        userAgent: "browser",
        accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5",
        timeoutMs: PAGE_TIMEOUT_MS,
        retries: 1,
        maxBytes: 16 * 1024 * 1024,
        hostIntervalMs: 1000,
      });
      if (!r.ok) return drop(`HTTP ${r.status}${r.error ? ` (${r.error})` : ""}`);
      ({ fetchedAt } = r);
      finalUrl = r.url;
      if (r.body.startsWith("%PDF-")) {
        const b = await fetchBytes(c.url, { userAgent: "browser", timeoutMs: PAGE_TIMEOUT_MS, retries: 1, maxBytes: 40 * 1024 * 1024, hostIntervalMs: 1000 });
        if (!b.ok) return drop(`HTTP ${b.status} on the PDF`);
        pdfBytes = b.bytes;
      } else html = r.body;
    }
    if (pdfBytes) {
      const pdf = await extractPdf(pdfBytes);
      if (!pdf.text.trim()) return drop(`PDF without extractable text${pdf.reason ? ` (${pdf.reason})` : ""}`);
      const wall = looksLikeWall(pdf.text);
      if (wall && !wall.startsWith("near-empty")) return drop(wall);
      return { page: { ...c, finalUrl, text: pdf.text.trim(), fetchedAt, pdf: true } };
    }
    const body = html ?? "";
    if (looksLikeChallenge(body)) return drop("anti-bot challenge page");
    const ex = extractFromHtml(body, finalUrl, { format: "markdown", stripConsent: true });
    const text = (ex.text ?? "").trim();
    const wall = looksLikeWall(text);
    if (wall) return drop(wall);
    const meta = pageMetadata(body, { baseUrl: finalUrl });
    return {
      page: { ...c, title: ex.title?.trim() || meta.title || c.title, finalUrl, text, fetchedAt, publishedAt: meta.publishedAt, pdf: false },
    };
  } catch (e) {
    // A fixture keeps only the pages that answered: one that failed while recording is absent on replay.
    if (e instanceof FixtureMiss) return drop("not in the recorded fixture (it did not answer when recorded)");
    return drop((e as Error).message.split("\n")[0]!.slice(0, 160));
  }
}

// What an official page links to that is worth reading too: the report itself.
const REPORT_LINK =
  /press[\s_-]?release|communiqu|financial[\s_-]?report|rapport[\s_-]?financier|annual[\s_-]?report|rapport[\s_-]?annuel|half[\s_-]?year|semestri|quarter|trimestr|results|r[ée]sultats|presentation|pr[ée]sentation|10-?[kq]\b|20-?f\b|universal[\s_-]?registration|document[\s_-]d.enregistrement|\burd\b|kid|dic\b|factsheet|fiche/i;
/** Links a page's Markdown carries: [text](url). */
const MD_LINK = /\[([^\]]{0,200})\]\((https?:\/\/[^)\s]+)\)/g;
/** Linked reports read per page, and per round. */
export const LINKS_PER_PAGE = 2;
export const LINKS_PER_ROUND = 4;

/**
 * The PDF reports an official page links to — a release's PDF, the financial
 * report, the investor presentation, a fund's KID or factsheet — named so in
 * the link's text or its URL. Followed one hop only: a page links a crawl's
 * worth, and the research needs the report, not the site.
 */
export function linkedReports(page: Pick<ReadPage, "text" | "finalUrl">): string[] {
  const out: string[] = [];
  const self = canonicalizeUrl(page.finalUrl);
  for (const m of page.text.matchAll(MD_LINK)) {
    const [, text, url] = m;
    if (!looksLikePdfUrl(url!) || canonicalizeUrl(url!) === self) continue;
    if (!REPORT_LINK.test(text!) && !REPORT_LINK.test(decodeURIComponent(url!.split("?")[0]!.split("/").pop() ?? ""))) continue;
    if (!out.includes(url!)) out.push(url!);
    if (out.length >= LINKS_PER_PAGE) break;
  }
  return out;
}

/**
 * Read the top candidates — concurrently, a few at a time, each host paced by
 * net.ts — follow the reports official pages link to, and keep the documents,
 * near-duplicates collapsed, in rank order.
 */
export async function readCandidates(
  cands: readonly Candidate[],
  opts: { max: number; concurrency?: number; read?: ReadOptions; follow?: { name: string } },
): Promise<{ pages: ReadPage[]; dropped: Dropped[] }> {
  const dropped: Dropped[] = [];
  const pool = cands.filter((c) => {
    if (notADocument(c.url)) {
      dropped.push({ url: c.url, reason: "not a document (video, social feed or search page)" });
      return false;
    }
    return true;
  });
  // Read a little past the cap: walls and duplicates eat into it.
  const toRead = pool.slice(0, Math.ceil(opts.max * 1.5));
  // The browser rung shares one browser across reads: keep it to a single tab at a time.
  const width = opts.read?.browser ? 2 : (opts.concurrency ?? 4);
  const reads = await mapLimit(toRead, width, (c) => readCandidate(c, opts.read));
  const pages: ReadPage[] = [];
  for (const r of reads) {
    if (r.page) pages.push(r.page);
    else if (r.dropped) dropped.push(r.dropped);
  }
  if (opts.follow) {
    const known = new Set([...toRead.map((c) => canonicalizeUrl(c.url)), ...pages.map((p) => canonicalizeUrl(p.finalUrl))]);
    const links: Candidate[] = [];
    for (const p of pages) {
      const host = domainOf(p.finalUrl) ?? "";
      if (p.pdf || !officialHost(host, opts.follow.name)) continue;
      for (const url of linkedReports(p)) {
        if (known.has(canonicalizeUrl(url)) || links.length >= LINKS_PER_ROUND) continue;
        known.add(canonicalizeUrl(url));
        links.push({ url, score: p.score * 0.999, angles: p.angles, meta: { linkedFrom: p.finalUrl } });
      }
    }
    const linked = await mapLimit(links, 2, (c) => readCandidate(c, { wayback: false }));
    linked.forEach((r, i) => {
      if (r.page) pages.push({ ...r.page, via: `linked from ${String(links[i]!.meta?.linkedFrom)}` });
      else if (r.dropped) dropped.push({ ...r.dropped, reason: `${r.dropped.reason} (a report linked from ${String(links[i]!.meta?.linkedFrom)})` });
    });
  }
  if (opts.read?.browser) await closeBrowserReads().catch(() => undefined);
  const seen = new Set<string>();
  const unique = pages.filter((p) => {
    const key = canonicalizeUrl(p.finalUrl);
    if (seen.has(key)) {
      dropped.push({ url: p.url, reason: `same page as ${p.finalUrl}` });
      return false;
    }
    seen.add(key);
    return true;
  });
  const near = dedupeNearDuplicates(unique, { minChars: 400 });
  for (const d of near.duplicates) dropped.push({ url: d.url, reason: `near-duplicate of ${d.of}` });
  const kept = near.items.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)).slice(0, opts.max);
  for (const p of near.items.slice(opts.max)) dropped.push({ url: p.url, reason: `beyond the ${opts.max}-source cap` });
  return { pages: kept, dropped };
}
