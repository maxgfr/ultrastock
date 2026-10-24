// Orchestration: load a market (bars, benchmark, funding), run a strategy or
// an allocation through the simulator and the validators, and turn every
// figure into a Dataset point whose provenance is the price series' and whose
// formula says how it was computed (the src/analyze/pack.ts pattern). The run
// directory then holds evidence.json, BACKTEST.md, equity.json, trades.json,
// bars.json (the HTML report charts it) and the validators' detail.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { drawdowns, performanceSummary } from "../analytics/performance.js";
import { defaultBenchmark } from "../analyze/technicals.js";
import { type Dataset, formatDatasets, type Point, registerDatasets } from "../core/datasets.js";
import { EvidenceStore } from "../core/evidence.js";
import { mapLimit, writeArtifact } from "../engine.js";
import type { Bar, Instrument, Interval, PriceSeries } from "../providers/types.js";
import { type Allocation, alignBars, allocationBacktest } from "./allocation.js";
import { fundingHistory, loadBars } from "./data.js";
import { buyAndHold, deflatedSharpeOf, periodSharpe, periodsPerYear, residualAlpha, type Summary, summarize, type TradeStats, tradeStats } from "./metrics.js";
import { type Review, reviewScorecard } from "./review.js";
import type { Costs, FundingEvent, SimResult } from "./simulate.js";
import type { ExecutionRules, RiskRules, StrategyDef } from "./strategy.js";
import {
  type Backtester,
  cpcv,
  defaultGrid,
  expandGrid,
  type GridDim,
  monteCarlo,
  type Objective,
  pbo,
  prepareVariant,
  runVariant,
  stressCosts,
  sweep,
  walkForward,
} from "./validation.js";

/** At most this many symbols in one allocation backtest (fetched 4 at a time). */
export const MAX_PORTFOLIO_SYMBOLS = 12;

export interface MarketOptions {
  from: Date;
  to: Date;
  interval: Interval;
  capital: number;
  costs?: Partial<Costs>;
  leverage?: number;
  /** Treat a crypto symbol as its USDT-M perpetual (funding) even unlevered. */
  perp?: boolean;
  /** Benchmark symbol; null for none; undefined for the market's default. */
  benchmark?: string | null;
  universe?: string;
}

export interface Market {
  symbol: string;
  instrument: Instrument;
  series: PriceSeries;
  bars: Bar[];
  interval: Interval;
  crypto: boolean;
  ppy: number;
  capital: number;
  costs: Costs;
  leverage: number;
  perp: boolean;
  funding?: { events: FundingEvent[]; url: string; fetchedAt: string; pair: string };
  benchmark?: { symbol: string; series: PriceSeries };
  universe?: string;
  notes: string[];
}

/**
 * Default costs, percent per side. Crypto spot: Binance's 0.1 % maker and
 * taker; perpetuals: 0.02 % maker, 0.05 % taker (USDT-M, regular tier);
 * listed securities: 0.1 % either way (a typical online broker); slippage
 * 0.05 % on every market order.
 */
export function defaultCosts(crypto: boolean, perp: boolean): Costs {
  if (crypto && perp) return { makerPct: 0.02, takerPct: 0.05, slippagePct: 0.05 };
  if (crypto) return { makerPct: 0.1, takerPct: 0.1, slippagePct: 0.05 };
  return { makerPct: 0.1, takerPct: 0.1, slippagePct: 0.05 };
}

export async function loadMarket(symbol: string, opts: MarketOptions, def?: StrategyDef): Promise<Market> {
  const { resolved, series } = await loadBars(symbol, { from: opts.from, to: opts.to, interval: opts.interval });
  const inst = resolved.instrument;
  const crypto = inst.market === "crypto";
  const notes = [...series.notes];
  let leverage = opts.leverage ?? def?.leverage ?? 1;
  if (!crypto && leverage > 1) {
    notes.push(`leverage ${leverage}× ignored: listed securities are backtested as a cash account (1×)`);
    leverage = 1;
  }
  const perp = crypto && (leverage > 1 || !!opts.perp || !!def?.short);
  const costs = { ...defaultCosts(crypto, perp), ...(opts.costs ?? {}) };
  let funding: Market["funding"];
  if (perp) {
    try {
      funding = await fundingHistory(inst.symbol, opts.from, opts.to);
      notes.push(`funding: ${funding.events.length} settlements of the ${funding.pair} perpetual (Binance USDT-M history)`);
    } catch (e) {
      notes.push(`funding history unavailable (${(e as Error).message}) — the perpetual is simulated without funding`);
    }
  }
  let benchmark: Market["benchmark"];
  const benchSym =
    opts.benchmark === null
      ? undefined
      : (opts.benchmark ?? (crypto ? (inst.symbol.startsWith("BTC") ? undefined : "BTCUSDT") : defaultBenchmark(inst.market, inst.mic)));
  if (benchSym) {
    try {
      benchmark = { symbol: benchSym, series: (await loadBars(benchSym, { from: opts.from, to: opts.to, interval: opts.interval })).series };
    } catch (e) {
      notes.push(`benchmark ${benchSym} unavailable (${(e as Error).message}) — no residual alpha`);
    }
  }
  if (series.bars.length < 50) throw new Error(`only ${series.bars.length} bars for ${inst.symbol} in the window — a backtest needs at least 50`);
  return {
    symbol: inst.symbol,
    instrument: inst,
    series,
    bars: series.bars,
    interval: opts.interval,
    crypto,
    ppy: periodsPerYear(series.bars, crypto),
    capital: opts.capital,
    costs,
    leverage,
    perp,
    funding,
    benchmark,
    universe: opts.universe,
    notes,
  };
}

