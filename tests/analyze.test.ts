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
    const a = JSON.parse(await cli(["analyze", "BTCUSDT", "--depth", "quick", "--out", run, ...fx, "--json"]));
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

describe("report", () => {
  it("renders a checked answer with its decision, the debate and the chart; refuses an unchecked one", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const run = mkdtempSync(join(tmpdir(), "us-rep-"));
    await cli(["analyze", "MC.PA", "--out", run, "--fixture", join(FIX, "mc-pa")]);
    expect(existsSync(join(run, "bars.json"))).toBe(true);
    const close = EvidenceStore.load(run)!.byKey("MC.PA.close")!;
    writeFileSync(join(run, "answer.md"), `# LVMH\n\nThe last close is ${close.value} EUR [${close.id}].\n`);
    mkdirSync(join(run, "notes"));
    writeFileSync(join(run, "notes", "bull.md"), "The bull case.");
    writeFileSync(join(run, "notes", "bear.md"), "The bear case.");
    writeFileSync(
      join(run, "decision.json"),
      JSON.stringify({ rating: "hold", horizon: "months", conviction: 2, thesis: "x", falsifiers: ["a close below the low"], portfolioContext: "flat" }),
    );
    expect(await cli(["report", run])).toMatch(/report written/);
    const page = readFileSync(join(run, "report.html"), "utf8");
    expect(page).toContain("<svg");
    expect(page).toContain("The debate");
    expect(page.indexOf(">bull<")).toBeLessThan(page.indexOf(">bear<"));
    expect(page).toContain("a close below the low");
    writeFileSync(join(run, "answer.md"), "# LVMH\n\nThe close is 999 EUR.\n");
    expect(await cli(["report", run])).toMatch(/report refused/);
    process.exitCode = 0;
  });
});

describe("analyze at standard depth", () => {
  it("indexes every slice, names the unavailable ones, and writes the debate runbook", async () => {
    const run = mkdtempSync(join(tmpdir(), "us-full-"));
    const a = JSON.parse(await cli(["analyze", "MC.PA", "--out", run, "--fixture", join(FIX, "mc-pa"), "--json"]));
    expect(a.depth).toBe("standard");
    expect(a.portfolioContext).toBe("not-provided");
    const names = a.slices.map((s: { name: string }) => s.name);
    expect(names).toEqual(expect.arrayContaining(["price and risk", "technicals", "valuation", "catalysts", "market regime", "news", "portfolio context"]));
    expect(a.slices.find((s: { name: string }) => s.name === "analysts").status).toBe("skipped");
    const brief = readFileSync(join(run, "BRIEF.md"), "utf8");
    expect(brief).toContain("| Slice | Status | Detail |");
    expect(brief).toContain("## The investor");
    for (const s of a.slices.filter((x: { status: string }) => x.status === "unavailable")) expect(brief).toContain(`| ${s.name} | unavailable |`);
    const runbook = readFileSync(join(run, "RUNBOOK.md"), "utf8");
    for (const role of [
      "Analysts",
      "Debate — 2 rounds",
      "Research judge",
      "Trader",
      "Risk trio",
      "Portfolio manager",
      "ultrastock decide",
      "ultrastock report",
    ])
      expect(runbook).toContain(role);
    expect(runbook).toContain('"portfolioContext": "not-provided"');
    expect(() => JSON.parse(readFileSync(join(run, "evidence.json"), "utf8"))).not.toThrow();
    // A second run against the first writes the delta.
    const run2 = mkdtempSync(join(tmpdir(), "us-full-"));
    const b = JSON.parse(await cli(["analyze", "MC.PA", "--depth", "quick", "--since", run, "--out", run2, "--fixture", join(FIX, "mc-pa"), "--json"]));
    expect(b.delta).toContain("MC.PA");
    expect(readFileSync(join(run2, "DELTA.md"), "utf8")).toBeTruthy();
  });
});
