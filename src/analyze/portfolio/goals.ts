// Will the portfolio reach a target? A Monte Carlo of monthly log-normal
// returns from an annual mean and volatility, with a monthly contribution,
// seeded (src/analytics/performance.ts seededRandom) so the same inputs give
// the same answer — and the contribution that would lift the probability to
// 80 %, by bisection over the same seeded paths.
//
// The inputs are the weak part: a year or two of history says little about the
// next twenty. When the history is short the assumption comes from the
// profile's risk score instead, and the output says which one was used.
import { seededRandom } from "../../analytics/performance.js";
import { normInv, quantile } from "../../analytics/stats.js";

export const GOAL_PATHS = 5000;
export const GOAL_SEED = 42;

/**
 * Long-run assumptions by risk score (1 very conservative … 7 speculative):
 * annual expected return and volatility, nominal, before tax. A blend from
 * cash/bonds (score 1) to an all-equity world portfolio (5) and beyond — stated
 * assumptions, not forecasts.
 */
export const PROFILE_ASSUMPTIONS: Record<number, { ret: number; vol: number }> = {
  1: { ret: 0.025, vol: 0.03 },
  2: { ret: 0.03, vol: 0.05 },
  3: { ret: 0.04, vol: 0.08 },
  4: { ret: 0.05, vol: 0.11 },
  5: { ret: 0.06, vol: 0.15 },
  6: { ret: 0.065, vol: 0.18 },
  7: { ret: 0.07, vol: 0.22 },
};

export interface GoalInput {
  start: number;
  target: number;
  years: number;
  monthly: number;
  /** Annual arithmetic mean return and volatility (fractions). */
  ret: number;
  vol: number;
  paths?: number;
  seed?: number;
}

/**
 * Standard normal draws for every path and month, generated once: the same
 * shocks are reused when the contribution changes, so the bisection compares
 * like with like (common random numbers).
 */
function shocks(paths: number, months: number, seed: number): Float64Array {
  const rnd = seededRandom(seed);
  const z = new Float64Array(paths * months);
  for (let i = 0; i < z.length; i++) z[i] = normInv(Math.min(1 - 1e-12, Math.max(1e-12, rnd())));
  return z;
}

function simulate(i: GoalInput, z: Float64Array, paths: number, months: number): number[] {
  // Monthly log-return with the annual arithmetic mean preserved: μ_log = ln(1+μ)/12 − σ²/24.
  const sm = i.vol / Math.sqrt(12);
  const mm = Math.log(1 + i.ret) / 12 - (sm * sm) / 2;
  const out: number[] = new Array(paths);
  for (let p = 0; p < paths; p++) {
    let v = i.start;
    for (let m = 0; m < months; m++) v = v * Math.exp(mm + sm * z[p * months + m]!) + i.monthly;
    out[p] = v;
  }
  return out;
}

export interface GoalResult {
  probability: number;
  p5: number;
  median: number;
  p95: number;
  contributed: number;
  /** The monthly contribution that reaches 80 % (undefined when even a large one does not within the horizon). */
  monthlyFor80?: number;
  paths: number;
}

/** Probability of ending at or above the target, the outcome quantiles, and the contribution for 80 %. */
export function goalMonteCarlo(i: GoalInput): GoalResult {
  const paths = i.paths ?? GOAL_PATHS;
  const months = Math.max(1, Math.round(i.years * 12));
  const z = shocks(paths, months, i.seed ?? GOAL_SEED);
  const run = (monthly: number) => simulate({ ...i, monthly }, z, paths, months);
  const prob = (xs: number[]) => xs.filter((v) => v >= i.target).length / xs.length;
  const base = run(i.monthly);
  // Bisection on the contribution: probability is monotone in it on fixed shocks.
  let monthlyFor80: number | undefined;
  if (prob(base) >= 0.8) {
    let lo = 0;
    let hi = i.monthly;
    if (prob(run(0)) >= 0.8) monthlyFor80 = 0;
    else {
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (prob(run(mid)) >= 0.8) hi = mid;
        else lo = mid;
      }
      monthlyFor80 = hi;
    }
  } else {
    let lo = i.monthly;
    let hi = Math.max(100, i.monthly * 2, i.target / months);
    for (let k = 0; k < 20 && prob(run(hi)) < 0.8; k++) {
      lo = hi;
      hi *= 2;
    }
    if (prob(run(hi)) >= 0.8) {
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (prob(run(mid)) >= 0.8) hi = mid;
        else lo = mid;
      }
      monthlyFor80 = hi;
    }
  }
  return {
    probability: prob(base),
    p5: quantile(base, 0.05),
    median: quantile(base, 0.5),
    p95: quantile(base, 0.95),
    contributed: i.start + i.monthly * months,
    monthlyFor80,
    paths,
  };
}
