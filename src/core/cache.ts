// A cache per dataset, each with its own freshness: a quote is stale in a
// minute, a daily history until the next session closes, a filing never. The
// engine's page cache has one global TTL, which fits web pages and not markets.
//
// Off in fixture mode (a replay must read the fixture, not yesterday's cache)
// and bypassed by --refresh; --offline serves whatever is on disk.
//
// Bounded: a write sweeps the directory at most once per SWEEP_INTERVAL_MS
// (across processes, through a marker file's time), dropping what is far past
// its freshness and, past a total size, the oldest written first.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheMode, contentHash, writeFileAtomic } from "../engine.js";
import { netMode } from "./net.js";
import { dataCacheDir } from "./paths.js";

export const TTL = {
  quote: 60_000,
  intraday: 5 * 60_000,
  daily: 6 * 3600_000,
  fundamentals: 24 * 3600_000,
  reference: 7 * 24 * 3600_000,
  immutable: 365 * 24 * 3600_000,
} as const;

interface Entry<T> {
  storedAt: number;
  /** The freshness it was stored with; written before the key so a sweep reads it from the file's first bytes. */
  ttlMs?: number;
  key: string;
  value: T;
}

/** An entry is dropped this many times its freshness after it was written… */
const EVICT_TTL_FACTOR = 2;
/** …but never sooner than this, so `--offline` still has last week's quotes. */
const EVICT_FLOOR_MS = 7 * 24 * 3600_000;
/** What the cache may hold in all; the oldest written go first. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 10 * 60_000;
const SWEEP_MARKER = ".swept";

function datasetsDir(): string {
  return join(dataCacheDir(), "datasets");
}

function pathFor(key: string): string {
  return join(datasetsDir(), `${contentHash(key).slice(0, 24)}.json`);
}

/** The freshness an entry was stored with, read from its first bytes; an older entry without one counts as reference data. */
function storedTtl(path: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(96);
    const n = readSync(fd, head, 0, head.length, 0);
    const m = /"ttlMs":(\d+)/.exec(head.subarray(0, n).toString("utf8"));
    return m ? Number(m[1]) : TTL.reference;
  } catch {
    return TTL.reference;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Drop entries written more than twice their freshness ago (a week at least),
 * then the oldest written until the whole fits `maxBytes`. Never throws: a
 * cache that cannot be swept is still a cache.
 */
export function sweepDatasetCache(opts: { maxBytes?: number } = {}): void {
  const dir = datasetsDir();
  const now = Date.now();
  try {
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, SWEEP_MARKER);
    if (existsSync(marker)) utimesSync(marker, now / 1000, now / 1000);
    else writeFileSync(marker, "");
    const kept: { path: string; at: number; size: number }[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (now - st.mtimeMs > Math.max(EVICT_FLOOR_MS, EVICT_TTL_FACTOR * storedTtl(path))) rmSync(path, { force: true });
        else kept.push({ path, at: st.mtimeMs, size: st.size });
      } catch {
        // gone meanwhile
      }
    }
    let total = kept.reduce((s, e) => s + e.size, 0);
    const maxBytes = opts.maxBytes ?? MAX_TOTAL_BYTES;
    if (total <= maxBytes) return;
    kept.sort((a, b) => a.at - b.at);
    for (const e of kept) {
      if (total <= maxBytes) break;
      rmSync(e.path, { force: true });
      total -= e.size;
    }
  } catch {
    // an unreadable directory is left alone
  }
}

function sweepIfDue(): void {
  try {
    if (Date.now() - statSync(join(datasetsDir(), SWEEP_MARKER)).mtimeMs < SWEEP_INTERVAL_MS) return;
  } catch {
    // never swept
  }
  sweepDatasetCache();
}

/** Read a cached value regardless of age, or undefined. */
export function peekCache<T>(key: string): { value: T; ageMs: number } | undefined {
  const path = pathFor(key);
  if (!existsSync(path)) return undefined;
  try {
    const e = JSON.parse(readFileSync(path, "utf8")) as Entry<T>;
    return e.key === key ? { value: e.value, ageMs: Date.now() - e.storedAt } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The value under `key` if younger than `ttlMs`, else `produce()`'s result,
 * stored. A produced value of `undefined` is not stored: a failed fetch must
 * not be served as an answer for the next six hours.
 */
export async function cachedJson<T>(key: string, ttlMs: number, produce: () => Promise<T | undefined>): Promise<T | undefined> {
  if (netMode().kind !== "live") return produce();
  const mode = cacheMode();
  if (!mode.refresh) {
    const hit = peekCache<T>(key);
    if (hit && (hit.ageMs < ttlMs || mode.offline)) return hit.value;
  }
  if (mode.offline) return undefined;
  const value = await produce();
  if (value !== undefined) {
    mkdirSync(datasetsDir(), { recursive: true });
    writeFileAtomic(pathFor(key), JSON.stringify({ storedAt: Date.now(), ttlMs, key, value } satisfies Entry<T>));
    sweepIfDue();
  }
  return value;
}
