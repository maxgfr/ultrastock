// Web search delegated to an agent CLI the user already has: Claude Code
// (`claude -p` with its WebSearch tool) or Codex (`codex --search exec`).
//
// Inside an agent session the agent searches itself and hands its hits over
// (`--web-results`); this is for everything else — a script, a scheduled run,
// an MCP client without a search tool, or a worklist too long to type out. The
// queries go in batches, the CLI is asked for structured output (a JSON schema)
// holding the hits only, never a summary, and the hits come back as one ranked
// list per query, like the agent's own. ultrastock then fetches every page
// itself: a hit is a lead, never evidence, and an invented URL simply fails to
// fetch.
//
// Opt-in and billed to the user's own plan (about 2 cents a query with Claude's
// small model, measured), so it never runs unasked. Recorded and replayed like
// any network read: a fixture holds the hits, a replay starts no CLI.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordedCall } from "../core/net.js";
import { env, have, shAsync } from "../engine.js";
import type { WebHit } from "./ingest.js";

export const SEARCH_DELEGATES = ["claude", "codex"] as const;
export type SearchDelegate = (typeof SEARCH_DELEGATES)[number];

/** Queries per CLI call: enough to amortise its start-up, few enough to finish in a few minutes. */
export const DELEGATE_BATCH = 6;
const HITS_PER_QUERY = 8;
const CALL_TIMEOUT_MS = 6 * 60_000;

export interface DelegateQuery {
  angle: string;
  query: string;
}

export interface DelegateResult {
  lists: WebHit[][];
  notes: string[];
}

