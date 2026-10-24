// An inter-process lock on a file, for state two ultrastock processes must not
// write at once (a ledger, the order audit, a paper book). Ported from
// maxgfr/binance-historical: the lock file names its owner, and a lock whose
// owner is a dead process on this host is stale and may be recovered. The
// engine's withRunLock only serialises within one process, which is not enough
// when an agent runs two commands in parallel.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { sleep } from "../engine.js";

interface LockOwner {
  pid: number;
  hostname: string;
  createdAt: string;
}

/** A lock whose owner is a dead process on this host. A foreign host's lock is never stale. */
export function isStaleLock(path: string): boolean {
  let owner: LockOwner;
  try {
    owner = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function tryAcquire(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() } satisfies LockOwner));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Take the lock at `path`, waiting up to `waitMs` for a live owner to let go and
 * recovering a dead owner's lock. Throws when it cannot.
 */
export async function acquireLock(path: string, waitMs = 10_000): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryAcquire(path)) return () => rmSync(path, { force: true });
    if (isStaleLock(path)) {
      // Recovery is itself exclusive, so two waiters cannot delete each other's fresh lock.
      if (tryAcquire(`${path}.recovery`)) {
        try {
          if (isStaleLock(path)) unlinkSync(path);
        } finally {
          rmSync(`${path}.recovery`, { force: true });
        }
        continue;
      }
    }
    if (Date.now() >= deadline)
      throw new Error(`${path} is locked by another ultrastock process — wait for it to finish, or remove the lock if its owner is gone`);
    await sleep(100);
  }
}

/** Run `fn` holding the lock at `path`. */
export async function withFileLock<T>(path: string, fn: () => Promise<T> | T, waitMs?: number): Promise<T> {
  const release = await acquireLock(path, waitMs);
  try {
    return await fn();
  } finally {
    release();
  }
}
