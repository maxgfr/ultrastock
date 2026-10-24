// Is the edge real? Each method answers one way a backtest fools its author:
//   - walk-forward: parameters chosen on a training window by a stated
//     objective, judged on the window after it, the out-of-sample pieces
//     stitched into one equity curve;
//   - combinatorially purged cross-validation (López de Prado, 2018): every
//     choice of k of N groups as the test set, training bars within `purge`
//     bars before a test group and `embargo` bars after it dropped, giving
//     several out-of-sample paths instead of one;
//   - probability of backtest overfitting by CSCV (Bailey, Borwein, López de
//     Prado & Zhu, 2015): how often the variant best in sample ranks in the
//     bottom half out of sample;
//   - a seeded bootstrap of the trades (the order of wins and losses was luck);
//   - a parameter sweep (the neighbourhood of the chosen parameters) and a
//     cost stress (×2 fees and slippage).
// Signals are computed once per variant on the full series — indicator values
// at bar i use bars ≤ i only — and simulations then run on index ranges.
import { computeIndicator } from "../analytics/indicators/index.js";
import { cagr, calmar, drawdowns, equityCurve, seededRandom, sharpe, sortino } from "../analytics/performance.js";
import { mean, quantile } from "../analytics/stats.js";
import type { Bar, Interval } from "../providers/types.js";
import { type Costs, type SimConfig, type SimResult, simulate } from "./simulate.js";
import { compileStrategy, paramValue, tunableParams, type Signals, type StrategyDef, withParam } from "./strategy.js";

/** At most this many variants per sweep (and per walk-forward, CPCV or PBO grid). */
export const MAX_RUNS = 500;

export interface Backtester {
  bars: readonly Bar[];
  interval: Interval;
  /** Everything but the strategy's own risk/execution rules, which `run` merges in. */
  base: Omit<SimConfig, "start" | "end" | "atr">;
  ppy: number;
  /** Risk overrides from the command line, applied over the strategy's. */
  riskOverride?: SimConfig["risk"];
  executionOverride?: SimConfig["execution"];
}

export interface Variant {
  params: Record<string, number>;
  def: StrategyDef;
  signals: Signals;
  atr?: Array<number | undefined>;
}

export function prepareVariant(bt: Backtester, def: StrategyDef, params: Record<string, number> = {}): Variant {
  let d = def;
  for (const [k, v] of Object.entries(params)) d = withParam(d, k, v);
  const signals = compileStrategy(d, bt.bars, bt.interval);
  const atrRule = { ...(d.risk ?? {}), ...(bt.riskOverride ?? {}) }.atrStop;
  const atr = atrRule ? computeIndicator("atr", bt.bars, { period: atrRule.period }).values.map((r) => r?.value) : undefined;
  return { params, def: d, signals, atr };
}

export function runVariant(bt: Backtester, v: Variant, range: { start?: number; end?: number } = {}, costs?: Costs): SimResult {
  return simulate(bt.bars, v.signals, {
    ...bt.base,
    costs: costs ?? bt.base.costs,
    risk: { ...(v.def.risk ?? {}), ...(bt.riskOverride ?? {}) },
    execution: { ...(v.def.execution ?? {}), ...(bt.executionOverride ?? {}) },
    atr: v.atr,
    ...range,
  });
}

// --- Objectives ------------------------------------------------------------------------

export const OBJECTIVES = ["sharpe", "sortino", "cagr", "calmar", "profit-factor"] as const;
export type Objective = (typeof OBJECTIVES)[number];

/** The number a variant is ranked by. Flat or undefined results rank last. */
export function objectiveOf(sim: SimResult, objective: Objective, ppy: number): number {
  const r = sim.returns;
  const finite = (x: number) => (Number.isFinite(x) ? x : Number.NEGATIVE_INFINITY);
  if (objective === "profit-factor") {
    const gp = sim.trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = -sim.trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    return gl > 0 ? gp / gl : gp > 0 ? 1e6 : Number.NEGATIVE_INFINITY;
  }
  return finite(objectiveOfReturns(r, objective, ppy));
}

/** The objective of a bare return series (CPCV and PBO rank subsets of bars, not trades). */
export function objectiveOfReturns(r: readonly number[], objective: Objective, ppy: number): number {
  if (r.length < 2) return Number.NEGATIVE_INFINITY;
  switch (objective) {
    case "sortino":
      return sortino(r, ppy);
    case "cagr":
      return cagr(equityCurve(r), ppy);
    case "calmar":
      return calmar(equityCurve(r), ppy);
    default:
      return sharpe(r, ppy);
  }
}