export function backtesterFor(m: Market, def: StrategyDef, overrides: { risk?: RiskRules; execution?: ExecutionRules } = {}): Backtester {
  return {
    bars: m.bars,
    interval: m.interval,
    ppy: m.ppy,
    base: {
      capital: m.capital,
      costs: m.costs,
      leverage: m.leverage,
      allowShort: !!def.short,
      liquidation: m.perp && m.leverage > 1,
      funding: m.funding?.events,
    },
    riskOverride: overrides.risk,
    executionOverride: overrides.execution,
  };
}

// --- Points -------------------------------------------------------------------------------------

class PointList {
  readonly points: Point[] = [];
  readonly skipped: string[] = [];
  constructor(private readonly prefix: string) {}
  add(key: string, label: string, value: number | string | undefined, unit: string | undefined, formula: string): void {
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      this.skipped.push(`${label}: undefined for this run`);
      return;
    }
    this.points.push({ key: `${this.prefix}.${key}`, label, value: typeof value === "number" ? Number(value.toPrecision(10)) : value, unit, formula });
  }
}

const pct = (x: number) => x * 100;
const costText = (c: Costs) => `maker ${c.makerPct} %, taker ${c.takerPct} %, slippage ${c.slippagePct} % per side`;
const FILLS = "signals on closed bars, filled at the next open; stops gap to the open; stop before target inside a bar";

function provenanceOf(m: Market) {
  return { ...m.series.provenance, asOf: m.bars[m.bars.length - 1]!.date };
}

function performancePoints(P: PointList, s: Summary, label: string, ccy: string, basis: string): void {
  P.add("cagr", `${label} CAGR`, pct(s.cagr), "%", `(final / initial)^(1 / years) − 1 of the ${basis}`);
  P.add("totalReturn", `${label} total return`, pct(s.totalReturn), "%", `final equity / initial − 1 (${basis})`);
  P.add("finalEquity", `${label} final equity`, s.finalEquity, ccy, `mark-to-market equity at the last close (${basis})`);
  P.add("volatility", `${label} annualised volatility`, pct(s.volatility), "%", "stdev of per-bar returns × √(periods per year)");
  P.add("sharpe", `${label} Sharpe ratio`, s.sharpe, "ratio", "mean / stdev of per-bar returns × √(periods per year), risk-free 0");
  P.add("sortino", `${label} Sortino ratio`, s.sortino, "ratio", "mean / downside deviation × √(periods per year), target 0");
  P.add("maxDrawdown", `${label} maximum drawdown`, pct(s.maxDrawdown), "%", "worst peak-to-trough of the equity curve");
  P.add("calmar", `${label} Calmar ratio`, s.calmar, "ratio", "CAGR / |maximum drawdown|");
  P.add("ulcer", `${label} Ulcer index`, s.ulcer, "index", "root mean square of percentage drawdowns (Martin)");
  P.add("omega", `${label} Omega ratio`, s.omega, "ratio", "sum of per-bar gains over sum of per-bar losses, threshold 0");
  P.add("var95", `${label} 1-bar historical VaR 95 %`, pct(s.var95), "%", "−5th percentile of per-bar returns");
  P.add("cvar95", `${label} 1-bar expected shortfall 95 %`, pct(s.cvar95), "%", "−mean of per-bar returns at or below the 5th percentile");
  P.add(
    "psr",
    `${label} probabilistic Sharpe ratio`,
    s.probabilisticSharpe,
    "ratio",
    "P(true Sharpe > 0) given T, skewness and kurtosis (Bailey & López de Prado 2012)",
  );
  P.add("longestUnderwater", `${label} longest stretch under a previous peak`, s.longestUnderwater, "bars", "bars between a peak and its recovery, longest");
}

function tradePoints(P: PointList, t: TradeStats, label: string, ccy: string): void {
  P.add("trades", `${label} closed trades`, t.trades, "count", "positions opened and closed in the window (open ones closed at the last bar)");
  P.add("winRate", `${label} win rate`, t.winRate, "%", "trades with a positive net P&L / trades");
  P.add(
    "profitFactor",
    `${label} profit factor`,
    Number.isFinite(t.profitFactor) ? t.profitFactor : t.trades ? "no losing trade" : undefined,
    Number.isFinite(t.profitFactor) ? "ratio" : undefined,
    "gross profit / gross loss",
  );
  P.add("expectancy", `${label} expectancy per trade`, t.expectancy, ccy, "net profit / trades");
  P.add("expectancyR", `${label} expectancy in R`, t.expectancyR, "R", "mean of net P&L / money at risk to the initial stop");
  P.add("avgHoldBars", `${label} average holding`, t.avgHoldBars, "bars", "mean of exit bar − entry bar");
  P.add("exposure", `${label} exposure`, t.exposurePct, "%", "bars with a position open at the close / bars");
  P.add("avgMae", `${label} average adverse excursion`, t.avgMaePct, "%", "mean worst move against the entry while held (MAE)");
  P.add("avgMfe", `${label} average favourable excursion`, t.avgMfePct, "%", "mean best move for the entry while held (MFE)");
  P.add("fees", `${label} fees paid`, t.fees, ccy, "Σ fees: taker on market orders, maker on limits");
  P.add("funding", `${label} funding paid`, t.funding, ccy, "Σ rate × notional at each 8 h settlement held (perpetuals only; negative = received)");
  P.add("netProfit", `${label} net profit`, t.netProfit, ccy, "Σ trade P&L net of fees and funding");
  P.add("largestWinShare", `${label} largest trade / net profit`, t.largestWinSharePct, "%", "best trade's net P&L / total net P&L");
  P.add("maxConsecutiveLosses", `${label} longest losing streak`, t.maxConsecutiveLosses, "count", "most consecutive losing trades");
}

