// `research`: web sources, compiled into evidence the answer cites and `check` verifies.
//
//   research <subject> [--kind equity|etf|crypto|company] [--focus results] [--ask "<question>"] --out <run>
//       writes RESEARCH.todo.json — the angles and their queries (FR + EN) — for the agent's own web search
//   research --out <run> --web-results websearch.json [--engine-search] [--limit 15]
//       reads what the agent found: fetches, cleans, dedupes and ranks the pages, registers each as a
//       document [E#] (sources/E#.md), writes DOSSIER.md and the next round's under-covered terms
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EvidenceStore, readDocText } from "../core/evidence.js";
import { clockNow, FixtureMiss } from "../core/net.js";
import { runDirFor } from "../core/paths.js";
import { argBool, argInt, argList, argValue, type CommandArgs, jsonLine, runId, UsageError, writeFileAtomic } from "../engine.js";
import { delegatedSearch, SEARCH_DELEGATES } from "../research/delegate.js";
import { resolveSymbol } from "../providers/router.js";
import {
  followUpAngles,
  RESEARCH_FOCUSES,
  RESEARCH_KINDS,
  type ResearchFocus,
  type ResearchKind,
  type ResearchSubject,
  researchAngles,
} from "../research/angles.js";
import {
  coverageTerms,
  cribleCrossCheck,
  documentCoverage,
  readTodo,
  type RegisteredDoc,
  registerDocuments,
  type ResearchTodo,
  TODO_FILE,
  writeDossier,
  writeTodo,
} from "../research/dossier.js";
import { engineSearch, fuseHits, notADocument, parseWebResults, type ReadPage, readCandidates, type WebHit } from "../research/ingest.js";

const INDEX_FILE = "research.json";

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

