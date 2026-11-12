// `profile set benchmark` is the symbol "the user measures analyses and the book against"
// (core/profile.ts), and tests/benchmark.test.ts says it is used "everywhere a convention would apply". `stats`
// (commands/quant.ts) still picks its own convention — SPY for a US listing, CW8.PA otherwise — whatever the profile
// says, and never says which benchmark it used or why.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statsCommand } from "../src/commands/quant.js";
import { defaultProfile, parseProfileValue, saveProfile } from "../src/core/profile.js";
import type { CommandArgs } from "../src/engine.js";
import { withFixture } from "./helpers/fixtures.js";

interface JsonOut {
  datasets: Array<{ title: string; notes: string[]; points: Array<{ key: string; value: unknown }> }>;
}

async function stats(positional: string[], values: Record<string, string>): Promise<JsonOut> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  try {
    const args: CommandArgs = { command: "stats", positional, values, bools: new Set() };
    // The fixture holds the recorded histories of NVDA, AMD and SPY: no network.
    await withFixture("quant-stats-multi", () => statsCommand(args, true));
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(out) as JsonOut;
}

describe("`stats` and the profile's benchmark", () => {
  beforeEach(() => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "bench-"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("control: --benchmark AMD measures NVDA against AMD on this fixture", async () => {
    const r = await stats(["NVDA"], { days: "250", benchmark: "AMD" });
    expect(r.datasets.map((d) => d.title)).toContain("NVDA performance vs AMD");
  });

  it("measures against the profile's benchmark when --benchmark is not given", async () => {
    saveProfile({ ...defaultProfile("US", "USD"), benchmark: parseProfileValue("benchmark", "amd") as string });
    const r = await stats(["NVDA"], { days: "250" });
    const titles = r.datasets.map((d) => d.title);
    // Before the fix: "NVDA performance vs SPY" — the profile's benchmark is ignored.
    expect(titles).toContain("NVDA performance vs AMD");
    expect(titles).not.toContain("NVDA performance vs SPY");
  });

  it("says which benchmark it used and why, as the other analyses do", async () => {
    const r = await stats(["NVDA"], { days: "250" });
    // Before the fix: no note names the convention (technicals, valuation, risk and the built-in screen all carry one).
    expect(r.datasets.flatMap((d) => d.notes).join("\n")).toMatch(/benchmark SPY: convention/);
  });
});