// --- A strategy on one symbol ---------------------------------------------------------------------

export interface StrategyReport {
  market: Market;
  def: StrategyDef;
  sim: SimResult;
  summary: Summary;
  stats: TradeStats;
  stressed: { summary: Summary; stats: TradeStats; costs: Costs };
  buyHold: { summary: ReturnType<typeof performanceSummary>; totalReturn: number };
  alpha?: ReturnType<typeof residualAlpha>;
  benchTotalReturn?: number;
  params: Record<string, Record<string, number | string>>;
  datasets: Dataset[];
}

export function strategyBacktest(m: Market, def: StrategyDef, overrides: { risk?: RiskRules; execution?: ExecutionRules } = {}): StrategyReport {
  const bt = backtesterFor(m, def, overrides);
  const v = prepareVariant(bt, def);
  const sim = runVariant(bt, v);
  const summary = summarize(sim, m.ppy, m.capital);
  const stats = tradeStats(sim);
  const sCosts = stressCosts(m.costs, 2);
  const sSim = runVariant(bt, v, {}, sCosts);
  const stressed = { summary: summarize(sSim, m.ppy, m.capital), stats: tradeStats(sSim), costs: sCosts };
  const bh = buyAndHold(m.bars, m.costs);
  const buyHold = { summary: performanceSummary(bh.returns, m.ppy), totalReturn: bh.totalReturn };
  const dates = sim.equity.map((e) => e.date);
  const alpha = m.benchmark ? residualAlpha(dates, sim.returns, m.benchmark.series.bars, m.ppy) : undefined;
  const bb = m.benchmark?.series.bars;
  const benchTotalReturn = bb?.length ? bb[bb.length - 1]!.close / bb[0]!.close - 1 : undefined;
  const ccy = m.instrument.currency;
  const name = def.name;
  const P = new PointList(`${m.symbol}.bt.${name}`);
  const basis = `daily mark-to-market equity of ${name} on ${m.symbol}, ${FILLS}, ${costText(m.costs)}`;
  P.add(
    "bars",
    `${name} on ${m.symbol}: bars simulated`,
    m.bars.length,
    "count",
    `${m.interval} bars from ${m.bars[0]!.date} to ${m.bars[m.bars.length - 1]!.date}`,
  );
  P.add("years", `${name} on ${m.symbol}: years simulated`, summary.years, "years", "bars / periods per year");
  performancePoints(P, summary, `${name} on ${m.symbol}`, ccy, basis);
  tradePoints(P, stats, `${name} on ${m.symbol}`, ccy);
  P.add("liquidations", `${name} on ${m.symbol}: liquidations`, sim.liquidations, "count", "positions closed at the maintenance margin (leverage > 1)");
  P.add(
    "bh.totalReturn",
    `Buy-and-hold ${m.symbol} total return`,
    pct(buyHold.totalReturn),
    "%",
    "bought at the first open, sold at the last close, taker fee and slippage both ways",
  );
  P.add("bh.cagr", `Buy-and-hold ${m.symbol} CAGR`, pct(buyHold.summary.cagr), "%", "(final / initial)^(1 / years) − 1");
  P.add("bh.sharpe", `Buy-and-hold ${m.symbol} Sharpe ratio`, buyHold.summary.sharpe, "ratio", "annualised per-bar Sharpe, risk-free 0");
  P.add("bh.maxDrawdown", `Buy-and-hold ${m.symbol} maximum drawdown`, pct(buyHold.summary.maxDrawdown), "%", "worst peak-to-trough");
  P.add(
    "excessReturn",
    `${name} total return minus buy-and-hold`,
    pct(summary.totalReturn - buyHold.totalReturn),
    "pp",
    "strategy total return − buy-and-hold total return",
  );
  P.add("x2.totalReturn", `${name} total return at ×2 costs`, pct(stressed.summary.totalReturn), "%", `same signals, ${costText(sCosts)}`);
  P.add("x2.netProfit", `${name} net profit at ×2 costs`, stressed.stats.netProfit, ccy, `Σ trade P&L, ${costText(sCosts)}`);
  P.add("x2.sharpe", `${name} Sharpe at ×2 costs`, stressed.summary.sharpe, "ratio", "annualised per-bar Sharpe with doubled fees and slippage");
  const datasets: Dataset[] = [
    {
      kind: "backtest",
      title: `${name} on ${m.symbol} — backtest (${m.interval}, ${m.bars[0]!.date} → ${m.bars[m.bars.length - 1]!.date})`,
      subject: m.symbol,
      points: P.points,
      provenance: provenanceOf(m),
      notes: [
        ...m.notes,
        `fills: ${FILLS}`,
        `costs: ${costText(m.costs)}`,
        ...(sim.breakerTrippedAt ? [`circuit breaker tripped on ${sim.breakerTrippedAt}`] : []),
        ...P.skipped,
      ],
    },
  ];
  if (m.benchmark) {
    const B = new PointList(`${m.symbol}.bt.${name}.vs.${m.benchmark.symbol}`);
    B.add(
      "benchTotalReturn",
      `${m.benchmark.symbol} total return over the window`,
      benchTotalReturn === undefined ? undefined : pct(benchTotalReturn),
      "%",
      "last close / first close − 1",
    );
    if (alpha) {
      B.add(
        "alpha",
        `${name} residual alpha vs ${m.benchmark.symbol} (annualised)`,
        alpha.alphaPct,
        "%",
        "OLS intercept of per-bar strategy returns on benchmark returns × periods per year",
      );
      B.add("alphaT", `${name} alpha t-stat (Newey–West)`, alpha.alphaT, "t", `intercept / HAC standard error, ${alpha.hacLags} lags, ${alpha.n} aligned bars`);
      B.add("beta", `${name} beta to ${m.benchmark.symbol}`, alpha.beta, "ratio", "OLS slope of strategy returns on benchmark returns");
      B.add("r2", `${name} R² against ${m.benchmark.symbol}`, alpha.r2, "ratio", "share of the strategy's variance the benchmark explains");
    }
    const bp = m.benchmark.series.provenance;
    datasets.push({
      kind: "backtest-relative",
      title: `${name} on ${m.symbol} against ${m.benchmark.symbol}`,
      subject: m.symbol,
      points: B.points,
      provenance: {
        ...m.series.provenance,
        source: `${m.series.provenance.source}+${bp.source}`,
        official: m.series.provenance.official && bp.official,
        fetchedAt: [m.series.provenance.fetchedAt, bp.fetchedAt].sort()[0]!,
        asOf: m.bars[m.bars.length - 1]!.date,
      },
      notes: [...m.benchmark.series.notes, ...B.skipped, ...(alpha ? [] : ["fewer than 30 aligned bars: no regression"])],
    });
  }
  return { market: m, def, sim, summary, stats, stressed, buyHold, alpha, benchTotalReturn, params: v.signals.params, datasets };
}

