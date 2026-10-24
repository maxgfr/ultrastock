// The builtin technical screens: pure functions of closed daily bars (oldest
// first) and an optional benchmark, each returning pass / fail / not
// evaluable with its reasons and the figures it judged. Two screens rank a
// figure across the screened universe (CAN SLIM's L, RS leaders): they leave
// a `rank` that `applyUniverseRanks` turns into a percentile and a verdict
// once every symbol is in.
//
// Look-ahead: every figure uses bars up to the last one given; the caller
// drops a session that may still be open. Thresholds are the presets' rules
// (src/analyze/screen/presets.ts), restated here as named constants.
import { rsi, sma } from "../../analytics/indicators.js";
import { fiftyTwoWeek, minerviniTrendTemplate, vcp } from "../../analytics/patterns.js";
import type { Bar } from "../../providers/types.js";

export const TECHNICAL_IDS = [
  "minervini",
  "vcp",
  "canslim-technical",
  "momentum-burst",
  "exhaustion-hammer",
  "pullback-to-50",
  "golden-cross",
  "rs-leaders",
] as const;
export type TechnicalId = (typeof TECHNICAL_IDS)[number];

export interface Metric {
  /** Key suffix: `<SYMBOL>.screen.<preset>.<name>`. */
  name: string;
  label: string;
  value: number | string | boolean;
  unit?: string;
  formula?: string;
}

export interface Verdict {
  id: TechnicalId;
  asOf: string;
  /** null = not evaluable (too little history, no volume, no benchmark). */
  pass: boolean | null;
  reasons: string[];
  metrics: Metric[];
  /** A figure ranked across the universe; the verdict needs its percentile ≥ minPercentile. */
  rank?: { value: number | undefined; minPercentile: number; label: string };
}

export interface TechnicalOptions {
  benchmark?: readonly Bar[];
  benchmarkName?: string;
  currency?: string;
}

// Thresholds, as the presets state them.
const BURST_MIN_GAIN = 0.04; // Stockbee: close ≥ 4 % above the previous close
const BURST_MAX_RUNUP = 0.1; // …after no more than 10 % in the 3 sessions before
const BURST_VOL_AVG = 20; // volume above its 20-session average (sessions before today)
const HAMMER_WICK_BODY = 2; // lower wick ≥ 2 × body
const HAMMER_PULLBACK = 10; // after a 10-session decline
const PULLBACK_BAND = 0.02; // close within 2 % of the 50-day
const PULLBACK_RSI: [number, number] = [40, 50];
const CROSS_WINDOW = 10; // golden cross in the last 10 sessions
const NEW_HIGH_WINDOW = 5; // CAN SLIM N: a new 52-week high within the last 5 sessions
const CANSLIM_RS_PCT = 80; // L: top 20 %
const RS_LEADERS_PCT = 90; // top decile
const SIX_MONTHS = 126;

const f2 = (x: number) => x.toFixed(2);
const pctTxt = (x: number) => `${(x * 100).toFixed(2)} %`;

/** Percentile of each defined value within the defined values: 100 × (count strictly below) / (n − 1); a lone value is 100. */
export function percentileRanks(values: ReadonlyArray<number | undefined>): Array<number | undefined> {
  const defined = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
  const n = defined.length;
  return values.map((v) => {
    if (v === undefined || !Number.isFinite(v)) return undefined;
    if (n <= 1) return 100;
    return (100 * defined.filter((w) => w < v).length) / (n - 1);
  });
}

/** Close-to-close return over `n` bars ending at the last bar, or undefined. */
function trailingReturn(closes: readonly number[], n: number): number | undefined {
  const t = closes.length - 1;
  return t >= n ? closes[t]! / closes[t - n]! - 1 : undefined;
}

function benchmarkUpTo(benchmark: readonly Bar[] | undefined, asOf: string): number[] | undefined {
  return benchmark?.filter((b) => b.date <= asOf).map((b) => b.close);
}

function minervini(bars: readonly Bar[], o: TechnicalOptions): Omit<Verdict, "id" | "asOf"> {
  const r = minerviniTrendTemplate(bars, { benchmark: o.benchmark });
  if (!r) return { pass: null, reasons: ["no bars"], metrics: [] };
  const failed = r.criteria.filter((c) => c.pass !== true);
  const reasons = r.allPass
    ? [`all 8 criteria pass`, ...r.criteria.filter((c) => c.id === 8).map((c) => `(8) ${c.reason}`)]
    : failed.map((c) => `(${c.id}) ${c.pass === null ? "not evaluable" : "fails"}: ${c.name} — ${c.reason}`);
  return {
    pass: r.evaluated < 8 ? (failed.some((c) => c.pass === false) ? false : null) : r.allPass,
    reasons,
    metrics: [
      { name: "criteriaPassed", label: "Minervini trend-template criteria passed (of 8)", value: r.passed, unit: "count" },
      { name: "criteriaEvaluated", label: "Minervini trend-template criteria evaluable (of 8)", value: r.evaluated, unit: "count" },
    ],
  };
}

