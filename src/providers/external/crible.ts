// maxgfr/crible — the owner's self-hosted global fundamental screener (~150k
// equities; SEC, ESEF, Companies House… audited figures; Piotroski, Altman,
// Beneish, composite quality/value/momentum ranks). A Python tool: ultrastock
// runs it at a pinned tag (a Homebrew crible of that version, else uvx), never
// reads its Parquet itself.
//
//   uvx --from git+https://github.com/maxgfr/crible@<tag> crible --data-dir <dir> screen "<DSL>" --format json
//   … company <symbol>, stats <fields> via its MCP server (stdio JSON-RPC), the only door to them
//
// `--data-dir` must precede the subcommand, and a fresh directory needs
// `bootstrap` once (~1 minute, downloads the published dataset).
//
// Like every network read, a crible call is recorded with `--record <dir>`
// (`<dir>/crible/<hash of the arguments>.json`) and replayed with `--fixture`:
// a replay never starts uvx, never needs a dataset, and a call it did not
// record fails instead of going live.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { env, have, shAsync } from "../../engine.js";
import { cachedJson, TTL } from "../../core/cache.js";
import { clockNow, fetchJson, netMode, politeUa, recordedCall } from "../../core/net.js";
import { homeDir } from "../../core/paths.js";
import { isoDayOf as iso } from "../fundamentals/util.js";
import { ProviderError } from "../types.js";

export const SOURCE = "crible";
export const CRIBLE_TAG = "v0.17.0";
const REPO = "https://github.com/maxgfr/crible";
/** What to say when crible cannot run here. */
export const NOT_RUNNABLE = `crible cannot run here: install it with \`brew install maxgfr/tap/crible\` (${CRIBLE_TAG.slice(1)}), or install uv (https://docs.astral.sh/uv/) so uvx runs the pinned tag`;

/** The version of a Homebrew crible from its keg path (`…/Cellar/crible/0.17.0_1/bin/crible` → 0.17.0). */
export function brewKegVersion(realPath: string): string | undefined {
  return /\/Cellar\/crible\/(\d+\.\d+\.\d+)(?:_\d+)?\/bin\/crible$/.exec(realPath)?.[1];
}

/** Does crible `version` serve what the pinned tag serves? The same minor, at least the pinned patch (0.x: a minor may break). */
export function servesPin(version: string, tag = CRIBLE_TAG): boolean {
  const v = version.split(".").map(Number);
  const p = tag.replace(/^v/, "").split(".").map(Number);
  return v.length === 3 && p.length === 3 && v[0] === p[0] && v[1] === p[1] && v[2]! >= p[2]!;
}

/** The `crible` on PATH when it is a Homebrew keg (`brew install maxgfr/tap/crible`), with its version. */
export function brewCrible(pathEnv = process.env.PATH ?? ""): { path: string; version: string } | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, "crible");
    if (!existsSync(bin)) continue;
    let real: string;
    try {
      real = realpathSync(bin);
    } catch {
      continue;
    }
    const version = brewKegVersion(real);
    return version ? { path: bin, version } : undefined; // the first crible on PATH is the one a shell runs
  }
  return undefined;
}

export interface CribleInvocation {
  cmd: string;
  args: string[];
  /** env: ULTRASTOCK_CRIBLE_CMD; brew: a Homebrew crible that serves the pin; uvx: the pinned tag through uvx. */
  via: "env" | "brew" | "uvx";
  /** Why a Homebrew crible on PATH was passed over. */
  note?: string;
}

/**
 * The command that runs crible: ULTRASTOCK_CRIBLE_CMD when set; else the Homebrew
 * crible when it serves the pinned tag (no git resolution, a ready environment);
 * else uvx at the pinned tag.
 */
export function cribleInvocation(): CribleInvocation {
  const custom = env("CRIBLE_CMD");
  if (custom) {
    const [cmd, ...args] = custom.split(/\s+/).filter(Boolean);
    return { cmd: cmd!, args, via: "env" };
  }
  const brew = brewCrible();
  if (brew && servesPin(brew.version)) return { cmd: brew.path, args: [], via: "brew" };
  return {
    cmd: "uvx",
    args: ["--from", `git+${REPO}@${CRIBLE_TAG}`, "crible"],
    via: "uvx",
    ...(brew ? { note: `the Homebrew crible is ${brew.version}, not the pinned ${CRIBLE_TAG}: \`brew upgrade crible\` once the tap follows it` } : {}),
  };
}

