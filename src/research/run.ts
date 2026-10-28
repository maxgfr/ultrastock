// The research layer as functions: start a worklist for a subject, then run a
// round on it — search the angles not searched yet (a delegated agent CLI,
// the engines) or take the hits the caller found, read and register the
// pages, write the dossier and the next round's angles. `research` (the
// command) and `value --research-with` both run on these, so a value run's
// top names are researched exactly like a hand-started research.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceStore, readDocText } from "../core/evidence.js";
import { clockNow, FixtureMiss } from "../core/net.js";
import { runDirFor } from "../core/paths.js";
import { runId, UsageError, writeFileAtomic } from "../engine.js";
import { resolveSymbol } from "../providers/router.js";
import { followUpAngles, type ResearchFocus, type ResearchKind, type ResearchSubject, researchAngles } from "./angles.js";
import { delegatedSearch, type SearchDelegate } from "./delegate.js";
import {
  angleCoverage,
  type CribleCheck,
  coverageTerms,
  cribleCrossCheck,
  documentCoverage,
  issuerDomain,
  type RegisteredDoc,
  registerDocuments,
  type ResearchTodo,
  researchFiles,
  writeDossier,
  writeTodo,
} from "./dossier.js";
import { type Dropped, engineSearch, fuseHits, notADocument, type ReadPage, readCandidates, type WebHit } from "./ingest.js";

interface IndexEntry {
  id: string;
  url: string;
  title?: string;
  host: string;
  angles: string[];
  pdf: boolean;
  fetchedAt: string;
  publishedAt?: string;
  official: boolean;
  via?: string;
}

/** The share-class words a listing's name carries ("NVIDIA Corporation Common Stock", "Alphabet Inc. Class A"). */
export const SHARE_CLASS =
  /\b(?:common stock|common shares?|ordinary shares?|class [a-c](?: (?:common )?(?:stock|shares?))?|american depositary shares?|depositary shares?|adrs?|ads)\b/gi;

