// Binary downloads (a ZIP index, a regulator's PDF) with the same record/replay
// contract as core/net.ts: `fetchText` decodes every body as text, which
// corrupts a ZIP and empties a PDF, and the sources in this folder need both
// (the House disclosure index is a ZIP, AMF and House filings are PDFs).
//
// The bytes are stored base64 in the fixture, beside net.ts's text answers and
// under the same `http/<key>.json` layout, with a key that cannot collide with
// a text request for the same URL. Replay never goes live; a miss throws.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { awaitHostSlot, contentHash, httpGet, writeFileAtomic } from "../../engine.js";
import { BROWSER_UA, FixtureMiss, netMode } from "../../core/net.js";

export interface BinaryResponse {
  ok: boolean;
  status: number;
  bytes: Buffer;
  url: string;
  contentType: string;
  fetchedAt: string;
  error?: string;
  replayed?: boolean;
}

export interface BinaryOptions {
  userAgent?: string;
  accept?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  hostIntervalMs?: number;
}

interface Recorded {
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  fetchedAt: string;
  bodyBase64: string;
}

const keyOf = (url: string) => contentHash(`GET-BYTES ${url}`).slice(0, 20);

/** GET a URL as raw bytes, live, recorded or replayed. Never throws on HTTP errors — `ok` says. */
export async function fetchBinary(url: string, opts: BinaryOptions = {}): Promise<BinaryResponse> {
  const mode = netMode();
  const path = mode.kind === "live" ? "" : join(mode.dir, "http", `${keyOf(url)}.json`);
  if (mode.kind === "fixture") {
    if (!existsSync(path)) throw new FixtureMiss(`fixture ${mode.dir} has no recorded answer for GET ${url} (binary) — re-record it with --record`);
    const rec = (JSON.parse(readFileSync(path, "utf8")) as { response: Recorded }).response;
    return {
      ok: rec.ok,
      status: rec.status,
      url: rec.url,
      contentType: rec.contentType,
      fetchedAt: rec.fetchedAt,
      bytes: Buffer.from(rec.bodyBase64, "base64"),
      replayed: true,
    };
  }
  if (opts.hostIntervalMs) await awaitHostSlot(url, opts.hostIntervalMs);
  const fetchedAt = new Date().toISOString();
  const r = await httpGet(url, {
    binary: true,
    userAgent: !opts.userAgent || opts.userAgent === "browser" ? BROWSER_UA : opts.userAgent,
    accept: opts.accept ?? "*/*",
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    maxBytes: opts.maxBytes ?? 32 * 1024 * 1024,
  });
  const bytes = r.bytes ?? Buffer.alloc(0);
  const ok = r.ok && !r.truncated;
  const res: BinaryResponse = {
    ok,
    status: r.status,
    bytes,
    url: r.url || url,
    contentType: r.contentType,
    fetchedAt,
    error: r.truncated ? "response over the size cap" : r.error,
  };
  if (mode.kind === "record" && ok) {
    mkdirSync(join(mode.dir, "http"), { recursive: true });
    const response: Recorded = { ok, status: r.status, url: res.url, contentType: r.contentType, fetchedAt, bodyBase64: bytes.toString("base64") };
    writeFileAtomic(path, `${JSON.stringify({ request: { method: "GET", url, binary: true }, response }, null, 1)}\n`);
  }
  return res;
}
