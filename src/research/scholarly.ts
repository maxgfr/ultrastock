// Sourcing a strategy in its literature: how much a source's word weighs, and
// what the scholarly record says about the paper behind it.
//
// A strategy stands on papers, and papers are not equal: a peer-reviewed
// article outweighs the working paper it started as, which outweighs a
// preprint, a central bank's note, an asset manager's research and the press
// that reports any of them. Each document a `--kind strategy` research keeps
// is ranked by its host (evidenceTier), and the paper it is — the DOI or arXiv
// id in its URL or at the head of its text — is looked up in OpenAlex
// (keyless, read through net.ts so it records and replays): its venue, year,
// type, citation count and whether it was retracted, registered as an [E#]
// citable at doi.org. A working paper since published shows up with its
// journal: a DOI its page names under the same title. Only a DOI is ever
// sent, never anything of the user's. (OpenAlex's title search is left out:
// it is rate-limited without a key.)
//
// The seeds: the screen presets, the value styles, the backtest strategies and
// the allocation rules name the literature they follow in a fixed string.
// Researching one of them by name searches that literature first (the
// cited-source angle), so the reference ends up read and citable.
import { arxivIdFromUrl, deaccent, deriveCitableUrl, doiFromUrl, domainOf, normalizeDoi } from "../engine.js";
import { BUILTIN_PRESETS, TV_PRESETS } from "../analyze/screen/presets.js";
import { VALUE_STYLES } from "../analyze/value/styles.js";
import { ALLOCATION_SOURCES, ALLOCATIONS } from "../backtest/allocation.js";
import { BUILTIN_STRATEGIES } from "../backtest/catalog.js";
import { EvidenceStore } from "../core/evidence.js";
import { FixtureMiss, fetchJson, politeUa } from "../core/net.js";
import { sanitizeExternalText } from "../core/untrusted.js";
import type { ResearchAngle } from "./angles.js";
import type { RegisteredDoc } from "./dossier.js";

// ── Levels of evidence ─────────────────────────────────────────────────────

export const EVIDENCE_TIERS = ["peer-reviewed", "working-paper", "preprint", "institutional", "practitioner", "press"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

const JOURNALS =
  /(?:^|\.)(?:doi\.org|sciencedirect\.com|onlinelibrary\.wiley\.com|academic\.oup\.com|jstor\.org|link\.springer\.com|tandfonline\.com|cambridge\.org|aeaweb\.org)$/;
const WORKING_PAPERS = /(?:^|\.)(?:ssrn\.com|nber\.org|cepr\.org|ideas\.repec\.org|hal\.science)$/;
const PREPRINTS = /(?:^|\.)arxiv\.org$/;
// Central banks (the Fed's regional banks publish most of its research), the BIS, the IMF and the AMF's studies.
const INSTITUTIONS =
  /(?:^|\.)(?:federalreserve\.gov|(?:newyork|stlouis|chicago|boston|cleveland|kansascity|philadelphia|richmond|dallas|atlanta|minneapolis)fed\.org|frbsf\.org|bis\.org|imf\.org|ecb\.europa\.eu|banque-france\.fr|bankofengland\.co\.uk|amf-france\.org)$/;
const UNIVERSITIES = /\.(?:edu|ac\.uk)$/;
// Asset managers' and practitioners' research: data and argument, not peer review.
const PRACTITIONERS =
  /(?:^|\.)(?:aqr\.com|vanguard\.com|alphaarchitect\.com|researchaffiliates\.com|dimensional\.com|msci\.com|morningstar\.com|blackrock\.com|man\.com|cfainstitute\.org)$/;

const hostOf = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** The host a source is from: a Wayback copy's is the page it copied (the URL asked for), not the archive's. */
export function sourceHost(host: string, requestedUrl: string): string {
  return host === "web.archive.org" ? domainOf(requestedUrl) || host : host;
}

/** A journal's, a working-paper series', a preprint server's, a central bank's or a university's host: a strategy's official source. */
export function scholarlyHost(host: string): boolean {
  const h = hostOf(host);
  return JOURNALS.test(h) || WORKING_PAPERS.test(h) || PREPRINTS.test(h) || INSTITUTIONS.test(h) || UNIVERSITIES.test(h);
}

/**
 * How much a source weighs: what OpenAlex says the paper is when it was found
 * there, else what its host publishes. A university page is a working paper —
 * a faculty's draft, not the journal's version.
 */
export function evidenceTier(host: string, work?: Pick<ScholarlyWork, "type" | "venue" | "venueType">): EvidenceTier {
  const known = work ? workTier(work) : undefined;
  if (known) return known;
  const h = hostOf(host);
  if (JOURNALS.test(h)) return "peer-reviewed";
  if (WORKING_PAPERS.test(h) || UNIVERSITIES.test(h)) return "working-paper";
  if (PREPRINTS.test(h)) return "preprint";
  if (INSTITUTIONS.test(h)) return "institutional";
  if (PRACTITIONERS.test(h)) return "practitioner";
  return "press";
}

function workTier(w: Pick<ScholarlyWork, "type" | "venue" | "venueType">): EvidenceTier | undefined {
  // SSRN's papers are "preprints" to OpenAlex: working papers, as finance calls them; arXiv's are preprints.
  if (w.type === "preprint") return /arxiv/i.test(w.venue ?? "") ? "preprint" : "working-paper";
  if (w.type === "report") return "working-paper";
  if (w.venueType === "journal" && (w.type === "article" || w.type === "review" || w.type === "letter")) return "peer-reviewed";
  return undefined;
}

// ── Identifiers ────────────────────────────────────────────────────────────

const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"'<>()[\],;]+/g;

/** "https://doi.org/10.1093/RFS/hhaa116." → "10.1093/rfs/hhaa116": a DOI as written in a text, trailing punctuation off. */
const cleanDoi = (raw: string) => normalizeDoi(raw.replace(/[.,;:)\]]+$/, ""));

