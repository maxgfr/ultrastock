// Out-of-band approval codes. A live order (and any loosening of the live
// limits) needs a 6-digit code bound to exactly what it approves — a ticket's
// order fingerprint, or the requested limits — valid 120 seconds, three tries.
//
// The code is delivered where the agent cannot read it: a desktop notification
// (macOS, Linux), a private ntfy topic, or the user's own terminal (/dev/tty,
// absent when an agent runs the command). It is NEVER written to stdout or
// stderr. With no channel, no code is issued: the human has to be able to see
// it, and only the human.
//
// No destination comes from the environment: whoever writes a command can
// prefix it with variables, so an environment-given URL would send the code to
// them. The ntfy topic and its token are read from the OS keychain only (the
// user stores them with the commands `broker setup ntfy` prints), over https,
// never to an address of this machine. ULTRASTOCK_NTFY_URL / _TOKEN feed
// alerts, never a code.
import { execFileSync } from "node:child_process";
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { withFileLockSync } from "../core/lock.js";
import { homeDir } from "../core/paths.js";
import { writeFileAtomic } from "../engine.js";
import { keychain } from "./secrets.js";

export const CODE_TTL_MS = 120_000;
const MAX_TRIES = 3;

interface Pending {
  subject: string;
  binding: string;
  salt: string;
  hash: string;
  expiresAt: string;
  tries: number;
}

