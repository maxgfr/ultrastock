import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backtestCommand, strategyCommand } from "../src/commands/backtest.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { setNetMode } from "../src/core/net.js";
import type { CommandArgs } from "../src/engine.js";
import { withFixture } from "./helpers/fixtures.js";

afterEach(() => vi.restoreAllMocks());

const cmd = (command: string, positional: string[], values: Record<string, string> = {}, bools: string[] = []): CommandArgs => ({
  command,
  positional,
  values,
  bools: new Set(bools),
});

async function run(fn: (a: CommandArgs, j: boolean) => Promise<void>, a: CommandArgs, json = false): Promise<string> {
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

describe("backtest command on a recorded year of BTCUSDT", () => {
  it("runs, reviews and sweeps, registering every figure and writing the run files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-bt-"));
    await withFixture("backtest-btc-1y", async () => {
      const out = await run(backtestCommand, cmd("backtest", ["run", "supertrend", "BTCUSDT"], { years: "1", out: join(dir, "run") }));
      expect(out).toMatch(/# supertrend on BTCUSDT — backtest/);
      expect(out).toMatch(/supertrend on BTCUSDT Sharpe ratio = /);
      for (const f of ["evidence.json", "BACKTEST.md", "equity.json", "trades.json", "bars.json", "meta.json"])
        expect(existsSync(join(dir, "run", f)), f).toBe(true);
      const store = EvidenceStore.load(join(dir, "run"))!;
      const cagr = store.byKey("BTCUSDT.bt.supertrend.cagr")!;
      expect(cagr.source).toBe("binance");
      expect(cagr.formula).toMatch(/next open/);
      expect(store.byKey("BTCUSDT.bt.supertrend.bh.totalReturn")).toBeDefined();
      const trades = JSON.parse(readFileSync(join(dir, "run", "trades.json"), "utf8")).trades;
      expect(trades.length).toBeGreaterThan(0);
      expect(trades[0].entryIndex).toBe(trades[0].signalIndex + 1);

      const rev = JSON.parse(
        await run(backtestCommand, cmd("backtest", ["review", "supertrend", "BTCUSDT"], { years: "1", out: join(dir, "review"), paths: "500" }), true),
      );
      expect(["PASS", "REVISE", "REJECT"]).toContain(rev.verdict);
      expect(rev.checks.find((c: { id: string }) => c.id === "lookahead").status).toBe("pass");
      expect(rev.checks.find((c: { id: string }) => c.id === "sample.span").status).toBe("fail"); // one year, under three
      const rs = EvidenceStore.load(join(dir, "review"))!;
      expect(rs.byKey("BTCUSDT.bt.supertrend.review.verdict")?.value).toBe(rev.verdict);
      expect(rs.byKey("BTCUSDT.bt.supertrend.sweep.dsr")).toBeDefined();
      expect(rs.byKey("BTCUSDT.bt.supertrend.mc.final.p50")).toBeDefined();

      const sw = JSON.parse(
        await run(
          backtestCommand,
          cmd("backtest", ["sweep", "supertrend", "BTCUSDT"], {
            years: "1",
            out: join(dir, "sweep"),
            grid: "supertrend.atrPeriod=7,10,14;supertrend.multiplier=2,3",
          }),
          true,
        ),
      );
      expect(sw.variants).toBe(6);
      expect(readFileSync(join(dir, "sweep", "BACKTEST.md"), "utf8")).toMatch(/Sharpe by supertrend\.atrPeriod \(rows\) × supertrend\.multiplier/);

      const wf = JSON.parse(
        await run(
          backtestCommand,
          cmd(
            "backtest",
            ["walkforward", "supertrend", "BTCUSDT"],
            { years: "1", out: join(dir, "wf"), train: "150", test: "50", grid: "supertrend.atrPeriod=7,14" },
            ["anchored"],
          ),
          true,
        ),
      );
      expect(wf.windows).toBe(5); // 150 train + 50 test bars stepping over 364, the last test window partial
      expect(EvidenceStore.load(join(dir, "wf"))!.byKey("BTCUSDT.bt.supertrend.wf.oosSharpe")).toBeDefined();
      const mc = JSON.parse(
        await run(
          backtestCommand,
          cmd("backtest", ["montecarlo", "supertrend", "BTCUSDT"], { years: "1", out: join(dir, "mc"), paths: "300", seed: "1" }),
          true,
        ),
      );
      expect(mc.montecarlo.paths).toBe(300);
      const cmp = JSON.parse(
        await run(backtestCommand, cmd("backtest", ["compare", "supertrend,sma-cross,turtle", "BTCUSDT"], { years: "1", out: join(dir, "cmp") }), true),
      );
      expect(cmp.strategies.map((x: { name: string }) => x.name)).toEqual(["supertrend", "sma-cross", "turtle"]);
      expect(readFileSync(join(dir, "cmp", "BACKTEST.md"), "utf8")).toMatch(/--trials 3/);
      const lim = JSON.parse(
        await run(
          backtestCommand,
          cmd("backtest", ["run", "sma-cross", "BTCUSDT"], {
            years: "1",
            out: join(dir, "lim"),
            entry: "limit",
            "limit-offset": "1",
            "atr-stop": "14:2",
            fee: "0.2",
            "time-stop": "30",
          }),
          true,
        ),
      );
      const limMeta = JSON.parse(readFileSync(join(dir, "lim", "meta.json"), "utf8"));
      expect(limMeta.execution).toEqual({ entry: "limit", limitOffsetPct: 1 });
      expect(limMeta.costs.takerPct).toBe(0.2);
      expect(lim.strategy).toBe("sma-cross");
    });
  });

  it("refuses bad invocations with usage errors, before any request", async () => {
    setNetMode({ kind: "fixture", dir: join(tmpdir(), "ultrastock-no-such-fixture") });
    await expect(backtestCommand(cmd("backtest", []), false)).rejects.toThrow(/usage: ultrastock backtest run/);
    await expect(backtestCommand(cmd("backtest", ["run", "no-such", "BTCUSDT"]), false)).rejects.toThrow(/no strategy "no-such"/);
    await expect(backtestCommand(cmd("backtest", ["run", "turtle", "BTCUSDT"], { interval: "2h" }), false)).rejects.toThrow(/--interval/);
    await expect(backtestCommand(cmd("backtest", ["run", "turtle", "BTCUSDT"], { objective: "x", stop: "-1" }), false)).rejects.toThrow(/--stop/);
    await expect(backtestCommand(cmd("backtest", ["sweep", "turtle", "BTCUSDT"], { grid: "bad" }), false)).rejects.toThrow();
    await expect(backtestCommand(cmd("backtest", ["run", "60-40", "SPY"], { rebalance: "yearly" }), false)).rejects.toThrow(/--rebalance/);
    await expect(backtestCommand(cmd("backtest", ["run", "turtle", "SPY"], { universe: "MOON" }), false)).rejects.toThrow(/not a known index/);
    setNetMode({ kind: "live" });
  });
});