/** The DOI an arXiv id is registered under (DataCite's, which OpenAlex indexes). */
export const arxivDoi = (id: string) => `10.48550/arxiv.${id.toLowerCase()}`;

/**
 * The paper a document is: the DOI or arXiv id its URL carries, else the first
 * one at the head of its text (where a paper's page or PDF states its own).
 */
export function paperIdentifier(url: string, text: string): string | undefined {
  const fromUrl = doiFromUrl(url) ?? (arxivIdFromUrl(url) ? arxivDoi(arxivIdFromUrl(url)!) : undefined);
  if (fromUrl) return fromUrl;
  const cite = deriveCitableUrl(text);
  if (!cite) return undefined;
  const doi = doiFromUrl(cite);
  if (doi) return cleanDoi(doi);
  const arxiv = arxivIdFromUrl(cite);
  return arxiv ? arxivDoi(arxiv) : undefined;
}

/** Every DOI a text names, in order, once each — the studies a press page or a blog cites. */
export function citedDois(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DOI_IN_TEXT)) {
    const doi = cleanDoi(m[0]);
    if (!out.includes(doi)) out.push(doi);
    if (out.length >= max) break;
  }
  return out;
}

const fold = (s: string) =>
  deaccent(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// ── OpenAlex ───────────────────────────────────────────────────────────────

export interface ScholarlyWork {
  /** Normalised, without the resolver: "10.1093/rfs/hhaa116". */
  doi: string;
  title: string;
  year?: number;
  /** The journal or the series: "Review of Financial Studies", "National Bureau of Economic Research". */
  venue?: string;
  /** OpenAlex's kind of venue: journal, repository, conference… */
  venueType?: string;
  /** OpenAlex's type: article, preprint, report, review… */
  type: string;
  /** The publisher's type, when given: journal-article, posted-content, report. */
  rawType?: string;
  citedBy?: number;
  retracted: boolean;
}

const OPENALEX = "https://api.openalex.org/works";
const SELECT = "id,doi,display_name,publication_year,type,is_retracted,cited_by_count,primary_location";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** One OpenAlex work, as its API answers it. */
export function parseOpenAlexWork(raw: unknown): ScholarlyWork | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const doi = str(o.doi);
  const title = str(o.display_name) ?? str(o.title);
  if (!doi || !title) return undefined;
  const loc = (o.primary_location ?? {}) as Record<string, unknown>;
  const src = (loc.source ?? {}) as Record<string, unknown>;
  return {
    doi: normalizeDoi(doi),
    title,
    ...(typeof o.publication_year === "number" ? { year: o.publication_year } : {}),
    ...(str(src.display_name) ? { venue: str(src.display_name) } : {}),
    ...(str(src.type) ? { venueType: str(src.type) } : {}),
    type: str(o.type) ?? "unknown",
    ...(str(loc.raw_type) ? { rawType: str(loc.raw_type) } : {}),
    ...(typeof o.cited_by_count === "number" ? { citedBy: o.cited_by_count } : {}),
    retracted: o.is_retracted === true,
  };
}

