// From the agent's search hits to readable documents.
//
// The host agent searched (RESEARCH.todo.json); its hits come back as a JSON
// file, one ranked list per query. Optionally the engine's keyless search
// engines add their own lists. The lists are fused by reciprocal rank on the
// canonical URL, then each page is read — HTML through the engine's extractor,
// PDFs through its extraction ladder — and a page that is a wall (consent,
// anti-bot, a JavaScript shell, next to no prose) is dropped with its reason.
//
// Every byte goes through core/net.ts, so a research run records and replays
// like any other; the engine contributes only pure functions over the bytes.
// Pages are read concurrently; what is kept is returned in a fixed order, so
// the evidence they become is numbered the same way on every replay.
import {
  canonicalizeUrl,
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
  parseDdgLite,
  parseMojeek,
  sniffDocument,
} from "../engine.js";
import { FixtureMiss, fetchBytes, fetchText, netMode } from "../core/net.js";

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
}

export interface Dropped {
  url: string;
  reason: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function toHit(raw: unknown, angle?: string, query?: string): WebHit | undefined {
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
 * `{url, title?, snippet?}` (`link`/`href`, `description` read too).
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
  visit(raw);
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
 * The engine's keyless search engines over the worklist's queries, one list
 * per query and engine — never in fixture mode (a replay has no search to
 * replay unless it was recorded, and the agent's hits are the input then).
 */
export async function engineSearch(
  queries: readonly { query: string; angle: string }[],
  opts: { perQuery?: number } = {},
): Promise<{ lists: WebHit[][]; notes: string[] }> {
  const notes: string[] = [];
  const lists: WebHit[][] = [];
  if (netMode().kind === "fixture") return { lists, notes: ["--engine-search is off while replaying a fixture: the recorded web results are the input"] };
  const engines: Array<{
    name: string;
    url: (q: string) => string;
    parse: (body: string, limit: number) => Array<{ url: string; title: string; snippet: string }>;
  }> = [
    { name: "ddglite", url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDdgLite },
    { name: "mojeek", url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, parse: parseMojeek },
  ];
  for (const { query, angle } of queries) {
    for (const e of engines) {
      const res = await fetchText(e.url(query), { userAgent: "browser", accept: "text/html", hostIntervalMs: 2000, timeoutMs: 15_000, retries: 0 });
      if (!res.ok) {
        notes.push(`${e.name} gave nothing for "${query}" (${res.status}${res.error ? `, ${res.error}` : ""})`);
        continue;
      }
      if (looksLikeChallenge(res.body)) {
        notes.push(`${e.name} answered "${query}" with a challenge page: skipped`);
        continue;
      }
      const hits = e.parse(res.body, opts.perQuery ?? 8).map((h) => ({ url: h.url, title: h.title, snippet: h.snippet, angle, query }));
      if (hits.length) lists.push(hits);
    }
  }
  return { lists, notes };
}

const PAGE_TIMEOUT_MS = 20_000;

/** Read one candidate in full: its text, title and publication date — or why it is no document. */
export async function readCandidate(c: Candidate): Promise<{ page?: ReadPage; dropped?: Dropped }> {
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

/**
 * Read the top candidates — concurrently, a few at a time, each host paced by
 * net.ts — and keep the documents, near-duplicates collapsed, in rank order.
 */
export async function readCandidates(
  cands: readonly Candidate[],
  opts: { max: number; concurrency?: number },
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
  const reads = await mapLimit(toRead, opts.concurrency ?? 4, (c) => readCandidate(c));
  const pages: ReadPage[] = [];
  for (const r of reads) {
    if (r.page) pages.push(r.page);
    else if (r.dropped) dropped.push(r.dropped);
  }
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
