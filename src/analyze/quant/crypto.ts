// `crypto-analysis`: readings on top of the crypto providers — how crowded
// leverage is, realised volatility and drawdown from daily bars, and whether a
// DeFi yield is earned (fees, interest) or paid in emissions. Pure functions;
// the thresholds are here, in the open, and every verdict carries its reasons.
import { logReturns } from "../../analytics/indicators.js";
import { drawdowns } from "../../analytics/performance.js";
import { parkinsonVol, stdev } from "../../analytics/stats.js";
import type { Point } from "../../core/datasets.js";
import type { Bar } from "../../providers/types.js";
import { fmt, type PointList } from "./common.js";

/** Funding above this, annualised, is expensive leverage on the long side (%/yr). */
export const HOT_FUNDING_PCT = 20;

export interface LeverageHeat {
  label: "crowded" | "warm" | "neutral" | "short-crowded" | "unknown";
  reasons: string[];
}

/**
 * Leverage heat from perpetual funding (annualised, %) and the open-interest
 * change (%): crowded when funding exceeds 20 %/yr AND open interest is rising
 * — longs pay a lot and more of them keep coming. Warm when only one holds;
 * short-crowded when funding is negative and OI rising.
 */
export function leverageHeat(fundingAnnualPct: number | undefined, oiChangePct: number | undefined): LeverageHeat {
  if (fundingAnnualPct === undefined || oiChangePct === undefined) {
    return { label: "unknown", reasons: [fundingAnnualPct === undefined ? "funding unavailable" : "open-interest change unavailable"] };
  }
  const hot = fundingAnnualPct > HOT_FUNDING_PCT;
  const rising = oiChangePct > 0;
  const reasons = [
    `funding ${fmt(fundingAnnualPct, 1)} %/yr annualised ${hot ? ">" : "≤"} ${HOT_FUNDING_PCT} %/yr`,
    `open interest ${rising ? "rising" : "not rising"} (${fmt(oiChangePct, 1)} % over the window)`,
  ];
  if (hot && rising) return { label: "crowded", reasons };
  if (fundingAnnualPct < 0 && rising) return { label: "short-crowded", reasons: [...reasons, "negative funding: shorts pay longs"] };
  if (hot || (rising && fundingAnnualPct > HOT_FUNDING_PCT / 2)) return { label: "warm", reasons };
  return { label: "neutral", reasons };
}

/** Realised volatility (30 days and the whole window), Parkinson, return and max drawdown over the window, from closed daily bars. */
export function realisedPoints(sym: string, bars: readonly Bar[], out: PointList, perYear = 365): void {
  if (bars.length < 3) return;
  const k = `${sym}.quant.realised`;
  const closes = bars.map((b) => b.close);
  const lr = logReturns(closes);
  const last30 = logReturns(closes.slice(-31));
  const span = `${bars[0]!.date} → ${bars[bars.length - 1]!.date}`;
  const ann = Math.sqrt(perYear);
  out.num(
    `${k}.vol30d`,
    `${sym} realised volatility, last 30 days, annualised`,
    stdev(last30) * ann * 100,
    "%",
    `stdev(daily log returns) × √${perYear} × 100`,
  );
  out.num(`${k}.volWindow`, `${sym} realised volatility (${span}), annualised`, stdev(lr) * ann * 100, "%", `stdev(daily log returns) × √${perYear} × 100`);
  const pk = bars.slice(-30).filter((b) => b.high > 0 && b.low > 0 && b.high >= b.low);
  if (pk.length >= 10)
    out.num(
      `${k}.parkinson30d`,
      `${sym} Parkinson volatility, last 30 days, annualised`,
      parkinsonVol(pk) * ann * 100,
      "%",
      `√(Σ ln(H/L)² / (4 ln 2 n)) × √${perYear} × 100`,
    );
  out.num(`${k}.return`, `${sym} price return (${span})`, (closes[closes.length - 1]! / closes[0]! - 1) * 100, "%", "(last close / first close − 1) × 100");
  const dd = drawdowns(closes);
  out.num(`${k}.maxDrawdown`, `${sym} maximum drawdown (${span})`, dd.maxDrawdown * 100, "%", "min of (close / running peak − 1) × 100");
  out.num(
    `${k}.fromHigh`,
    `${sym} drawdown from the window high now`,
    (dd.series[dd.series.length - 1] ?? 0) * 100,
    "%",
    "(last close / window high − 1) × 100",
  );
}

/** Reward share above this (% of APY from emissions) makes a yield fragile. */
export const FRAGILE_REWARD_SHARE = 50;
/** A pool smaller than this (USD) is fragile: thin liquidity, one whale's exit moves it. */
export const FRAGILE_TVL_USD = 10_000_000;

export interface PoolReading {
  id: string;
  label: string;
  tvl?: number;
  apy?: number;
  apyBase?: number;
  apyReward?: number;
  rewardShare?: number;
}

/** DefiLlama pool points (`YIELD.<id>.…`) grouped back into pools. */
export function poolsFromPoints(points: readonly Point[]): PoolReading[] {
  const by = new Map<string, PoolReading>();
  for (const p of points) {
    const m = /^YIELD\.([^.]+)\.(tvl|apy|apy\.base|apy\.reward|apy\.rewardShare)$/.exec(p.key);
    if (!m || typeof p.value !== "number") continue;
    const r = by.get(m[1]!) ?? { id: m[1]!, label: p.label.replace(/ (pool TVL|APY|base APY.*|reward APY.*|share of APY.*)$/, "") };
    if (m[2] === "tvl") r.tvl = p.value;
    if (m[2] === "apy") r.apy = p.value;
    if (m[2] === "apy.base") r.apyBase = p.value;
    if (m[2] === "apy.reward") r.apyReward = p.value;
    if (m[2] === "apy.rewardShare") r.rewardShare = p.value;
    by.set(m[1]!, r);
  }
  return [...by.values()];
}

/** Fragile when more than half the APY is emissions, or TVL is under $10M; each reason stated. */
export function yieldSustainability(p: PoolReading): { verdict: "fragile" | "sustainable-looking"; reasons: string[] } {
  const reasons: string[] = [];
  const share = p.rewardShare ?? (p.apyReward !== undefined && p.apyBase === undefined ? 100 : 0);
  if (share > FRAGILE_REWARD_SHARE) reasons.push(`${fmt(share, 0)} % of the APY is token emissions (> ${FRAGILE_REWARD_SHARE} %)`);
  if (p.tvl !== undefined && p.tvl < FRAGILE_TVL_USD) reasons.push(`TVL ${fmt(p.tvl / 1e6, 1)} M USD < ${FRAGILE_TVL_USD / 1e6} M`);
  if (reasons.length) return { verdict: "fragile", reasons };
  return {
    verdict: "sustainable-looking",
    reasons: [
      `emissions ${fmt(share, 0)} % of APY (≤ ${FRAGILE_REWARD_SHARE} %)`,
      ...(p.tvl !== undefined ? [`TVL ${fmt(p.tvl / 1e6, 1)} M USD ≥ ${FRAGILE_TVL_USD / 1e6} M`] : []),
      "smart-contract, depeg and governance risk are not measured here",
    ],
  };
}
