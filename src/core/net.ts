// Every byte ultrastock reads from the network goes through here, so a run can
// be recorded (`--record <dir>`) and replayed offline (`--fixture <dir>`).
//
// A fixture stores the raw HTTP answer, not the parsed result: the providers'
// parsers are then exercised against what the upstream really sent, and a
// replay reproduces a run byte for byte — the same evidence, the same [E#] ids,
// the same `fetchedAt`, which is what makes the offline evals deterministic.
// A replay that misses throws: silently going live, or returning nothing, would
// turn a broken gate into a green one.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { awaitHostSlot, contentHash, httpGet, httpJson, writeFileAtomic } from "../engine.js";
import { VERSION } from "../version.js";

export const CONTACT_URL = "https://github.com/maxgfr/ultrastock";
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** The identifying User-Agent for official APIs that ask to be told who calls them. */
export function politeUa(contact?: string): string {
  return `ultrastock/${VERSION} (+${CONTACT_URL}${contact ? `; ${contact}` : ""})`;
}

export type NetMode = { kind: "live" } | { kind: "record"; dir: string } | { kind: "fixture"; dir: string };
let mode: NetMode = { kind: "live" };

/**
 * Declare how this process reaches the network. Recording stamps the fixture
 * with the time it was made; replaying reads that time back as "now", so date
 * windows (the last two years, the last 14 days) ask for the very URLs that
 * were recorded.
 */
export function setNetMode(next: NetMode): void {
  mode = next;
  if (next.kind === "record") {
    mkdirSync(next.dir, { recursive: true });
    const meta = join(next.dir, "fixture.json");
    if (!existsSync(meta)) writeFileAtomic(meta, `${JSON.stringify({ recordedAt: new Date().toISOString(), tool: `ultrastock ${VERSION}` }, null, 2)}\n`);
  }
}

/** The current time — the recording time when replaying a fixture. */
export function clockNow(): Date {
  if (mode.kind !== "live") {
    const meta = join(mode.dir, "fixture.json");
    if (existsSync(meta)) {
      const at = (JSON.parse(readFileSync(meta, "utf8")) as { recordedAt?: string }).recordedAt;
      if (at && !Number.isNaN(Date.parse(at))) return new Date(at);
    }
  }
  return new Date();
}
export function netMode(): NetMode {
  return mode;
}

export interface FetchOptions {
  method?: "GET" | "POST";
  /** A JSON body (POST). */
  json?: unknown;
  headers?: Record<string, string>;
  /** "browser" (default) or a full User-Agent string. */
  userAgent?: string;
  accept?: string;
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  /** Minimum gap between two calls to the same host, for APIs with a published pace (GDELT: 5 s). */
  hostIntervalMs?: number;
}

export interface NetResponse {
  ok: boolean;
  status: number;
  body: string;
  url: string;
  /** When the bytes were read — the recorded time on a replay. */
  fetchedAt: string;
  rateLimited?: boolean;
  error?: string;
  replayed?: boolean;
}

export class FixtureMiss extends Error {}

function requestKey(url: string, opts: FetchOptions, binary = false): string {
  if (binary) return contentHash(`BYTES ${url}`).slice(0, 20);
  return contentHash(`${opts.method ?? "GET"} ${url} ${opts.json === undefined ? "" : JSON.stringify(opts.json)}`).slice(0, 20);
}

function fixturePath(dir: string, key: string): string {
  return join(dir, "http", `${key}.json`);
}

