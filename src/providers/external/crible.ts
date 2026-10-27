// maxgfr/crible — the owner's self-hosted global fundamental screener (~95k
// equities; SEC, ESEF, Companies House… audited figures; Piotroski, Altman,
// Beneish, composite quality/value/momentum ranks). A Python tool: ultrastock
// runs it through uvx at a pinned tag, never reads its Parquet itself.
//
//   uvx --from git+https://github.com/maxgfr/crible@<tag> crible --data-dir <dir> screen "<DSL>" --format json
//   … company <symbol>                via its MCP server (stdio JSON-RPC), the only door to it
//
// `--data-dir` must precede the subcommand, and a fresh directory needs
// `bootstrap` once (~1 minute, downloads the published dataset).
//
// Like every network read, a crible call is recorded with `--record <dir>`
// (`<dir>/crible/<hash of the arguments>.json`) and replayed with `--fixture`:
// a replay never starts uvx, never needs a dataset, and a call it did not
// record fails instead of going live.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env, have, shAsync } from "../../engine.js";
import { cachedJson, TTL } from "../../core/cache.js";
import { clockNow, fetchJson, netMode, politeUa, recordedCall } from "../../core/net.js";
import { homeDir } from "../../core/paths.js";
import { ProviderError } from "../types.js";

export const SOURCE = "crible";
export const CRIBLE_TAG = "v0.16.0";
const REPO = "https://github.com/maxgfr/crible";

/** The command that runs crible: ULTRASTOCK_CRIBLE_CMD (e.g. "crible" when installed), else uvx at the pinned tag. */
export function cribleInvocation(): { cmd: string; args: string[] } {
  const custom = env("CRIBLE_CMD");
  if (custom) {
    const [cmd, ...args] = custom.split(/\s+/).filter(Boolean);
    return { cmd: cmd!, args };
  }
  return { cmd: "uvx", args: ["--from", `git+${REPO}@${CRIBLE_TAG}`, "crible"] };
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
  if (!cribleAvailable()) throw new ProviderError(SOURCE, "uvx is not installed — install uv (https://docs.astral.sh/uv/) to use crible", 0);
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
const iso = (d: Date) => d.toISOString().slice(0, 10);

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

export async function cribleStatus(): Promise<Record<string, unknown>> {
  return JSON.parse(await run(["status"]));
}

export interface CribleScreen {
  total: number;
  rows: Array<Record<string, unknown>>;
}

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
  if (!cribleAvailable()) throw new ProviderError(SOURCE, "uvx is not installed — install uv to use crible", 0);
  const { cmd, args } = cribleInvocation();
  const child = spawn(cmd, [...args, "--data-dir", cribleDataDir(), "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ProviderError(SOURCE, `crible mcp did not answer ${tool} within ${timeoutMs} ms`, 0));
    }, timeoutMs);
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        const msg = JSON.parse(line) as { id?: number; result?: any; error?: { message: string } };
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: toolArgs } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          if (msg.error) return reject(new ProviderError(SOURCE, `crible ${tool}: ${msg.error.message}`, 400));
          const r = msg.result ?? {};
          if (r.isError) return reject(new ProviderError(SOURCE, `crible ${tool}: ${r.content?.[0]?.text ?? "error"}`, 400));
          if (r.structuredContent !== undefined) return resolve(r.structuredContent.result ?? r.structuredContent);
          const text = r.content?.[0]?.text;
          resolve(text === undefined ? null : JSON.parse(text));
        }
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ProviderError(SOURCE, `cannot start crible: ${e.message}`, 0));
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
