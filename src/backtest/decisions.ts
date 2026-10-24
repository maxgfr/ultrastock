// How good the recorded calls have been: the journal's settled decisions
// (journal/settlements.jsonl, written by `journal settle`) grouped by rating
// and horizon, with the hit rate's Wilson interval and the mean alpha's
// t interval. A replay of what was decided, never a portfolio simulated from
// it: decisions carry no sizes, and inventing them would be a backtest of a
// strategy nobody ran.
import { mean, normInv, stdev } from "../analytics/stats.js";
import type { Settlement } from "../journal/settle.js";

/** Wilson score interval for a binomial proportion (successes of n) at `confidence`. */
export function wilsonInterval(successes: number, n: number, confidence = 0.95): { low: number; high: number } {
  if (n <= 0) return { low: Number.NaN, high: Number.NaN };
  const z = normInv(1 - (1 - confidence) / 2);
  const p = successes / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Student-t quantile by the Cornish–Fisher expansion of the normal (Abramowitz & Stegun 26.7.5) — good to ~1e-3 from 3 degrees of freedom. */
export function tQuantile(p: number, df: number): number {
  const z = normInv(p);
  const g1 = (z ** 3 + z) / 4;
  const g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96;
  const g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3;
}

export interface DecisionGroup {
  rating: string;
  horizon: number;
  n: number;
  hits: number;
  /** Fractions 0–1. */
  hitRate: number;
  hitLow: number;
  hitHigh: number;
  /** Alpha against the benchmark, %; undefined when no settlement had a benchmark. */
  meanAlphaPct?: number;
  alphaLowPct?: number;
  alphaHighPct?: number;
  meanReturnPct: number;
}

/** Group settlements by rating and horizon; intervals at 95 %. */
export function decisionQuality(settlements: readonly Settlement[], confidence = 0.95): DecisionGroup[] {
  const groups = new Map<string, Settlement[]>();
  for (const s of settlements) {
    const k = `${s.rating}|${s.horizon}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const out: DecisionGroup[] = [];
  for (const [k, xs] of groups) {
    const [rating, h] = k.split("|") as [string, string];
    const hits = xs.filter((x) => x.hit).length;
    const ci = wilsonInterval(hits, xs.length, confidence);
    const alphas = xs.map((x) => x.alphaPct).filter((x): x is number => typeof x === "number");
    const g: DecisionGroup = {
      rating,
      horizon: Number(h),
      n: xs.length,
      hits,
      hitRate: hits / xs.length,
      hitLow: ci.low,
      hitHigh: ci.high,
      meanReturnPct: mean(xs.map((x) => x.returnPct)),
    };
    if (alphas.length) {
      g.meanAlphaPct = mean(alphas);
      if (alphas.length >= 2) {
        const half = (tQuantile(1 - (1 - confidence) / 2, alphas.length - 1) * stdev(alphas)) / Math.sqrt(alphas.length);
        g.alphaLowPct = g.meanAlphaPct - half;
        g.alphaHighPct = g.meanAlphaPct + half;
      }
    }
    out.push(g);
  }
  return out.sort((a, b) => a.rating.localeCompare(b.rating) || a.horizon - b.horizon);
}