// --- Grids ------------------------------------------------------------------------------

export interface GridDim {
  path: string;
  values: number[];
}

/** "ema.period=10,20,30;risk.stopLossPct=5:15:5" → dimensions ("a:b:step" is an inclusive range). */
export function parseGrid(spec: string): GridDim[] {
  return spec
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 1) throw new Error(`grid "${part}": write alias.param=v1,v2 or alias.param=from:to:step`);
      const path = part.slice(0, eq).trim();
      const rhs = part.slice(eq + 1).trim();
      let values: number[];
      const range = /^(-?[\d.]+):(-?[\d.]+):([\d.]+)$/.exec(rhs);
      if (range) {
        const [a, b, st] = [Number(range[1]), Number(range[2]), Number(range[3])];
        if (!(st > 0) || b < a) throw new Error(`grid "${part}": from ≤ to and step > 0`);
        values = [];
        for (let v = a; v <= b + st * 1e-9; v += st) values.push(Number(v.toFixed(10)));
      } else values = rhs.split(",").map((v) => Number(v.trim()));
      if (!values.length || values.some((v) => !Number.isFinite(v))) throw new Error(`grid "${part}": values must be numbers`);
      if (!/^[a-zA-Z]+\.[a-zA-Z]+$/.test(path)) throw new Error(`grid "${part}": the parameter is alias.param or risk.key`);
      return { path, values: [...new Set(values)] };
    });
}

/** Every combination of the dimensions, refused beyond MAX_RUNS. */
export function expandGrid(dims: readonly GridDim[]): Array<Record<string, number>> {
  const total = dims.reduce((n, d) => n * d.values.length, 1);
  if (total > MAX_RUNS) throw new Error(`the grid has ${total} combinations — at most ${MAX_RUNS} runs; narrow a dimension`);
  let out: Array<Record<string, number>> = [{}];
  for (const d of dims) out = out.flatMap((c) => d.values.map((v) => ({ ...c, [d.path]: v })));
  return out;
}

/**
 * The default neighbourhood when no grid is given: the first three numeric
 * indicator parameters (periods first) at 75 %, 100 % and 125 % of their value
 * (periods rounded, ≥ 2) — 27 variants at most.
 */
export function defaultGrid(def: StrategyDef): GridDim[] {
  return tunableParams(def)
    .slice(0, 3)
    .map(({ path, value, integer }) => ({
      path,
      values: [...new Set([0.75, 1, 1.25].map((f) => (integer ? Math.max(2, Math.round(value * f)) : Number((value * f).toFixed(4)))))],
    }));
}

/** The strategy's own values of the grid's parameters (the "as written" variant). */
export function baseParams(def: StrategyDef, dims: readonly GridDim[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dims) {
    const v = paramValue(def, d.path);
    if (v !== undefined) out[d.path] = v;
  }
  return out;
}

// --- Sweep --------------------------------------------------------------------------------

export interface SweepRow {
  params: Record<string, number>;
  sharpe: number;
  cagr: number;
  maxDrawdown: number;
  trades: number;
  objective: number;
}

export function sweep(bt: Backtester, def: StrategyDef, combos: ReadonlyArray<Record<string, number>>, objective: Objective) {
  const variants = combos.map((c) => prepareVariant(bt, def, c));
  const sims = variants.map((v) => runVariant(bt, v));
  const rows: SweepRow[] = sims.map((s, i) => ({
    params: combos[i]!,
    sharpe: sharpe(s.returns, bt.ppy),
    cagr: cagr(equityCurve(s.returns), bt.ppy),
    maxDrawdown: drawdowns(equityCurve(s.returns)).maxDrawdown,
    trades: s.trades.length,
    objective: objectiveOf(s, objective, bt.ppy),
  }));
  return { variants, sims, rows };
}

// --- Walk-forward ------------------------------------------------------------------------------

export interface WalkForwardWindow {
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  chosen: Record<string, number>;
  isObjective: number;
  isSharpe: number;
  oosSharpe: number;
  oosReturnPct: number;
  oosTrades: number;
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  /** Stitched out-of-sample returns, bar by bar. */
  oosReturns: number[];
  oosDates: string[];
  oosTrades: SimResult["trades"];
  isSharpeMean: number;
  oosSharpe: number;
  /** OOS Sharpe over the mean in-sample Sharpe of the chosen variants. */
  efficiency: number;
  objective: Objective;
  anchored: boolean;
}