describe("perpetuals and allocations on recorded data", () => {
  it("simulates a 2× long/short perpetual with Binance funding history", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "us-perp-")), "run");
    await withFixture("backtest-btc-perp-6m", async () => {
      const r = JSON.parse(await run(backtestCommand, cmd("backtest", ["run", "adaptive-momentum-reversal", "BTCUSDT"], { years: "0.5", out: dir }), true));
      expect(r.notes.join("\n")).toMatch(/funding: \d+ settlements of the BTCUSDT perpetual/);
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
      expect(meta).toMatchObject({ perp: true, leverage: 2, costs: { makerPct: 0.02, takerPct: 0.05 } });
      const store = EvidenceStore.load(dir)!;
      expect(store.byKey("BTCUSDT.bt.adaptive-momentum-reversal.funding")).toBeDefined();
    });
  });

  it("backtests a 60/40 allocation, monthly rebalanced, against costs", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "us-alloc-")), "run");
    await withFixture("backtest-alloc-60-40-1y", async () => {
      const r = JSON.parse(await run(backtestCommand, cmd("backtest", ["run", "60-40", "SPY,TLT"], { years: "1", out: dir }), true));
      expect(r.symbols).toEqual(["SPY", "TLT"]);
      const store = EvidenceStore.load(dir)!;
      expect(store.byKey("SPY+TLT.bt.60-40.rebalances")!.value).toBeGreaterThanOrEqual(11);
      expect(store.byKey("SPY+TLT.bt.60-40.cagr")!.source).toBe("nasdaq");
      const rb = JSON.parse(readFileSync(join(dir, "rebalances.json"), "utf8"));
      expect(rb[0].weights).toEqual([0.6, 0.4]);
    });
  }, 60_000);
});