export function cribleDataDir(): string {
  return env("CRIBLE_DATA_DIR") ?? join(homeDir(), "crible");
}

/** Can crible run here — or, replaying a fixture, are its calls replayed (no uvx needed)? */
export function cribleAvailable(): boolean {
  if (netMode().kind === "fixture") return true;
  return have(cribleInvocation().cmd);
}

export function cribleBootstrapped(dir = cribleDataDir()): boolean {
  if (netMode().kind === "fixture") return true;
  return existsSync(join(dir, "universe.parquet")) || existsSync(join(dir, "crible.duckdb")) || existsSync(join(dir, "snapshot"));
}

async function run(sub: string[], timeoutMs = 120_000): Promise<string> {
  // bootstrap writes a dataset: never recorded, never replayed.
  if (sub[0] === "bootstrap") return runLive(sub, timeoutMs);
  return recordedCall("crible", ["cli", ...sub], () => runLive(sub, timeoutMs));
}

async function runLive(sub: string[], timeoutMs: number): Promise<string> {
  if (!cribleAvailable()) throw new ProviderError(SOURCE, NOT_RUNNABLE, 0);
  const { cmd, args } = cribleInvocation();
  const r = await shAsync(cmd, [...args, "--data-dir", cribleDataDir(), ...sub], { timeoutMs });
  if (!r.ok) throw new ProviderError(SOURCE, `crible ${sub[0]} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`, 0);
  return r.stdout;
}

/** Download the published dataset into the data directory (once; ~1 minute) — with `force`, over an existing one (a refresh). */
export async function cribleBootstrap(force = false): Promise<string> {
  return run(["bootstrap", ...(force ? ["--force"] : [])], 15 * 60_000);
}

// ── Freshness ──────────────────────────────────────────────────────────────
// crible publishes its dataset daily as the `data-latest` release; a local
// copy only moves when the user bootstraps again. Every crible-backed command
// says when the local copy is old — it never downloads one by itself.

/** The manifest of the latest published dataset (its `generated_at` is the build time, unix seconds). */
export const CRIBLE_DATA_MANIFEST = `${REPO}/releases/download/data-latest/manifest.json`;
/** A local dataset older than this many days is called stale (ULTRASTOCK_CRIBLE_MAX_AGE_DAYS overrides). */
export const CRIBLE_MAX_AGE_DAYS = 7;
/** The command that refreshes it. */
export const CRIBLE_REFRESH = "ultrastock screen --engine crible --bootstrap";

const DAY_MS = 86_400_000;

/**
 * When the local dataset was built: the manifest of the release it was
 * restored from (`.restored-manifest.json`, `generated_at`), else crible's own
 * `status.json` timestamp; undefined when the directory holds neither.
 */
export function cribleLocalBuiltAt(dir = cribleDataDir()): Date | undefined {
  for (const [file, field] of [
    [".restored-manifest.json", "generated_at"],
    ["status.json", "ts"],
  ] as const) {
    try {
      const v = (JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>)[field];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000);
    } catch {
      // absent or unreadable: try the next one
    }
  }
  return undefined;
}

export interface CribleFreshness {
  /** The local dataset's build day. */
  local: string;
  ageDays: number;
  maxAgeDays: number;
  /** The latest published dataset's build day, when the release answered. */
  published?: string;
  /** Older than the threshold, and no published dataset known to be as old or older. */
  stale: boolean;
  message: string;
}

/** The build time of the latest published dataset (cached six hours), or undefined when GitHub does not answer. */
async function publishedBuiltAt(): Promise<Date | undefined> {
  const t = await cachedJson<number>("crible:data-latest:generated_at", TTL.daily, async () => {
    const r = await fetchJson<{ generated_at?: number }>(CRIBLE_DATA_MANIFEST, { userAgent: politeUa(), retries: 0, timeoutMs: 10_000 });
    const v = r.ok ? r.data?.generated_at : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  });
  return t === undefined ? undefined : new Date(t * 1000);
}