export function walkForward(
  bt: Backtester,
  def: StrategyDef,
  combos: ReadonlyArray<Record<string, number>>,
  opts: { train: number; test: number; anchored?: boolean; objective?: Objective },
): WalkForwardResult {
  const objective = opts.objective ?? "sharpe";
  const n = bt.bars.length;
  if (opts.train < 20 || opts.test < 5) throw new Error("walk-forward needs a training window ≥ 20 bars and a test window ≥ 5");
  if (opts.train + opts.test > n)
    throw new Error(`walk-forward needs ${opts.train + opts.test} bars (train ${opts.train} + test ${opts.test}); the series has ${n}`);
  const variants = (combos.length ? combos : [{}]).map((c) => prepareVariant(bt, def, c));
  const windows: WalkForwardWindow[] = [];
  const oosReturns: number[] = [];
  const oosDates: string[] = [];
  const oosTrades: SimResult["trades"] = [];
  for (let trainEnd = opts.train; trainEnd + Math.min(opts.test, 5) <= n; trainEnd += opts.test) {
    const trainStart = opts.anchored ? 0 : trainEnd - opts.train;
    const testEnd = Math.min(n, trainEnd + opts.test);
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestSim: SimResult | undefined;
    variants.forEach((v, i) => {
      const s = runVariant(bt, v, { start: trainStart, end: trainEnd });
      const score = objectiveOf(s, objective, bt.ppy);
      if (score > bestScore || !bestSim) {
        best = i;
        bestScore = score;
        bestSim = s;
      }
    });
    const test = runVariant(bt, variants[best]!, { start: trainEnd, end: testEnd });
    oosReturns.push(...test.returns);
    oosDates.push(...test.equity.map((e) => e.date));
    oosTrades.push(...test.trades);
    windows.push({
      trainFrom: bt.bars[trainStart]!.date,
      trainTo: bt.bars[trainEnd - 1]!.date,
      testFrom: bt.bars[trainEnd]!.date,
      testTo: bt.bars[testEnd - 1]!.date,
      chosen: variants[best]!.params,
      isObjective: bestScore,
      isSharpe: sharpe(bestSim!.returns, bt.ppy),
      oosSharpe: sharpe(test.returns, bt.ppy),
      oosReturnPct: (test.equity[test.equity.length - 1]!.equity / bt.base.capital - 1) * 100,
      oosTrades: test.trades.length,
    });
  }
  const isSharpes = windows.map((w) => w.isSharpe).filter(Number.isFinite);
  const isMean = isSharpes.length ? mean(isSharpes) : Number.NaN;
  const oos = sharpe(oosReturns, bt.ppy);
  return {
    windows,
    oosReturns,
    oosDates,
    oosTrades,
    isSharpeMean: isMean,
    oosSharpe: oos,
    efficiency: isMean > 0 && Number.isFinite(oos) ? oos / isMean : Number.NaN,
    objective,
    anchored: !!opts.anchored,
  };
}

// --- CPCV ----------------------------------------------------------------------------------------

/** All k-subsets of 0..n−1, in lexicographic order. */
export function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (from: number) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = from; i <= n - (k - cur.length); i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

export interface CpcvResult {
  groups: number;
  testGroups: number;
  purge: number;
  embargo: number;
  splits: number;
  /** Annualised Sharpe of each reassembled out-of-sample path. */
  pathSharpes: number[];
  meanPathSharpe: number;
  minPathSharpe: number;
  /** Share of paths with a positive Sharpe, %. */
  positivePathsPct: number;
  /** How often each variant was chosen on a training set. */
  chosenCounts: Record<string, number>;
}

/**
 * CPCV over per-variant return series (one full-series simulation per
 * variant). Each split chooses the best variant on its purged, embargoed
 * training bars; each test group then takes that variant's returns; the
 * C(N−1, k−1) appearances of each group make that many full paths.
 */