/** "LVMH Moët Hennessy - Louis Vuitton, Société Européenne" → "LVMH Moët Hennessy": what a search engine is asked. */
export function searchName(name: string): string {
  const cut = name
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

function oneOf<T extends string>(v: string | undefined, all: readonly T[], flag: string): T | undefined {
  if (v === undefined) return undefined;
  if (!(all as readonly string[]).includes(v)) throw new UsageError(`--${flag} is one of ${all.join(", ")}, not "${v}"`);
  return v as T;
}

function printTodo(todo: ResearchTodo, dir: string, notes: string[]): string {
  const lines = [
    `Research worklist — ${todo.name}${todo.symbol ? ` (${todo.symbol})` : ""}, ${todo.kind}${todo.ask ? `, question: ${todo.ask}` : todo.focus === "results" ? ", latest results" : ""}`,
    `run: ${dir}`,
    "",
    "Search each query with your own web search (one angle per query, French and English):",
    "",
  ];
  for (const a of todo.angles) {
    lines.push(`  ${a.id} — ${a.title}`);
    for (const q of a.queries) lines.push(`      ${q}`);
  }
  lines.push(
    "",
    "Save every result list to a JSON file, one entry per query:",
    '  [{ "angle": "<angle id>", "query": "<the query>", "results": [{ "url": "…", "title": "…", "snippet": "…" }] }]',
    `then: ultrastock research --out ${dir} --web-results <file> [--engine-search]`,
    ...notes.map((n) => `note: ${n}`),
  );
  return `${lines.join("\n")}\n`;
}

/** The documents earlier rounds registered, read back from the run. */
function previousDocs(dir: string): RegisteredDoc[] {
  const path = join(dir, INDEX_FILE);
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

/** The queries of the angles still to search (all of them on a first round, else the unsearched and the gaps). */
export function pendingQueries(todo: ResearchTodo): Array<{ angle: string; query: string; lang?: string }> {
  const done = new Set(todo.searched ?? []);
  return (
    todo.angles
      .filter((a) => !done.has(a.id))
      // Angle queries are written French first, then English.
      .flatMap((a) => a.queries.map((query, i) => ({ angle: a.id, query, ...(a.queries.length === 2 ? { lang: i === 0 ? "fr-FR" : "en-US" } : {}) })))
  );
}

function readWebResults(file: string): unknown {
  try {
    return JSON.parse(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read ${file === "-" ? "stdin" : file} as JSON: ${(e as Error).message}`);
  }
}

export async function researchCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const webResults = argValue(args, "web-results");
  const urls = argList(args, "urls");
  const searchWith = oneOf(argValue(args, "search-with"), SEARCH_DELEGATES, "search-with");
  const engines = argBool(args, "engine-search");
  const out = argValue(args, "out");
  const raw = args.positional[0];
  const searches = !!(searchWith || engines);

  let dir: string;
  let todo: ResearchTodo;
  const notes: string[] = [];
  if (raw) {
    // A new worklist — and, with --search-with or --engine-search, its search and ingestion in the same call.
    if (webResults || urls.length)
      throw new UsageError("a subject starts a new worklist: pass --web-results / --urls with --out <run> only, on a run that has one");
    const kind = oneOf(argValue(args, "kind"), RESEARCH_KINDS, "kind");
    const focus = oneOf(argValue(args, "focus"), RESEARCH_FOCUSES, "focus") ?? "general";
    const ask = argValue(args, "ask")?.trim() || undefined;
    const sub = await subjectOf(raw, kind, argValue(args, "name"));
    notes.push(...sub.notes);
    dir = runDirFor(out, `research-${(sub.s.symbol ?? sub.s.name).replace(/[^A-Za-z0-9.-]+/g, "_")}-${runId()}`);
    const subject: ResearchSubject = { ...sub.s, focus: focus as ResearchFocus, ask, year: clockNow().getUTCFullYear() };
    todo = { schema: 1, ...subject, createdAt: clockNow().toISOString(), round: 1, angles: researchAngles(subject) };
    writeTodo(dir, todo);
    if (!searches) {
      if (asJson) process.stdout.write(jsonLine({ dir, todo: join(dir, TODO_FILE), ...todo, notes }));
      else process.stdout.write(printTodo(todo, dir, notes));
      return;
    }
  } else {
    if (!out) throw new UsageError("research needs a subject (a new worklist) or the run it adds to: --out <run>");
    if (!webResults && !urls.length && !searches)
      throw new UsageError("nothing to ingest: pass --web-results <file|->, --urls a,b, --search-with claude|codex or --engine-search");
    dir = resolve(out);
    const t = readTodo(dir);
    if (!t) throw new UsageError(`${dir} holds no ${TODO_FILE} — run \`ultrastock research <subject> --out ${dir}\` first`);
    todo = t;
  }

  const lists: WebHit[][] = [];
  if (webResults) {
    const { lists: got, skipped } = parseWebResults(readWebResults(webResults));
    if (skipped) notes.push(`${skipped} entr${skipped === 1 ? "y" : "ies"} of ${webResults === "-" ? "stdin" : webResults} without an http(s) url skipped`);
    lists.push(...got);
  }
  if (urls.length) {
    const bad = urls.filter((u) => !/^https?:\/\//i.test(u));
    if (bad.length) throw new UsageError(`--urls takes http(s) URLs, not ${bad.join(", ")}`);
    lists.push(urls.map((url) => ({ url, angle: "added" })));
  }
  const pending = searches ? pendingQueries(todo) : [];
  if (searches && !pending.length) notes.push(`every angle of ${TODO_FILE} was searched already — add queries with --web-results or --urls`);
  if (searchWith && pending.length) {
    const got = await delegatedSearch(searchWith, pending, { model: argValue(args, "search-model") });
    lists.push(...got.lists);
    notes.push(...got.notes);
  }
  if (engines && pending.length) {
    const got = await engineSearch(pending);
    lists.push(...got.lists);
    notes.push(...got.notes);
  }
  if (!lists.length) throw new UsageError(`no search result with a url to read${notes.length ? ` (${notes.slice(-3).join("; ")})` : ""}`);
  return ingestRound(dir, todo, lists, notes, {
    limit: argInt(args, "limit", { min: 1 }) ?? 15,
    read: { wayback: !argBool(args, "no-wayback"), browser: argBool(args, "browser") },
    asJson,
  });
}

async function ingestRound(
  dir: string,
  todo: ResearchTodo,
  lists: WebHit[][],
  notes: string[],
  opts: { limit: number; read: { wayback: boolean; browser: boolean }; asJson: boolean },
): Promise<void> {
  const before = previousDocs(dir);
  const known = new Set(before.map((d) => d.page.url));
  const candidates = fuseHits(lists, notADocument).filter((c) => !known.has(c.url));
  const { pages, dropped } = await readCandidates(candidates, { max: opts.limit, read: opts.read, follow: { name: todo.name } });
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
  writeFileAtomic(join(dir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);

  const crible = todo.kind === "equity" && todo.symbol ? await cribleCrossCheck(dir, todo.symbol, docs) : undefined;
  const searched = new Set([...(todo.searched ?? []), ...lists.flat().map((h) => h.angle ?? ""), ...docs.flatMap((d) => d.page.angles)].filter(Boolean));
  const { coverage, under } = documentCoverage(docs, coverageTerms(todo, searched));
  const unsearched = todo.angles.filter((a) => !searched.has(a.id)).map((a) => a.id);
  if (unsearched.length) notes.push(`angles not searched yet: ${unsearched.join(", ")} — their queries are in ${TODO_FILE}`);
  const next: ResearchTodo = {
    ...todo,
    round: todo.round + 1,
    underCovered: under,
    searched: [...searched].sort(),
    angles: [...todo.angles.filter((a) => !a.id.startsWith("gap-") || searched.has(a.id)), ...followUpAngles(todo, under).filter((a) => !searched.has(a.id))],
  };
  writeTodo(dir, next);
  const dossier = writeDossier(dir, next, docs, dropped, { notes, crible, under, coverage });
  const result = {
    dir,
    dossier,
    kept: fresh.map((d) => ({
      id: d.id,
      url: d.page.finalUrl,
      host: d.host,
      chars: d.page.text.length,
      official: d.official,
      angles: d.page.angles,
      via: d.page.via,
    })),
    total: docs.length,
    dropped,
    underCovered: under,
    crible: crible?.rows,
    notes,
  };
  if (opts.asJson) process.stdout.write(jsonLine(result));
  else
    process.stdout.write(
      [
        `research: ${fresh.length} new source${fresh.length === 1 ? "" : "s"} (${docs.length} in the run), ${dropped.length} dropped — ${dossier}`,
        ...fresh.map(
          (d) =>
            `  [${d.id}] ${d.host}${d.page.pdf ? " (PDF)" : ""} — ${d.page.text.length} characters${d.official ? ", official" : ""}${d.page.via ? ` — ${d.page.via}` : ""}`,
        ),
        under.length ? `under-covered: ${under.join(", ")} — next round's queries in ${join(dir, TODO_FILE)}` : "no term under-covered",
        ...notes.map((n) => `note: ${n}`),
        "",
      ].join("\n"),
    );
}