/** "LVMH Moët Hennessy - Louis Vuitton, Société Européenne" → "LVMH Moët Hennessy", "NVIDIA Corporation Common Stock" → "NVIDIA": what a search engine is asked. */
export function searchName(name: string): string {
  const cut = name
    .replace(SHARE_CLASS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*[-–,(].*$/, "")
    .replace(/\b(?:S\.?A\.?|SE|S\.?p\.?A\.?|N\.?V\.?|AG|PLC|plc|Inc\.?|Corp\.?|Corporation|Ltd\.?|Limited|Holdings?|Group|Groupe|Company|Co\.)$/i, "")
    .trim();
  const words = cut.split(/\s+/);
  return (words.length > 3 ? words.slice(0, 3).join(" ") : cut) || name;
}

async function subjectOf(
  raw: string,
  kind: ResearchKind | undefined,
  name: string | undefined,
): Promise<{ s: Omit<ResearchSubject, "focus" | "year" | "ask">; notes: string[] }> {
  const notes: string[] = [];
  const symbolLike = /^[A-Za-z0-9.:\-^=]{1,15}$/.test(raw.trim());
  if (kind !== "company" && symbolLike) {
    try {
      const r = await resolveSymbol(raw);
      const inst = r.instrument;
      const resolved: ResearchKind = inst.market === "crypto" || inst.kind === "crypto" ? "crypto" : inst.kind === "etf" ? "etf" : "equity";
      const label = inst.name ?? inst.symbol;
      return {
        s: { subject: raw, symbol: inst.symbol, name: name ?? (resolved === "equity" ? searchName(label) : label), kind: kind ?? resolved },
        notes: [...r.notes],
      };
    } catch (e) {
      if (kind || e instanceof FixtureMiss) throw e;
      notes.push(`${raw} is no listed symbol (${(e as Error).message.split("\n")[0]!.slice(0, 120)}): researched as a company`);
    }
  }
  return { s: { subject: raw, name: name ?? raw.trim(), kind: kind ?? "company" }, notes };
}

export interface ResearchStart {
  kind?: ResearchKind;
  focus?: ResearchFocus;
  ask?: string;
  /** The name to search with, instead of the resolved one. */
  name?: string;
  /** The run directory (default: a new one under <home>/runs). */
  out?: string;
  /** Tag the subject's files, for a run that researches several subjects (see researchFiles). */
  tag?: string;
  /** The year the queries ask about (default: this year) — the year of the date a calendar search confirms. */
  year?: number;
}

/** A new worklist for a subject: resolve it, write its angles. Searches nothing. */
export async function startResearch(raw: string, opts: ResearchStart = {}): Promise<{ dir: string; todo: ResearchTodo; notes: string[] }> {
  const sub = await subjectOf(raw, opts.kind, opts.name);
  const dir = runDirFor(opts.out, `research-${(sub.s.symbol ?? sub.s.name).replace(/[^A-Za-z0-9.-]+/g, "_")}-${runId()}`);
  const subject: ResearchSubject = { ...sub.s, focus: opts.focus ?? "general", ask: opts.ask, year: opts.year ?? clockNow().getUTCFullYear() };
  const todo: ResearchTodo = {
    schema: 1,
    ...subject,
    ...(opts.tag ? { tag: opts.tag } : {}),
    createdAt: clockNow().toISOString(),
    round: 1,
    angles: researchAngles(subject),
  };
  writeTodo(dir, todo);
  return { dir, todo, notes: [...sub.notes] };
}

/** The documents earlier rounds registered, read back from the run. */
function previousDocs(dir: string, tag?: string): RegisteredDoc[] {
  const path = join(dir, researchFiles(tag).index);
  if (!existsSync(path)) return [];
  const store = EvidenceStore.load(dir);
  if (!store) return [];
  const out: RegisteredDoc[] = [];
  for (const e of JSON.parse(readFileSync(path, "utf8")) as IndexEntry[]) {
    const item = store.get(e.id);
    const text = item ? readDocText(dir, item) : undefined;
    if (!item || text === undefined) continue;
    const page: ReadPage = {
      url: e.url,
      finalUrl: e.url,
      title: e.title,
      text,
      fetchedAt: e.fetchedAt,
      publishedAt: e.publishedAt,
      pdf: e.pdf,
      angles: e.angles,
      score: 0,
      ...(e.via ? { via: e.via } : {}),
    };
    out.push({ id: e.id, page, host: e.host, official: e.official });
  }
  return out;
}

/** The queries of the angles still to search (all of them on a first round, else the unsearched and the second round's). */
export function pendingQueries(todo: ResearchTodo): Array<{ angle: string; query: string; lang?: string }> {
  const done = new Set(todo.searched ?? []);
  return todo.angles
    .filter((a) => !done.has(a.id))
    .flatMap((a) =>
      a.queries.map((query, i) => {
        // A first-round angle is written French first, then English; a second round says each query's language.
        const lang = a.langs ? (a.langs[i] ?? undefined) : a.queries.length === 2 ? (i === 0 ? "fr-FR" : "en-US") : undefined;
        return { angle: a.id, query, ...(lang ? { lang } : {}) };
      }),
    );
}

export interface ResearchRound {
  /** Hit lists the caller already has (its own web search, --urls). */
  lists?: WebHit[][];
  /** Search the pending queries with an agent CLI (billed to the user's plan). */
  searchWith?: SearchDelegate;
  model?: string;
  /** Search the pending queries with the engines (SearXNG, …). */
  engines?: boolean;
  limit?: number;
  read?: { wayback: boolean; browser: boolean };
}

export interface ResearchRoundResult {
  dir: string;
  dossier: string;
  kept: Array<{ id: string; url: string; host: string; pdf: boolean; chars: number; official: boolean; angles: string[]; via?: string }>;
  total: number;
  dropped: Dropped[];
  /** Angle ids with fewer than two kept sources — the next round's angles rephrase their queries. */
  underCovered: string[];
  crible?: CribleCheck["rows"];
  notes: string[];
}

/** One round: search what is pending (when asked), read and register the pages, write the dossier and the next round's worklist. */
export async function researchRound(dir: string, todo: ResearchTodo, notes: string[], opts: ResearchRound = {}): Promise<ResearchRoundResult> {
  const lists: WebHit[][] = [...(opts.lists ?? [])];
  const searches = !!(opts.searchWith || opts.engines);
  const pending = searches ? pendingQueries(todo) : [];
  const files = researchFiles(todo.tag);
  if (searches && !pending.length) notes.push(`every angle of ${files.todo} was searched already — add queries with --web-results or --urls`);
  if (opts.searchWith && pending.length) {
    const got = await delegatedSearch(opts.searchWith, pending, { model: opts.model });
    lists.push(...got.lists);
    notes.push(...got.notes);
  }
  if (opts.engines && pending.length) {
    const got = await engineSearch(pending);
    lists.push(...got.lists);
    notes.push(...got.notes);
  }
  if (!lists.length) throw new UsageError(`no search result with a url to read${notes.length ? ` (${notes.slice(-3).join("; ")})` : ""}`);

  const before = previousDocs(dir, todo.tag);
  const known = new Set(before.map((d) => d.page.url));
  const candidates = fuseHits(lists, notADocument).filter((c) => !known.has(c.url));
  const { pages, dropped } = await readCandidates(candidates, {
    max: opts.limit ?? 15,
    read: opts.read ?? { wayback: true, browser: false },
    follow: { name: todo.name },
  });
  const notDocs = [...new Set(lists.flat().map((h) => h.url))].filter(notADocument);
  dropped.push(...notDocs.map((url) => ({ url, reason: "not a document (video, social feed or search page)" })));
  const fresh = registerDocuments(dir, todo, pages);
  const seen = new Set(before.map((d) => d.id));
  const docs = [...before, ...fresh.filter((d) => !seen.has(d.id))];
  const index: IndexEntry[] = docs.map((d) => ({
    id: d.id,
    url: d.page.finalUrl,
    title: d.page.title,
    host: d.host,
    angles: d.page.angles,
    pdf: d.page.pdf,
    fetchedAt: d.page.fetchedAt,
    publishedAt: d.page.publishedAt,
    official: d.official,
    ...(d.page.via ? { via: d.page.via } : {}),
  }));
  writeFileAtomic(join(dir, files.index), `${JSON.stringify(index, null, 2)}\n`);

  const crible = todo.kind === "equity" && todo.symbol ? await cribleCrossCheck(dir, todo.symbol, docs) : undefined;
  const searched = new Set([...(todo.searched ?? []), ...lists.flat().map((h) => h.angle ?? ""), ...docs.flatMap((d) => d.page.angles)].filter(Boolean));
  // The second round follows the angles with too few sources; the terms are a statistic.
  const { coverage: angles, under } = angleCoverage(todo, docs, searched);
  const { coverage: terms } = documentCoverage(docs, coverageTerms(todo, searched));
  const unsearched = todo.angles.filter((a) => !searched.has(a.id)).map((a) => a.id);
  if (unsearched.length) notes.push(`angles not searched yet: ${unsearched.join(", ")} — their queries are in ${files.todo}`);
  const asked = new Set(todo.angles.flatMap((a) => a.queries));
  const follow = followUpAngles(todo, under, { issuerDomain: issuerDomain(docs, todo.name), asked }).filter((a) => !searched.has(a.id));
  const isFollowUp = (id: string) => id.startsWith("gap-") || id.startsWith("more-");
  const next: ResearchTodo = {
    ...todo,
    round: todo.round + 1,
    underCovered: under.map((u) => u.angle.id),
    searched: [...searched].sort(),
    angles: [...todo.angles.filter((a) => !isFollowUp(a.id) || searched.has(a.id)), ...follow],
  };
  writeTodo(dir, next);
  const dossier = writeDossier(dir, next, docs, dropped, { notes, crible, angles, under, terms });
  return {
    dir,
    dossier,
    kept: fresh.map((d) => ({
      id: d.id,
      url: d.page.finalUrl,
      host: d.host,
      pdf: d.page.pdf,
      chars: d.page.text.length,
      official: d.official,
      angles: d.page.angles,
      via: d.page.via,
    })),
    total: docs.length,
    dropped,
    underCovered: next.underCovered ?? [],
    crible: crible?.rows,
    notes,
  };
}