/** Classify a local dataset's age against the threshold and the published one. Pure. */
export function cribleFreshnessOf(local: Date, now: Date, maxAgeDays: number, published?: Date): CribleFreshness {
  const ageDays = Math.floor((now.getTime() - local.getTime()) / DAY_MS);
  // Refreshing only helps when the release is newer than the local copy (by more than a day's rebuild).
  const newer = published === undefined || published.getTime() - local.getTime() > DAY_MS;
  const stale = ageDays > maxAgeDays && newer;
  const pub = published ? `; the published data-latest dataset was built ${iso(published)}` : "";
  const message = stale
    ? `crible's local dataset is ${ageDays} days old (built ${iso(local)}${pub}) — its fundamentals, caps and prices may be out of date; refresh it with \`${CRIBLE_REFRESH}\` (re-downloads the published dataset, about a minute, and replaces the local copy)`
    : `crible's local dataset was built ${iso(local)} (${ageDays} day${ageDays === 1 ? "" : "s"} old${pub})`;
  return { local: iso(local), ageDays, maxAgeDays, ...(published ? { published: iso(published) } : {}), stale, message };
}

let freshness: Promise<CribleFreshness | undefined> | undefined;

/**
 * How old the local dataset is, checked once per process. Undefined when
 * there is no local dataset to date, and in a recorded or replayed run (a
 * fixture's answers do not depend on the machine's dataset).
 */
export function cribleFreshness(now: Date = clockNow()): Promise<CribleFreshness | undefined> {
  if (netMode().kind !== "live") return Promise.resolve(undefined);
  freshness ??= (async () => {
    const local = cribleLocalBuiltAt();
    if (!local) return undefined;
    const max = Number(env("CRIBLE_MAX_AGE_DAYS") ?? CRIBLE_MAX_AGE_DAYS);
    const published = await publishedBuiltAt().catch(() => undefined);
    return cribleFreshnessOf(local, now, Number.isFinite(max) && max >= 0 ? max : CRIBLE_MAX_AGE_DAYS, published);
  })();
  return freshness;
}

/** The warning a crible-backed command adds to its notes when the local dataset is stale, else undefined. Never throws. */
export async function cribleStaleWarning(): Promise<string | undefined> {
  try {
    const f = await cribleFreshness();
    return f?.stale ? f.message : undefined;
  } catch {
    return undefined;
  }
}

export interface CribleScreen {
  total: number;
  rows: Array<Record<string, unknown>>;
}

/**
 * A value as a crible DSL string literal: single-quoted, a backslash and a
 * single quote escaped by a backslash. crible's lexer reads
 * `'(?:[^'\\]|\\.)*'` and unescapes `\'` and `\\` (src/crible/dsl/parser.py
 * at the pinned tag); a doubled `''` is not an escape there. Build every value
 * a query compares against with this, never by hand.
 */
export const cribleString = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** Run a DSL query: `piotroski_f >= 7 AND altman_z > 3`, `symbol = 'MC.PA'`. */
export async function cribleScreen(query: string, opts: { sort?: string; limit?: number; offset?: number } = {}): Promise<CribleScreen> {
  if (!cribleBootstrapped())
    throw new ProviderError(
      SOURCE,
      `crible has no dataset in ${cribleDataDir()} — run \`ultrastock screen --engine crible --bootstrap\` once (about a minute)`,
      400,
    );
  const args = ["screen", query, "--format", "json", "--limit", String(opts.limit ?? 50), "--offset", String(opts.offset ?? 0)];
  if (opts.sort) args.push("--sort", opts.sort);
  const out = await run(args);
  try {
    const parsed = JSON.parse(out.slice(out.indexOf("{"))) as CribleScreen;
    return parsed;
  } catch {
    throw new ProviderError(SOURCE, `crible screen did not return JSON: ${out.slice(0, 200)}`, 0);
  }
}

export async function cribleFields(): Promise<Array<{ name: string; type: string }>> {
  return JSON.parse(await run(["fields", "--format", "json"]));
}