// --- Validation runs ----------------------------------------------------------------------------------

export interface SweepReport {
  dims: GridDim[];
  rows: ReturnType<typeof sweep>["rows"];
  best: { params: Record<string, number>; objective: number; sharpe: number };
  dsr: number;
  nTrials: number;
  pbo?: ReturnType<typeof pbo>;
  cpcv?: ReturnType<typeof cpcv>;
  medianSharpe: number;
  positiveSharePct: number;
  /** Per-period Sharpe of every variant (0 for a flat one), for deflation. */
  variantSharpes: number[];
  dataset: Dataset;
  notes: string[];
}

export function sweepReport(
  m: Market,
  def: StrategyDef,
  dims: GridDim[],
  objective: Objective,
  opts: {
    trials?: number;
    groups?: number;
    testGroups?: number;
    purge?: number;
    embargo?: number;
    overrides?: { risk?: RiskRules; execution?: ExecutionRules };
  } = {},
): SweepReport {
  const bt = backtesterFor(m, def, opts.overrides);
  const combos = dims.length ? expandGrid(dims) : [{}];
  const { sims, rows } = sweep(bt, def, combos, objective);
  const notes: string[] = [];
  let bi = 0;
  rows.forEach((r, i) => {
    if (r.objective > rows[bi]!.objective) bi = i;
  });
  const sharpes = sims.map((s) => periodSharpe(s.returns));
  const nTrials = combos.length + (opts.trials ?? 0);
  const dsr = deflatedSharpeOf(sims[bi]!.returns, sharpes, nTrials);
  const returns = sims.map((s) => s.returns);
  const labels = combos.map(
    (c) =>
      Object.entries(c)
        .map(([k, v]) => `${k}=${v}`)
        .join(",") || "as written",
  );
  let pboR: ReturnType<typeof pbo>;
  let cpcvR: ReturnType<typeof cpcv> | undefined;
  if (combos.length >= 2) {
    pboR = pbo(returns);
    if (!pboR) notes.push("PBO not computed: it needs at least 40 bars and variants whose returns differ");
    try {
      cpcvR = cpcv(returns, labels, m.ppy, { groups: opts.groups, testGroups: opts.testGroups, purge: opts.purge, embargo: opts.embargo, objective });
    } catch (e) {
      notes.push(`CPCV skipped: ${(e as Error).message}`);
    }
  } else notes.push("a single variant: no PBO or CPCV (give --grid)");
  const sorted = [...rows.map((r) => r.sharpe).filter(Number.isFinite)].sort((a, b) => a - b);
  const medianSharpe = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : Number.NaN;
  const positiveSharePct = (rows.filter((r) => r.sharpe > 0).length / rows.length) * 100;
  const P = new PointList(`${m.symbol}.bt.${def.name}.sweep`);
  P.add(
    "variants",
    `${def.name} on ${m.symbol}: variants swept`,
    combos.length,
    "count",
    dims.map((d) => `${d.path} ∈ {${d.values.join(", ")}}`).join(" × ") || "as written",
  );
  P.add("trials", `${def.name}: trials counted for deflation`, nTrials, "count", "variants swept + --trials declared beforehand");
  P.add("best", `${def.name}: best variant by ${objective}`, labels[bi]!, undefined, `argmax ${objective} over the grid`);
  P.add("bestSharpe", `${def.name}: best variant's Sharpe`, rows[bi]!.sharpe, "ratio", "annualised per-bar Sharpe of the best variant");
  P.add("medianSharpe", `${def.name}: median variant Sharpe`, medianSharpe, "ratio", "median annualised Sharpe across the grid (sensitivity)");
  P.add("positiveShare", `${def.name}: variants with a positive Sharpe`, positiveSharePct, "%", "variants with Sharpe > 0 / variants");
  P.add(
    "dsr",
    `${def.name}: deflated Sharpe ratio of the best variant`,
    dsr,
    "ratio",
    `PSR against E[max Sharpe] of ${nTrials} skill-less trials (Bailey & López de Prado 2014)`,
  );
  if (pboR)
    P.add(
      "pbo",
      `${def.name}: probability of backtest overfitting`,
      pboR.pbo,
      "ratio",
      `CSCV over ${pboR.blocks} blocks, ${pboR.splits} splits, ${pboR.variants} variants (Bailey et al. 2015)`,
    );
  if (cpcvR) {
    P.add(
      "cpcv.paths",
      `${def.name}: CPCV out-of-sample paths`,
      cpcvR.pathSharpes.length,
      "count",
      `N=${cpcvR.groups} groups, k=${cpcvR.testGroups} test groups, purge ${cpcvR.purge}, embargo ${cpcvR.embargo} bars`,
    );
    P.add("cpcv.meanSharpe", `${def.name}: CPCV mean path Sharpe`, cpcvR.meanPathSharpe, "ratio", "mean annualised Sharpe of the reassembled OOS paths");
    P.add("cpcv.minSharpe", `${def.name}: CPCV worst path Sharpe`, cpcvR.minPathSharpe, "ratio", "minimum annualised Sharpe over the OOS paths");
    P.add("cpcv.positivePaths", `${def.name}: CPCV paths with a positive Sharpe`, cpcvR.positivePathsPct, "%", "paths with Sharpe > 0 / paths");
  }
  return {
    dims,
    rows,
    best: { params: combos[bi]!, objective: rows[bi]!.objective, sharpe: rows[bi]!.sharpe },
    dsr,
    nTrials,
    pbo: pboR,
    cpcv: cpcvR,
    medianSharpe,
    positiveSharePct,
    variantSharpes: sharpes,
    notes,
    dataset: {
      kind: "backtest-sweep",
      title: `${def.name} on ${m.symbol} — parameter sweep, deflated Sharpe, PBO and CPCV`,
      subject: m.symbol,
      points: P.points,
      provenance: provenanceOf(m),
      notes: [...notes, ...P.skipped],
    },
  };
}

