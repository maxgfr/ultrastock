import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, isStaleLock, withFileLock } from "../src/core/lock.js";

describe("file lock", () => {
  it("excludes a second holder, then releases", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "us-lock-")), "ledger.lock");
    const release = await acquireLock(path);
    await expect(acquireLock(path, 150)).rejects.toThrow(/locked/);
    release();
    expect(existsSync(path)).toBe(false);
    expect(await withFileLock(path, () => 42)).toBe(42);
  });
  it("recovers a lock left by a dead process on this host, never a foreign host's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-lock-"));
    const dead = join(dir, "dead.lock");
    writeFileSync(dead, JSON.stringify({ pid: 999_999_9, hostname: hostname(), createdAt: "x" }));
    expect(isStaleLock(dead)).toBe(true);
    const release = await acquireLock(dead, 500);
    release();
    const foreign = join(dir, "foreign.lock");
    writeFileSync(foreign, JSON.stringify({ pid: 999_999_9, hostname: "another-host", createdAt: "x" }));
    expect(isStaleLock(foreign)).toBe(false);
  });
});
