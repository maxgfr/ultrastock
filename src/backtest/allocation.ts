// Portfolio-level backtests of allocation rules over a list of symbols:
//   buy-and-hold   equal weights at the start, never rebalanced;
//   60-40          60 % in the first symbol, 40 % in the second, rebalanced;
//   equal-weight   1/N, rebalanced;
//   dual-momentum  Antonacci's GEM: the risky symbol (all but the last) with the
//                  best 12-month return, held only while that return beats the
//                  cash rate (absolute momentum), else the last symbol (bonds);
//   risk-parity    equal risk contributions from a Ledoit–Wolf covariance of the
//                  trailing year of daily returns (src/analytics/portfolio.ts).
// Weights are decided on the close BEFORE the rebalance bar (the last bar of
// the previous month or quarter) and traded at the rebalance bar's open, every
// traded euro paying the taker fee and the slippage. Series are joined on the
// dates every symbol traded.
import { ledoitWolf, riskParity } from "../analytics/portfolio.js";
import type { Bar } from "../providers/types.js";
import type { Costs, EquityPoint } from "./simulate.js";

export const ALLOCATIONS = ["buy-and-hold", "60-40", "equal-weight", "dual-momentum", "risk-parity"] as const;
export type Allocation = (typeof ALLOCATIONS)[number];

export interface AllocationOptions {
  rebalance?: "monthly" | "quarterly";
  costs: Costs;
  capital: number;
  /** Momentum lookback for dual momentum, months. */
  lookbackMonths?: number;
  /** Annual cash rate the absolute-momentum test must beat, %. */
  cashRatePct?: number;
  /** Bars of daily returns for the risk-parity covariance. */
  covarianceBars?: number;
}

export interface AllocationResult {
  dates: string[];
  equity: EquityPoint[];
  returns: number[];
  rebalances: Array<{ date: string; weights: number[]; reason: string; costs: number; turnoverPct: number }>;
  costs: number;
  /** Sum of the traded value over the average equity, %. */
  turnoverPct: number;
  finalWeights: number[];
}

/** Keep the dates present in every series, in order. */
export function alignBars(series: ReadonlyArray<readonly Bar[]>): { dates: string[]; bars: Bar[][] } {
  const maps = series.map((s) => new Map(s.map((b) => [b.date.slice(0, 10), b])));
  const dates = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  return { dates, bars: maps.map((m) => dates.map((d) => m.get(d)!)) };
}

const periodKey = (date: string, rebalance: "monthly" | "quarterly") => {
  const m = Number(date.slice(5, 7));
  return rebalance === "monthly" ? date.slice(0, 7) : `${date.slice(0, 4)}Q${Math.ceil(m / 3)}`;
};

/** The last index at or before `date` minus `months` calendar months. */
function indexMonthsBefore(dates: readonly string[], t: number, months: number): number {
  const [y, m, d] = dates[t]!.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
  let i = t;
  while (i > 0 && dates[i]! > target) i--;
  return dates[i]! <= target ? i : -1;
}

/** Target weights decided on the close of bar `t` (data up to t only), or undefined to stay as is. */
function targetWeights(
  kind: Allocation,
  bars: Bar[][],
  dates: readonly string[],
  t: number,
  opts: AllocationOptions,
): { w: number[]; reason: string } | undefined {
  const n = bars.length;
  if (kind === "equal-weight" || kind === "buy-and-hold") return { w: new Array(n).fill(1 / n), reason: `1/${n} each` };
  if (kind === "60-40") return { w: [0.6, 0.4], reason: "60 % / 40 %" };
  if (kind === "dual-momentum") {
    const months = opts.lookbackMonths ?? 12;
    const back = indexMonthsBefore(dates, t, months);
    if (back < 0) return undefined;
    const ret = bars.map((b) => b[t]!.close / b[back]!.close - 1);
    const risky = ret.slice(0, n - 1);
    const best = risky.indexOf(Math.max(...risky));
    const hurdle = ((opts.cashRatePct ?? 0) / 100) * (months / 12);
    const w = new Array(n).fill(0);
    if (risky[best]! > hurdle) {
      w[best] = 1;
      return {
        w,
        reason: `relative momentum: asset ${best + 1} led with ${(risky[best]! * 100).toFixed(2)} % over ${months} months, above the ${(hurdle * 100).toFixed(2)} % hurdle`,
      };
    }
    w[n - 1] = 1;
    return {
      w,
      reason: `absolute momentum: the best risky return ${(risky[best]! * 100).toFixed(2)} % is under the ${(hurdle * 100).toFixed(2)} % hurdle — safe asset`,
    };
  }
  // risk-parity
  const window = opts.covarianceBars ?? 252;
  const from = Math.max(1, t - window + 1);
  if (t - from + 1 < 60) return undefined;
  const rets = bars.map((b) => {
    const r: number[] = [];
    for (let i = from; i <= t; i++) r.push(b[i]!.close / b[i - 1]!.close - 1);
    return r;
  });
  const { cov, shrinkage } = ledoitWolf(rets);
  const w = riskParity(cov);
  return { w, reason: `equal risk contributions, Ledoit–Wolf covariance of ${rets[0]!.length} daily returns (shrinkage ${shrinkage.toFixed(3)})` };
}