export interface WalkForwardReport {
  wf: ReturnType<typeof walkForward>;
  summary: ReturnType<typeof performanceSummary>;
  dataset: Dataset;
}

/** Train/test windows in bars: ~2 years / ~6 months by default. */
export function defaultWindows(m: Market): { train: number; test: number } {
  const year = m.ppy;
  let train = Math.round(2 * year);
  let test = Math.round(year / 2);
  if (train + test > m.bars.length) {
    train = Math.floor(m.bars.length * 0.6);
    test = Math.max(5, Math.floor(m.bars.length * 0.2));
  }
  return { train, test };
}

export function walkForwardReport(
  m: Market,
  def: StrategyDef,
  dims: GridDim[],
  opts: { train?: number; test?: number; anchored?: boolean; objective: Objective; overrides?: { risk?: RiskRules; execution?: ExecutionRules } },
): WalkForwardReport {
  const bt = backtesterFor(m, def, opts.overrides);
  const w = defaultWindows(m);
  const combos = dims.length ? expandGrid(dims) : [{}];
  const wf = walkForward(bt, def, combos, { train: opts.train ?? w.train, test: opts.test ?? w.test, anchored: opts.anchored, objective: opts.objective });
  const summary = performanceSummary(wf.oosReturns, m.ppy);
  const P = new PointList(`${m.symbol}.bt.${def.name}.wf`);
  const how = `${wf.anchored ? "anchored" : "rolling"} windows of ${opts.train ?? w.train} train / ${opts.test ?? w.test} test bars, ${combos.length} variant(s) chosen by ${wf.objective}`;
  P.add("windows", `${def.name} on ${m.symbol}: walk-forward windows`, wf.windows.length, "count", how);
  P.add("oosSharpe", `${def.name}: walk-forward out-of-sample Sharpe`, wf.oosSharpe, "ratio", "annualised Sharpe of the stitched out-of-sample returns");
  P.add("isSharpe", `${def.name}: mean in-sample Sharpe of the chosen variants`, wf.isSharpeMean, "ratio", "mean over windows of the training-window Sharpe");
  P.add(
    "efficiency",
    `${def.name}: walk-forward efficiency`,
    Number.isFinite(wf.efficiency) ? wf.efficiency * 100 : undefined,
    "%",
    "OOS Sharpe / mean IS Sharpe",
  );
  P.add("oosCagr", `${def.name}: out-of-sample CAGR`, pct(summary.cagr), "%", "CAGR of the stitched out-of-sample equity");
  P.add("oosMaxDrawdown", `${def.name}: out-of-sample maximum drawdown`, pct(summary.maxDrawdown), "%", "worst peak-to-trough of the stitched OOS equity");
  P.add("oosTrades", `${def.name}: out-of-sample trades`, wf.oosTrades.length, "count", "trades opened and closed inside the test windows");
  return {
    wf,
    summary,
    dataset: {
      kind: "backtest-walkforward",
      title: `${def.name} on ${m.symbol} — walk-forward (${how})`,
      subject: m.symbol,
      points: P.points,
      provenance: provenanceOf(m),
      notes: P.skipped,
    },
  };
}

