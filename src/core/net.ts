// Every byte ultrastock reads from the network goes through here, so a run can
// be recorded (`--record <dir>`) and replayed offline (`--fixture <dir>`).
//
// A fixture stores the raw HTTP answer, not the parsed result: the providers'
// parsers are then exercised against what the upstream really sent, and a
// replay reproduces a run byte for byte — the same evidence, the same [E#] ids,
// the same `fetchedAt`, which is what makes the offline evals deterministic.
// A replay that misses throws: silently going live, or returning nothing, would
// turn a broken gate into a green one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awaitHostSlot, contentHash, httpGet, httpJson, sleep, writeFileAtomic } from "../engine.js";
import { VERSION } from "../version.js";
import { withFileLockSync } from "./lock.js";
import { dataCacheDir } from "./paths.js";

export const CONTACT_URL = "https://github.com/maxgfr/ultrastock";
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** The identifying User-Agent for official APIs that ask to be told who calls them. */
export function politeUa(contact?: string): string {
  return `ultrastock/${VERSION} (+${CONTACT_URL}${contact ? `; ${contact}` : ""})`;
}

export type NetMode = { kind: "live" } | { kind: "record"; dir: string } | { kind: "fixture"; dir: string };
let mode: NetMode = { kind: "live" };

// One process, one answer per GET.
//
// A command is one short-lived process (an MCP tool call spawns its own), and
// its slices are written independently: `analyze --depth full` on a US share
// reads the SEC's submissions index from four of them, the price history and
// the quote from three, each insider filing from two. Within the process a GET
// is therefore sent once and its answer shared — in flight included, so two
// slices running side by side wait for the same request — with the `fetchedAt`
// of the read that really happened. Nothing is kept across processes: this is
// no cache of market data, and a second command asks again.
const MEMO_MS = 5 * 60_000;
/** A body larger than this is not held (characters). */
const MEMO_ENTRY_CHARS = 8 * 1024 * 1024;
/** What the memo may hold in all (characters); the oldest answers go first. */
const MEMO_TOTAL_CHARS = 64 * 1024 * 1024;
const memo = new Map<string, { at: number; size: number; res: Promise<NetResponse> }>();

function forget(key: string, entry: { res: Promise<NetResponse> }): void {
  if (memo.get(key)?.res === entry.res) memo.delete(key);
}

function trimMemo(): void {
  let total = 0;
  for (const e of memo.values()) total += e.size;
  for (const [k, e] of memo) {
    if (total <= MEMO_TOTAL_CHARS) break;
    memo.delete(k);
    total -= e.size;
  }
}

/**
 * Declare how this process reaches the network. Recording stamps the fixture
 * with the time it was made; replaying reads that time back as "now", so date
 * windows (the last two years, the last 14 days) ask for the very URLs that
 * were recorded.
 */
export function setNetMode(next: NetMode): void {
  mode = next;
  memo.clear(); // an answer read live is not what another recording, or a replay, holds
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
  /**
   * Approves the URL and every redirect before it is requested (GET only): a
   * link that did not come from ultrastock's own code is fetched with
   * `isPublicUrl`. A refusal answers `ok: false` with "URL not authorized".
   */
  authorizeUrl?: (url: string) => Promise<boolean>;
  /**
   * The URL a fixture stores and is keyed by, for a request whose real URL
   * carries a credential (an API key in the query, a private RPC endpoint): a
   * recording never holds the secret, and replays whatever key is set, or none.
   */
  recordAs?: string;
  /** Ask the network again even when this process already holds the answer to the same GET. */
  fresh?: boolean;
}

/** Was the request refused by its `authorizeUrl`, before any byte left? */
export const refusedUrl = (res: Pick<NetResponse, "error">): boolean => /^URL (?:not authorized|authorization failed)/.test(res.error ?? "");

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

const MAX_BYTES = 32 * 1024 * 1024;

/**
 * A body cut at the size cap is not the answer: a parser would read half a
 * CSV, or the first pages of a PDF, as if it were the whole file. It is a
 * failed read, said so, and never recorded.
 */
function whole(r: { ok: boolean; truncated?: boolean; error?: string }, maxBytes = MAX_BYTES): { ok: boolean; error?: string } {
  return r.ok && r.truncated ? { ok: false, error: `the response is larger than ${maxBytes} bytes: cut short, not used` } : { ok: r.ok, error: r.error };
}

function fixturePath(dir: string, key: string): string {
  return join(dir, "http", `${key}.json`);
}

/** Fetch a URL as text, live, recorded or replayed. Never throws on HTTP errors — `ok` says. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<NetResponse> {
  const shown = opts.recordAs ?? url;
  const key = requestKey(shown, opts);
  if (mode.kind === "fixture") {
    const path = fixturePath(mode.dir, key);
    if (!existsSync(path))
      throw new FixtureMiss(`fixture ${mode.dir} has no recorded answer for ${opts.method ?? "GET"} ${shown} — re-record it with --record`);
    const rec = JSON.parse(readFileSync(path, "utf8")) as { response: NetResponse };
    return { ...rec.response, replayed: true };
  }
  // A GET already answered, or in flight, in this process is that answer. A request that names who may be reached
  // (`authorizeUrl`) is a link from outside, read once; `fresh` asks for a new read.
  if ((opts.method ?? "GET") !== "GET" || opts.authorizeUrl || opts.fresh) return requestText(url, opts, shown, key);
  const memoKey = JSON.stringify([shown, opts.userAgent ?? "", opts.accept ?? "", opts.headers ?? {}, opts.maxBytes ?? 0]);
  const hit = memo.get(memoKey);
  if (hit && Date.now() - hit.at < MEMO_MS) return { ...(await hit.res) };
  const entry = { at: Date.now(), size: 0, res: requestText(url, opts, shown, key) };
  memo.set(memoKey, entry);
  try {
    const res = await entry.res;
    entry.size = res.body.length;
    // Only an answer is kept: a refusal or a throttle must stay free to be asked again, and a very large body is not held.
    if (!res.ok || entry.size > MEMO_ENTRY_CHARS) forget(memoKey, entry);
    else trimMemo();
    return { ...res };
  } catch (e) {
    forget(memoKey, entry);
    throw e;
  }
}

// A host's published pace (GDELT one call per 5 s, the SEC ten a second) is a
// pace per caller, and two MCP tool calls are two processes. The engine spaces
// calls within this process and holds them after a 429; across processes each
// call also reserves the host's next free instant in <cache>/hosts/<host>.next,
// read and moved on under a lock held for the read and the write only, then
// sleeps outside it until its instant comes.

/** A reservation further ahead than this many intervals is a clock moved back or a garbled file, not a queue. */
const MAX_QUEUED_INTERVALS = 200;

