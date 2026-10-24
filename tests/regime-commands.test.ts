// The market-context commands end to end on recorded answers:
//   ULTRASTOCK_RECORD=1 npx vitest run tests/regime-commands.test.ts   records them
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalystsCommand, regimeCommand, sectorsCommand } from "../src/commands/regime.js";
import { EvidenceStore } from "../src/core/evidence.js";
import type { CommandArgs } from "../src/engine.js";
import { withFixture } from "./helpers/fixtures.js";

afterEach(() => vi.restoreAllMocks());

const args = (command: string, positional: string[], values: Record<string, string> = {}): CommandArgs => ({ command, positional, values, bools: new Set() });

/** Run a command function and capture what it prints. */
async function run(fn: (a: CommandArgs, json: boolean) => Promise<void>, a: CommandArgs, json = false): Promise<string> {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  try {
    await fn(a, json);
  } finally {
    vi.restoreAllMocks();
  }
  return out;
}

describe("regime", () => {
  it("crypto: BTC trend, alt breadth, funding and drawdown feed the risk-on score, each registered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-regime-"));
    const out = await withFixture("regime-crypto", () => run(regimeCommand, args("regime", [], { market: "crypto", out: dir })));
    expect(out).toMatch(/# Crypto market regime — as of \d{4}-\d{2}-\d{2}/);
    expect(out).toMatch(/regime: [a-z-]+ \[E\d+\]/);
    const items = EvidenceStore.load(dir)!.items;
    const keys = items.map((i) => i.key);
    for (const k of [
      "CRYPTO.regime.signal.trend.BTC",
      "CRYPTO.regime.signal.trend.BTC.reason",
      "CRYPTO.regime.altBreadth.pct",
      "CRYPTO.regime.score",
      "CRYPTO.regime.label",
    ])
      expect(keys).toContain(k);
    expect(keys.some((k) => /^CRYPTO\.regime\.coach\.btcTrend\.score$/.test(k))).toBe(true);
    const score = items.find((i) => i.key === "CRYPTO.regime.score")!;
    expect(score).toMatchObject({ source: "ultrastock", unit: "score" });
    expect(Number(score.value)).toBeGreaterThanOrEqual(0);
    expect(Number(score.value)).toBeLessThanOrEqual(100);
    expect(items.find((i) => i.key === "CRYPTO.regime.signal.trend.BTC")).toMatchObject({ source: "binance", official: true });
  }, 60_000);

  it("eu: CAC 40 trend, breadth and VIX term; the index's missing volumes are said, not guessed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-regime-"));
    const out = await withFixture("regime-eu", () => run(regimeCommand, args("regime", [], { market: "eu", out: dir })));
    expect(out).toMatch(/max exposure: (\d+ %|n\/a)/);
    expect(out).toMatch(/CAC 40: no session volumes from euronext — distribution days and follow-through .* unavailable/);
    const keys = EvidenceStore.load(dir)!.items.map((i) => i.key);
    for (const k of [
      "EU.regime.signal.trend.CAC40",
      "EU.regime.breadth.above200.pct",
      "EU.regime.coach.zone",
      "EU.regime.coach.coverage",
      "EA.rates.aaa.spread.2s10s",
    ])
      expect(keys).toContain(k);
    expect(keys.some((k) => k.startsWith("EU.regime.dist."))).toBe(false);
  }, 60_000);

  it("refuses an unknown market and stray words", async () => {
    await expect(regimeCommand(args("regime", [], { market: "moon" }), false)).rejects.toThrow(/--market is us, eu, crypto/);
    await expect(regimeCommand(args("regime", ["us"]), false)).rejects.toThrow(/usage/);
    await expect(sectorsCommand(args("sectors", [], { market: "crypto" }), false)).rejects.toThrow(/--market is us, eu/);
  });
});

describe("sectors", () => {
  it("eu: sectors ranked from the screener, rotation read, JSON carries the ranking", async () => {
    const json = await withFixture("regime-sectors-eu", () => run(sectorsCommand, args("sectors", [], { market: "eu" }), true));
    const r = JSON.parse(json);
    expect(["risk-on", "risk-off", "mixed"]).toContain(r.rotation.reading);
    expect(r.ranked.length).toBeGreaterThan(5);
    expect(r.ranked[0].rank).toBe(1);
    const keys = r.datasets[0].points.map((p: { key: string }) => p.key);
    expect(keys).toContain("EU.sector.rotation");
    expect(keys.some((k: string) => /^EU\.sector\.[a-zA-Z]+\.rs\.rank$/.test(k))).toBe(true);
  }, 60_000);
});

describe("catalysts", () => {
  it("a Euronext issuer: TradingView dates, euro macro releases, holidays; no SEC, no options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-cat-"));
    const out = await withFixture("regime-catalysts-mc-pa", () => run(catalystsCommand, args("catalysts", ["MC.PA"], { days: "5", out: dir })));
    expect(out).toMatch(/# MC\.PA — .*catalysts \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2} \(5 days\)/);
    expect(out).toMatch(/event cluster: (yes|no) \[E\d+\]/);
    expect(out).toMatch(/options-implied move: US listings only/);
    const items = EvidenceStore.load(dir)!.items;
    expect(items.find((i) => i.key === "MC.PA.cat.cluster")).toBeDefined();
    expect(items.filter((i) => i.key.startsWith("MC.PA.cat.macro.")).every((i) => i.untrusted)).toBe(true);
  }, 60_000);

  it("validates its arguments", async () => {
    await expect(catalystsCommand(args("catalysts", []), false)).rejects.toThrow(/usage/);
    await expect(catalystsCommand(args("catalysts", ["MC.PA"], { days: "400" }), false)).rejects.toThrow();
  });
});
