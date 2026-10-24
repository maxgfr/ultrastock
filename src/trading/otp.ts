// Out-of-band approval codes. A live order (and any loosening of the live
// limits) needs a 6-digit code bound to exactly what it approves — a ticket's
// order fingerprint, or the requested limits — valid 120 seconds, three tries.
//
// The code is delivered where the agent cannot read it: a desktop notification
// (macOS, Linux), a private ntfy topic (token required), or the user's own
// terminal (/dev/tty, absent when an agent runs the command). It is NEVER
// written to stdout or stderr. With no channel, no code is issued: the human
// has to be able to see it, and only the human.
import { execFileSync } from "node:child_process";
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../core/paths.js";
import { env, writeFileAtomic } from "../engine.js";

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

/** A private ntfy topic: only with a token (a public topic would publish the code). */
export const ntfyChannel: Channel = async (message) => {
  const url = env("NTFY_URL");
  const token = env("NTFY_TOKEN");
  if (!url || !token) return false;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, title: "ultrastock approval code", priority: "high" },
      body: message,
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
};

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
      "no out-of-band channel reached you (desktop notification, private ntfy topic with ULTRASTOCK_NTFY_TOKEN, or your own terminal): no code issued",
    );
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const p: Pending = { subject, binding, salt, hash: digest(code, binding, salt), expiresAt, tries: 0 };
  writeFileAtomic(fileFor(subject), `${JSON.stringify(p)}\n`, 0o600);
  return { sentTo, expiresAt };
}

/** Check and consume a code. A wrong binding (the order changed) or an expired code fails. */
export function verifyCode(subject: string, binding: string, code: string | undefined, now = new Date()): { ok: true } | { ok: false; reason: string } {
  const f = fileFor(subject);
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