export function allocationBacktest(kind: Allocation, bars: Bar[][], dates: readonly string[], opts: AllocationOptions): AllocationResult {
  const n = bars.length;
  if (kind === "60-40" && n !== 2) throw new Error("60-40 takes exactly two symbols: equities first, bonds second");
  if (kind === "dual-momentum" && n < 2) throw new Error("dual-momentum takes at least two symbols: the risky ones, then the safe one last");
  if (n < 1 || !dates.length) throw new Error("no common dates across the symbols");
  const rebalance = opts.rebalance ?? "monthly";
  const rate = (opts.costs.takerPct + opts.costs.slippagePct) / 100;
  let cash = opts.capital;
  let units = new Array<number>(n).fill(0);
  const equity: EquityPoint[] = [];
  const returns: number[] = [];
  const rebalances: AllocationResult["rebalances"] = [];
  let traded = 0;
  let costs = 0;
  let prevEq = opts.capital;
  let started = false;
  for (let t = 0; t < dates.length; t++) {
    const opens = bars.map((b) => b[t]!.open);
    const newPeriod = t === 0 || periodKey(dates[t]!, rebalance) !== periodKey(dates[t - 1]!, rebalance);
    const due = kind === "buy-and-hold" ? !started : newPeriod;
    if (due) {
      // Decided on the previous close (t − 1); buy-and-hold and fixed weights need no history.
      const decision =
        t === 0
          ? kind === "dual-momentum" || kind === "risk-parity"
            ? undefined
            : targetWeights(kind, bars, dates, 0, opts)
          : targetWeights(kind, bars, dates, t - 1, opts);
      if (decision) {
        const value = cash + units.reduce((s, u, i) => s + u * opens[i]!, 0);
        const sum = decision.w.reduce((s, x) => s + x, 0);
        const w = decision.w.map((x) => (sum > 0 ? x / sum : 0));
        const tradedValue = (v: number) => w.reduce((s, wi, i) => s + Math.abs(wi * v - units[i]! * opens[i]!), 0);
        const cost = tradedValue(value) * rate;
        const after = value - cost;
        const tv = tradedValue(after);
        units = w.map((wi, i) => (wi * after) / opens[i]!);
        cash = after - units.reduce((s, u, i) => s + u * opens[i]!, 0);
        traded += tv;
        costs += cost;
        started = true;
        rebalances.push({ date: dates[t]!, weights: w, reason: decision.reason, costs: cost, turnoverPct: value > 0 ? (tv / value) * 100 : 0 });
      }
    }
    const eq = cash + units.reduce((s, u, i) => s + u * bars[i]![t]!.close, 0);
    const gross = units.reduce((s, u, i) => s + Math.abs(u * bars[i]![t]!.close), 0);
    equity.push({ date: dates[t]!, equity: eq, exposure: eq > 0 ? gross / eq : 0 });
    returns.push(prevEq > 0 ? eq / prevEq - 1 : 0);
    prevEq = eq;
  }
  const avgEq = equity.reduce((s, e) => s + e.equity, 0) / equity.length;
  const lastEq = equity[equity.length - 1]!.equity;
  return {
    dates: [...dates],
    equity,
    returns,
    rebalances,
    costs,
    turnoverPct: avgEq > 0 ? (traded / avgEq) * 100 : 0,
    finalWeights: units.map((u, i) => (lastEq > 0 ? (u * bars[i]![dates.length - 1]!.close) / lastEq : 0)),
  };
}