export function monteCarloDataset(
  m: Market,
  def: StrategyDef,
  sim: SimResult,
  paths: number,
  seed: number,
): { mc?: ReturnType<typeof monteCarlo>; dataset: Dataset } {
  const mc = monteCarlo(
    sim.trades.map((t) => t.returnPct),
    paths,
    seed,
  );
  const P = new PointList(`${m.symbol}.bt.${def.name}.mc`);
  if (mc) {
    const how = `${mc.paths} bootstrap paths of ${mc.trades} trades (seed ${mc.seed}), trade returns on equity compounded`;
    P.add("paths", `${def.name}: Monte Carlo paths`, mc.paths, "count", how);
    P.add("final.p5", `${def.name}: total return, 5th percentile`, mc.finalReturnPct.p5, "%", how);
    P.add("final.p50", `${def.name}: total return, median`, mc.finalReturnPct.p50, "%", how);
    P.add("final.p95", `${def.name}: total return, 95th percentile`, mc.finalReturnPct.p95, "%", how);
    P.add("maxdd.p50", `${def.name}: maximum drawdown, median`, mc.maxDrawdownPct.p50, "%", `${how}; drawdown measured trade to trade`);
    P.add("maxdd.p5", `${def.name}: maximum drawdown, 5th percentile (bad tail)`, mc.maxDrawdownPct.p5, "%", `${how}; drawdown measured trade to trade`);
    P.add("lossProbability", `${def.name}: probability of a loss`, mc.lossProbabilityPct, "%", "paths ending below the starting capital / paths");
    P.add("ruinProbability", `${def.name}: probability of a ≥ 50 % drawdown`, mc.ruinProbabilityPct, "%", "paths with a drawdown of 50 % or worse / paths");
  }
  return {
    mc,
    dataset: {
      kind: "backtest-montecarlo",
      title: `${def.name} on ${m.symbol} — Monte Carlo of the trade sequence`,
      subject: m.symbol,
      points: P.points,
      provenance: provenanceOf(m),
      notes: mc ? P.skipped : ["no closed trade: nothing to resample"],
    },
  };
}

/** Re-run on the series cut at two thirds: the trades that closed before the cut must be identical. */
export function lookAheadCheck(
  m: Market,
  def: StrategyDef,
  full: SimResult,
  overrides: { risk?: RiskRules; execution?: ExecutionRules } = {},
): { mismatches: number; cutAt: string } {
  const k = Math.floor((m.bars.length * 2) / 3);
  const cut = { ...m, bars: m.bars.slice(0, k), funding: m.funding };
  const bt = backtesterFor(cut, def, overrides);
  const short = runVariant(bt, prepareVariant(bt, def));
  const a = full.trades.filter((t) => t.exitIndex < k - 1);
  const b = short.trades.filter((t) => t.exitIndex < k - 1);
  const same = (x: (typeof a)[number], y: (typeof a)[number]) =>
    x.entryIndex === y.entryIndex &&
    x.exitIndex === y.exitIndex &&
    Math.abs(x.entryPrice - y.entryPrice) <= 1e-9 * x.entryPrice &&
    Math.abs(x.pnl - y.pnl) <= 1e-6 * Math.max(1, Math.abs(x.pnl));
  let mismatches = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (!same(a[i]!, b[i]!)) mismatches++;
  return { mismatches, cutAt: m.bars[k - 1]!.date };
}

export interface ReviewReport {
  review: Review;
  base: StrategyReport;
  sweep: SweepReport;
  wf?: WalkForwardReport;
  mc: ReturnType<typeof monteCarloDataset>;
  dataset: Dataset;
  notes: string[];
}

export function reviewRun(
  m: Market,
  def: StrategyDef,
  opts: {
    dims?: GridDim[];
    objective: Objective;
    trials?: number;
    train?: number;
    test?: number;
    anchored?: boolean;
    paths?: number;
    seed?: number;
    overrides?: { risk?: RiskRules; execution?: ExecutionRules };
  },
): ReviewReport {
  const base = strategyBacktest(m, def, opts.overrides);
  const dims = opts.dims ?? defaultGrid(def);
  const notes: string[] = [];
  const sw = sweepReport(m, def, dims, opts.objective, { trials: opts.trials, overrides: opts.overrides });
  // The strategy as written, deflated by everything tried around it.
  const dsrBase = deflatedSharpeOf(base.sim.returns, sw.variantSharpes, sw.nTrials);
  let wf: WalkForwardReport | undefined;
  try {
    wf = walkForwardReport(m, def, dims, { train: opts.train, test: opts.test, anchored: opts.anchored, objective: opts.objective, overrides: opts.overrides });
  } catch (e) {
    notes.push(`walk-forward skipped: ${(e as Error).message}`);
  }
  const mc = monteCarloDataset(m, def, base.sim, opts.paths ?? 5000, opts.seed ?? 42);
  const la = lookAheadCheck(m, def, base.sim, opts.overrides);
  const closes = m.bars.map((b) => b.close);
  const dd = drawdowns(closes);
  const fullCycle = dd.maxDrawdown <= -0.2 && dd.recoveryIndex !== undefined;
  const review = reviewScorecard({
    trades: base.stats.trades,
    years: base.summary.years,
    fullCycle,
    netProfit: base.stats.netProfit,
    isSharpe: wf?.wf.isSharpeMean,
    oosSharpe: wf?.wf.oosSharpe,
    dsr: dsrBase,
    nTrials: sw.nTrials,
    pbo: sw.pbo?.pbo,
    stressedNetProfit: base.stressed.stats.netProfit,
    largestWinSharePct: base.stats.largestWinSharePct,
    universe: m.universe,
    lookAheadMismatches: la.mismatches,
    lookAheadCheckedAt: la.cutAt,
  });
  const P = new PointList(`${m.symbol}.bt.${def.name}.review`);
  P.add("verdict", `${def.name} on ${m.symbol}: review verdict`, review.verdict, undefined, review.reasons.join("; "));
  P.add(
    "dsr",
    `${def.name} as written: deflated Sharpe ratio`,
    dsrBase,
    "ratio",
    `PSR of the strategy as written against E[max Sharpe] of ${sw.nTrials} trials`,
  );
  for (const c of review.checks)
    P.add(
      `check.${c.id}`,
      `${def.name} review — ${c.label}`,
      c.status.toUpperCase(),
      undefined,
      `${c.reason} (value ${c.value ?? "n/a"}; threshold ${c.threshold}${c.critical && c.status === "fail" ? "; critical" : ""})`,
    );
  return {
    review,
    base,
    sweep: sw,
    wf,
    mc,
    notes,
    dataset: {
      kind: "backtest-review",
      title: `${def.name} on ${m.symbol} — review scorecard: ${review.verdict}`,
      subject: m.symbol,
      points: P.points,
      provenance: provenanceOf(m),
      notes: [...notes, ...P.skipped],
    },
  };
}

