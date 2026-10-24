// A cache per dataset, each with its own freshness: a quote is stale in a
// minute, a daily history until the next session closes, a filing never. The
// engine's page cache has one global TTL, which fits web pages and not markets.
//
// Off in fixture mode (a replay must read the fixture, not yesterday's cache)
// and bypassed by --refresh; --offline serves whatever is on disk.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  key: string;
  value: T;
}

function pathFor(key: string): string {
  return join(dataCacheDir(), "datasets", `${contentHash(key).slice(0, 24)}.json`);
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
    mkdirSync(join(dataCacheDir(), "datasets"), { recursive: true });
    writeFileAtomic(pathFor(key), JSON.stringify({ storedAt: Date.now(), key, value } satisfies Entry<T>));
  }
  return value;
}