/** What the record says, in one line an answer can cite: "Review of Financial Studies, 2020, journal-article, cited 224 times, not retracted". */
export function describeWork(w: ScholarlyWork): string {
  return [
    w.venue ?? "no venue given",
    w.year,
    w.rawType ?? w.type,
    w.citedBy !== undefined ? `cited ${w.citedBy} time${w.citedBy === 1 ? "" : "s"}` : undefined,
    w.retracted ? "RETRACTED" : "not retracted",
  ]
    .filter((x) => x !== undefined)
    .join(", ");
}

const doiPath = (doi: string) => encodeURIComponent(doi).replace(/%2F/gi, "/");

class LookupFailed extends Error {}

async function openAlex(url: string): Promise<{ data?: unknown; fetchedAt: string; missing?: boolean }> {
  let r: Awaited<ReturnType<typeof fetchJson>>;
  try {
    r = await fetchJson(url, { userAgent: politeUa(), hostIntervalMs: 120, retries: 1 });
  } catch (e) {
    // A recording keeps the answers only: a DOI OpenAlex did not know then is no answer the replay holds.
    if (e instanceof FixtureMiss) return { fetchedAt: "", missing: true };
    throw e;
  }
  if (r.ok) return { data: r.data, fetchedAt: r.fetchedAt };
  if (r.status === 404) return { fetchedAt: r.fetchedAt, missing: true };
  throw new LookupFailed(r.error ?? `HTTP ${r.status}`);
}

// ── The check ──────────────────────────────────────────────────────────────

export interface ScholarlyRow {
  /** The document's [E#]. */
  doc: string;
  host: string;
  tier: EvidenceTier;
  /** The paper the document is, when it names one. */
  doi?: string;
  /** The OpenAlex records found for it: its own, and its published version (a DOI it names under the same title). */
  works: Array<{ id: string; doi: string; tier: EvidenceTier; retracted: boolean; title: string; published?: boolean }>;
}

export interface ScholarlyCheck {
  rows: ScholarlyRow[];
  /** OpenAlex records marked retracted. */
  retracted: Array<{ id: string; doi: string; title: string }>;
  /** Studies a non-scholarly source cites but no source of the run is: what the next round looks for. */
  cites: Array<{ doc: string; doi: string }>;
  notes: string[];
}

/** OpenAlex requests a round may send: a run keeps 15 sources, most of them never a paper. */
const MAX_LOOKUPS = 12;

/**
 * Rank each document, look the papers among them up in OpenAlex, register
 * each record found as an [E#], and list the studies the other sources cite.
 * OpenAlex unreachable (or a replay that never recorded it): each level then
 * rests on the source's domain, and the notes say so.
 */
