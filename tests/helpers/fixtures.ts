// Run a provider call against a recorded fixture: assets/fixtures/<name>/.
//
//   ULTRASTOCK_RECORD=1 pnpm vitest run tests/<file>   records the live answers
//   pnpm test                                          replays them, offline
//
// A replay that asks for a URL the fixture never recorded fails the test.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setNetMode } from "../../src/core/net.js";

export const FIXTURES = join(import.meta.dirname, "..", "..", "assets", "fixtures");

export async function withFixture<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const dir = join(FIXTURES, name);
  const record = process.env.ULTRASTOCK_RECORD === "1";
  if (record && existsSync(dir)) rmSync(dir, { recursive: true });
  setNetMode(record ? { kind: "record", dir } : { kind: "fixture", dir });
  try {
    return await fn();
  } finally {
    setNetMode({ kind: "live" });
  }
}
