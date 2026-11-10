// An inter-process lock on a file, for state two ultrastock processes must not
// write at once (a ledger, the order audit, a paper book). Ported from
// maxgfr/binance-historical: the lock file names its owner, and a lock whose
// owner is a dead process on this host is stale and may be recovered. The
// engine's withRunLock only serialises within one process, which is not enough
// when an agent runs two commands in parallel.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { sleep } from "../engine.js";

interface LockOwner {
  pid: number;
  hostname: string;
  createdAt: string;
}

/** A lock file is written the instant it is created: one still unreadable after this long was left by a process that died in between. */
const UNWRITTEN_GRACE_MS = 5_000;

/**
 * A lock whose owner is a dead process on this host — or one that never got
 * its owner written (a crash between creating the file and filling it) and has
 * sat there since. A foreign host's lock is never stale.
 */
export function isStaleLock(path: string): boolean {
  let owner: LockOwner;
  try {
    owner = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    try {
      return Date.now() - statSync(path).mtimeMs > UNWRITTEN_GRACE_MS;
    } catch {
      return false; // gone meanwhile
    }
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
    const got = attempt(path);
    if (got === "acquired") return () => rmSync(path, { force: true });
    if (got === "recovered") continue;
    if (Date.now() >= deadline) throw new Error(LOCKED(path));
    await sleep(100);
  }
}

const LOCKED = (path: string) => `${path} is locked by another ultrastock process — wait for it to finish, or remove the lock if its owner is gone`;

/** One try at the lock: taken, a stale one cleared out of the way (try again at once), or held by someone alive. */
function attempt(path: string): "acquired" | "recovered" | "held" {
  if (tryAcquire(path)) return "acquired";
  if (!isStaleLock(path)) return "held";
  // Recovery is itself exclusive, so two waiters cannot delete each other's fresh lock.
  const recovery = `${path}.recovery`;
  if (tryAcquire(recovery)) {
    try {
      if (isStaleLock(path)) unlinkSync(path);
    } finally {
      rmSync(recovery, { force: true });
    }
    return "recovered";
  }
  // The recovery lock has an owner too, and it can die: left in place it would keep the stale lock for ever.
  if (isStaleLock(recovery)) {
    rmSync(recovery, { force: true });
    return "recovered";
  }
  return "held";
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

/**
 * Run a synchronous `fn` holding the lock at `path`, for the short read-change-write
 * of a file that synchronous code owns (the evidence register). The wait blocks
 * the thread: hold it for milliseconds, never across a network call.
 */
export function withFileLockSync<T>(path: string, fn: () => T, waitMs = 10_000): T {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const got = attempt(path);
    if (got === "acquired") break;
    if (got === "recovered") continue;
    if (Date.now() >= deadline) throw new Error(LOCKED(path));
    Atomics.wait(pause, 0, 0, 20);
  }
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}
