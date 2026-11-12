import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { FIXTURES } from "./helpers/fixtures.js";
import { installJurisdictionTestFacts } from "./helpers/jurisdiction-facts.js";

afterEach(() => {
  setNetMode({ kind: "live" });
  vi.restoreAllMocks();
});

/** Run the CLI in-process; returns stdout, or the error a process.exit would have carried. */
async function cli(argv: string[]): Promise<{ out: string; err: string; code?: number }> {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    err += String(c);
    return true;
  });
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
    // Nothing researched: every rule is unknown, and the command to research it is named.
    const before = (await cli(["jurisdiction", "show"])).out;
    expect(before).toMatch(/polymarket: UNKNOWN — not researched for FR/);
    expect(before).toContain("ultrastock facts research jurisdiction --country FR");
    installJurisdictionTestFacts();
    expect((await cli(["jurisdiction", "show"])).out).toMatch(/polymarket: BLOCKED/);
  });
  it("refuses Polymarket for a French resident without touching the network", async () => {
    await cli(["profile", "init", "--jurisdiction", "FR"]);
    installJurisdictionTestFacts();
    const r = await cli(["predict", "polymarket", "election"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Polymarket is blocked for residents of FR \(BLOCKED_JURISDICTION\)/);
  });
  it("refuses Polymarket where it was never researched, naming the research command", async () => {
    rmSync(homeDir(), { recursive: true, force: true });
    await cli(["profile", "init", "--jurisdiction", "DE"]);
    const r = await cli(["predict", "polymarket", "election"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Polymarket is unknown for residents of DE \(BLOCKED_JURISDICTION\)/);
    expect(r.err).toContain("ultrastock facts research jurisdiction --country DE --key polymarket --out <run>");
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

describe("portfolio perf", () => {
  it("leaves the XIRR not computed, and says why, when a deposit's rate on its own date cannot be read", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "perf-home-"));
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions(
      [
        { date: "2026-09-01", type: "deposit", account: "pea", amount: 10_000, currency: "EUR", origin: "manual" },
        { date: "2026-09-01", type: "deposit", account: "cto", amount: 5000, currency: "USD", origin: "manual" },
        { date: "2026-09-02", type: "buy", account: "pea", symbol: "MC.PA", quantity: 5, price: 600, fee: 3, currency: "EUR", origin: "paper" },
        { date: "2026-09-02", type: "buy", account: "cto", symbol: "NVDA", quantity: 10, price: 180, fee: 1, currency: "USD", origin: "paper" },
      ],
      "paper",
    );
    // The fixture holds the quotes and today's rate, not the ECB rate of 2026-09-01.
    const fixture = ["--fixture", join(FIXTURES, "portfolio-analytics-paper")];
    const text = await cli(["portfolio", "perf", "--book", "paper", ...fixture]);
    expect(text.out).toMatch(/money-weighted return \(XIRR\) n\/a/);
    expect(text.out).toMatch(/note: XIRR not computed: no EUR rate for USD on 2026-09-01/);
    const json = JSON.parse((await cli(["portfolio", "perf", "--book", "paper", "--json", ...fixture])).out);
    expect(json.xirr).toBeUndefined();
    expect(json.xirrNotes.join("\n")).toMatch(/no EUR rate for USD on 2026-09-01/);
  }, 60_000);
});

describe("etf propose", () => {
  it("refuses --max-funds below the sleeves the risk profile needs, as a usage error, before reading anything", async () => {
    // A fixture recorded for another plan: any request this run sent would fail as unrecorded, not as usage.
    const r = await cli(["etf", "propose", "--goal", "core", "--risk", "2", "--max-funds", "1", "--fixture", join(FIXTURES, "etf-propose-pea")]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--max-funds 1 is too few for goal core at risk 2: .*at least 2 funds/);
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