function vcpScreen(bars: readonly Bar[], o: TechnicalOptions): Omit<Verdict, "id" | "asOf"> {
  const r = vcp(bars);
  if (!r) return { pass: null, reasons: ["no bars"], metrics: [] };
  const metrics: Metric[] = [
    { name: "contractions", label: "VCP contractions found", value: r.contractions.length, unit: "count" },
    { name: "status", label: "VCP status (none, forming, breakout)", value: r.status },
  ];
  if (r.pivotPrice !== undefined) metrics.push({ name: "pivot", label: "VCP pivot (high of the last contraction)", value: r.pivotPrice, unit: o.currency });
  return { pass: r.detected, reasons: r.reasons, metrics };
}

function canslim(bars: readonly Bar[], o: TechnicalOptions): Omit<Verdict, "id" | "asOf"> {
  const t = bars.length - 1;
  const reasons: string[] = [];
  let newHigh: boolean | null = null;
  const yr = fiftyTwoWeek(bars);
  if (!yr || yr.barsUsed < 252) reasons.push(`N not evaluable: a 52-week high needs 252 sessions, have ${bars.length}`);
  else {
    let at = -1;
    for (let i = Math.max(0, t - NEW_HIGH_WINDOW + 1); i <= t; i++) if (fiftyTwoWeek(bars, { at: i })?.newHigh) at = i;
    newHigh = at >= 0;
    reasons.push(
      newHigh ? `N passes: new 52-week high on ${bars[at]!.date}` : `N fails: no new 52-week high in the last ${NEW_HIGH_WINDOW} sessions (${yr.reasons[0]})`,
    );
  }
  const crit8 = minerviniTrendTemplate(bars, { benchmark: o.benchmark })?.criteria.find((c) => c.id === 8);
  const rs = crit8?.pass === null ? undefined : crit8?.value;
  reasons.push(rs === undefined ? `L not evaluable: ${crit8?.reason ?? "no benchmark"}` : `L input: ${crit8!.reason}`);
  const metrics: Metric[] = [];
  if (newHigh !== null) metrics.push({ name: "newHigh", label: `new 52-week high in the last ${NEW_HIGH_WINDOW} sessions`, value: newHigh });
  if (rs !== undefined)
    metrics.push({
      name: "relativeStrength",
      label: `IBD-weighted 12-month performance minus ${o.benchmarkName ?? "the benchmark"}'s`,
      value: rs,
      unit: "pp",
      formula: "(0.4·r(0,63) + 0.2·r(63,126) + 0.2·r(126,189) + 0.2·r(189,252)) − same for the benchmark, × 100",
    });
  return {
    pass: newHigh === false ? false : newHigh === null || rs === undefined ? null : true,
    reasons,
    metrics,
    rank: { value: rs, minPercentile: CANSLIM_RS_PCT, label: "L: relative-strength percentile in the screened universe" },
  };
}

function momentumBurst(bars: readonly Bar[]): Omit<Verdict, "id" | "asOf"> {
  const t = bars.length - 1;
  if (t < Math.max(BURST_VOL_AVG, 4)) return { pass: null, reasons: [`needs ${BURST_VOL_AVG + 1} sessions, have ${bars.length}`], metrics: [] };
  const vol = bars.map((b) => b.volume);
  if (vol.slice(t - BURST_VOL_AVG, t + 1).some((v) => v === undefined)) return { pass: null, reasons: ["no volume data"], metrics: [] };
  const c = bars.map((b) => b.close);
  const gain = c[t]! / c[t - 1]! - 1;
  const avg = vol.slice(t - BURST_VOL_AVG, t).reduce((s, v) => s! + v!, 0)! / BURST_VOL_AVG;
  const runup = c[t - 1]! / c[t - 4]! - 1;
  const checks: Array<[boolean, string]> = [
    [gain >= BURST_MIN_GAIN, `close ${pctTxt(gain)} vs the previous close (needs ≥ ${pctTxt(BURST_MIN_GAIN)})`],
    [vol[t]! > vol[t - 1]!, `volume ${vol[t]} vs ${vol[t - 1]} the session before`],
    [vol[t]! > avg, `volume ${vol[t]} vs its ${BURST_VOL_AVG}-session average ${Math.round(avg)}`],
    [runup <= BURST_MAX_RUNUP, `${pctTxt(runup)} over the 3 sessions before (needs ≤ ${pctTxt(BURST_MAX_RUNUP)})`],
  ];
  return {
    pass: checks.every(([ok]) => ok),
    reasons: checks.map(([ok, r]) => `${ok ? "pass" : "fail"}: ${r}`),
    metrics: [
      { name: "dayGain", label: "close vs the previous close", value: gain * 100, unit: "%", formula: "(close / close[t−1] − 1) × 100" },
      { name: "volumeVsAvg20", label: "volume vs its 20-session average", value: vol[t]! / avg, unit: "x", formula: "volume / mean(volume[t−20 … t−1])" },
      { name: "runup3d", label: "return over the 3 sessions before", value: runup * 100, unit: "%", formula: "(close[t−1] / close[t−4] − 1) × 100" },
    ],
  };
}

