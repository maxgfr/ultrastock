import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setNetMode } from "../src/core/net.js";
import {
  CRIBLE_MAX_AGE_DAYS,
  CRIBLE_REFRESH,
  cribleFreshness,
  cribleFreshnessOf,
  cribleLocalBuiltAt,
  cribleStaleWarning,
} from "../src/providers/external/crible.js";

const NOW = new Date("2026-10-27T08:00:00Z");
const day = (d: string) => new Date(`${d}T03:00:00Z`);

describe("crible dataset freshness", () => {
  afterEach(() => {
    setNetMode({ kind: "live" });
    delete process.env.ULTRASTOCK_CRIBLE_DATA_DIR;
  });

  it("dates the local dataset from the manifest it was restored from, else crible's status", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-crible-"));
    expect(cribleLocalBuiltAt(dir)).toBeUndefined();
    writeFileSync(join(dir, "status.json"), JSON.stringify({ ts: 1792984703.6 }));
    expect(cribleLocalBuiltAt(dir)!.toISOString().slice(0, 10)).toBe("2026-10-26");
    writeFileSync(join(dir, ".restored-manifest.json"), JSON.stringify({ schema: 2, generated_at: 1792000000 }));
    expect(cribleLocalBuiltAt(dir)!.toISOString().slice(0, 10)).toBe("2026-10-14");
  });

  it("is stale past the threshold when a newer dataset is published, and says how to refresh", () => {
    expect(CRIBLE_MAX_AGE_DAYS).toBe(7);
    const old = cribleFreshnessOf(day("2026-10-12"), NOW, 7, day("2026-10-27"));
    expect(old).toMatchObject({ local: "2026-10-12", published: "2026-10-27", ageDays: 15, stale: true });
    expect(old.message).toContain(CRIBLE_REFRESH);
    expect(old.message).toMatch(/15 days old \(built 2026-10-12; the published data-latest dataset was built 2026-10-27\)/);
    // Recent: not stale, whatever was published since.
    expect(cribleFreshnessOf(day("2026-10-26"), NOW, 7, day("2026-10-27")).stale).toBe(false);
    // Old, but nothing newer was published: refreshing would not help, so no warning.
    expect(cribleFreshnessOf(day("2026-10-12"), NOW, 7, day("2026-10-12")).stale).toBe(false);
    // Old, the release unreachable: the age alone decides.
    expect(cribleFreshnessOf(day("2026-10-12"), NOW, 7).stale).toBe(true);
  });

  it("is never checked in a recorded or replayed run, and never downloads anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-crible-"));
    writeFileSync(join(dir, ".restored-manifest.json"), JSON.stringify({ generated_at: 1700000000 }));
    process.env.ULTRASTOCK_CRIBLE_DATA_DIR = dir;
    setNetMode({ kind: "fixture", dir: mkdtempSync(join(tmpdir(), "us-fix-")) });
    expect(await cribleFreshness(NOW)).toBeUndefined();
    expect(await cribleStaleWarning()).toBeUndefined();
  });
});