export async function scholarlyCheck(dir: string, subject: string, docs: readonly RegisteredDoc[]): Promise<ScholarlyCheck> {
  const out: ScholarlyCheck = { rows: [], retracted: [], cites: [], notes: [] };
  const store = EvidenceStore.open(dir, { subject });
  // Every record OpenAlex answered this round, by DOI (null: not in OpenAlex); one is registered when a row uses it.
  const records = new Map<string, { work: ScholarlyWork; fetchedAt: string } | null>();
  let budget = MAX_LOOKUPS;
  let down: string | undefined;

  const use = (r: { work: ScholarlyWork; fetchedAt: string }, published = false): ScholarlyRow["works"][number] => {
    const w = r.work;
    const tier = evidenceTier("", w);
    const id = store.add({
      key: `openalex.${w.doi}`,
      label: `OpenAlex record of "${sanitizeExternalText(w.title, 160)}" (${tier})`,
      value: sanitizeExternalText(describeWork(w), 300),
      source: "openalex",
      url: `https://doi.org/${w.doi}`,
      fetchedAt: r.fetchedAt,
      official: true,
      untrusted: true,
    });
    return { id, doi: w.doi, tier, retracted: w.retracted, title: sanitizeExternalText(w.title, 160), ...(published ? { published } : {}) };
  };
  const ask = async (url: string): Promise<{ data?: unknown; fetchedAt: string; missing?: boolean } | undefined> => {
    if (down || budget <= 0) return undefined;
    budget--;
    try {
      return await openAlex(url);
    } catch (e) {
      down = (e as Error).message.split("\n")[0]!.slice(0, 160);
      return undefined;
    }
  };
  const lookupDoi = async (doi: string) => {
    if (records.has(doi)) return records.get(doi) ?? undefined;
    const r = await ask(`${OPENALEX}/doi:${doiPath(doi)}?select=${SELECT}`);
    if (!r) return undefined;
    const work = r.missing ? undefined : parseOpenAlexWork(r.data);
    records.set(doi, work ? { work, fetchedAt: r.fetchedAt } : null);
    return work ? { work, fetchedAt: r.fetchedAt } : undefined;
  };

  for (const d of docs) {
    const host = sourceHost(d.host, d.page.url);
    const tier = (d.tier as EvidenceTier | undefined) ?? evidenceTier(host);
    const row: ScholarlyRow = { doc: d.id, host, tier, works: [] };
    out.rows.push(row);
    if (!scholarlyHost(host)) continue;
    const doi = paperIdentifier(d.page.url, d.page.text) ?? paperIdentifier(d.page.finalUrl, "");
    if (!doi) continue;
    row.doi = doi;
    const own = await lookupDoi(doi);
    if (!own) {
      if (!down && records.has(doi)) out.notes.push(`[${d.id}] names ${doi}, which OpenAlex does not hold: its level of evidence is read from its domain`);
      continue;
    }
    row.works.push(use(own));
    // A working paper's page names its published version's DOI ("Published Versions" on NBER): the same title in a journal.
    if (evidenceTier("", own.work) === "peer-reviewed") continue;
    for (const other of citedDois(d.page.text, 4).filter((x) => x !== own.work.doi)) {
      const r = await lookupDoi(other);
      if (r && fold(r.work.title) === fold(own.work.title) && evidenceTier("", r.work) === "peer-reviewed") {
        row.works.push(use(r, true));
        break;
      }
    }
  }
  store.save();

  // A press page or a blog that names a DOI cites a study: read the study itself.
  const known = new Set([...records.keys(), ...out.rows.flatMap((r) => [r.doi, ...r.works.map((w) => w.doi)])].filter(Boolean));
  for (const d of docs) {
    const row = out.rows.find((r) => r.doc === d.id)!;
    if (scholarlyHost(row.host)) continue;
    for (const doi of citedDois(d.page.text)) {
      if (known.has(doi) || out.cites.some((c) => c.doi === doi)) continue;
      out.cites.push({ doc: d.id, doi });
      out.notes.push(`[${d.id}] ${row.host} (${row.tier}) cites ${doi}: read the study, not the page that reports it`);
    }
  }
  const seen = new Set<string>();
  for (const w of out.rows.flatMap((r) => r.works))
    if (w.retracted && !seen.has(w.doi)) {
      seen.add(w.doi);
      out.retracted.push({ id: w.id, doi: w.doi, title: w.title });
    }
  if (down) out.notes.push(`OpenAlex unavailable (${down}): each source's level of evidence is inferred from its domain`);
  else if (budget <= 0) out.notes.push(`OpenAlex: ${MAX_LOOKUPS} lookups this round, the rest of the sources ranked by their domain`);
  return out;
}

/** The next round's angle for the studies the sources cite and no source is. */
export function citedStudiesAngle(check: ScholarlyCheck): ResearchAngle | undefined {
  const dois = check.cites.map((c) => c.doi).slice(0, 4);
  if (!dois.length) return undefined;
  return { id: "gap-cited-studies", title: "The studies the sources cite", queries: dois.map((d) => `"${d}"`), langs: dois.map(() => null) };
}