export function cpcv(
  returnsByVariant: ReadonlyArray<readonly number[]>,
  labels: readonly string[],
  ppy: number,
  opts: { groups?: number; testGroups?: number; purge?: number; embargo?: number; objective?: Objective } = {},
): CpcvResult {
  const T = returnsByVariant[0]?.length ?? 0;
  const N = opts.groups ?? 6;
  const k = opts.testGroups ?? 2;
  if (k < 1 || k >= N) throw new Error("CPCV needs 1 ≤ test groups < groups");
  if (T < N * 10) throw new Error(`CPCV with ${N} groups needs at least ${N * 10} bars; the series has ${T}`);
  const purge = opts.purge ?? 5;
  const embargo = opts.embargo ?? Math.ceil(T * 0.01);
  const bounds = Array.from({ length: N }, (_, g) => [Math.floor((g * T) / N), Math.floor(((g + 1) * T) / N)] as const);
  const objective = opts.objective === "profit-factor" ? "sharpe" : (opts.objective ?? "sharpe");
  const splits = combinations(N, k);
  const chosenBySplit: number[] = [];
  const chosenCounts: Record<string, number> = {};
  for (const test of splits) {
    const excluded = new Uint8Array(T);
    for (const g of test) {
      const [a, b] = bounds[g]!;
      for (let i = Math.max(0, a - purge); i < Math.min(T, b + embargo); i++) excluded[i] = 1;
    }
    const trainIdx: number[] = [];
    for (let i = 0; i < T; i++) if (!excluded[i]) trainIdx.push(i);
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    returnsByVariant.forEach((r, v) => {
      const s = objectiveOfReturns(
        trainIdx.map((i) => r[i]!),
        objective,
        ppy,
      );
      if (s > bestScore) {
        bestScore = s;
        best = v;
      }
    });
    chosenBySplit.push(best);
    const label = labels[best] ?? String(best);
    chosenCounts[label] = (chosenCounts[label] ?? 0) + 1;
  }
  // Path p of group g uses the p-th split (in order) that tests g.
  const nPaths = combinations(N - 1, k - 1).length;
  const paths: number[][] = Array.from({ length: nPaths }, () => []);
  for (let g = 0; g < N; g++) {
    const using = splits.map((s, i) => (s.includes(g) ? i : -1)).filter((i) => i >= 0);
    using.forEach((splitIdx, p) => {
      const [a, b] = bounds[g]!;
      const r = returnsByVariant[chosenBySplit[splitIdx]!]!;
      for (let i = a; i < b; i++) paths[p]!.push(r[i]!);
    });
  }
  const pathSharpes = paths.map((p) => sharpe(p, ppy)).map((x) => (Number.isFinite(x) ? x : 0));
  return {
    groups: N,
    testGroups: k,
    purge,
    embargo,
    splits: splits.length,
    pathSharpes,
    meanPathSharpe: mean(pathSharpes),
    minPathSharpe: Math.min(...pathSharpes),
    positivePathsPct: (pathSharpes.filter((s) => s > 0).length / pathSharpes.length) * 100,
    chosenCounts,
  };
}

// --- PBO by CSCV ------------------------------------------------------------------------------------

export interface PboResult {
  /** Probability of backtest overfitting: share of splits where the in-sample best ranks at or below the out-of-sample median. */
  pbo: number;
  blocks: number;
  splits: number;
  variants: number;
  /** Median logit of the best variant's out-of-sample relative rank (negative = overfit). */
  medianLogit: number;
}

/**
 * CSCV: cut the T × N matrix of per-bar returns into S blocks; for every half
 * of the blocks as in-sample (C(S, S/2) splits), take the variant with the best
 * in-sample Sharpe and its relative rank ω among the N out of sample; PBO is
 * the share of splits with logit(ω) ≤ 0.
 */
