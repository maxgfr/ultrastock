import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { setNetMode } from "../src/core/net.js";
import { FIXTURES } from "./helpers/fixtures.js";

afterEach(() => {
  setNetMode({ kind: "live" });
  vi.restoreAllMocks();
});

/** Run the CLI in-process; returns stdout, or the error a process.exit would have carried. */
async function cli(argv: string[]): Promise<{ out: string; err: string; code?: number }> {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => ((out += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => ((err += String(c)), true));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw Object.assign(new Error("exit"), { exitCode: code });
  }) as never);
  try {
    await main(argv);
    return { out, err };
  } catch (e) {
    return { out, err, code: (e as { exitCode?: number }).exitCode ?? 99 };
  } finally {
    vi.restoreAllMocks();
  }
}

describe("profile and jurisdiction commands", () => {
  it("init, set, envelope, show, suitability questions and scoring", async () => {
    expect((await cli(["profile", "show"])).code).toBe(1);
    expect((await cli(["profile", "init", "--jurisdiction", "FR"])).out).toMatch(/profile created/);
    expect((await cli(["profile", "init"])).code).toBe(1);
    expect((await cli(["profile", "set", "limits.maxPositionPct", "6"])).out).toMatch(/5 → 6/);
    expect((await cli(["profile", "set", "nope", "1"])).code).toBe(1);
    expect((await cli(["profile", "envelope", "pea", "--type", "PEA", "--broker", "X"])).out).toMatch(/PEA at X/);
    expect((await cli(["profile", "suitability"])).out).toMatch(/horizon/);
    const answers = join(mkdtempSync(join(tmpdir(), "us-ans-")), "a.json");
    writeFileSync(
      answers,
      JSON.stringify({ horizon: "gt10", drop: "hold", maxLoss: "20", share: "25to50", income: "stable", goal: "growth", emergencyFundMonths: 6 }),
    );
    expect((await cli(["profile", "suitability", "--answers", answers])).out).toMatch(/risk score 5\/7/);
    expect(JSON.parse((await cli(["profile", "show", "--json"])).out).riskScore).toBe(5);
    expect((await cli(["jurisdiction", "show"])).out).toMatch(/polymarket: BLOCKED/);
  });
  it("refuses Polymarket for a French resident without touching the network", async () => {
    await cli(["profile", "init", "--jurisdiction", "FR"]);
    const r = await cli(["predict", "polymarket", "election"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/BLOCKED_JURISDICTION/);
  });
});

describe("calendar command", () => {
  it("sessions, holidays and verify", async () => {
    expect((await cli(["calendar", "holidays", "--market", "XNYS", "--year", "2026"])).out).toMatch(/2026-11-26/);
    expect(JSON.parse((await cli(["calendar", "sessions", "--market", "XPAR", "--days", "3", "--json"])).out).sessions).toHaveLength(3);
    expect((await cli(["calendar", "verify", "--market", "XPAR", "--year", "2026"])).out).toMatch(/euronext\.com/);
    expect((await cli(["calendar", "earnings", "not-a-date"])).code).toBe(2);
    expect((await cli(["calendar", "sessions", "--market", "MOON"])).code).toBe(2);
  });
});

describe("data commands on fixtures", () => {
  it("options and universe register their figures as evidence", async () => {
    const run = mkdtempSync(join(tmpdir(), "us-cmd-"));
    const o = await cli(["options", "GPRO", "--out", run, "--fixture", join(FIXTURES, "options-cboe-gpro")]);
    expect(o.code).toBeUndefined();
    expect(o.out).toMatch(/\[E1\] GPRO/);
    setNetMode({ kind: "live" });
    const u = await cli(["universe", "DAX", "--out", run, "--fixture", join(FIXTURES, "macro-universe-eu"), "--json"]);
    expect(JSON.parse(u.out).datasets[0].ids.length).toBeGreaterThan(40);
    expect(EvidenceStore.load(run)!.items.some((i) => i.untrusted)).toBe(true);
  });
  it("without --out, says that nothing was registered", async () => {
    const o = await cli(["options", "GPRO", "--fixture", join(FIXTURES, "options-cboe-gpro")]);
    expect(o.out).toMatch(/nothing was registered/);
  });
  it("usage errors exit 2", async () => {
    for (const argv of [["crypto"], ["predict", "nowhere"], ["fundamentals"], ["holdings"], ["cot"], ["fx", "EURO"], ["news"], ["macro", "fred"]]) {
      expect((await cli(argv)).code, argv.join(" ")).toBe(2);
    }
  });
});