// --- Allocations ------------------------------------------------------------------------------------------

export interface PortfolioReport {
  kind: Allocation;
  symbols: string[];
  series: PriceSeries[];
  result: ReturnType<typeof allocationBacktest>;
  summary: ReturnType<typeof performanceSummary>;
  stressedSummary: ReturnType<typeof performanceSummary>;
  dataset: Dataset;
  bars: Bar[];
  notes: string[];
}

export async function portfolioRun(
  kind: Allocation,
  symbols: string[],
  opts: MarketOptions & { rebalance?: "monthly" | "quarterly"; lookbackMonths?: number; cashRatePct?: number },
): Promise<PortfolioReport> {
  if (symbols.length > MAX_PORTFOLIO_SYMBOLS) throw new Error(`at most ${MAX_PORTFOLIO_SYMBOLS} symbols in one allocation backtest`);
  const notes: string[] = [];
  const loaded = await mapLimit(symbols, 4, async (s) => {
    try {
      return (await loadBars(s, { from: opts.from, to: opts.to, interval: "1d" })).series;
    } catch (e) {
      notes.push(`${s}: ${(e as Error).message}`);
      return undefined;
    }
  });
  const ok = loaded.filter((s): s is PriceSeries => !!s);
  if (ok.length !== symbols.length) throw new Error(`could not load every symbol: ${notes.join("; ")}`);
  const { dates, bars } = alignBars(ok.map((s) => s.bars));
  if (dates.length < 60) throw new Error(`only ${dates.length} dates common to every symbol — an allocation backtest needs at least 60`);
  const crypto = ok.every((s) => s.instrument.market === "crypto");
  const ppy = crypto ? 365 : 252;
  const costs = { ...defaultCosts(crypto, false), ...(opts.costs ?? {}) };
  const common = { rebalance: opts.rebalance, capital: opts.capital, lookbackMonths: opts.lookbackMonths, cashRatePct: opts.cashRatePct };
  const result = allocationBacktest(kind, bars, dates, { ...common, costs });
  const stressed = allocationBacktest(kind, bars, dates, { ...common, costs: stressCosts(costs, 2) });
  const summary = performanceSummary(result.returns, ppy);
  const stressedSummary = performanceSummary(stressed.returns, ppy);
  for (const s of ok) notes.push(...s.notes.map((n) => `${s.instrument.symbol}: ${n}`));
  if (opts.universe)
    notes.push(
      `SURVIVORSHIP: the symbols are today's members of ${opts.universe} — every company that left the index is missing, so results are biased upward`,
    );
  if (dates.length < Math.min(...ok.map((s) => s.bars.length))) notes.push(`${dates.length} dates common to all symbols (series joined on shared sessions)`);
  const subject = ok.map((s) => s.instrument.symbol).join("+");
  const P = new PointList(`${subject}.bt.${kind}`);
  const final = result.equity[result.equity.length - 1]!.equity;
  const s: Summary = { ...summary, finalEquity: final, totalReturn: final / opts.capital - 1, years: result.returns.length / ppy };
  const basis = `${kind} over ${subject}, ${opts.rebalance ?? "monthly"} rebalancing decided on the prior close and traded at the open, ${costText(costs)}`;
  P.add("bars", `${kind} on ${subject}: sessions simulated`, dates.length, "count", `common dates from ${dates[0]} to ${dates[dates.length - 1]}`);
  performancePoints(P, s, `${kind} on ${subject}`, ok[0]!.instrument.currency, basis);
  P.add("rebalances", `${kind}: rebalances`, result.rebalances.length, "count", "rebalance dates where weights were traded");
  P.add("turnover", `${kind}: turnover`, result.turnoverPct, "%", "Σ traded value / average equity");
  P.add("costs", `${kind}: trading costs paid`, result.costs, ok[0]!.instrument.currency, "Σ traded value × (taker fee + slippage)");
  P.add("x2.cagr", `${kind}: CAGR at ×2 costs`, pct(stressedSummary.cagr), "%", "same rule with doubled fees and slippage");
  result.finalWeights.forEach((w, i) =>
    P.add(
      `weight.${ok[i]!.instrument.symbol}`,
      `${kind}: final weight of ${ok[i]!.instrument.symbol}`,
      pct(w),
      "%",
      "position value / equity at the last close",
    ),
  );
  const provs = ok.map((x) => x.provenance);
  return {
    kind,
    symbols: ok.map((x) => x.instrument.symbol),
    series: ok,
    result,
    summary,
    stressedSummary,
    bars: bars[0]!,
    notes,
    dataset: {
      kind: "backtest-allocation",
      title: `${kind} on ${subject} — allocation backtest (${dates[0]} → ${dates[dates.length - 1]})`,
      subject,
      points: P.points,
      provenance: {
        source: [...new Set(provs.map((p) => p.source))].join("+"),
        url: provs[0]!.url,
        fetchedAt: provs.map((p) => p.fetchedAt).sort()[0]!,
        delay: provs[0]!.delay,
        official: provs.every((p) => p.official),
        asOf: dates[dates.length - 1],
      },
      notes: [...notes, ...P.skipped],
    },
  };
}

// --- Writing the run ---------------------------------------------------------------------------------------