export function pbo(returnsByVariant: ReadonlyArray<readonly number[]>, opts: { blocks?: number } = {}): PboResult | undefined {
  const N = returnsByVariant.length;
  const T = returnsByVariant[0]?.length ?? 0;
  if (N < 2) return undefined;
  // Variants with identical returns cannot be ranked against each other.
  const distinct = new Set(returnsByVariant.map((r) => r.join(","))).size;
  if (distinct < 2) return undefined;
  let S = opts.blocks ?? 16;
  S = Math.min(S, Math.floor(T / 10));
  if (S % 2) S--;
  if (S < 4) return undefined;
  const sums = returnsByVariant.map((r) =>
    Array.from({ length: S }, (_, b) => {
      const a = Math.floor((b * T) / S);
      const e = Math.floor(((b + 1) * T) / S);
      let s = 0;
      let q = 0;
      for (let i = a; i < e; i++) {
        s += r[i]!;
        q += r[i]! * r[i]!;
      }
      return { s, q, n: e - a };
    }),
  );
  const sr = (v: number, blocks: readonly number[]) => {
    let s = 0;
    let q = 0;
    let n = 0;
    for (const b of blocks) {
      const x = sums[v]![b]!;
      s += x.s;
      q += x.q;
      n += x.n;
    }
    const m = s / n;
    const vr = (q - n * m * m) / (n - 1);
    return vr > 0 ? m / Math.sqrt(vr) : 0;
  };
  const logits: number[] = [];
  for (const is of combinations(S, S / 2)) {
    const oos = Array.from({ length: S }, (_, b) => b).filter((b) => !is.includes(b));
    let best = 0;
    let bestSr = Number.NEGATIVE_INFINITY;
    for (let v = 0; v < N; v++) {
      const x = sr(v, is);
      if (x > bestSr) {
        bestSr = x;
        best = v;
      }
    }
    const oosSr = Array.from({ length: N }, (_, v) => sr(v, oos));
    const target = oosSr[best]!;
    // Relative rank in (0, 1): 1-based rank of the chosen variant among N, ties at their mean rank.
    const below = oosSr.filter((x) => x < target).length;
    const equal = oosSr.filter((x) => x === target).length;
    const omega = (below + (equal + 1) / 2) / (N + 1);
    logits.push(Math.log(omega / (1 - omega)));
  }
  // A logit of exactly 0 (the chosen variant at the median, ties included) counts half.
  const overfit = logits.filter((l) => l < -1e-12).length + 0.5 * logits.filter((l) => Math.abs(l) <= 1e-12).length;
  return { pbo: overfit / logits.length, blocks: S, splits: logits.length, variants: N, medianLogit: quantile(logits, 0.5) };
}

// --- Monte Carlo ---------------------------------------------------------------------------------------

export interface MonteCarloResult {
  paths: number;
  seed: number;
  trades: number;
  /** Percentiles of the total return, %. */
  finalReturnPct: { p5: number; p25: number; p50: number; p75: number; p95: number };
  /** Percentiles of the maximum drawdown, % (negative). */
  maxDrawdownPct: { p5: number; p25: number; p50: number; p75: number; p95: number };
  /** Share of paths ending below the starting capital, %. */
  lossProbabilityPct: number;
  /** Share of paths with a drawdown of 50 % or worse, %. */
  ruinProbabilityPct: number;
}

/**
 * Bootstrap the trades (with replacement, seeded): each path draws as many
 * trades as the backtest made and compounds their returns on equity. The
 * drawdown is measured trade to trade, so it understates the intra-trade one.
 */
export function monteCarlo(tradeReturnsPct: readonly number[], paths = 5000, seed = 42): MonteCarloResult | undefined {
  const n = tradeReturnsPct.length;
  if (!n) return undefined;
  const rnd = seededRandom(seed);
  const finals: number[] = [];
  const dds: number[] = [];
  for (let p = 0; p < paths; p++) {
    let eq = 1;
    let peak = 1;
    let dd = 0;
    for (let i = 0; i < n; i++) {
      eq *= Math.max(0, 1 + tradeReturnsPct[Math.floor(rnd() * n)]! / 100);
      peak = Math.max(peak, eq);
      dd = Math.min(dd, peak > 0 ? eq / peak - 1 : -1);
    }
    finals.push((eq - 1) * 100);
    dds.push(dd * 100);
  }
  const pct = (xs: number[]) => ({ p5: quantile(xs, 0.05), p25: quantile(xs, 0.25), p50: quantile(xs, 0.5), p75: quantile(xs, 0.75), p95: quantile(xs, 0.95) });
  return {
    paths,
    seed,
    trades: n,
    finalReturnPct: pct(finals),
    maxDrawdownPct: pct(dds),
    lossProbabilityPct: (finals.filter((f) => f < 0).length / paths) * 100,
    ruinProbabilityPct: (dds.filter((d) => d <= -50).length / paths) * 100,
  };
}

/** Costs multiplied (fees and slippage; funding is the market's, not stressed). */
export function stressCosts(c: Costs, factor = 2): Costs {
  return { makerPct: c.makerPct * factor, takerPct: c.takerPct * factor, slippagePct: c.slippagePct * factor };
}