/** Fetch a URL as text, live, recorded or replayed. Never throws on HTTP errors — `ok` says. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<NetResponse> {
  const key = requestKey(url, opts);
  if (mode.kind === "fixture") {
    const path = fixturePath(mode.dir, key);
    if (!existsSync(path)) throw new FixtureMiss(`fixture ${mode.dir} has no recorded answer for ${opts.method ?? "GET"} ${url} — re-record it with --record`);
    const rec = JSON.parse(readFileSync(path, "utf8")) as { response: NetResponse };
    return { ...rec.response, replayed: true };
  }
  if (opts.hostIntervalMs) await awaitHostSlot(url, opts.hostIntervalMs);
  const userAgent = !opts.userAgent || opts.userAgent === "browser" ? BROWSER_UA : opts.userAgent;
  const fetchedAt = new Date().toISOString();
  let res: NetResponse;
  if ((opts.method ?? "GET") === "GET") {
    const r = await httpGet(url, {
      userAgent,
      headers: opts.headers,
      accept: opts.accept,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      maxBytes: opts.maxBytes ?? 32 * 1024 * 1024,
    });
    res = { ok: r.ok, status: r.status, body: r.body, url: r.url || url, fetchedAt, rateLimited: r.rateLimited, error: r.error };
  } else {
    const r = await httpJson("POST", url, opts.json, {
      userAgent,
      headers: opts.headers,
      accept: opts.accept,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      maxBytes: opts.maxBytes ?? 32 * 1024 * 1024,
    });
    res = { ok: r.ok, status: r.status, body: r.data === undefined ? "" : JSON.stringify(r.data), url, fetchedAt, error: r.error };
  }
  if (mode.kind === "record" && res.ok) {
    mkdirSync(join(mode.dir, "http"), { recursive: true });
    writeFileAtomic(
      fixturePath(mode.dir, key),
      `${JSON.stringify({ request: { method: opts.method ?? "GET", url, json: opts.json }, response: { ...res, rateLimited: undefined } }, null, 1)}\n`,
    );
  }
  return res;
}

/** Fetch and parse JSON; `data` is undefined when the body is not JSON. */
export async function fetchJson<T = any>(url: string, opts: FetchOptions = {}): Promise<NetResponse & { data?: T }> {
  const res = await fetchText(url, { accept: "application/json", ...opts });
  if (!res.ok) return res;
  try {
    return { ...res, data: JSON.parse(res.body) as T };
  } catch {
    return { ...res, ok: false, error: `not JSON: ${res.body.slice(0, 80)}` };
  }
}

/** A response read as raw bytes: a PDF, an office document, a page whose charset the caller decodes. */
export interface BytesResponse extends NetResponse {
  bytes: Buffer;
  contentType: string;
}

/**
 * Fetch a URL as bytes (a factsheet or a KID PDF, a page to sniff), live,
 * recorded or replayed. The fixture keeps the body in base64 next to its
 * content type, so a replayed PDF is the very file that was read.
 */
export async function fetchBytes(url: string, opts: FetchOptions = {}): Promise<BytesResponse> {
  const key = requestKey(url, opts, true);
  if (mode.kind === "fixture") {
    const path = fixturePath(mode.dir, key);
    if (!existsSync(path)) throw new FixtureMiss(`fixture ${mode.dir} has no recorded bytes for GET ${url} — re-record it with --record`);
    const rec = JSON.parse(readFileSync(path, "utf8")) as { response: NetResponse & { bodyBase64?: string; contentType?: string } };
    const { bodyBase64, contentType, ...response } = rec.response;
    return { ...response, bytes: Buffer.from(bodyBase64 ?? "", "base64"), contentType: contentType ?? "", replayed: true };
  }
  if (opts.hostIntervalMs) await awaitHostSlot(url, opts.hostIntervalMs);
  const userAgent = !opts.userAgent || opts.userAgent === "browser" ? BROWSER_UA : opts.userAgent;
  const fetchedAt = new Date().toISOString();
  const r = await httpGet(url, {
    userAgent,
    headers: opts.headers,
    accept: opts.accept,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    maxBytes: opts.maxBytes ?? 32 * 1024 * 1024,
    binary: true,
  });
  const bytes = r.bytes ?? Buffer.from(r.body ?? "", "utf8");
  const res: BytesResponse = {
    ok: r.ok,
    status: r.status,
    body: "",
    url: r.url || url,
    fetchedAt,
    rateLimited: r.rateLimited,
    error: r.error,
    bytes,
    contentType: r.contentType ?? "",
  };
  if (mode.kind === "record" && res.ok) {
    mkdirSync(join(mode.dir, "http"), { recursive: true });
    const { bytes: _bytes, ...rest } = res;
    writeFileAtomic(
      fixturePath(mode.dir, key),
      `${JSON.stringify({ request: { method: "GET", url, binary: true }, response: { ...rest, rateLimited: undefined, bodyBase64: bytes.toString("base64") } }, null, 1)}\n`,
    );
  }
  return res;
}
