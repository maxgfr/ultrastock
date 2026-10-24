// `backtest` and `strategy`: declarative strategies run through a simulator
// that fills at the next open, gaps stops to the open and charges taker or
// maker by order type; allocation rules over a list of symbols; the
// validators (walk-forward, CPCV, PBO, Monte Carlo, sweeps, ×2 costs); a
// PASS/REVISE/REJECT review; and the journal's decisions replayed for hit
// rates. Every figure lands in the run's evidence (--out, else a run directory
// under <home>/runs), with BACKTEST.md, equity.json, trades.json and bars.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Allocation, ALLOCATIONS } from "../backtest/allocation.js";
import { findStrategy, listStrategies, loadStrategy, strategyTemplate, userStrategyDir } from "../backtest/catalog.js";
import { decisionQuality } from "../backtest/decisions.js";
import {
  equityJson,
  loadMarket,
  type Market,
  type MarketOptions,
  monteCarloDataset,
  portfolioRun,
  reviewRun,
  reviewTable,
  strategyBacktest,
  sweepReport,
  sweepTable,
  tradesTable,
  walkForwardReport,
  walkForwardTable,
  writeRun,
} from "../backtest/run.js";
import type { Costs } from "../backtest/simulate.js";
import { type ExecutionRules, resolveIndicator, type RiskRules, type StrategyDef, validateStrategy } from "../backtest/strategy.js";
import { defaultGrid, type GridDim, OBJECTIVES, type Objective, parseGrid } from "../backtest/validation.js";
import type { Dataset, Point } from "../core/datasets.js";
import { clockNow } from "../core/net.js";
import { runDirFor } from "../core/paths.js";
import { argBool, argInt, argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";
import { readSettlements } from "../journal/settle.js";
import { indexId } from "../providers/macro/universe.js";
import type { Interval } from "../providers/types.js";
import { emitDatasets } from "./emit.js";

const INTERVALS: Interval[] = ["1d", "1w", "4h", "1h", "15m"];

const COMMON = "[--from YYYY-MM-DD] [--to YYYY-MM-DD] [--years N] [--interval 1d|4h|1h|15m] [--capital N] [cost, risk and data flags] [--out <dir>] [--json]";
export const BACKTEST_USAGE = [
  `usage: ultrastock backtest run <strategy> <symbol> ${COMMON}`,
  "       ultrastock backtest run <buy-and-hold|60-40|equal-weight|dual-momentum|risk-parity> <sym1,sym2,…> [--rebalance monthly|quarterly] [--lookback 12] [--cash-rate 0] [--universe INDEX]",
  "       ultrastock backtest walkforward <strategy> <symbol> [--grid alias.param=a,b;…] [--train N] [--test N] [--anchored] [--objective sharpe|sortino|cagr|calmar|profit-factor]",
  "       ultrastock backtest sweep <strategy> <symbol> [--grid …] [--objective …] [--trials N] [--groups 6] [--test-groups 2] [--purge 5] [--embargo N]",
  "       ultrastock backtest montecarlo <strategy> <symbol> [--paths 5000] [--seed 42]",
  "       ultrastock backtest compare <strategy1,strategy2,…> <symbol>",
  "       ultrastock backtest review <strategy> <symbol> [--grid …] [--trials N] [--universe INDEX]",
  "       ultrastock backtest decisions [--rating buy|…] [--horizon 5|20|60]",
].join("\n");

export const STRATEGY_USAGE =
  "usage: ultrastock strategy list | show <name|file.json> | validate <name|file.json> | new <name> [--like <strategy>] — strategies live in <home>/strategies/";

// --- Flag parsing ---------------------------------------------------------------------------

const day = (v: string, flag: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new UsageError(`--${flag} is a date like 2021-01-31`);
  return new Date(`${v}T00:00:00Z`);
};

const num = (args: CommandArgs, flag: string, lo: number, hi: number): number | undefined => {
  const v = argValue(args, flag);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new UsageError(`--${flag} is a number between ${lo} and ${hi}`);
  return n;
};

function marketOptions(args: CommandArgs): MarketOptions {
  const now = clockNow();
  const to = argValue(args, "to") ? day(argValue(args, "to")!, "to") : now;
  const years = num(args, "years", 0.25, 30) ?? 5;
  const from = argValue(args, "from") ? day(argValue(args, "from")!, "from") : new Date(to.getTime() - Math.round(years * 365.25) * 86_400_000);
  if (from >= to) throw new UsageError("--from must be before --to");
  const interval = (argValue(args, "interval") ?? "1d") as Interval;
  if (!INTERVALS.includes(interval)) throw new UsageError(`--interval must be one of ${INTERVALS.join(", ")}`);
  const costs: Partial<Costs> = {};
  const fee = num(args, "fee", 0, 5);
  if (fee !== undefined) costs.makerPct = costs.takerPct = fee;
  const maker = num(args, "maker", 0, 5);
  if (maker !== undefined) costs.makerPct = maker;
  const taker = num(args, "taker", 0, 5);
  if (taker !== undefined) costs.takerPct = taker;
  const slip = num(args, "slippage", 0, 5);
  if (slip !== undefined) costs.slippagePct = slip;
  const bench = argValue(args, "benchmark");
  const universe = argValue(args, "universe");
  if (universe && !indexId(universe)) throw new UsageError(`--universe ${universe}: not a known index (SPX, NDX, DJI, CAC40, SBF120, DAX, SX5E, AEX, UKX)`);
  return {
    from,
    to,
    interval,
    capital: num(args, "capital", 1, 1e12) ?? 10_000,
    costs,
    leverage: num(args, "leverage", 1, 125),
    perp: argBool(args, "perp"),
    benchmark: bench === undefined ? undefined : bench.toLowerCase() === "none" ? null : bench,
    universe: universe ? indexId(universe) : undefined,
  };
}

function overrides(args: CommandArgs): { risk?: RiskRules; execution?: ExecutionRules } {
  const risk: RiskRules = {};
  const set = <K extends keyof RiskRules>(k: K, v: RiskRules[K] | undefined) => {
    if (v !== undefined) risk[k] = v;
  };
  set("stopLossPct", num(args, "stop", 0.01, 100));
  set("takeProfitPct", num(args, "target", 0.01, 10_000));
  set("trailingStopPct", num(args, "trail", 0.01, 100));
  set("riskPerTradePct", num(args, "risk", 0.01, 100));
  set("maxDrawdownPct", num(args, "max-dd", 0.01, 100));
  set("timeStopBars", argInt(args, "time-stop", { min: 1, max: 100_000 }));
  const atr = argValue(args, "atr-stop");
  if (atr !== undefined) {
    const m = /^(\d+):([\d.]+)$/.exec(atr);
    if (!m || Number(m[2]) <= 0) throw new UsageError("--atr-stop is period:multiplier, like 14:3");
    risk.atrStop = { period: Number(m[1]), multiplier: Number(m[2]) };
  }
  const execution: ExecutionRules = {};
  const entry = argValue(args, "entry");
  if (entry !== undefined) {
    if (entry !== "market" && entry !== "limit") throw new UsageError("--entry is market or limit");
    execution.entry = entry;
  }
  const off = num(args, "limit-offset", 0, 50);
  if (off !== undefined) execution.limitOffsetPct = off;
  return { risk: Object.keys(risk).length ? risk : undefined, execution: Object.keys(execution).length ? execution : undefined };
}

function objectiveOf(args: CommandArgs): Objective {
  const o = argValue(args, "objective") ?? "sharpe";
  if (!(OBJECTIVES as readonly string[]).includes(o)) throw new UsageError(`--objective must be one of ${OBJECTIVES.join(", ")}`);
  return o as Objective;
}

function gridOf(args: CommandArgs, def: StrategyDef): GridDim[] {
  const g = argValue(args, "grid");
  if (!g) return defaultGrid(def);
  try {
    return parseGrid(g);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function loadDef(ref: string | undefined, usage: string): { def: StrategyDef; warnings: string[] } {
  if (!ref) throw new UsageError(usage);
  try {
    const { def, warnings } = loadStrategy(ref);
    return { def, warnings };
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

const runDir = (args: CommandArgs, name: string) =>
  argValue(args, "out") ? resolve(argValue(args, "out")!) : runDirFor(undefined, `${name.toUpperCase().replace(/[^A-Z0-9.+-]/g, "_")}-${runId()}`);

function finish(asJson: boolean, dir: string, evidence: number, summary: Record<string, unknown>): void {
  if (asJson) process.stdout.write(jsonLine({ dir, evidence, ...summary }));
  else process.stdout.write(`${readFileSync(join(dir, "BACKTEST.md"), "utf8")}\nrun: ${dir}\n`);
}

const tradesJson = (m: Market, trades: ReturnType<typeof strategyBacktest>["sim"]["trades"]) => ({ symbol: m.symbol, currency: m.instrument.currency, trades });

// --- backtest ---------------------------------------------------------------------------------

export async function backtestCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub, first, second] = args.positional;
  const now = clockNow();
  switch (sub) {
    case "run": {
      if (!first || !second) throw new UsageError(BACKTEST_USAGE);
      if ((ALLOCATIONS as readonly string[]).includes(first)) return allocationCommand(first as Allocation, args, asJson);
      const { def, warnings } = loadDef(first, BACKTEST_USAGE);
      const o = overrides(args);
      const m = await loadMarket(second, marketOptions(args), def);
      const rep = strategyBacktest(m, def, o);
      rep.datasets[0]!.notes.push(...warnings.map((w) => `strategy: ${w}`));
      const dir = runDir(args, `${m.symbol}-backtest-${def.name}`);
      const evidence = writeRun(
        dir,
        `${def.name} on ${m.symbol} — backtest`,
        rep.datasets,
        {
          sections: [paramsSection(rep.params), tradesTable(rep.sim.trades)],
          json: { "equity.json": equityJson(rep.sim), "trades.json": tradesJson(m, rep.sim.trades), "strategy.json": def, "meta.json": meta(m, def, o) },
          bars: m.bars,
        },
        now.toISOString(),
      );
      return finish(asJson, dir, evidence, {
        symbol: m.symbol,
        strategy: def.name,
        cagrPct: rep.summary.cagr * 100,
        sharpe: rep.summary.sharpe,
        maxDrawdownPct: rep.summary.maxDrawdown * 100,
        trades: rep.stats.trades,
        notes: rep.datasets[0]!.notes,
      });
    }
    case "walkforward": {
      const { def } = loadDef(first, BACKTEST_USAGE);
      if (!second) throw new UsageError(BACKTEST_USAGE);
      const o = overrides(args);
      const wfOpts = {
        train: argInt(args, "train", { min: 20, max: 1_000_000 }),
        test: argInt(args, "test", { min: 5, max: 1_000_000 }),
        anchored: argBool(args, "anchored"),
        objective: objectiveOf(args),
        overrides: o,
      };
      const dims = gridOf(args, def);
      const m = await loadMarket(second, marketOptions(args), def);
      const wf = walkForwardReport(m, def, dims, wfOpts);
      const dir = runDir(args, `${m.symbol}-walkforward-${def.name}`);
      const equity = wf.wf.oosDates.map((d, i) => ({ date: d, return: wf.wf.oosReturns[i] }));
      const evidence = writeRun(
        dir,
        `${def.name} on ${m.symbol} — walk-forward`,
        [wf.dataset],
        {
          sections: [walkForwardTable(wf.wf), tradesTable(wf.wf.oosTrades)],
          json: {
            "walkforward.json": { ...wf.wf, oosReturns: undefined, oosDates: undefined },
            "equity.json": oosEquity(m.capital, equity),
            "trades.json": tradesJson(m, wf.wf.oosTrades),
          },
          bars: m.bars,
        },
        now.toISOString(),
      );
      return finish(asJson, dir, evidence, {
        symbol: m.symbol,
        strategy: def.name,
        oosSharpe: wf.wf.oosSharpe,
        isSharpe: wf.wf.isSharpeMean,
        windows: wf.wf.windows.length,
      });
    }
    case "sweep": {
      const { def } = loadDef(first, BACKTEST_USAGE);
      if (!second) throw new UsageError(BACKTEST_USAGE);
      const dims = gridOf(args, def);
      const objective = objectiveOf(args);
      const swOpts = {
        trials: argInt(args, "trials", { min: 0, max: 1_000_000 }),
        groups: argInt(args, "groups", { min: 3, max: 20 }),
        testGroups: argInt(args, "test-groups", { min: 1, max: 10 }),
        purge: argInt(args, "purge", { min: 0, max: 10_000 }),
        embargo: argInt(args, "embargo", { min: 0, max: 10_000 }),
        overrides: overrides(args),
      };
      const m = await loadMarket(second, marketOptions(args), def);
      const sw = sweepReport(m, def, dims, objective, swOpts);
      const dir = runDir(args, `${m.symbol}-sweep-${def.name}`);
      const evidence = writeRun(
        dir,
        `${def.name} on ${m.symbol} — sweep`,
        [sw.dataset],
        {
          sections: [sweepTable(sw)],
          json: { "sweep.json": { dims: sw.dims, rows: sw.rows, best: sw.best, dsr: sw.dsr, nTrials: sw.nTrials, pbo: sw.pbo, cpcv: sw.cpcv } },
          bars: m.bars,
        },
        now.toISOString(),
      );
      return finish(asJson, dir, evidence, { symbol: m.symbol, strategy: def.name, variants: sw.rows.length, best: sw.best, dsr: sw.dsr, pbo: sw.pbo?.pbo });
    }
    case "montecarlo": {
      const { def } = loadDef(first, BACKTEST_USAGE);
      if (!second) throw new UsageError(BACKTEST_USAGE);
      const m = await loadMarket(second, marketOptions(args), def);
      const rep = strategyBacktest(m, def, overrides(args));
      const mc = monteCarloDataset(
        m,
        def,
        rep.sim,
        argInt(args, "paths", { min: 100, max: 100_000 }) ?? 5000,
        argInt(args, "seed", { min: 0, max: 2 ** 31 }) ?? 42,
      );
      const dir = runDir(args, `${m.symbol}-montecarlo-${def.name}`);
      const evidence = writeRun(
        dir,
        `${def.name} on ${m.symbol} — Monte Carlo`,
        [...rep.datasets, mc.dataset],
        {
          sections: [tradesTable(rep.sim.trades)],
          json: { "montecarlo.json": mc.mc ?? null, "equity.json": equityJson(rep.sim), "trades.json": tradesJson(m, rep.sim.trades) },
          bars: m.bars,
        },
        now.toISOString(),
      );
      return finish(asJson, dir, evidence, { symbol: m.symbol, strategy: def.name, montecarlo: mc.mc });
    }
    case "compare": {
      if (!first || !second) throw new UsageError(BACKTEST_USAGE);
      const names = first
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length < 2 || names.length > 30) throw new UsageError("compare takes 2 to 30 comma-separated strategies");
      const defs = names.map((n) => loadDef(n, BACKTEST_USAGE).def);
      const o = overrides(args);
      const m = await loadMarket(second, marketOptions(args), defs[0]);
      const reps = defs.map((d) => strategyBacktest(m, d, o));
      const table = [
        `## Comparison on ${m.symbol} (${names.length} strategies)`,
        "",
        "| Strategy | CAGR % | Sharpe | Max DD % | Trades | Win % | ×2 costs return % |",
        "|---|---|---|---|---|---|---|",
        ...reps.map(
          (r) =>
            `| ${r.def.name} | ${(r.summary.cagr * 100).toFixed(2)} | ${r.summary.sharpe.toFixed(2)} | ${(r.summary.maxDrawdown * 100).toFixed(2)} | ${r.stats.trades} | ${Number.isFinite(r.stats.winRate) ? r.stats.winRate.toFixed(1) : "–"} | ${(r.stressed.summary.totalReturn * 100).toFixed(2)} |`,
        ),
        "",
        `Comparing ${names.length} strategies is ${names.length} trials: run \`backtest review\` on the winner with \`--trials ${names.length}\` so its deflated Sharpe counts them.`,
      ].join("\n");
      const dir = runDir(args, `${m.symbol}-compare`);
      const evidence = writeRun(
        dir,
        `${names.length} strategies on ${m.symbol} — comparison`,
        reps.flatMap((r) => r.datasets),
        { sections: [table], bars: m.bars },
        now.toISOString(),
      );
      return finish(asJson, dir, evidence, {
        symbol: m.symbol,
        strategies: reps.map((r) => ({
          name: r.def.name,
          cagrPct: r.summary.cagr * 100,
          sharpe: r.summary.sharpe,
          maxDrawdownPct: r.summary.maxDrawdown * 100,
          trades: r.stats.trades,
        })),
      });
    }
    case "review": {
      const { def } = loadDef(first, BACKTEST_USAGE);
      if (!second) throw new UsageError(BACKTEST_USAGE);
      const o = overrides(args);
      const rvOpts = {
        dims: argValue(args, "grid") ? gridOf(args, def) : undefined,
        objective: objectiveOf(args),
        trials: argInt(args, "trials", { min: 0, max: 1_000_000 }),
        train: argInt(args, "train", { min: 20, max: 1_000_000 }),
        test: argInt(args, "test", { min: 5, max: 1_000_000 }),
        anchored: argBool(args, "anchored"),
        paths: argInt(args, "paths", { min: 100, max: 100_000 }),
        seed: argInt(args, "seed", { min: 0, max: 2 ** 31 }),
        overrides: o,
      };
      const m = await loadMarket(second, marketOptions(args), def);
      const r = reviewRun(m, def, rvOpts);
      const dir = runDir(args, `${m.symbol}-review-${def.name}`);
      const datasets = [r.dataset, ...r.base.datasets, r.sweep.dataset, ...(r.wf ? [r.wf.dataset] : []), r.mc.dataset];
      const evidence = writeRun(
        dir,
        `${def.name} on ${m.symbol} — review: ${r.review.verdict}`,
        datasets,
        {
          sections: [reviewTable(r.review), sweepTable(r.sweep), ...(r.wf ? [walkForwardTable(r.wf.wf)] : []), tradesTable(r.base.sim.trades)],
          json: {
            "review.json": r.review,
            "equity.json": equityJson(r.base.sim),
            "trades.json": tradesJson(m, r.base.sim.trades),
            "sweep.json": { dims: r.sweep.dims, rows: r.sweep.rows, best: r.sweep.best, dsr: r.sweep.dsr, pbo: r.sweep.pbo, cpcv: r.sweep.cpcv },
            ...(r.wf ? { "walkforward.json": { ...r.wf.wf, oosReturns: undefined, oosDates: undefined } } : {}),
            "montecarlo.json": r.mc.mc ?? null,
            "meta.json": meta(m, def, o),
          },
          bars: m.bars,
        },
        now.toISOString(),
      );
      return finish(asJson, dir, evidence, {
        symbol: m.symbol,
        strategy: def.name,
        verdict: r.review.verdict,
        reasons: r.review.reasons,
        checks: r.review.checks,
      });
    }
    case "decisions":
      return decisionsCommand(args, asJson);
    default:
      throw new UsageError(BACKTEST_USAGE);
  }
}

async function allocationCommand(kind: Allocation, args: CommandArgs, asJson: boolean): Promise<void> {
  const symbols = args.positional
    .slice(2)
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!symbols.length) throw new UsageError(BACKTEST_USAGE);
  const opts = marketOptions(args);
  if (opts.interval !== "1d") throw new UsageError("allocation backtests run on daily bars");
  const rebalance = argValue(args, "rebalance") ?? "monthly";
  if (rebalance !== "monthly" && rebalance !== "quarterly") throw new UsageError("--rebalance is monthly or quarterly");
  const r = await portfolioRun(kind, symbols, {
    ...opts,
    rebalance,
    lookbackMonths: argInt(args, "lookback", { min: 1, max: 36 }),
    cashRatePct: num(args, "cash-rate", -5, 20),
  });
  const dir = runDir(args, `${r.symbols.join("+")}-backtest-${kind}`);
  const rebal = [
    `## Rebalances (${r.result.rebalances.length})`,
    "",
    `| Date | ${r.symbols.join(" | ")} | Turnover % | Why |`,
    `|---|${r.symbols.map(() => "---").join("|")}|---|---|`,
    ...r.result.rebalances
      .slice(-24)
      .map((x) => `| ${x.date} | ${x.weights.map((w) => (w * 100).toFixed(1)).join(" | ")} | ${x.turnoverPct.toFixed(1)} | ${x.reason} |`),
  ].join("\n");
  const evidence = writeRun(
    dir,
    `${kind} on ${r.symbols.join(", ")} — allocation backtest`,
    [r.dataset],
    {
      sections: [rebal],
      json: {
        "equity.json": equityJson(r.result),
        "rebalances.json": r.result.rebalances,
        "trades.json": { symbols: r.symbols, rebalances: r.result.rebalances },
      },
      bars: r.bars,
    },
    clockNow().toISOString(),
  );
  return finish(asJson, dir, evidence, {
    symbols: r.symbols,
    allocation: kind,
    cagrPct: r.summary.cagr * 100,
    sharpe: r.summary.sharpe,
    maxDrawdownPct: r.summary.maxDrawdown * 100,
  });
}

function oosEquity(capital: number, rows: Array<{ date: string; return: number | undefined }>) {
  let e = capital;
  return rows.map((r) => ({ date: r.date, equity: Number((e *= 1 + (r.return ?? 0)).toFixed(4)) }));
}

function meta(m: Market, def: StrategyDef, o: { risk?: RiskRules; execution?: ExecutionRules }) {
  return {
    symbol: m.symbol,
    strategy: def.name,
    interval: m.interval,
    from: m.bars[0]!.date,
    to: m.bars[m.bars.length - 1]!.date,
    bars: m.bars.length,
    capital: m.capital,
    costs: m.costs,
    leverage: m.leverage,
    perp: m.perp,
    benchmark: m.benchmark?.symbol,
    universe: m.universe,
    risk: { ...(def.risk ?? {}), ...(o.risk ?? {}) },
    execution: { ...(def.execution ?? {}), ...(o.execution ?? {}) },
    fills: "signal at bar i close → fill at bar i+1 open; stops gap to the open; stop before target in a bar; market = taker, limit = maker",
    source: m.series.provenance,
  };
}

function paramsSection(params: Record<string, Record<string, number | string>>): string {
  return [
    "## Indicator parameters used",
    "",
    ...Object.entries(params).map(
      ([a, p]) =>
        `- ${a}: ${
          Object.entries(p)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ") || "defaults"
        }`,
    ),
  ].join("\n");
}

// --- decisions -----------------------------------------------------------------------------------

async function decisionsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const rating = argValue(args, "rating");
  const horizon = argInt(args, "horizon", { min: 1, max: 1000 });
  const all = readSettlements().filter((s) => (!rating || s.rating === rating) && (!horizon || s.horizon === horizon));
  if (!all.length) throw new Error("no settled decision yet — record calls with `decide`, then `journal settle` once 5, 20 and 60 sessions have passed");
  const groups = decisionQuality(all);
  const points: Point[] = [];
  const how = "settled decisions in journal/settlements.jsonl";
  points.push({ key: "journal.decisions.settlements", label: "Settled decision horizons", value: all.length, unit: "count", formula: how });
  for (const g of groups) {
    const k = `journal.decisions.${g.rating}.h${g.horizon}`;
    const l = `${g.rating} calls at +${g.horizon} sessions`;
    points.push(
      { key: `${k}.n`, label: `${l}: settled`, value: g.n, unit: "count", formula: how },
      {
        key: `${k}.hitRate`,
        label: `${l}: hit rate`,
        value: g.hitRate * 100,
        unit: "%",
        formula: "right calls / settled (buy/overweight right when alpha > 0, sell/underweight when < 0, hold when |alpha| < 2 % a month)",
      },
      { key: `${k}.hitLow`, label: `${l}: hit rate, 95 % Wilson low`, value: g.hitLow * 100, unit: "%", formula: "Wilson score interval, z = 1.96" },
      { key: `${k}.hitHigh`, label: `${l}: hit rate, 95 % Wilson high`, value: g.hitHigh * 100, unit: "%", formula: "Wilson score interval, z = 1.96" },
      {
        key: `${k}.meanReturn`,
        label: `${l}: mean return`,
        value: Number(g.meanReturnPct.toPrecision(10)),
        unit: "%",
        formula: "mean of the symbol's return over the horizon",
      },
    );
    if (g.meanAlphaPct !== undefined)
      points.push({
        key: `${k}.meanAlpha`,
        label: `${l}: mean alpha`,
        value: Number(g.meanAlphaPct.toPrecision(10)),
        unit: "%",
        formula: "mean of return − benchmark return",
      });
    if (g.alphaLowPct !== undefined && g.alphaHighPct !== undefined)
      points.push(
        {
          key: `${k}.alphaLow`,
          label: `${l}: mean alpha, 95 % low`,
          value: Number(g.alphaLowPct.toPrecision(10)),
          unit: "%",
          formula: "mean − t(0.975, n−1) · s / √n",
        },
        {
          key: `${k}.alphaHigh`,
          label: `${l}: mean alpha, 95 % high`,
          value: Number(g.alphaHighPct.toPrecision(10)),
          unit: "%",
          formula: "mean + t(0.975, n−1) · s / √n",
        },
      );
  }
  const last = all.map((s) => s.endDate).sort()[all.length - 1];
  const ds: Dataset = {
    kind: "decision-quality",
    title: "Decision quality — the journal's settled calls by rating and horizon",
    points,
    provenance: { source: "journal", fetchedAt: clockNow().toISOString(), official: false, asOf: last },
    notes: [
      "A replay of recorded calls, never a simulated portfolio: decisions carry no sizes.",
      ...groups.filter((g) => g.n < 30).map((g) => `${g.rating} at +${g.horizon}: ${g.n} settled — the interval is wide; do not read a rate from so few`),
    ],
  };
  emitDatasets(args, [ds], asJson);
}