// ── Seeds: the literature ultrastock's own rules cite ──────────────────────

export interface StrategySource {
  /** Where ultrastock names it: a screen preset, a value style, a backtest strategy, an allocation rule. */
  origin: string;
  id: string;
  source: string;
}

const key = (s: string) =>
  deaccent(s)
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();

/** The rules whose id or title the names are (case, accents and dashes aside), with the literature each cites. */
export function strategySources(names: readonly string[]): StrategySource[] {
  const wanted = new Set(names.map(key).filter(Boolean));
  const is = (...xs: Array<string | undefined>) => xs.some((x) => x !== undefined && wanted.has(key(x)));
  const out: StrategySource[] = [];
  for (const p of TV_PRESETS) if (is(p.id, p.title)) out.push({ origin: "screen preset", id: p.id, source: p.source });
  for (const p of BUILTIN_PRESETS) if (is(p.id, p.title)) out.push({ origin: "screen preset", id: p.id, source: p.source });
  for (const s of Object.values(VALUE_STYLES)) if (is(s.id, s.title)) out.push({ origin: "value style", id: s.id, source: s.source });
  for (const raw of BUILTIN_STRATEGIES) {
    const s = raw as { name?: string; description?: string };
    if (s.name && is(s.name)) out.push({ origin: "backtest strategy", id: s.name, source: String(s.description ?? "") });
  }
  for (const a of ALLOCATIONS) if (is(a)) out.push({ origin: "allocation rule", id: a, source: ALLOCATION_SOURCES[a] });
  return out;
}

const YEAR = /^(?:1[89]|20)\d\d$/;
const JOURNAL = /\b(?:journal|review|quarterly|letters|econometrica)\b/i;

const words = (s: string) =>
  s
    .replace(/['’]s\b/g, "")
    .replace(/['"‘’“”]/g, "")
    .replace(/&/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The search queries a source string's citations make: "(Jegadeesh & Titman,
 * Journal of Finance, 1993)" → "Jegadeesh Titman 1993 Journal of Finance pdf";
 * "Piotroski (2000)" → "Piotroski 2000". A string that cites nothing (a
 * backtest strategy's description) is searched by its head words.
 */
export function citationQueries(source: string, max = 4): string[] {
  const out: string[] = [];
  const add = (q: string) => {
    const t = q.replace(/\s+/g, " ").trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const m of source.matchAll(/\(([^()]*)\)/g)) {
    const before = source.slice(0, m.index);
    for (const piece of m[1]!.split(";")) {
      const parts = piece
        .split(",")
        .map((p) => words(p))
        .filter(Boolean);
      const yi = parts.findIndex((p) => YEAR.test(p));
      if (yi < 0) continue;
      // "Piotroski (2000)", "Mark Minervini, Trade Like a Stock Market Wizard (2013)": the name or title just before.
      const lead =
        yi > 0
          ? parts.slice(0, yi)
          : [
              words(
                before
                  .split(/[—–;:()]/)
                  .pop()!
                  .split(",")
                  .pop() ?? "",
              ),
            ].filter(Boolean);
      if (!lead.length) continue;
      const [first, ...rest] = lead;
      add(`${first} ${parts[yi]} ${rest.join(" ")}${lead.some((p) => JOURNAL.test(p)) ? " pdf" : ""}`);
    }
  }
  if (!out.length) {
    const head = words(source.split(/\s[—–-]\s|[:;(,]/)[0] ?? "")
      .split(" ")
      .slice(0, 6)
      .join(" ");
    if (head) add(`${head} backtest study`);
  }
  return out.slice(0, max);
}

/** The cited-source angle: the literature ultrastock's own rule of that name cites, searched first. */
export function citedSourceAngle(names: readonly string[]): ResearchAngle | undefined {
  const found = strategySources(names);
  if (!found.length) return undefined;
  const queries = [...new Set(found.flatMap((f) => citationQueries(f.source)))].slice(0, 4);
  if (!queries.length) return undefined;
  return {
    id: "cited-source",
    title: `What ultrastock's ${found.map((f) => `${f.origin} "${f.id}"`).join(", ")} cite${found.length === 1 ? "s" : ""}`,
    queries,
    langs: queries.map(() => "en-US"),
  };
}