function exhaustionHammer(bars: readonly Bar[]): Omit<Verdict, "id" | "asOf"> {
  const t = bars.length - 1;
  if (t < HAMMER_PULLBACK + 1) return { pass: null, reasons: [`needs ${HAMMER_PULLBACK + 2} sessions, have ${bars.length}`], metrics: [] };
  const b = bars[t]!;
  const body = Math.abs(b.close - b.open);
  const wick = Math.min(b.open, b.close) - b.low;
  const pull = bars[t - 1]!.close / bars[t - 1 - HAMMER_PULLBACK]!.close - 1;
  const checks: Array<[boolean, string]> = [
    [wick > 0 && wick >= HAMMER_WICK_BODY * body, `lower wick ${f2(wick)} vs body ${f2(body)} (needs ≥ ${HAMMER_WICK_BODY}×)`],
    [pull < 0, `${pctTxt(pull)} over the ${HAMMER_PULLBACK} sessions before (needs a decline)`],
    [b.close > bars[t - 1]!.low, `close ${f2(b.close)} vs the previous low ${f2(bars[t - 1]!.low)}`],
  ];
  return {
    pass: checks.every(([ok]) => ok),
    reasons: checks.map(([ok, r]) => `${ok ? "pass" : "fail"}: ${r}`),
    metrics: [
      {
        name: "wickToBody",
        label: "lower wick to body",
        value: body > 0 ? wick / body : wick > 0 ? 999 : 0,
        unit: "x",
        formula: "(min(open, close) − low) / |close − open| (999 when the body is zero)",
      },
      { name: "pullback10d", label: "return over the 10 sessions before", value: pull * 100, unit: "%", formula: "(close[t−1] / close[t−11] − 1) × 100" },
    ],
  };
}

function pullbackTo50(bars: readonly Bar[]): Omit<Verdict, "id" | "asOf"> {
  const c = bars.map((b) => b.close);
  const t = c.length - 1;
  const s50 = sma(c, 50)[t];
  const s200 = sma(c, 200)[t];
  const r = rsi(c, 14)[t];
  if (s50 === undefined || s200 === undefined || r === undefined) return { pass: null, reasons: [`needs 200 sessions, have ${bars.length}`], metrics: [] };
  const dist = c[t]! / s50 - 1;
  const checks: Array<[boolean, string]> = [
    [c[t]! > s200 && s50 > s200, `close ${f2(c[t]!)}, SMA50 ${f2(s50)}, SMA200 ${f2(s200)} (needs close and SMA50 above SMA200)`],
    [Math.abs(dist) <= PULLBACK_BAND, `close ${pctTxt(dist)} from the SMA50 (needs within ${pctTxt(PULLBACK_BAND)})`],
    [r >= PULLBACK_RSI[0] && r <= PULLBACK_RSI[1], `RSI(14) ${f2(r)} (needs ${PULLBACK_RSI[0]}–${PULLBACK_RSI[1]})`],
  ];
  return {
    pass: checks.every(([ok]) => ok),
    reasons: checks.map(([ok, x]) => `${ok ? "pass" : "fail"}: ${x}`),
    metrics: [
      { name: "vsSma50", label: "close vs the 50-day SMA", value: dist * 100, unit: "%", formula: "(close / SMA50 − 1) × 100" },
      { name: "rsi14", label: "RSI(14), Wilder", value: r, unit: "index" },
    ],
  };
}

