import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, isStaleLock, withFileLock, withFileLockSync } from "../src/core/lock.js";

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
  it("locks synchronous work too: waits for a live holder, then gives up; releases on a throw", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "us-lock-")), "evidence.json.lock");
    expect(withFileLockSync(path, () => existsSync(path))).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(() =>
      withFileLockSync(path, () => {
        throw new Error("inside");
      }),
    ).toThrow("inside");
    expect(existsSync(path)).toBe(false);
    const release = await acquireLock(path);
    expect(() => withFileLockSync(path, () => 1, 80)).toThrow(/locked/);
    release();
    expect(withFileLockSync(path, () => 1, 80)).toBe(1);
  });
  it("recovers when the process doing the recovery died too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-lock-"));
    const path = join(dir, "ledger.lock");
    const deadOwner = JSON.stringify({ pid: 999_999_9, hostname: hostname(), createdAt: "x" });
    writeFileSync(path, deadOwner);
    // A waiter took the recovery lock and crashed before removing it: nobody could ever recover the main lock again.
    writeFileSync(`${path}.recovery`, deadOwner);
    const release = await acquireLock(path, 500);
    release();
    expect(existsSync(`${path}.recovery`)).toBe(false);
  });
  it("recovers a lock file left empty by a crash, once it is clearly not being written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-lock-"));
    const fresh = join(dir, "fresh.lock");
    writeFileSync(fresh, "");
    // Created this instant: its owner may be about to write itself in.
    expect(isStaleLock(fresh)).toBe(false);
    await expect(acquireLock(fresh, 150)).rejects.toThrow(/locked/);
    const old = join(dir, "old.lock");
    writeFileSync(old, "");
    const before = new Date(Date.now() - 60_000);
    utimesSync(old, before, before);
    expect(isStaleLock(old)).toBe(true);
    (await acquireLock(old, 500))();
  });
});
