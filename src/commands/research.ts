// `research`: web sources, compiled into evidence the answer cites and `check` verifies.
//
//   research <subject> [--kind equity|etf|crypto|company] [--focus results|calendar] [--ask "<question>"] --out <run>
//       writes RESEARCH.todo.json — the angles and their queries (FR + EN) — for the agent's own web search
//   research --out <run> [--for <tag>] --web-results websearch.json [--engine-search] [--limit 15]
//       reads what the agent found: fetches, cleans, dedupes and ranks the pages, registers each as a
//       document [E#] (sources/E#.md), writes DOSSIER.md and the next round's angles (the under-covered
//       ones' queries, rephrased). A run researching several subjects (value --research-with) tags each
//       one's files; --for picks one.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argBool, argInt, argList, argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";
import { RESEARCH_FOCUSES, RESEARCH_KINDS, type ResearchFocus } from "../research/angles.js";
import { SEARCH_DELEGATES } from "../research/delegate.js";
import { readTodo, type ResearchTodo, researchFiles, researchTag, researchTags, TODO_FILE } from "../research/dossier.js";
import { parseWebResults, type WebHit } from "../research/ingest.js";
import { type ResearchRoundResult, researchRound, startResearch } from "../research/run.js";

export { pendingQueries, searchName } from "../research/run.js";

function oneOf<T extends string>(v: string | undefined, all: readonly T[], flag: string): T | undefined {
  if (v === undefined) return undefined;
  if (!(all as readonly string[]).includes(v)) throw new UsageError(`--${flag} is one of ${all.join(", ")}, not "${v}"`);
  return v as T;
}

function printTodo(todo: ResearchTodo, dir: string, notes: string[]): string {
  const lines = [
    `Research worklist — ${todo.name}${todo.symbol ? ` (${todo.symbol})` : ""}, ${todo.kind}${todo.ask ? `, question: ${todo.ask}` : todo.focus === "results" ? ", latest results" : todo.focus === "calendar" ? ", financial calendar" : ""}`,
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
    `then: ultrastock research --out ${dir}${todo.tag ? ` --for ${todo.tag}` : ""} --web-results <file> [--engine-search]`,
    ...notes.map((n) => `note: ${n}`),
  );
  return `${lines.join("\n")}\n`;
}

function readWebResults(file: string): unknown {
  try {
    return JSON.parse(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read ${file === "-" ? "stdin" : file} as JSON: ${(e as Error).message}`);
  }
}

/** The worklist a `--out <run>` round adds to: the untagged one, the one --for names, or the run's only tagged one. */
function todoOf(dir: string, tag: string | undefined): ResearchTodo {
  if (tag) {
    const t = readTodo(dir, tag);
    if (!t) throw new UsageError(`${dir} holds no ${researchFiles(tag).todo} — tags here: ${researchTags(dir).join(", ") || "none"}`);
    return t;
  }
  const plain = readTodo(dir);
  if (plain) return plain;
  const tags = researchTags(dir);
  if (tags.length === 1) return readTodo(dir, tags[0])!;
  if (tags.length > 1) throw new UsageError(`${dir} researches several subjects (${tags.join(", ")}): pick one with --for <tag>`);
  throw new UsageError(`${dir} holds no ${TODO_FILE} — run \`ultrastock research <subject> --out ${dir}\` first`);
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
    const started = await startResearch(raw, {
      kind,
      focus: focus as ResearchFocus,
      ask: argValue(args, "ask")?.trim() || undefined,
      name: argValue(args, "name"),
      out,
      // Several subjects in one run (a value run's top names): each one's files carry its tag.
      tag: argValue(args, "for") ? researchTag(argValue(args, "for")!) : undefined,
    });
    ({ dir, todo } = started);
    notes.push(...started.notes);
    if (!searches) {
      if (asJson) process.stdout.write(jsonLine({ dir, todo: join(dir, researchFiles(todo.tag).todo), ...todo, notes }));
      else process.stdout.write(printTodo(todo, dir, notes));
      return;
    }
  } else {
    if (!out) throw new UsageError("research needs a subject (a new worklist) or the run it adds to: --out <run>");
    if (!webResults && !urls.length && !searches)
      throw new UsageError("nothing to ingest: pass --web-results <file|->, --urls a,b, --search-with claude|codex or --engine-search");
    dir = resolve(out);
    if (!existsSync(dir)) throw new UsageError(`no run at ${dir}`);
    const forTag = argValue(args, "for");
    todo = todoOf(dir, forTag ? researchTag(forTag) : undefined);
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
  const result = await researchRound(dir, todo, notes, {
    lists,
    searchWith,
    model: argValue(args, "search-model"),
    engines,
    limit: argInt(args, "limit", { min: 1 }) ?? 15,
    read: { wayback: !argBool(args, "no-wayback"), browser: argBool(args, "browser") },
  });
  if (asJson) process.stdout.write(jsonLine(result));
  else process.stdout.write(formatRound(result, researchFiles(todo.tag).todo));
}

/** A round's summary, as the command prints it. */
export function formatRound(r: ResearchRoundResult, todoFile: string): string {
  return [
    `research: ${r.kept.length} new source${r.kept.length === 1 ? "" : "s"} (${r.total} in the run), ${r.dropped.length} dropped — ${r.dossier}`,
    ...r.kept.map((d) => `  [${d.id}] ${d.host}${d.pdf ? " (PDF)" : ""} — ${d.chars} characters${d.official ? ", official" : ""}${d.via ? ` — ${d.via}` : ""}`),
    r.underCovered.length
      ? `under-covered angles: ${r.underCovered.join(", ")} — the next round's rephrased queries are in ${join(r.dir, todoFile)}`
      : "no angle under-covered",
    ...r.notes.map((n) => `note: ${n}`),
    "",
  ].join("\n");
}
