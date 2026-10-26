// `searxng`, `firecrawl` and `stack` up|down|status: the optional local
// containers the engine's search cascade uses — SearXNG (:8888, keyless
// discovery with a JSON API, so `research --engine-search` stops depending on
// public engines that throttle) and Firecrawl (:3002, a browser-backed reader).
// Docker only; everything they provide degrades to a note without them.
//
// The compose project is shared with the other skills built on the engine
// (ultrasearch, webindex): one SearXNG on the machine, whichever tool started
// it — the same directory ultrasearch uses.
import { homedir } from "node:os";
import { join } from "node:path";
import { brand, type CommandArgs, firecrawlBase, jsonLine, probeFirecrawl, probeSearxng, searxngBase, stackControl, UsageError } from "../engine.js";

/** Run a stack action with the engine's cache pointed at the shared compose directory. */
function withSharedStack<T>(action: () => T): T {
  const key = `${brand().envPrefix}_CACHE_DIR`;
  const saved = process.env[key];
  process.env[key] = process.env.ULTRA_STACK_CACHE_DIR || join(homedir(), ".cache", "skills");
  try {
    return action();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

export async function localServices(): Promise<Array<{ name: string; url: string | null; up: boolean }>> {
  const sx = searxngBase();
  const fc = firecrawlBase();
  return [
    { name: "searxng", url: sx, up: sx ? await probeSearxng(sx) : false },
    { name: "firecrawl", url: fc, up: fc ? await probeFirecrawl(fc) : false },
  ];
}

export async function stackCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const service = args.command === "stack" ? ["searxng", "firecrawl"] : [args.command];
  const action = args.positional[0] ?? "status";
  if (!["up", "down", "status"].includes(action)) throw new UsageError(`usage: ultrastock ${args.command} up|down|status`);
  if (action !== "status") {
    const r = withSharedStack(() => stackControl(args.command === "stack" ? "firecrawl" : service[0]!, action));
    if (asJson) process.stdout.write(jsonLine({ action, service, code: r.code, message: r.message }));
    else process.stdout.write(`${r.message}\n`);
    if (r.code !== 0) process.exit(r.code);
    if (action === "down") return;
  }
  const rows = (await localServices()).filter((s) => service.includes(s.name));
  if (asJson) process.stdout.write(jsonLine({ services: rows }));
  else
    for (const s of rows)
      process.stdout.write(
        `${s.name}: ${s.up ? `up at ${s.url}` : s.url ? `not answering at ${s.url} — \`ultrastock ${s.name} up\` (Docker)` : "off (ULTRASTOCK_" + s.name.toUpperCase() + "=off)"}\n`,
      );
}
