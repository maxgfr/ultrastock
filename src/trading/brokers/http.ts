// What the four venue adapters share: the default HTTP transport, the options
// every factory takes, plain-decimal formatting and credential scrubbing.
//
// The transport sends ONE request (retries: 0) with a hard timeout and logs
// nothing. Its errors never carry the URL — a Binance query string holds the
// signature — only "timeout" or the network error code.
import type { Credentials, Environment, HttpFn } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 10_000;

/** What every adapter factory takes; tests inject `http` and `now`. */
export interface AdapterOptions {
  env: Environment;
  creds: Credentials;
  http?: HttpFn;
  /** Epoch milliseconds (timestamps, nonces, JWT nbf). */
  now?: () => number;
  timeoutMs?: number;
}

/** A refusal or a malformed answer from a venue, worded without any credential. */
export class BrokerError extends Error {
  constructor(
    readonly venue: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${venue}: ${message}`);
    this.name = "BrokerError";
  }
}

/** The default transport over the global fetch: one attempt, AbortController timeout. */
export const fetchHttp: HttpFn = async (req) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctrl.signal, redirect: "error" });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`timeout after ${req.timeoutMs} ms`);
    const code = (e as { cause?: { code?: string } }).cause?.code;
    throw new Error(`network error${code ? ` (${code})` : ""}`);
  } finally {
    clearTimeout(timer);
  }
};

/** A number as a plain decimal string: never exponent notation, no trailing zeros (1e-7 → "0.0000001"). */
export function plainDecimal(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return s;
  const digits = m[2]! + (m[3] ?? "");
  const point = m[2]!.length + Number(m[4]);
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  out = out.replace(/^0+(?=\d)/, "");
  return m[1] + out;
}

/**
 * Remove every credential from a text. Short strings (< 8 chars) are skipped:
 * no real key is that short, and blanking every "a" would garble the message.
 */
export function scrubSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

/** The credential strings to scrub from a venue's answer. */
export function credentialStrings(creds: Credentials): string[] {
  return [creds.key, creds.secret, creds.keyName, creds.passphrase].filter((s): s is string => !!s);
}

/** JSON, or the text itself when the body is not JSON. */
export function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** A finite number from a venue field (they send strings), else undefined. */
export function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** A local refusal: nothing was sent. */
export function notSent(clientOrderId: string, message: string) {
  return { state: "rejected" as const, clientOrderId, message };
}
