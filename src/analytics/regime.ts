// Market regime: is this a market to be invested in, and how much? Pure
// scoring over price series and gauges the providers fetch — every score keeps
// its components and reasons, and every weight is written here, in the open.
//
// The pieces follow the practitioners they come from: O'Neil's distribution
// days and follow-through day, intermarket ratios (breadth RSP/SPY, credit
// HYG/LQD, size IWM/SPY, cyclicals XLY/XLP, equities vs bonds), a crypto
// risk-on score, and an exposure coach that turns them into a ceiling on how
// much of the portfolio should be at risk. None of it predicts; it describes
// the tape and keeps a plan honest.
import { sma } from "./indicators.js";

export interface Signal {
  id: string;
  label: string;
  /** −1 risk-off … +1 risk-on; undefined when not computable. */
  value?: number;
  reason: string;
}

export interface Bar {
  date: string;
  close: number;
  volume?: number;
  high?: number;
  low?: number;
}

const last = <T>(xs: readonly T[]) => xs[xs.length - 1];
const pct = (a: number, b: number) => (a / b - 1) * 100;

/**
 * An intermarket ratio's trend: the ratio against its 50- and 200-day
 * averages and its 3-month change. +1 when the ratio rises (the numerator
 * leads), −1 when it falls.
 */
export function ratioSignal(id: string, label: string, numerator: readonly number[], denominator: readonly number[], riskOnWhenRising = true): Signal {
  const n = Math.min(numerator.length, denominator.length);
  if (n < 200) return { id, label, reason: `needs 200 aligned sessions, has ${n}` };
  const ratio = Array.from({ length: n }, (_, i) => numerator[numerator.length - n + i]! / denominator[denominator.length - n + i]!);
  const now = last(ratio)!;
  const s50 = last(sma(ratio, 50))!;
  const s200 = last(sma(ratio, 200))!;
  const chg3m = pct(now, ratio[n - 64]!);
  let score = 0;
  if (now > s50) score += 1 / 3;
  else score -= 1 / 3;
  if (s50 > s200) score += 1 / 3;
  else score -= 1 / 3;
  if (chg3m > 0) score += 1 / 3;
  else score -= 1 / 3;
  const value = riskOnWhenRising ? score : -score;
  return {
    id,
    label,
    value,
    reason: `ratio ${now > s50 ? "above" : "below"} its 50-day average, 50-day ${s50 > s200 ? "above" : "below"} 200-day, ${chg3m >= 0 ? "+" : ""}${chg3m.toFixed(1)} % over 3 months`,
  };
}

export interface DistributionDay {
  date: string;
  /** Close-to-close fall in %. */
  change: number;
}

/**
 * O'Neil distribution days over the last `window` sessions: the index closes
 * down at least 0.2 % on higher volume than the session before. A day stops
 * counting after `window` sessions, or once the index closes 5 % above that
 * day's close.
 */
export function distributionDays(
  bars: readonly Bar[],
  window = 25,
  minDrop = 0.2,
): { days: DistributionDay[]; level: "normal" | "caution" | "high" | "severe" } {
  const days: DistributionDay[] = [];
  const start = Math.max(1, bars.length - window);
  for (let i = start; i < bars.length; i++) {
    const b = bars[i]!;
    const p = bars[i - 1]!;
    const change = pct(b.close, p.close);
    if (change <= -minDrop && b.volume !== undefined && p.volume !== undefined && b.volume > p.volume) {
      const voided = bars.slice(i + 1).some((x) => x.close >= b.close * 1.05);
      if (!voided) days.push({ date: b.date, change });
    }
  }
  const n = days.length;
  return { days, level: n >= 7 ? "severe" : n >= 5 ? "high" : n >= 3 ? "caution" : "normal" };
}

export type FtdState = "uptrend" | "correction" | "rally-attempt" | "follow-through" | "failed";

/**
 * The follow-through day state machine (O'Neil): after a correction (the index
 * 8 % below its high), the first up day off the low starts a rally attempt; a
 * gain of at least `minGain` % on higher volume on day 4–10 of the attempt is a
 * follow-through day, confirming a new uptrend. Undercutting the attempt's low
 * resets it.
 */