// Codex's structured output wants every property required; Claude accepts the same schema.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query", "results"],
        properties: {
          query: { type: "string" },
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["url", "title", "snippet"],
              properties: { url: { type: "string" }, title: { type: "string" }, snippet: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

export function delegatePrompt(queries: readonly string[]): string {
  return [
    `For EACH numbered query below, run one web search (one search per query; run them in parallel when you can) and return its hits — url, title, snippet — at most ${HITS_PER_QUERY} per query, in the order the search returned them.`,
    "Return only URLs the search tool actually returned: never write a URL from memory. Do not open or fetch the pages, do not run any other tool or command, do not summarise or comment.",
    "Answer with the JSON object the schema describes, one entry per query, in the same order, each with the query text as given.",
    "",
    ...queries.map((q, i) => `${i + 1}. ${q}`),
  ].join("\n");
}

/** The command line for one batch — ULTRASTOCK_CLAUDE_CMD / ULTRASTOCK_CODEX_CMD override the binary. */
export function delegateCommand(
  who: SearchDelegate,
  prompt: string,
  opts: { model?: string; schemaFile: string; outFile: string },
): { cmd: string; args: string[] } {
  if (who === "claude") {
    const cmd = env("CLAUDE_CMD") ?? "claude";
    return {
      cmd,
      args: [
        "-p",
        prompt,
        "--allowedTools",
        "WebSearch",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(SCHEMA),
        "--max-turns",
        "8",
        "--model",
        opts.model ?? "haiku",
      ],
    };
  }
  const cmd = env("CODEX_CMD") ?? "codex";
  return {
    cmd,
    args: [
      "--search",
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--output-schema",
      opts.schemaFile,
      "--output-last-message",
      opts.outFile,
      ...(opts.model ? ["--model", opts.model] : []),
      prompt,
    ],
  };
}

/** The structured answer of one batch, from the CLI's stdout (Claude) or its last-message file (Codex). */
export function parseDelegateAnswer(
  who: SearchDelegate,
  stdout: string,
  lastMessage?: string,
): { queries: Array<{ query: string; results: WebHit[] }>; cost?: number } {
  if (who === "claude") {
    const d = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { is_error?: boolean; result?: string; structured_output?: unknown; total_cost_usd?: number };
    if (d.is_error) throw new Error(`claude: ${String(d.result ?? "error").slice(0, 200)}`);
    const so = (d.structured_output ?? (typeof d.result === "string" ? JSON.parse(d.result) : undefined)) as { queries?: unknown } | undefined;
    return { queries: normalizeQueries(so?.queries), cost: d.total_cost_usd };
  }
  const so = JSON.parse(lastMessage ?? "{}") as { queries?: unknown };
  return { queries: normalizeQueries(so.queries) };
}

function normalizeQueries(raw: unknown): Array<{ query: string; results: WebHit[] }> {
  if (!Array.isArray(raw)) throw new Error("the search answer holds no query list");
  return raw.map((q) => {
    const o = (q ?? {}) as { query?: unknown; results?: unknown };
    const results = (Array.isArray(o.results) ? o.results : [])
      .map((h) => (h ?? {}) as Record<string, unknown>)
      .filter((h) => typeof h.url === "string" && /^https?:\/\//i.test(h.url))
      .map((h) => ({
        url: String(h.url),
        ...(typeof h.title === "string" && h.title ? { title: h.title } : {}),
        ...(typeof h.snippet === "string" && h.snippet ? { snippet: h.snippet } : {}),
      }));
    return { query: typeof o.query === "string" ? o.query : "", results };
  });
}

async function runBatch(
  who: SearchDelegate,
  batch: readonly DelegateQuery[],
  model: string | undefined,
): Promise<{ queries: Array<{ query: string; results: WebHit[] }>; cost?: number }> {
  const work = mkdtempSync(join(tmpdir(), "ultrastock-search-"));
  try {
    const schemaFile = join(work, "schema.json");
    const outFile = join(work, "answer.json");
    writeFileSync(schemaFile, JSON.stringify(SCHEMA));
    const { cmd, args } = delegateCommand(who, delegatePrompt(batch.map((q) => q.query)), { model, schemaFile, outFile });
    // Run from an empty directory: the CLI reads no project of ours, writes nothing into one.
    const r = await shAsync(cmd, args, { cwd: work, timeoutMs: CALL_TIMEOUT_MS });
    if (!r.ok) throw new Error(`${who} exited with an error: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 240)}`);
    let last: string | undefined;
    try {
      last = readFileSync(outFile, "utf8");
    } catch {
      last = undefined;
    }
    return parseDelegateAnswer(who, r.stdout, last);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Search every query through the agent CLI, in batches; one hit list per query that returned any. */
export async function delegatedSearch(who: SearchDelegate, queries: readonly DelegateQuery[], opts: { model?: string } = {}): Promise<DelegateResult> {
  const notes: string[] = [];
  const lists: WebHit[][] = [];
  const bin = who === "claude" ? (env("CLAUDE_CMD") ?? "claude") : (env("CODEX_CMD") ?? "codex");
  let cost = 0;
  for (let i = 0; i < queries.length; i += DELEGATE_BATCH) {
    const batch = queries.slice(i, i + DELEGATE_BATCH);
    let answer: Awaited<ReturnType<typeof runBatch>>;
    try {
      answer = await recordedCall(
        "search",
        [who, opts.model ?? null, batch.map((q) => q.query)],
        async () => {
          if (!have(bin.split(/\s+/)[0]!)) throw new Error(`${who} is not installed (${bin}) — install it, or search with your agent and pass --web-results`);
          return runBatch(who, batch, opts.model);
        },
        (a) => a.queries.some((q) => q.results.length > 0),
      );
    } catch (e) {
      notes.push(`${who} search failed for ${batch.length} quer${batch.length === 1 ? "y" : "ies"}: ${(e as Error).message.split("\n")[0]!.slice(0, 200)}`);
      continue;
    }
    if (answer.cost) cost += answer.cost;
    batch.forEach((q, j) => {
      // By position first (the order was asked for), else by the query text echoed back.
      const got = answer.queries[j]?.query === q.query ? answer.queries[j] : (answer.queries.find((x) => x.query === q.query) ?? answer.queries[j]);
      const hits = (got?.results ?? []).map((h) => ({ ...h, angle: q.angle, query: q.query }));
      if (hits.length) lists.push(hits);
      else notes.push(`${who} search returned nothing for "${q.query}"`);
    });
  }
  notes.push(
    `${queries.length} quer${queries.length === 1 ? "y" : "ies"} searched with ${who}${cost ? ` (${cost.toFixed(2)} USD, billed to your plan)` : " (billed to your plan)"}`,
  );
  return { lists, notes };
}
