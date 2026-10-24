// Where ultrastock keeps the user's state. Never inside the repository: a
// profile, a ledger and an audit trail are personal, and a skill directory is
// replaced on every `npx skills update`.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "../engine.js";

/** ULTRASTOCK_HOME, else ~/.ultrastock. */
export function homeDir(): string {
  const configured = env("HOME");
  return configured ? resolve(configured) : join(homedir(), ".ultrastock");
}

/** A run directory: --out when given, else <home>/runs/<name>. */
export function runDirFor(out: string | undefined, name: string): string {
  return out ? resolve(out) : join(homeDir(), "runs", name);
}

/** The dataset cache: ULTRASTOCK_CACHE_DIR, else <home>/cache. */
export function dataCacheDir(): string {
  const configured = env("CACHE_DIR");
  return configured ? resolve(configured) : join(homeDir(), "cache");
}