export function followThrough(
  bars: readonly Bar[],
  minGain = 1.25,
  correctionPct = 8,
): { state: FtdState; date?: string; dayOfAttempt?: number; reason: string } {
  if (bars.length < 30) return { state: "uptrend", reason: "not enough history" };
  let high = bars[0]!.close;
  let state: FtdState = "uptrend";
  let low = Number.POSITIVE_INFINITY;
  let attemptStart = -1;
  let ftd: { date: string; day: number } | undefined;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const p = bars[i - 1]!;
    if (state === "uptrend" || state === "follow-through") {
      high = Math.max(high, b.close);
      if (pct(b.close, high) <= -correctionPct) {
        state = "correction";
        low = b.close;
        ftd = undefined;
      }
      continue;
    }
    if (b.close < low) {
      low = b.close;
      state = "correction";
      attemptStart = -1;
      continue;
    }
    if (state === "correction" && b.close > p.close) {
      state = "rally-attempt";
      attemptStart = i;
    }
    if (state === "rally-attempt") {
      const day = i - attemptStart + 1;
      if (day >= 4 && day <= 10 && pct(b.close, p.close) >= minGain && (b.volume ?? 0) > (p.volume ?? Number.POSITIVE_INFINITY)) {
        state = "follow-through";
        ftd = { date: b.date, day };
        high = b.close;
      } else if (day > 10) {
        state = "failed";
      }
    } else if (state === "failed" && b.close > p.close) {
      state = "rally-attempt";
      attemptStart = i;
    }
  }
  const reason =
    state === "follow-through"
      ? `follow-through day on ${ftd!.date} (day ${ftd!.day} of the rally attempt)`
      : state === "rally-attempt"
        ? "a rally attempt is under way, no follow-through yet"
        : state === "correction"
          ? `in a correction (≥ ${correctionPct} % off the high), no rally attempt`
          : state === "failed"
            ? "the last rally attempt passed day 10 without a follow-through"
            : "no correction in the window";
  return { state, date: ftd?.date, dayOfAttempt: ftd?.day, reason };
}

export interface Weighted {
  id: string;
  label: string;
  /** 0 (worst) … 100 (best); undefined when not available. */
  score?: number;
  weight: number;
  reason: string;
}

/** Weighted average of the available components, with the weights renormalised over what was computable. */
export function weightedScore(components: readonly Weighted[]): { score?: number; coverage: number; components: Weighted[] } {
  const avail = components.filter((c) => c.score !== undefined);
  const wsum = avail.reduce((s, c) => s + c.weight, 0);
  const total = components.reduce((s, c) => s + c.weight, 0);
  return {
    score: wsum > 0 ? avail.reduce((s, c) => s + c.score! * c.weight, 0) / wsum : undefined,
    coverage: total > 0 ? wsum / total : 0,
    components: [...components],
  };
}

/** −1…+1 → 0…100. */
export const toScore = (v?: number) => (v === undefined ? undefined : Math.round(((v + 1) / 2) * 100));

export interface ExposureAdvice {
  score?: number;
  coverage: number;
  /** Suggested ceiling of capital at risk, in % of the portfolio. */
  maxExposurePct?: number;
  zone: "risk-on" | "constructive" | "neutral" | "defensive" | "risk-off" | "unknown";
  newEntries: "allowed" | "selective" | "avoid";
  components: Weighted[];
}

/**
 * The exposure coach: market regime (weights in the open) → a ceiling on
 * invested capital and whether to open new positions. Bands: ≥ 80 → 100 %,
 * ≥ 65 → 80 %, ≥ 50 → 60 %, ≥ 35 → 40 %, else 20 %. A ceiling, not a target —
 * the profile's own limits still apply below it.
 */
export function exposureCoach(c: {
  trend?: number;
  breadth?: number;
  credit?: number;
  distribution?: "normal" | "caution" | "high" | "severe";
  followThrough?: FtdState;
  volatility?: number;
  sentiment?: number;
}): ExposureAdvice {
  const distScore = c.distribution === undefined ? undefined : { normal: 90, caution: 60, high: 35, severe: 10 }[c.distribution];
  const ftdScore =
    c.followThrough === undefined ? undefined : { uptrend: 75, "follow-through": 85, "rally-attempt": 40, correction: 15, failed: 25 }[c.followThrough];
  const w = weightedScore([
    {
      id: "trend",
      label: "index trend (vs 50/200-day averages)",
      score: toScore(c.trend),
      weight: 0.25,
      reason: "price above rising averages is the first condition",
    },
    {
      id: "breadth",
      label: "breadth (equal-weight vs cap-weight, % above 200-day)",
      score: toScore(c.breadth),
      weight: 0.2,
      reason: "a rally carried by few stocks is fragile",
    },
    { id: "distribution", label: "distribution days (25 sessions)", score: distScore, weight: 0.15, reason: "institutional selling clusters before tops" },
    { id: "credit", label: "credit (high yield vs investment grade)", score: toScore(c.credit), weight: 0.15, reason: "credit cracks before equities" },
    { id: "followThrough", label: "follow-through state", score: ftdScore, weight: 0.1, reason: "a new uptrend is confirmed by a follow-through day" },
    {
      id: "volatility",
      label: "volatility regime (VIX term structure)",
      score: toScore(c.volatility),
      weight: 0.1,
      reason: "inverted volatility curves mark stress",
    },
    {
      id: "sentiment",
      label: "sentiment (fear & greed, contrarian at extremes)",
      score: toScore(c.sentiment),
      weight: 0.05,
      reason: "extremes are contrarian, the middle is noise",
    },
  ]);
  if (w.score === undefined || w.coverage < 0.5)
    return { score: w.score, coverage: w.coverage, zone: "unknown", newEntries: "selective", components: w.components };
  const s = w.score;
  const [zone, maxExposurePct, newEntries]: [ExposureAdvice["zone"], number, ExposureAdvice["newEntries"]] =
    s >= 80
      ? ["risk-on", 100, "allowed"]
      : s >= 65
        ? ["constructive", 80, "allowed"]
        : s >= 50
          ? ["neutral", 60, "selective"]
          : s >= 35
            ? ["defensive", 40, "avoid"]
            : ["risk-off", 20, "avoid"];
  return { score: s, coverage: w.coverage, maxExposurePct, zone, newEntries, components: w.components };
}

