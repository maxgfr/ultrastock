import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSymbol } from "../src/analyze/pack.js";
import { main } from "../src/cli.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { setNetMode } from "../src/core/net.js";
import { doctorReport, formatDoctor } from "../src/doctor.js";

const FIX = join(import.meta.dirname, "..", "assets", "fixtures");
afterEach(() => {
  setNetMode({ kind: "live" });
  vi.restoreAllMocks();
});

/** Run the CLI in-process and capture what it prints. */
async function cli(argv: string[]): Promise<string> {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await main(argv);
  vi.restoreAllMocks();
  return out;
}

describe("analyze", () => {
  it("builds the same evidence from a fixture every time, with provenance on each item", async () => {
    setNetMode({ kind: "fixture", dir: join(FIX, "mc-pa") });
    const a = mkdtempSync(join(tmpdir(), "us-an-"));
    const b = mkdtempSync(join(tmpdir(), "us-an-"));
    const ra = await analyzeSymbol("MC.PA", a);
    await analyzeSymbol("MC.PA", b);
    const ea = EvidenceStore.load(a)!.items;
    const eb = EvidenceStore.load(b)!.items;
    expect(ea.map((i) => [i.id, i.key, i.value])).toEqual(eb.map((i) => [i.id, i.key, i.value]));
    expect(ra).toMatchObject({ symbol: "MC.PA", asOf: "2026-10-23" });
    expect(ea.every((i) => i.source && i.fetchedAt && typeof i.official === "boolean")).toBe(true);
    expect(ea.find((i) => i.key === "MC.PA.trend")!.value).toBe(ra.trend);
    const brief = readFileSync(join(a, "BRIEF.md"), "utf8");
    expect(brief).toContain("## Trend and momentum");
    expect(brief).toMatch(/\[E1\] MC\.PA latest price = /);
    expect(readFileSync(join(a, "RUNBOOK.md"), "utf8")).toContain("ultrastock check");
  });
  it("re-running into the same directory keeps the ids", async () => {
    setNetMode({ kind: "fixture", dir: join(FIX, "nvda") });
    const dir = mkdtempSync(join(tmpdir(), "us-an-"));
    await analyzeSymbol("NVDA", dir);
    const n = EvidenceStore.load(dir)!.items.length;
    await analyzeSymbol("NVDA", dir);
    expect(EvidenceStore.load(dir)!.items.length).toBe(n);
  });
});

describe("cli, in process", () => {
  it("analyze, quote, calc, evidence and check on a fixture", async () => {
    const run = mkdtempSync(join(tmpdir(), "us-cli-"));
    const fx = ["--fixture", join(FIX, "btcusdt")];
    const a = JSON.parse(await cli(["analyze", "BTCUSDT", "--out", run, ...fx, "--json"]));
    expect(a.evidence).toBe(26);
    setNetMode({ kind: "live" });
    expect(await cli(["quote", "BTCUSDT", "--out", run, ...fx])).toMatch(/^\[E1\] BTCUSDT/);
    setNetMode({ kind: "live" });
    expect(await cli(["calc", run, "E1 / E3", "--label", "price over close"])).toMatch(/\[E27\] price over close/);
    expect(await cli(["evidence", run])).toContain("[E27]");
    const answer = join(run, "answer.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(answer, "Bitcoin last traded at 80,226.55 USDT [E1].\n");
    expect(await cli(["check", run, answer])).toMatch(/OK/);
    expect(JSON.parse(await cli(["check", run, answer, "--json"])).ok).toBe(true);
  });
  it("prints help and version", async () => {
    expect(await cli(["--help"])).toContain("USAGE");
    expect((await cli(["--version"])).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("doctor", () => {
  it("reports node, state and tools without probing", async () => {
    const r = await doctorReport({ has: () => false });
    expect(r.node.major).toBeGreaterThanOrEqual(18);
    expect(Object.values(r.tools).every((t) => !t.installed)).toBe(true);
    expect(r.probes).toBeUndefined();
    expect(formatDoctor(r)).toContain("not installed");
  });
});
