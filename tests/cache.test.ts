import { existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachedJson, peekCache, sweepDatasetCache, TTL } from "../src/core/cache.js";
import { dataCacheDir } from "../src/core/paths.js";
import { contentHash } from "../src/engine.js";

const DAY = 24 * 3600_000;

const datasetPath = (key: string) => join(dataCacheDir(), "datasets", `${contentHash(key).slice(0, 24)}.json`);

function age(key: string, ms: number): void {
  const at = (Date.now() - ms) / 1000;
  utimesSync(datasetPath(key), at, at);
}

describe("dataset cache eviction", () => {
  it("drops an entry long past its kind's freshness, keeps the others", async () => {
    await cachedJson("quote:OLD", TTL.quote, async () => ({ p: 1 }));
    await cachedJson("quote:RECENT", TTL.quote, async () => ({ p: 2 }));
    await cachedJson("filing:OLD", TTL.immutable, async () => ({ f: 1 }));
    await cachedJson("reference:OLD", TTL.reference, async () => ({ r: 1 }));
    age("quote:OLD", 8 * DAY); // a quote a week old serves no one, not even --offline
    age("quote:RECENT", 2 * 3600_000); // kept a while for --offline
    age("filing:OLD", 400 * DAY); // a filing does not change
    age("reference:OLD", 15 * DAY); // twice its week
    sweepDatasetCache();
    expect(peekCache("quote:OLD")).toBeUndefined();
    expect(peekCache("quote:RECENT")?.value).toEqual({ p: 2 });
    expect(peekCache("filing:OLD")?.value).toEqual({ f: 1 });
    expect(peekCache("reference:OLD")).toBeUndefined();
  });

  it("keeps the whole under a size cap, the oldest written going first", async () => {
    const big = "x".repeat(10_000);
    for (const k of ["a", "b", "c"]) await cachedJson(`size:${k}`, TTL.immutable, async () => big);
    age("size:a", 3 * DAY);
    age("size:b", 2 * DAY);
    age("size:c", 1 * DAY);
    sweepDatasetCache({ maxBytes: 25_000 });
    expect(existsSync(datasetPath("size:a"))).toBe(false);
    expect(existsSync(datasetPath("size:b"))).toBe(true);
    expect(existsSync(datasetPath("size:c"))).toBe(true);
  });

  it("sweeps on a write, at most once per interval across processes", async () => {
    sweepDatasetCache(); // stamps the sweep
    await cachedJson("quote:STALE1", TTL.quote, async () => 1);
    age("quote:STALE1", 30 * DAY);
    await cachedJson("quote:W1", TTL.quote, async () => 1); // a write within the interval: no sweep
    expect(existsSync(datasetPath("quote:STALE1"))).toBe(true);
    // The last sweep was long ago (another process, or this one): the next write sweeps.
    const marker = join(dataCacheDir(), "datasets", ".swept");
    const longAgo = (Date.now() - DAY) / 1000;
    utimesSync(marker, longAgo, longAgo);
    await cachedJson("quote:W2", TTL.quote, async () => 2);
    expect(existsSync(datasetPath("quote:STALE1"))).toBe(false);
    expect(readdirSync(join(dataCacheDir(), "datasets"))).toContain(".swept");
  });
});