export interface RunFiles {
  /** Extra markdown sections after the evidence (working detail). */
  sections?: string[];
  /** JSON files to write in the run directory: name → value. */
  json?: Record<string, unknown>;
  bars?: readonly Bar[];
}

/** Register the datasets, write BACKTEST.md and the JSON detail; returns the evidence count. */
export function writeRun(dir: string, title: string, datasets: Dataset[], files: RunFiles, createdAt: string): number {
  mkdirSync(dir, { recursive: true });
  const store = EvidenceStore.open(dir, { subject: datasets[0]?.subject, createdAt });
  const reg = registerDatasets(store, datasets);
  const md = [
    `# ${title}`,
    "",
    "Every figure below is an [E#] of this run: cite those. The tables after the evidence are working detail (also in the JSON files of the run), not evidence.",
    "",
    formatDatasets(reg).trimEnd(),
    ...(files.sections?.length ? ["", files.sections.join("\n\n")] : []),
    "",
  ].join("\n");
  writeArtifact(join(dir, "BACKTEST.md"), md);
  for (const [name, value] of Object.entries(files.json ?? {})) writeArtifact(join(dir, name), `${JSON.stringify(value, null, 1)}\n`);
  if (files.bars) writeArtifact(join(dir, "bars.json"), `${JSON.stringify(files.bars)}\n`);
  return store.items.length;
}

const f = (x: number | undefined, d = 2) => (x === undefined || !Number.isFinite(x) ? "–" : x.toFixed(d));

/** Markdown tables of the trades (first and last ones when there are many). */
export function tradesTable(trades: SimResult["trades"], max = 40): string {
  if (!trades.length) return "## Trades\n\nNo trade.";
  const rows = trades.length > max ? [...trades.slice(0, max / 2), undefined, ...trades.slice(-max / 2)] : trades;
  return [
    `## Trades (${trades.length})`,
    "",
    "| # | Side | Entry | Entry price | Exit | Exit price | Reason | Bars | P&L | Return % | R | MAE % | MFE % |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((t) =>
      t
        ? `| ${trades.indexOf(t) + 1} | ${t.side} | ${t.entryDate} | ${f(t.entryPrice, 4)} | ${t.exitDate} | ${f(t.exitPrice, 4)} | ${t.exitReason} | ${t.bars} | ${f(t.pnl)} | ${f(t.returnPct)} | ${f(t.r)} | ${f(t.maePct)} | ${f(t.mfePct)} |`
        : `| … | ${trades.length - max} more (trades.json) | | | | | | | | | | | |`,
    ),
  ].join("\n");
}

/** A heat table of the sweep: Sharpe by the first two dimensions (others at their best). */
export function sweepTable(sw: SweepReport): string {
  const lines = ["## Parameter sensitivity", ""];
  if (sw.dims.length === 2) {
    const [a, b] = sw.dims as [GridDim, GridDim];
    lines.push(
      `Sharpe by ${a.path} (rows) × ${b.path} (columns):`,
      "",
      `| ${a.path} \\ ${b.path} | ${b.values.join(" | ")} |`,
      `|---|${b.values.map(() => "---").join("|")}|`,
    );
    for (const va of a.values) {
      const cells = b.values.map((vb) => f(sw.rows.find((r) => r.params[a.path] === va && r.params[b.path] === vb)?.sharpe));
      lines.push(`| ${va} | ${cells.join(" | ")} |`);
    }
  } else {
    lines.push("| Variant | Sharpe | CAGR % | Max DD % | Trades |", "|---|---|---|---|---|");
    const top = [...sw.rows].sort((x, y) => y.objective - x.objective).slice(0, 30);
    for (const r of top)
      lines.push(
        `| ${
          Object.entries(r.params)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ") || "as written"
        } | ${f(r.sharpe)} | ${f(r.cagr * 100)} | ${f(r.maxDrawdown * 100)} | ${r.trades} |`,
      );
    if (sw.rows.length > 30) lines.push(`| … ${sw.rows.length - 30} more in sweep.json | | | | |`);
  }
  return lines.join("\n");
}

export function walkForwardTable(wf: ReturnType<typeof walkForward>): string {
  return [
    "## Walk-forward windows",
    "",
    "| Train | Test | Chosen | IS Sharpe | OOS Sharpe | OOS trades |",
    "|---|---|---|---|---|---|",
    ...wf.windows.map(
      (w) =>
        `| ${w.trainFrom} → ${w.trainTo} | ${w.testFrom} → ${w.testTo} | ${
          Object.entries(w.chosen)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ") || "as written"
        } | ${f(w.isSharpe)} | ${f(w.oosSharpe)} | ${w.oosTrades} |`,
    ),
  ].join("\n");
}

export function reviewTable(r: Review): string {
  return [
    `## Review: ${r.verdict}`,
    "",
    ...r.reasons.map((x) => `- ${x}`),
    "",
    "| Check | Status | Value | Threshold | Why |",
    "|---|---|---|---|---|",
    ...r.checks.map(
      (c) =>
        `| ${c.label} | ${c.status.toUpperCase()}${c.critical && c.status === "fail" ? " (critical)" : ""} | ${c.value ?? "–"} | ${c.threshold} | ${c.reason} |`,
    ),
  ].join("\n");
}

/** The equity curve and drawdown, compact, for equity.json. */
export function equityJson(sim: { equity: SimResult["equity"] }) {
  const dd = drawdowns(sim.equity.map((e) => e.equity)).series;
  return sim.equity.map((e, i) => ({
    date: e.date,
    equity: Number(e.equity.toFixed(4)),
    drawdownPct: Number((dd[i]! * 100).toFixed(4)),
    exposure: Number(e.exposure.toFixed(4)),
  }));
}