const dir = () => join(homeDir(), "state", "codes");
const fileFor = (subject: string) => {
  if (!/^[a-z0-9-]{3,90}$/.test(subject)) throw new Error(`"${subject}" cannot hold an approval code`);
  return join(dir(), `${subject}.json`);
};
// A code's file is read, changed and written as one step: two processes guessing at
// once must each use up a try. Its own lock, so a caller holding the live lock cannot deadlock on it.
const codesLock = <T>(fn: () => T): T => withFileLockSync(join(homeDir(), "state", "codes.lock"), fn);
// scrypt, not a bare hash: a six-digit code under SHA-256 falls to brute force in a
// second; at this cost a million guesses take hours, far beyond the 2-minute life.
// (A process running as the user can still read this file: the code guards against
// mistakes and injected instructions; the harness's own approval prompt is the second guard.)
const digest = (code: string, binding: string, salt: string) =>
  scryptSync(`${binding}|${code}`, salt, 32, { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString("hex");

export type Channel = (message: string) => Promise<boolean> | boolean;

/** Desktop notification; true when the platform tool ran. */
export const desktopChannel: Channel = (message) => {
  try {
    if (process.platform === "darwin") {
      execFileSync("osascript", ["-e", `display notification ${JSON.stringify(message)} with title "ultrastock — approval code"`], {
        stdio: "ignore",
        timeout: 5000,
      });
      return true;
    }
    if (process.platform === "linux") {
      execFileSync("notify-send", ["ultrastock — approval code", message], { stdio: "ignore", timeout: 5000 });
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

/** The controlling terminal of the person who ran the command — not the agent's captured output. */
export const ttyChannel: Channel = (message) => {
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, `\n${message}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
};

/** Hosts that are this machine: a server anyone running a command here could listen on. */
const LOOPBACK = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|\[::ffff:.+\])$/i;

/**
 * Where the ntfy channel sends a code: the keychain's `ntfy-url` and
 * `ntfy-token` (service "ultrastock"), an https URL that is not this machine —
 * or why there is none. The environment is never read.
 */
export function ntfyDestination(read: (account: string) => string | undefined = keychain): { url: string; token: string } | { refused: string } {
  const url = read("ntfy-url");
  const token = read("ntfy-token");
  if (!url || !token) return { refused: "no ntfy topic and token in the keychain (`ultrastock broker setup ntfy`)" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { refused: "the keychain's ntfy-url is not a URL" };
  }
  if (u.protocol !== "https:") return { refused: "the keychain's ntfy-url is not https" };
  if (LOOPBACK.test(u.hostname)) return { refused: "the keychain's ntfy-url points at this machine" };
  return { url: u.toString(), token };
}

/** A private ntfy topic, read from the keychain, with its token (a public topic would publish the code). */
export function ntfyChannelFrom(read: (account: string) => string | undefined = keychain): Channel {
  return async (message) => {
    // Tests and evals switch the channels off: the user's keychain is not even read.
    if (process.env.ULTRASTOCK_CODE_CHANNELS === "none" && read === keychain) return false;
    const d = ntfyDestination(read);
    if ("refused" in d) return false;
    try {
      const r = await fetch(d.url, {
        method: "POST",
        headers: { authorization: `Bearer ${d.token}`, title: "ultrastock approval code", priority: "high" },
        body: message,
        // A redirect could take the code somewhere the user never stored.
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      return r.ok;
    } catch {
      return false;
    }
  };
}

export const ntfyChannel: Channel = ntfyChannelFrom();

export const DEFAULT_CHANNELS: Array<[string, Channel]> = [
  ["desktop notification", desktopChannel],
  ["private ntfy topic", ntfyChannel],
  ["your terminal", ttyChannel],
];

/**
 * Issue a code for `subject` (a ticket id, "limits") bound to `binding` (the
 * fingerprint of what is approved). Returns where it was sent — never the code.
 */
export async function issueCode(
  subject: string,
  binding: string,
  what: string,
  channels: Array<[string, Channel]> = DEFAULT_CHANNELS,
  now = new Date(),
): Promise<{ sentTo: string[]; expiresAt: string }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  const message = `${code} — approves ${what}. Valid 2 minutes. Type it yourself; never paste it to an agent you did not mean to approve.`;
  const sentTo: string[] = [];
  // ULTRASTOCK_CODE_CHANNELS=none switches every channel off (tests, evals); nothing can redirect them.
  const off = process.env.ULTRASTOCK_CODE_CHANNELS === "none" && channels === DEFAULT_CHANNELS;
  if (!off) for (const [name, ch] of channels) if (await ch(message)) sentTo.push(name);
  if (!sentTo.length)
    throw new Error(
      "no out-of-band channel reached you (desktop notification, the private ntfy topic stored in your keychain — `ultrastock broker setup ntfy`, or your own terminal): no code issued",
    );
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const p: Pending = { subject, binding, salt, hash: digest(code, binding, salt), expiresAt, tries: 0 };
  codesLock(() => writeFileAtomic(fileFor(subject), `${JSON.stringify(p)}\n`, 0o600));
  return { sentTo, expiresAt };
}

/** Check and consume a code. A wrong binding (the order changed) or an expired code fails. */
export function verifyCode(subject: string, binding: string, code: string | undefined, now = new Date()): { ok: true } | { ok: false; reason: string } {
  const f = fileFor(subject);
  return codesLock(() => verifyLocked(f, binding, code, now));
}

function verifyLocked(f: string, binding: string, code: string | undefined, now: Date): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(f)) return { ok: false, reason: "no code was issued for this — run the code step first" };
  const p = JSON.parse(readFileSync(f, "utf8")) as Pending;
  if (now.getTime() > Date.parse(p.expiresAt)) {
    rmSync(f, { force: true });
    return { ok: false, reason: "the code expired (2 minutes): issue a new one" };
  }
  if (!code || !/^\d{6}$/.test(code)) return { ok: false, reason: "the code is six digits" };
  if (p.binding !== binding) {
    rmSync(f, { force: true });
    return { ok: false, reason: "the code was issued for a different order or change — it is void; issue a new one" };
  }
  const a = Buffer.from(digest(code, binding, p.salt), "hex");
  const b = Buffer.from(p.hash, "hex");
  if (a.length === b.length && timingSafeEqual(a, b)) {
    rmSync(f, { force: true });
    return { ok: true };
  }
  p.tries++;
  if (p.tries >= MAX_TRIES) {
    rmSync(f, { force: true });
    return { ok: false, reason: `wrong code ${MAX_TRIES} times: void, issue a new one` };
  }
  writeFileAtomic(f, `${JSON.stringify(p)}\n`, 0o600);
  return { ok: false, reason: `wrong code (${MAX_TRIES - p.tries} tries left)` };
}