/** Sentiment gauge read contrarian at its extremes: extreme fear → +1 (risk-on for the patient), extreme greed → −1. */
export function contrarianSentiment(fearGreed0to100: number): number {
  if (fearGreed0to100 <= 20) return 0.8;
  if (fearGreed0to100 >= 80) return -0.8;
  return ((50 - fearGreed0to100) / 30) * 0.5;
}

/** VIX term structure: VIX / VIX3M above 1 (inversion) is stress (−1), well below 0.9 is calm (+1). */
export function vixTermSignal(vix: number, vix3m: number): Signal {
  const r = vix / vix3m;
  const value = r >= 1.05 ? -1 : r >= 1 ? -0.5 : r >= 0.9 ? 0.2 : 1;
  return {
    id: "vixTerm",
    label: "VIX / VIX3M",
    value,
    reason: `ratio ${r.toFixed(3)} — ${r >= 1 ? "inverted: near-term fear above longer-term" : "contango: calm"}`,
  };
}

/** Trend of one series: close vs 50/200-day averages and the 200-day's slope, −1…+1. */
export function trendSignal(id: string, label: string, closes: readonly number[]): Signal {
  if (closes.length < 221) return { id, label, reason: `needs 221 sessions, has ${closes.length}` };
  const c = last(closes)!;
  const s50 = last(sma(closes, 50))!;
  const s200a = sma(closes, 200);
  const s200 = last(s200a)!;
  const s200prev = s200a[s200a.length - 21]!;
  let v = 0;
  v += c > s200 ? 0.4 : -0.4;
  v += s50 > s200 ? 0.3 : -0.3;
  v += s200 > s200prev ? 0.3 : -0.3;
  return {
    id,
    label,
    value: v,
    reason: `close ${c > s200 ? "above" : "below"} the 200-day, 50-day ${s50 > s200 ? "above" : "below"} the 200-day, 200-day ${s200 > s200prev ? "rising" : "falling"} over a month`,
  };
}

/**
 * Crypto risk-on score (0–100): BTC trend 25, alt breadth 20, BTC dominance 15
 * (falling dominance = risk appetite), funding 15 (moderately positive is
 * healthy; extreme either way is fragile), drawdown 15, momentum 10.
 */
export function cryptoRegime(c: {
  btcTrend?: number;
  altBreadthPct?: number;
  dominanceChange30d?: number;
  fundingAnnualizedPct?: number;
  btcDrawdownPct?: number;
  btcReturn30dPct?: number;
}): {
  score?: number;
  coverage: number;
  label: string;
  components: Weighted[];
} {
  const funding = c.fundingAnnualizedPct;
  const fundingScore = funding === undefined ? undefined : funding < -10 ? 30 : funding < 0 ? 45 : funding <= 20 ? 75 : funding <= 50 ? 50 : 20;
  const w = weightedScore([
    { id: "btcTrend", label: "BTC trend", score: toScore(c.btcTrend), weight: 0.25, reason: "the market follows its largest asset" },
    {
      id: "altBreadth",
      label: "share of top coins above their 50-day average",
      score: c.altBreadthPct === undefined ? undefined : Math.round(c.altBreadthPct),
      weight: 0.2,
      reason: "broad participation",
    },
    {
      id: "dominance",
      label: "BTC dominance change over 30 days",
      score: c.dominanceChange30d === undefined ? undefined : Math.max(0, Math.min(100, 50 - c.dominanceChange30d * 10)),
      weight: 0.15,
      reason: "falling dominance means appetite for risk further out",
    },
    { id: "funding", label: "perpetual funding, annualised", score: fundingScore, weight: 0.15, reason: "leverage demand: healthy when moderately positive" },
    {
      id: "drawdown",
      label: "BTC drawdown from its high",
      score: c.btcDrawdownPct === undefined ? undefined : Math.max(0, Math.min(100, 100 + c.btcDrawdownPct * 2)),
      weight: 0.15,
      reason: "deep drawdowns are bear markets",
    },
    {
      id: "momentum",
      label: "BTC 30-day return",
      score: c.btcReturn30dPct === undefined ? undefined : Math.max(0, Math.min(100, 50 + c.btcReturn30dPct * 2.5)),
      weight: 0.1,
      reason: "momentum thrust",
    },
  ]);
  const s = w.score;
  return {
    score: s,
    coverage: w.coverage,
    label: s === undefined ? "unknown" : s >= 70 ? "risk-on" : s >= 55 ? "constructive" : s >= 40 ? "neutral" : s >= 25 ? "defensive" : "risk-off",
    components: w.components,
  };
}
