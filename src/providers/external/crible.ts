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
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, have, shAsync } from "../../engine.js";
import { homeDir } from "../../core/paths.js";
import { ProviderError } from "../types.js";

export const SOURCE = "crible";
export const CRIBLE_TAG = "v0.15.0";
const REPO = "https://github.com/maxgfr/crible";

/** The command that runs crible: ULTRASTOCK_CRIBLE_CMD (e.g. "crible" when installed), else uvx at the pinned tag. */
export function cribleInvocation(): { cmd: string; args: string[] } {
  const custom = env("CRIBLE_CMD");
  if (custom) {
    const [cmd, ...args] = custom.split(/\s+/).filter(Boolean);
    return { cmd: cmd!, args };
  }
  // crible declares `mcp>=1.2` and its server imports `mcp.server.fastmcp`, which mcp 2.x removed:
  // cap it here until crible caps it itself.
  return { cmd: "uvx", args: ["--from", `git+${REPO}@${CRIBLE_TAG}`, "--with", "mcp<2", "crible"] };
}

export function cribleDataDir(): string {
  return env("CRIBLE_DATA_DIR") ?? join(homeDir(), "crible");
}

export function cribleAvailable(): boolean {
  return have(cribleInvocation().cmd);
}

export function cribleBootstrapped(dir = cribleDataDir()): boolean {
  return existsSync(join(dir, "universe.parquet")) || existsSync(join(dir, "crible.duckdb")) || existsSync(join(dir, "snapshot"));
}

async function run(sub: string[], timeoutMs = 120_000): Promise<string> {
  if (!cribleAvailable()) throw new ProviderError(SOURCE, "uvx is not installed — install uv (https://docs.astral.sh/uv/) to use crible", 0);
  const { cmd, args } = cribleInvocation();
  const r = await shAsync(cmd, [...args, "--data-dir", cribleDataDir(), ...sub], { timeoutMs });
  if (!r.ok) throw new ProviderError(SOURCE, `crible ${sub[0]} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`, 0);
  return r.stdout;
}

/** Download the published dataset into the data directory (once; ~1 minute). */
export async function cribleBootstrap(): Promise<string> {
  return run(["bootstrap"], 15 * 60_000);
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