describe("backtest decisions", () => {
  it("replays the journal's settlements with Wilson intervals", async () => {
    await expect(backtestCommand(cmd("backtest", ["decisions"]), false)).rejects.toThrow(/no settled decision/);
    const j = join(process.env.ULTRASTOCK_HOME!, "journal");
    mkdirSync(j, { recursive: true });
    const row = (id: string, rating: string, alphaPct: number, hit: boolean) =>
      JSON.stringify({
        decisionId: id,
        symbol: "NVDA",
        rating,
        horizon: 20,
        decidedAt: "2026-01-02",
        startClose: 1,
        endDate: "2026-02-01",
        endClose: 1,
        returnPct: alphaPct,
        alphaPct,
        hit,
        settledAt: "2026-02-02",
      });
    writeFileSync(join(j, "settlements.jsonl"), `${[row("a", "buy", 3, true), row("b", "buy", -1, false), row("c", "buy", 2, true)].join("\n")}\n`);
    const out = join(mkdtempSync(join(tmpdir(), "us-dq-")), "run");
    const text = await run(backtestCommand, cmd("backtest", ["decisions"], { out }));
    expect(text).toMatch(/buy calls at \+20 sessions: hit rate = 66\.6667%/);
    expect(EvidenceStore.load(out)!.byKey("journal.decisions.buy.h20.hitLow")).toBeDefined();
  });
});

describe("strategy command", () => {
  it("lists, shows, validates and creates strategies", async () => {
    expect(await run(strategyCommand, cmd("strategy", ["list"]))).toMatch(/27 strategies/);
    const show = await run(strategyCommand, cmd("strategy", ["show", "confluence"]));
    expect(show).toMatch(/pmax: pmax \(maPeriod=10/);
    expect(await run(strategyCommand, cmd("strategy", ["validate", "turtle"]))).toMatch(/turtle: valid/);
    const bad = join(mkdtempSync(join(tmpdir(), "us-st-")), "bad.json");
    writeFileSync(
      bad,
      JSON.stringify({
        name: "bad",
        description: "x",
        indicators: {},
        buy: { mode: "all", conditions: [["rsi", "<", 3]] },
        sell: { mode: "all", conditions: [] },
      }),
    );
    let printed = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      printed += String(c);
      return true;
    });
    await expect(strategyCommand(cmd("strategy", ["validate", bad]), false)).rejects.toThrow(/error/);
    vi.restoreAllMocks();
    expect(printed).toMatch(/undeclared indicator "rsi"/);
    const made = JSON.parse(await run(strategyCommand, cmd("strategy", ["new", "my-turtle"], { like: "turtle" }), true));
    expect(made.strategy.name).toBe("my-turtle");
    expect(await run(strategyCommand, cmd("strategy", ["list"]))).toMatch(/my-turtle \(yours\)/);
    await expect(strategyCommand(cmd("strategy", ["new", "my-turtle"]), false)).rejects.toThrow(/already exists/);
    await expect(strategyCommand(cmd("strategy", ["nope"]), false)).rejects.toThrow(/usage: ultrastock strategy/);
  });
});