function goldenCross(bars: readonly Bar[]): Omit<Verdict, "id" | "asOf"> {
  const c = bars.map((b) => b.close);
  const t = c.length - 1;
  const s50 = sma(c, 50);
  const s200 = sma(c, 200);
  if (s200[t] === undefined || t - CROSS_WINDOW < 199)
    return { pass: null, reasons: [`needs ${200 + CROSS_WINDOW} sessions, have ${bars.length}`], metrics: [] };
  let crossed = -1;
  for (let i = t - CROSS_WINDOW + 1; i <= t; i++) if (s50[i - 1]! <= s200[i - 1]! && s50[i]! > s200[i]!) crossed = i;
  const above = s50[t]! > s200[t]!;
  const reasons = [
    crossed >= 0
      ? `pass: SMA50 crossed above SMA200 on ${bars[crossed]!.date}`
      : `fail: no upward cross of SMA50 over SMA200 in the last ${CROSS_WINDOW} sessions`,
    `${above ? "pass" : "fail"}: SMA50 ${f2(s50[t]!)} vs SMA200 ${f2(s200[t]!)} now`,
  ];
  const metrics: Metric[] = [
    { name: "sma50vs200", label: "SMA50 vs SMA200", value: (s50[t]! / s200[t]! - 1) * 100, unit: "%", formula: "(SMA50 / SMA200 − 1) × 100" },
  ];
  if (crossed >= 0) metrics.push({ name: "crossDate", label: "golden-cross date", value: bars[crossed]!.date });
  return { pass: crossed >= 0 && above, reasons, metrics };
}

function rsLeaders(bars: readonly Bar[], o: TechnicalOptions): Omit<Verdict, "id" | "asOf"> {
  const mine = trailingReturn(
    bars.map((b) => b.close),
    SIX_MONTHS,
  );
  const bc = benchmarkUpTo(o.benchmark, bars[bars.length - 1]!.date);
  const theirs = bc ? trailingReturn(bc, SIX_MONTHS) : undefined;
  const name = o.benchmarkName ?? "the benchmark";
  if (mine === undefined || theirs === undefined)
    return {
      pass: null,
      reasons: [mine === undefined ? `needs ${SIX_MONTHS + 1} sessions, have ${bars.length}` : `no ${SIX_MONTHS + 1}-session history for ${name}`],
      metrics: [],
      rank: { value: undefined, minPercentile: RS_LEADERS_PCT, label: "6-month relative-strength percentile in the screened universe" },
    };
  const excess = (mine - theirs) * 100;
  return {
    pass: true,
    reasons: [`6-month return ${pctTxt(mine)} vs ${name} ${pctTxt(theirs)}: ${excess.toFixed(2)} pp`],
    metrics: [
      { name: "return6m", label: "6-month return (126 sessions)", value: mine * 100, unit: "%", formula: "(close / close[t−126] − 1) × 100" },
      {
        name: "excess6m",
        label: `6-month return minus ${name}'s`,
        value: excess,
        unit: "pp",
        formula: `return6m − ${name}'s 126-session return to the same date`,
      },
    ],
    rank: { value: excess, minPercentile: RS_LEADERS_PCT, label: "6-month relative-strength percentile in the screened universe" },
  };
}

/** One technical screen on one symbol's closed daily bars (oldest first). */
export function technicalVerdict(id: TechnicalId, bars: readonly Bar[], opts: TechnicalOptions = {}): Verdict {
  const asOf = bars[bars.length - 1]?.date ?? "";
  if (!bars.length) return { id, asOf, pass: null, reasons: ["no bars"], metrics: [] };
  const run = {
    minervini: () => minervini(bars, opts),
    vcp: () => vcpScreen(bars, opts),
    "canslim-technical": () => canslim(bars, opts),
    "momentum-burst": () => momentumBurst(bars),
    "exhaustion-hammer": () => exhaustionHammer(bars),
    "pullback-to-50": () => pullbackTo50(bars),
    "golden-cross": () => goldenCross(bars),
    "rs-leaders": () => rsLeaders(bars, opts),
  }[id];
  return { id, asOf, ...run() };
}

/**
 * Resolve the cross-sectional part: each ranked figure's percentile among the
 * symbols that have one; a verdict that passed its own checks passes only if
 * the percentile reaches the threshold. The percentile is registered as a metric.
 */
export function applyUniverseRanks(verdicts: readonly Verdict[]): Verdict[] {
  const pct = percentileRanks(verdicts.map((v) => v.rank?.value));
  const n = pct.filter((p) => p !== undefined).length;
  return verdicts.map((v, i) => {
    if (!v.rank) return v;
    const p = pct[i];
    if (p === undefined) return { ...v, pass: v.pass === false ? false : null };
    const ok = p >= v.rank.minPercentile;
    return {
      ...v,
      pass: v.pass === true ? ok : v.pass,
      reasons: [...v.reasons, `${ok ? "pass" : "fail"}: ${v.rank.label} ${p.toFixed(1)} (needs ≥ ${v.rank.minPercentile}; ${n} symbols ranked)`],
      metrics: [
        ...v.metrics,
        {
          name: "percentile",
          label: v.rank.label,
          value: p,
          unit: "percentile",
          formula: `100 × (symbols with a lower value) / (${n} ranked − 1)`,
        },
      ],
    };
  });
}