// --- strategy --------------------------------------------------------------------------------------

export async function strategyCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub, ref] = args.positional;
  switch (sub) {
    case "list": {
      const list = listStrategies();
      if (asJson) return void process.stdout.write(jsonLine(list));
      const lines = list.map((s) => `- ${s.name}${s.origin === "user" ? " (yours)" : ""}${s.valid ? "" : " — INVALID"}: ${s.description}`);
      process.stdout.write(`${list.length} strategies (built-in, and yours in ${userStrategyDir()}):\n${lines.join("\n")}\n`);
      return;
    }
    case "show": {
      if (!ref) throw new UsageError(STRATEGY_USAGE);
      const found = findStrategy(ref);
      if (!found) throw new UsageError(`no strategy "${ref}" — \`ultrastock strategy list\``);
      const v = validateStrategy(found.raw);
      const mapping = v.def
        ? Object.entries(v.def.indicators).map(([alias, raw]) => {
            const r = resolveIndicator(alias, raw);
            return typeof r === "string"
              ? { alias, error: r }
              : { alias, name: r.name, registry: r.info.name, params: r.params, fields: Object.fromEntries(r.fields), defaultField: r.defaultField };
          })
        : [];
      if (asJson)
        return void process.stdout.write(
          jsonLine({ origin: found.origin, strategy: found.raw, valid: v.valid, errors: v.errors, warnings: v.warnings, indicators: mapping }),
        );
      const ind = mapping.map((x) =>
        "error" in x
          ? `- ${x.alias}: ${x.error}`
          : `- ${x.alias}: ${x.name}${x.name !== x.registry ? ` → registry ${x.registry}` : ""} (${
              Object.entries(x.params)
                .map(([k, val]) => `${k}=${String(val)}`)
                .join(", ") || "defaults"
            }); a bare reference reads "${x.defaultField}"`,
      );
      process.stdout.write(
        `${JSON.stringify(found.raw, null, 2)}\n\norigin: ${found.origin}\n${v.valid ? "valid" : `INVALID:\n  - ${v.errors.join("\n  - ")}`}\n${v.warnings.map((w) => `warning: ${w}\n`).join("")}${ind.length ? `indicators:\n${ind.join("\n")}\n` : ""}`,
      );
      return;
    }
    case "validate": {
      if (!ref) throw new UsageError(STRATEGY_USAGE);
      let raw: unknown;
      try {
        raw = findStrategy(ref)?.raw;
      } catch (e) {
        throw new Error(`${ref}: not JSON (${(e as Error).message})`);
      }
      if (raw === undefined) throw new UsageError(`no strategy "${ref}"`);
      const v = validateStrategy(raw);
      if (asJson) process.stdout.write(jsonLine({ valid: v.valid, errors: v.errors, warnings: v.warnings }));
      else
        process.stdout.write(
          `${v.valid ? `${ref}: valid` : `${ref}: INVALID\n  - ${v.errors.join("\n  - ")}`}\n${v.warnings.map((w) => `warning: ${w}\n`).join("")}`,
        );
      if (!v.valid) throw new Error(`${ref}: ${v.errors.length} error(s)`);
      return;
    }
    case "new": {
      if (!ref || !/^[a-z][a-z0-9-]*$/.test(ref)) throw new UsageError("usage: ultrastock strategy new <kebab-case-name> [--like <strategy>]");
      const like = argValue(args, "like");
      const base = like ? findStrategy(like)?.raw : strategyTemplate(ref);
      if (!base) throw new UsageError(`no strategy "${like}" to start from`);
      const def = { ...(base as StrategyDef), name: ref };
      const dir = userStrategyDir();
      const path = join(dir, `${ref}.json`);
      if (existsSync(path)) throw new UsageError(`${path} already exists — edit it, or pick another name`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify(def, null, 2)}\n`);
      if (asJson) process.stdout.write(jsonLine({ path, strategy: def }));
      else process.stdout.write(`wrote ${path}\nedit it, then: ultrastock strategy validate ${ref} && ultrastock backtest run ${ref} <symbol>\n`);
      return;
    }
    default:
      throw new UsageError(STRATEGY_USAGE);
  }
}