/** Call one tool of `crible mcp` over stdio JSON-RPC and return its JSON result. */
export async function cribleMcpCall(tool: string, toolArgs: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
  return recordedCall("crible", ["mcp", tool, toolArgs], () => cribleMcpLive(tool, toolArgs, timeoutMs));
}

async function cribleMcpLive(tool: string, toolArgs: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  if (!cribleAvailable()) throw new ProviderError(SOURCE, NOT_RUNNABLE, 0);
  const { cmd, args } = cribleInvocation();
  return mcpToolCall(spawn(cmd, [...args, "--data-dir", cribleDataDir(), "mcp"], { stdio: ["pipe", "pipe", "pipe"] }), tool, toolArgs, timeoutMs);
}

/**
 * One `tools/call` against an MCP server speaking JSON-RPC over stdio:
 * initialize, call, read the answer, stop the server. Whatever the server does
 * — an unreadable line, an early exit, silence — ends in a rejected promise
 * that says so: a throw inside a stream listener would be an uncaught
 * exception and take the whole command down with it.
 */
export function mcpToolCall(child: ChildProcessWithoutNullStreams, tool: string, toolArgs: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const send = (msg: unknown) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let errors = "";
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      settle();
    };
    const fail = (message: string, status = 0) => finish(() => reject(new ProviderError(SOURCE, message, status)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(`crible mcp did not answer ${tool} within ${timeoutMs} ms`);
    }, timeoutMs);
    const answer = (line: string) => {
      const msg = JSON.parse(line) as { id?: number; result?: any; error?: { message: string } };
      if (msg.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: toolArgs } });
      } else if (msg.id === 2) {
        if (msg.error) return fail(`crible ${tool}: ${msg.error.message}`, 400);
        const r = msg.result ?? {};
        if (r.isError) return fail(`crible ${tool}: ${r.content?.[0]?.text ?? "error"}`, 400);
        const text = r.content?.[0]?.text;
        const value = r.structuredContent !== undefined ? (r.structuredContent.result ?? r.structuredContent) : text === undefined ? null : JSON.parse(text);
        finish(() => resolve(value));
      }
    };
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          answer(line);
        } catch {
          fail(`crible mcp sent an answer to ${tool} that is not JSON: ${line.slice(0, 120)}`);
        }
      }
    });
    // Read, so a talkative server never blocks on a full pipe; its last line explains an early exit.
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString("utf8")).slice(-2000);
    });
    // A server that died closed its end: the exit below reports it, the write error must not be thrown.
    child.stdin.on("error", () => {});
    child.on("error", (e) => fail(`cannot start crible: ${e.message}`));
    child.on("exit", (code, signal) => {
      const last = errors.trim().split("\n").at(-1)?.slice(0, 200);
      fail(`crible mcp stopped before answering ${tool} (${signal ?? `exit ${code}`})${last ? `: ${last}` : ""}`);
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ultrastock", version: "1" } },
    });
  });
}

/** One company's profile and full period history, or undefined when crible does not cover it. */
export async function cribleCompany(symbol: string): Promise<Record<string, unknown> | undefined> {
  const r = await cribleMcpCall("company", { symbol });
  return r && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
}

export interface CribleFieldStats {
  n: number;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  p10?: number | null;
  p25?: number | null;
  median?: number | null;
  p75?: number | null;
  p90?: number | null;
  value?: number | null;
  percentile?: number | null;
}
export interface CribleStats {
  symbol: string | null;
  group: { basis: string; rows: number; query?: string; region?: string; sector?: string; reason?: string };
  fields: Record<string, CribleFieldStats>;
}

/**
 * crible's `stats` tool (crible ≥ v0.17): each numeric field's distribution
 * over a peer group — the DSL `query`, else the symbol's region×sector, else
 * the universe — and the symbol's value and percentile in it. Undefined when
 * the symbol is not in crible's snapshot.
 */
export async function cribleStats(fields: string[], opts: { symbol?: string; query?: string } = {}): Promise<CribleStats | undefined> {
  const r = await cribleMcpCall("stats", { fields, ...(opts.symbol ? { symbol: opts.symbol } : {}), ...(opts.query ? { query: opts.query } : {}) });
  return r && typeof r === "object" && "fields" in r ? (r as CribleStats) : undefined;
}
