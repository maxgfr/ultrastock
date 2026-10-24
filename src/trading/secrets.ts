// Venue credentials, read from the operating system's keychain — macOS
// `security`, Linux `secret-tool` — or, failing that, from environment
// variables. Each field is its own entry, service "ultrastock", account
// "<venue>-<env>-<field>" (binance-test-key, binance-live-secret…), so test and
// live keys can never be mixed up. The user stores them; ultrastock only reads,
// never prints, and redacts them from anything it shows.
import { execFileSync } from "node:child_process";
import type { Credentials, Environment, Venue } from "./brokers/types.js";

const FIELDS = ["key", "secret", "keyname", "passphrase"] as const;
type Field = (typeof FIELDS)[number];

function keychain(account: string): string | undefined {
  try {
    if (process.platform === "darwin")
      return execFileSync("security", ["find-generic-password", "-s", "ultrastock", "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trimEnd();
    if (process.platform === "linux")
      return execFileSync("secret-tool", ["lookup", "service", "ultrastock", "account", account], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trimEnd();
  } catch {
    return undefined;
  }
  return undefined;
}

const envName = (venue: Venue, env: Environment, field: Field) => `ULTRASTOCK_${venue.toUpperCase()}_${env.toUpperCase()}_${field.toUpperCase()}`;

/** The venue's credentials and where they came from; undefined when no key is stored. */
export function readCredentials(
  venue: Venue,
  env: Environment,
  read: (account: string) => string | undefined = keychain,
): { creds: Credentials; source: string } | undefined {
  const got: Partial<Record<Field, string>> = {};
  let source = "";
  for (const f of FIELDS) {
    const k = read(`${venue}-${env}-${f}`);
    if (k) {
      got[f] = k;
      source = process.platform === "darwin" ? "macOS keychain" : "secret-tool";
      continue;
    }
    const e = process.env[envName(venue, env, f)];
    if (e) {
      got[f] = e;
      source ||= "environment";
    }
  }
  // IBKR's gateway session needs no key; an account id may be stored as "key".
  if (venue === "ibkr") return { creds: { key: got.key ?? "", secret: "" }, source: source || "gateway session" };
  if (!got.key || !got.secret) return undefined;
  return { creds: { key: got.key, secret: got.secret, keyName: got.keyname, passphrase: got.passphrase }, source };
}

/** The commands the USER runs to store a key — ultrastock never takes a secret on its command line. */
export function setupCommands(venue: Venue, env: Environment): string[] {
  const fields: Field[] = venue === "coinbase" ? ["keyname", "secret"] : venue === "ibkr" ? ["key"] : ["key", "secret"];
  const label: Record<Field, string> = {
    key: venue === "kalshi" ? "API key id" : "API key",
    secret: venue === "kalshi" ? "RSA private key (PEM)" : "API secret",
    keyname: "CDP key name",
    passphrase: "key password",
  };
  if (process.platform === "darwin")
    return fields.map((f) => `security add-generic-password -U -s ultrastock -a ${venue}-${env}-${f} -w   # prompts for the ${label[f]}`);
  if (process.platform === "linux")
    return fields.map((f) => `secret-tool store --label="ultrastock ${venue} ${env} ${f}" service ultrastock account ${venue}-${env}-${f}`);
  return fields.map((f) => `set ${envName(venue, env, f)} in your environment (no keychain on ${process.platform})`);
}

/** Remove every credential value from a text before it is shown or logged. */
export function redact(text: string, creds?: Credentials): string {
  let out = text;
  for (const v of [creds?.key, creds?.secret, creds?.keyName, creds?.passphrase]) if (v && v.length >= 6) out = out.split(v).join("[redacted]");
  return out;
}