function reserveSharedSlot(url: string, intervalMs: number): number {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 0;
  }
  if (!host) return 0;
  const path = join(dataCacheDir(), "hosts", `${host.replace(/[^a-z0-9.-]/g, "_")}.next`);
  try {
    return withFileLockSync(
      `${path}.lock`,
      () => {
        const now = Date.now();
        let next = 0;
        try {
          next = Number(readFileSync(path, "utf8")) || 0;
        } catch {
          // the first call to this host
        }
        if (next - now > MAX_QUEUED_INTERVALS * intervalMs) next = 0;
        const at = Math.max(now, next);
        writeFileSync(path, String(at + intervalMs));
        return at - now;
      },
      2_000,
    );
  } catch {
    return 0; // a cache directory that cannot be written leaves the in-process pacing alone
  }
}

/** Wait for a slot to a host that publishes a pace: in this process, after the host's back-off, and across processes. */
export async function awaitPace(url: string, intervalMs: number): Promise<void> {
  await awaitHostSlot(url, intervalMs);
  const wait = reserveSharedSlot(url, intervalMs);
  if (wait > 0) await sleep(wait);
}

/** The request itself: paced, sent, and recorded when recording. */
async function requestText(url: string, opts: FetchOptions, shown: string, key: string): Promise<NetResponse> {
  if (opts.hostIntervalMs) await awaitPace(url, opts.hostIntervalMs);
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
      maxBytes: opts.maxBytes ?? MAX_BYTES,
      authorizeUrl: opts.authorizeUrl,
    });
    res = { status: r.status, body: r.body, url: r.url || url, fetchedAt, rateLimited: r.rateLimited, ...whole(r, opts.maxBytes) };
  } else {
    const r = await httpJson("POST", url, opts.json, {
      userAgent,
      headers: opts.headers,
      accept: opts.accept,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      maxBytes: opts.maxBytes ?? MAX_BYTES,
    });
    res = { ok: r.ok, status: r.status, body: r.data === undefined ? "" : JSON.stringify(r.data), url, fetchedAt, error: r.error };
  }
  if (mode.kind === "record" && res.ok) {
    mkdirSync(join(mode.dir, "http"), { recursive: true });
    writeFileAtomic(
      fixturePath(mode.dir, key),
      `${JSON.stringify(
        {
          request: { method: opts.method ?? "GET", url: shown, json: opts.json },
          response: { ...res, ...(opts.recordAs ? { url: shown } : {}), rateLimited: undefined },
        },
        null,
        1,
      )}\n`,
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
  if (opts.hostIntervalMs) await awaitPace(url, opts.hostIntervalMs);
  const userAgent = !opts.userAgent || opts.userAgent === "browser" ? BROWSER_UA : opts.userAgent;
  const fetchedAt = new Date().toISOString();
  const r = await httpGet(url, {
    userAgent,
    headers: opts.headers,
    accept: opts.accept,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    maxBytes: opts.maxBytes ?? MAX_BYTES,
    binary: true,
    authorizeUrl: opts.authorizeUrl,
  });
  const bytes = r.bytes ?? Buffer.from(r.body ?? "", "utf8");
  const res: BytesResponse = {
    ...whole(r, opts.maxBytes),
    status: r.status,
    body: "",
    url: r.url || url,
    fetchedAt,
    rateLimited: r.rateLimited,
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

/**
 * A call that is no plain HTTP read — a subprocess (crible, an agent CLI's web
 * search), the engine's search cascade, a browser render — recorded and
 * replayed like one: `<fixture>/<kind>/<hash of the call>.json`. A replay
 * never runs `live`, and a call the fixture never saw throws FixtureMiss.
 * `keep` decides whether a live answer is worth recording (default: always).
 */
export async function recordedCall<T>(kind: string, call: unknown, live: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
  const key = contentHash(JSON.stringify(call)).slice(0, 20);
  if (mode.kind === "fixture") {
    const path = join(mode.dir, kind, `${key}.json`);
    if (!existsSync(path))
      throw new FixtureMiss(`fixture ${mode.dir} has no recorded ${kind} call ${JSON.stringify(call).slice(0, 160)} — re-record it with --record`);
    return (JSON.parse(readFileSync(path, "utf8")) as { value: T }).value;
  }
  const value = await live();
  if (mode.kind === "record" && keep(value)) {
    mkdirSync(join(mode.dir, kind), { recursive: true });
    writeFileAtomic(join(mode.dir, kind, `${key}.json`), `${JSON.stringify({ call, value }, null, 1)}\n`);
  }
  return value;
}
