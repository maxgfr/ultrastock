// Chart patterns: swing pivots, support/resistance, 52-week range, the
// Minervini trend template, VCP, Darvas boxes, gaps and volume-confirmed
// breakouts. Every detector answers "as of bar `at`" (the last bar by
// default) using bars 0 … at only, and returns its reasons — which checks
// passed, by how much — not just a boolean.
//
// Look-ahead discipline: a fractal pivot at bar p needs `right` later bars to
// exist, so it is only *known* at p + right (its `confirmedIndex`); every
// consumer here filters pivots by confirmedIndex ≤ at.
import type { Bar } from "../providers/types.js";
import { atr, sma } from "./indicators.js";

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)} %`;
const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(3) : x.toPrecision(4));
const lastIndex = (bars: readonly Bar[], at?: number) => Math.min(at ?? bars.length - 1, bars.length - 1);

export interface SwingPivot {
  type: "high" | "low";
  /** The pivot bar. */
  index: number;
  date: string;
  price: number;
  /** First bar at which the pivot is known: index + right. */
  confirmedIndex: number;
  confirmedDate: string;
}

/**
 * Fractal swing pivots (Bill Williams' fractal generalised to left/right n):
 * a pivot high's high is strictly above the `left` highs before it and ≥ the
 * `right` highs after it (so a flat top counts once, at its first bar);
 * mirror for lows. Sorted by confirmation, then by bar.
 */
export function swingPivots(bars: readonly Bar[], left = 5, right = 5): SwingPivot[] {
  const out: SwingPivot[] = [];
  for (let p = left; p + right < bars.length; p++) {
    const b = bars[p]!;
    let isHigh = true;
    let isLow = true;
    for (let j = p - left; j < p && (isHigh || isLow); j++) {
      if (bars[j]!.high >= b.high) isHigh = false;
      if (bars[j]!.low <= b.low) isLow = false;
    }
    for (let j = p + 1; j <= p + right && (isHigh || isLow); j++) {
      if (bars[j]!.high > b.high) isHigh = false;
      if (bars[j]!.low < b.low) isLow = false;
    }
    const c = p + right;
    if (isHigh) out.push({ type: "high", index: p, date: b.date, price: b.high, confirmedIndex: c, confirmedDate: bars[c]!.date });
    if (isLow) out.push({ type: "low", index: p, date: b.date, price: b.low, confirmedIndex: c, confirmedDate: bars[c]!.date });
  }
  return out.sort((a, b) => a.confirmedIndex - b.confirmedIndex || a.index - b.index);
}

// ---- support / resistance ------------------------------------------------------------

export interface PriceLevel {
  /** Mean price of the clustered pivots. */
  price: number;
  low: number;
  high: number;
  touches: number;
  pivotHighs: number;
  pivotLows: number;
  kind: "support" | "resistance";
  /** (price − close)/close × 100. */
  distancePct: number;
  /** (price − close)/ATR. */
  distanceAtr: number;
  firstDate: string;
  lastDate: string;
  pivots: SwingPivot[];
  reasons: string[];
}

export interface SupportResistanceOptions {
  left?: number;
  right?: number;
  atrPeriod?: number;
  /** Cluster width: pivots within tolerance × ATR of a cluster's mean join it. Default 0.5. */
  tolerance?: number;
  minTouches?: number;
  /** Only pivots from the last `lookback` bars. Default 252. */
  lookback?: number;
  at?: number;
}

export interface SupportResistanceResult {
  asOf: string;
  index: number;
  close: number;
  atr: number;
  /** Cluster width in price units. */
  tolerance: number;
  levels: PriceLevel[];
  reasons: string[];
}

/**
 * Support/resistance levels by clustering confirmed swing pivots: sorted by
 * price, a pivot joins the current cluster when it lies within tolerance × ATR
 * of the cluster mean. Levels with ≥ minTouches pivots are kept, labelled
 * support (below the close) or resistance, strongest (most touches) first.
 */
export function supportResistance(bars: readonly Bar[], opts: SupportResistanceOptions = {}): SupportResistanceResult | undefined {
  const { left = 5, right = 5, atrPeriod = 14, tolerance = 0.5, minTouches = 2, lookback = 252 } = opts;
  const at = lastIndex(bars, opts.at);
  if (at < 0) return undefined;
  const close = bars[at]!.close;
  const reasons: string[] = [];
  let a = atr(bars.slice(0, at + 1), atrPeriod)[at];
  if (a === undefined) {
    const from = Math.max(0, at - atrPeriod + 1);
    const w = bars.slice(from, at + 1);
    a = w.reduce((s, b) => s + b.high - b.low, 0) / w.length;
    reasons.push(`fewer than ${atrPeriod + 1} bars: ATR approximated by the mean high − low (${fmt(a)})`);
  }
  const tol = tolerance * a;
  const pivots = swingPivots(bars.slice(0, at + 1), left, right).filter((p) => p.index >= at - lookback);
  reasons.push(`${pivots.length} swing pivots (${left}/${right} fractal) confirmed in the last ${lookback} bars; cluster width ${tolerance} ATR = ${fmt(tol)}`);
  const sorted = [...pivots].sort((x, y) => x.price - y.price);
  const clusters: SwingPivot[][] = [];
  let cur: SwingPivot[] = [];
  let sum = 0;
  for (const p of sorted) {
    if (cur.length > 0 && p.price - sum / cur.length > tol) {
      clusters.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(p);
    sum += p.price;
  }
  if (cur.length > 0) clusters.push(cur);
  const levels: PriceLevel[] = [];
  for (const c of clusters) {
    if (c.length < minTouches) continue;
    const price = c.reduce((s, p) => s + p.price, 0) / c.length;
    const highs = c.filter((p) => p.type === "high").length;
    const byDate = [...c].sort((x, y) => x.index - y.index);
    const kind = price < close ? "support" : "resistance";
    const distanceAtr = a === 0 ? 0 : (price - close) / a;
    levels.push({
      price,
      low: Math.min(...c.map((p) => p.price)),
      high: Math.max(...c.map((p) => p.price)),
      touches: c.length,
      pivotHighs: highs,
      pivotLows: c.length - highs,
      kind,
      distancePct: ((price - close) / close) * 100,
      distanceAtr,
      firstDate: byDate[0]!.date,
      lastDate: byDate[byDate.length - 1]!.date,
      pivots: byDate,
      reasons: [
        `${c.length} touches (${highs} swing highs, ${c.length - highs} swing lows) between ${fmt(Math.min(...c.map((p) => p.price)))} and ${fmt(Math.max(...c.map((p) => p.price)))}`,
        `last touch ${byDate[byDate.length - 1]!.date}`,
        `${kind}: ${fmt(Math.abs(distanceAtr))} ATR ${price < close ? "below" : "above"} the close ${fmt(close)}`,
      ],
    });
  }
  levels.sort((x, y) => y.touches - x.touches || Math.abs(x.distanceAtr) - Math.abs(y.distanceAtr));
  if (levels.length === 0) reasons.push(`no cluster reached ${minTouches} touches`);
  return { asOf: bars[at]!.date, index: at, close, atr: a, tolerance: tol, levels, reasons };
}

// ---- 52-week range ------------------------------------------------------------------------

export interface YearRange {
  asOf: string;
  close: number;
  high: number;
  highDate: string;
  low: number;
  lowDate: string;
  /** (close / high − 1) × 100 — ≤ 0. */
  pctFromHigh: number;
  /** (close / low − 1) × 100 — ≥ 0. */
  pctAboveLow: number;
  nearHigh: boolean;
  nearLow: boolean;
  /** Bar `at` set the window's high (or low). */
  newHigh: boolean;
  newLow: boolean;
  barsUsed: number;
  reasons: string[];
}

/** 52-week (252-bar) high/low proximity from intraday highs and lows, "near" = within `nearPct` %. */
export function fiftyTwoWeek(bars: readonly Bar[], opts: { lookback?: number; nearPct?: number; at?: number } = {}): YearRange | undefined {
  const { lookback = 252, nearPct = 5 } = opts;
  const at = lastIndex(bars, opts.at);
  if (at < 0) return undefined;
  const from = Math.max(0, at - lookback + 1);
  let hi = from;
  let lo = from;
  for (let i = from; i <= at; i++) {
    if (bars[i]!.high >= bars[hi]!.high) hi = i;
    if (bars[i]!.low <= bars[lo]!.low) lo = i;
  }
  const close = bars[at]!.close;
  const high = bars[hi]!.high;
  const low = bars[lo]!.low;
  const pctFromHigh = (close / high - 1) * 100;
  const pctAboveLow = (close / low - 1) * 100;
  const barsUsed = at - from + 1;
  const reasons = [
    `high ${fmt(high)} on ${bars[hi]!.date}: close ${fmt(close)} is ${Math.abs(pctFromHigh).toFixed(2)} % below it`,
    `low ${fmt(low)} on ${bars[lo]!.date}: close is ${pctAboveLow.toFixed(2)} % above it`,
  ];
  if (barsUsed < lookback) reasons.push(`only ${barsUsed} of ${lookback} bars available`);
  return {
    asOf: bars[at]!.date,
    close,
    high,
    highDate: bars[hi]!.date,
    low,
    lowDate: bars[lo]!.date,
    pctFromHigh,
    pctAboveLow,
    nearHigh: pctFromHigh >= -nearPct,
    nearLow: pctAboveLow <= nearPct,
    newHigh: hi === at,
    newLow: lo === at,
    barsUsed,
    reasons,
  };
}

// ---- Minervini trend template ---------------------------------------------------------

export interface Criterion {
  id: number;
  name: string;
  /** null when it cannot be evaluated (too little history, no RS input). */
  pass: boolean | null;
  value?: number;
  threshold?: number;
  reason: string;
}

export interface TrendTemplateResult {
  asOf: string;
  passed: number;
  evaluated: number;
  total: 8;
  /** All eight criteria pass. */
  allPass: boolean;
  criteria: Criterion[];
}

/** IBD-style weighted 12-month performance: 40 % on the last quarter, 20 % on each of the three before. */
function weightedPerformance(closes: readonly number[], at: number): number | undefined {
  if (at < 252) return undefined;
  const r = (a: number, b: number) => closes[at - a]! / closes[at - b]! - 1;
  return 0.4 * r(0, 63) + 0.2 * r(63, 126) + 0.2 * r(126, 189) + 0.2 * r(189, 252);
}

/**
 * Mark Minervini's trend template (Trade Like a Stock Market Wizard, 2013):
 * (1) price > 150- and 200-day SMA, (2) 150 > 200, (3) 200-day SMA rising for
 * ≥ 1 month (21 bars), (4) 50 > 150 and 200, (5) price > 50-day, (6) ≥ 30 %
 * above the 52-week low, (7) within 25 % of the 52-week high, (8) RS rating ≥ 70.
 * The RS rating is an IBD percentile over all stocks: pass `rsRating` if you
 * have it; with only a `benchmark`, criterion 8 is approximated by the stock's
 * IBD-weighted 12-month performance beating the benchmark's (said so in the reason).
 */
export function minerviniTrendTemplate(
  bars: readonly Bar[],
  opts: { benchmark?: readonly Bar[]; rsRating?: number; at?: number } = {},
): TrendTemplateResult | undefined {
  const at = lastIndex(bars, opts.at);
  if (at < 0) return undefined;
  const closes = bars.slice(0, at + 1).map((b) => b.close);
  const close = closes[at]!;
  const s50 = sma(closes, 50)[at];
  const s150 = sma(closes, 150)[at];
  const s200series = sma(closes, 200);
  const s200 = s200series[at];
  const s200then = at >= 21 ? s200series[at - 21] : undefined;
  const yr = fiftyTwoWeek(bars, { at });
  const need = (n: number) => `needs ${n} bars, have ${at + 1}`;
  const criteria: Criterion[] = [];
  const add = (c: Criterion) => criteria.push(c);

  add(
    s150 === undefined || s200 === undefined
      ? { id: 1, name: "Price above the 150- and 200-day SMA", pass: null, reason: need(200) }
      : {
          id: 1,
          name: "Price above the 150- and 200-day SMA",
          pass: close > s150 && close > s200,
          value: close,
          threshold: Math.max(s150, s200),
          reason: `close ${fmt(close)} vs SMA150 ${fmt(s150)} and SMA200 ${fmt(s200)}`,
        },
  );
  add(
    s150 === undefined || s200 === undefined
      ? { id: 2, name: "150-day SMA above the 200-day", pass: null, reason: need(200) }
      : { id: 2, name: "150-day SMA above the 200-day", pass: s150 > s200, value: s150, threshold: s200, reason: `SMA150 ${fmt(s150)} vs SMA200 ${fmt(s200)}` },
  );
  add(
    s200 === undefined || s200then === undefined
      ? { id: 3, name: "200-day SMA rising for at least a month", pass: null, reason: need(221) }
      : {
          id: 3,
          name: "200-day SMA rising for at least a month",
          pass: s200 > s200then,
          value: (s200 / s200then - 1) * 100,
          threshold: 0,
          reason: `SMA200 ${fmt(s200)} vs ${fmt(s200then)} 21 bars ago (${pct(s200 / s200then - 1)})`,
        },
  );
  add(
    s50 === undefined || s150 === undefined || s200 === undefined
      ? { id: 4, name: "50-day SMA above the 150- and 200-day", pass: null, reason: need(200) }
      : {
          id: 4,
          name: "50-day SMA above the 150- and 200-day",
          pass: s50 > s150 && s50 > s200,
          value: s50,
          threshold: Math.max(s150, s200),
          reason: `SMA50 ${fmt(s50)} vs SMA150 ${fmt(s150)} and SMA200 ${fmt(s200)}`,
        },
  );
  add(
    s50 === undefined
      ? { id: 5, name: "Price above the 50-day SMA", pass: null, reason: need(50) }
      : { id: 5, name: "Price above the 50-day SMA", pass: close > s50, value: close, threshold: s50, reason: `close ${fmt(close)} vs SMA50 ${fmt(s50)}` },
  );
  const fullYear = yr !== undefined && yr.barsUsed >= 252;
  add(
    !yr || !fullYear
      ? { id: 6, name: "At least 30 % above the 52-week low", pass: null, reason: need(252) }
      : {
          id: 6,
          name: "At least 30 % above the 52-week low",
          pass: close >= 1.3 * yr.low,
          value: yr.pctAboveLow,
          threshold: 30,
          reason: `${yr.pctAboveLow.toFixed(1)} % above the low ${fmt(yr.low)} (${yr.lowDate})`,
        },
  );
  add(
    !yr || !fullYear
      ? { id: 7, name: "Within 25 % of the 52-week high", pass: null, reason: need(252) }
      : {
          id: 7,
          name: "Within 25 % of the 52-week high",
          pass: close >= 0.75 * yr.high,
          value: yr.pctFromHigh,
          threshold: -25,
          reason: `${Math.abs(yr.pctFromHigh).toFixed(1)} % below the high ${fmt(yr.high)} (${yr.highDate})`,
        },
  );
  if (opts.rsRating !== undefined) {
    add({
      id: 8,
      name: "Relative-strength rating ≥ 70",
      pass: opts.rsRating >= 70,
      value: opts.rsRating,
      threshold: 70,
      reason: `RS rating ${opts.rsRating} (given)`,
    });
  } else if (opts.benchmark) {
    const bench = opts.benchmark;
    const target = bars[at]!.date;
    const bc = bench.filter((b) => b.date <= target).map((b) => b.close);
    const mine = weightedPerformance(closes, at);
    const theirs = weightedPerformance(bc, bc.length - 1);
    add(
      mine === undefined || theirs === undefined
        ? { id: 8, name: "Relative-strength rating ≥ 70", pass: null, reason: "RS proxy needs 253 bars of the stock and the benchmark" }
        : {
            id: 8,
            name: "Relative-strength rating ≥ 70",
            pass: mine > theirs,
            value: (mine - theirs) * 100,
            threshold: 0,
            reason: `proxy, not an IBD percentile: weighted 12-month performance ${pct(mine)} vs benchmark ${pct(theirs)}`,
          },
    );
  } else {
    add({ id: 8, name: "Relative-strength rating ≥ 70", pass: null, reason: "no RS rating or benchmark given" });
  }
  const passed = criteria.filter((c) => c.pass === true).length;
  const evaluated = criteria.filter((c) => c.pass !== null).length;
  return { asOf: bars[at]!.date, passed, evaluated, total: 8, allPass: passed === 8, criteria };
}

// ---- VCP ---------------------------------------------------------------------------------

export interface Contraction {
  highIndex: number;
  highDate: string;
  high: number;
  lowIndex: number;
  lowDate: string;
  low: number;
  /** (high − low)/high × 100. */
  depthPct: number;
  /** Mean volume from the high to the low. */
  avgVolume: number;
  /** The low is the lowest low since the last confirmed swing high, not yet a confirmed pivot. */
  provisional: boolean;
}

export interface Check {
  name: string;
  pass: boolean;
  reason: string;
}

export interface VcpResult {
  asOf: string;
  detected: boolean;
  /** "breakout" = detected and the close is above the pivot. */
  status: "none" | "forming" | "breakout";
  contractions: Contraction[];
  /** Buy point: the high the last contraction started from. */
  pivotPrice?: number;
  checks: Check[];
  reasons: string[];
}

export interface VcpOptions {
  left?: number;
  right?: number;
  /** Base length searched, in bars. Default 260. */
  lookback?: number;
  minContractions?: number;
  /** Deepest allowed first contraction, %. Default 40. */
  maxDepthPct?: number;
  /** Deepest allowed final contraction, %. Default 10. */
  maxFinalDepthPct?: number;
  at?: number;
}

/**
 * Minervini's volatility contraction pattern: successive pullbacks (swing
 * high → next swing low) each shallower than the one before, on drying-up
 * volume, the last one tight; the pivot is the high of the last contraction.
 * Takes the longest run of strictly shrinking contractions ending at the
 * latest one. Combine with the trend template — a VCP is a continuation pattern.
 */
export function vcp(bars: readonly Bar[], opts: VcpOptions = {}): VcpResult | undefined {
  const { left = 3, right = 3, lookback = 260, minContractions = 2, maxDepthPct = 40, maxFinalDepthPct = 10 } = opts;
  const at = lastIndex(bars, opts.at);
  if (at < 0) return undefined;
  const known = bars.slice(0, at + 1);
  const pivots = swingPivots(known, left, right)
    .filter((p) => p.index >= at - lookback)
    .sort((a, b) => a.index - b.index);
  // Alternate highs and lows, keeping the extreme of consecutive same-type pivots.
  const alt: SwingPivot[] = [];
  for (const p of pivots) {
    const last = alt[alt.length - 1];
    if (last && last.type === p.type) {
      if ((p.type === "high" && p.price > last.price) || (p.type === "low" && p.price < last.price)) alt[alt.length - 1] = p;
    } else alt.push(p);
  }
  const avgVol = (from: number, to: number) => {
    let s = 0;
    for (let i = from; i <= to; i++) s += known[i]!.volume ?? 0;
    return s / (to - from + 1);
  };
  const all: Contraction[] = [];
  const mk = (h: SwingPivot, lowIndex: number, low: number, provisional: boolean): Contraction => ({
    highIndex: h.index,
    highDate: h.date,
    high: h.price,
    lowIndex,
    lowDate: known[lowIndex]!.date,
    low,
    depthPct: ((h.price - low) / h.price) * 100,
    avgVolume: avgVol(h.index, lowIndex),
    provisional,
  });
  for (let k = 0; k + 1 < alt.length; k++) {
    const h = alt[k]!;
    const l = alt[k + 1]!;
    if (h.type === "high" && l.type === "low") all.push(mk(h, l.index, l.price, false));
  }
  const tail = alt[alt.length - 1];
  if (tail?.type === "high" && tail.index < at) {
    let lo = tail.index + 1;
    for (let i = tail.index + 1; i <= at; i++) if (known[i]!.low < known[lo]!.low) lo = i;
    if (known[lo]!.low < tail.price) all.push(mk(tail, lo, known[lo]!.low, true));
  }
  let start = all.length - 1;
  while (start > 0 && all[start - 1]!.depthPct > all[start]!.depthPct) start--;
  const contractions = start >= 0 ? all.slice(start) : [];
  const first = contractions[0];
  const lastC = contractions[contractions.length - 1];
  const checks: Check[] = [
    {
      name: `at least ${minContractions} successively shallower contractions`,
      pass: contractions.length >= minContractions,
      reason: contractions.length
        ? `${contractions.length} contraction(s): ${contractions.map((c) => `${c.depthPct.toFixed(1)} %`).join(" → ")}`
        : "no swing high → swing low pullback in the base",
    },
  ];
  if (first && lastC) {
    checks.push(
      {
        name: `first contraction ≤ ${maxDepthPct} %`,
        pass: first.depthPct <= maxDepthPct,
        reason: `first pullback ${first.depthPct.toFixed(1)} % from ${fmt(first.high)} (${first.highDate})`,
      },
      {
        name: `final contraction ≤ ${maxFinalDepthPct} %`,
        pass: lastC.depthPct <= maxFinalDepthPct,
        reason: `last pullback ${lastC.depthPct.toFixed(1)} %${lastC.provisional ? " (still forming)" : ""}`,
      },
      {
        name: "volume dries up",
        pass: contractions.length >= 2 && lastC.avgVolume < first.avgVolume,
        reason:
          first.avgVolume > 0 ? `average volume ${fmt(lastC.avgVolume)} in the last contraction vs ${fmt(first.avgVolume)} in the first` : "no volume data",
      },
    );
  }
  const detected = checks.every((c) => c.pass);
  const pivotPrice = lastC?.high;
  const close = known[at]!.close;
  const status = !detected ? "none" : pivotPrice !== undefined && close > pivotPrice ? "breakout" : "forming";
  const reasons = checks.map((c) => `${c.pass ? "pass" : "fail"}: ${c.name} — ${c.reason}`);
  if (pivotPrice !== undefined) reasons.push(`pivot ${fmt(pivotPrice)}; close ${fmt(close)} (${pct(close / pivotPrice - 1)} from it)`);
  return { asOf: known[at]!.date, detected, status, contractions, pivotPrice, checks, reasons };
}

// ---- Darvas boxes --------------------------------------------------------------------------

export interface DarvasBox {
  top: number;
  topIndex: number;
  topDate: string;
  bottom: number;
  bottomIndex: number;
  bottomDate: string;
  /** Bar at which both edges were confirmed. */
  confirmedIndex: number;
  confirmedDate: string;
  /** "open" = still active at the last bar. */
  end: "breakout" | "breakdown" | "open";
  endIndex?: number;
  endDate?: string;
  reasons: string[];
}

/**
 * Nicolas Darvas' boxes (How I Made $2,000,000 in the Stock Market, 1960): the
 * top is a high not exceeded for `confirm` (3) following bars; the bottom the
 * lowest low after it, not undercut for `confirm` bars (a new high before that
 * restarts the top). The box ends when a close leaves it — above the top
 * (breakout) or below the bottom (breakdown) — and a new top search starts at that bar.
 */
export function darvasBoxes(bars: readonly Bar[], opts: { confirm?: number; at?: number } = {}): DarvasBox[] {
  const confirm = opts.confirm ?? 3;
  const at = lastIndex(bars, opts.at);
  const boxes: DarvasBox[] = [];
  if (at < 0) return boxes;
  let state: "top" | "bottom" | "box" = "top";
  let topIdx = 0;
  let botIdx = 0;
  let box: DarvasBox | undefined;
  const restart = (i: number) => {
    state = "top";
    topIdx = i;
  };
  for (let i = 1; i <= at; i++) {
    const b = bars[i]!;
    if (state === "top") {
      if (b.high > bars[topIdx]!.high) topIdx = i;
      else if (i - topIdx >= confirm) {
        state = "bottom";
        botIdx = topIdx + 1;
        for (let j = topIdx + 1; j <= i; j++) if (bars[j]!.low < bars[botIdx]!.low) botIdx = j;
      }
    } else if (state === "bottom") {
      if (b.high > bars[topIdx]!.high) {
        restart(i);
        continue;
      }
      if (b.low < bars[botIdx]!.low) botIdx = i;
    }
    if (state === "bottom" && i - botIdx >= confirm) {
      const t = bars[topIdx]!;
      const lo = bars[botIdx]!;
      box = {
        top: t.high,
        topIndex: topIdx,
        topDate: t.date,
        bottom: lo.low,
        bottomIndex: botIdx,
        bottomDate: lo.date,
        confirmedIndex: i,
        confirmedDate: b.date,
        end: "open",
        reasons: [`top ${fmt(t.high)} (${t.date}) held ${confirm} bars; bottom ${fmt(lo.low)} (${lo.date}) held ${confirm} bars; confirmed ${b.date}`],
      };
      state = "box";
      continue;
    }
    if (state === "box" && box) {
      if (b.close > box.top || b.close < box.bottom) {
        const up = b.close > box.top;
        box.end = up ? "breakout" : "breakdown";
        box.endIndex = i;
        box.endDate = b.date;
        box.reasons.push(`${up ? "breakout" : "breakdown"}: close ${fmt(b.close)} ${up ? "above the top" : "below the bottom"} on ${b.date}`);
        boxes.push(box);
        box = undefined;
        restart(i);
      }
    }
  }
  if (state === "box" && box) {
    box.reasons.push(`still open at ${bars[at]!.date}`);
    boxes.push(box);
  }
  return boxes;
}

// ---- gaps ------------------------------------------------------------------------------------

export interface Gap {
  index: number;
  date: string;
  direction: "up" | "down";
  /** The untraded zone between the two bars. */
  gapLow: number;
  gapHigh: number;
  size: number;
  /** size / previous close × 100. */
  sizePct: number;
  /** size / ATR at the previous bar (known before the gap); undefined during the ATR warm-up. */
  sizeAtr?: number;
  /** Whether a later bar (up to `at`) traded back across the whole zone — a retrospective status as of `at`. */
  filled: boolean;
  filledIndex?: number;
  filledDate?: string;
  reasons: string[];
}

/** True (window) gaps: low above the previous high (up) or high below the previous low (down), sized in % and ATR. */
export function gaps(bars: readonly Bar[], opts: { atrPeriod?: number; minSizeAtr?: number; at?: number } = {}): Gap[] {
  const { atrPeriod = 14, minSizeAtr = 0 } = opts;
  const at = lastIndex(bars, opts.at);
  const a = atr(bars.slice(0, Math.max(0, at + 1)), atrPeriod);
  const out: Gap[] = [];
  for (let i = 1; i <= at; i++) {
    const p = bars[i - 1]!;
    const c = bars[i]!;
    const up = c.low > p.high;
    const down = c.high < p.low;
    if (!up && !down) continue;
    const gapLow = up ? p.high : c.high;
    const gapHigh = up ? c.low : p.low;
    const size = gapHigh - gapLow;
    const prevAtr = a[i - 1];
    const sizeAtr = prevAtr === undefined || prevAtr === 0 ? undefined : size / prevAtr;
    if (minSizeAtr > 0 && (sizeAtr === undefined || sizeAtr < minSizeAtr)) continue;
    let filledIndex: number | undefined;
    for (let j = i + 1; j <= at; j++) {
      if ((up && bars[j]!.low <= gapLow) || (down && bars[j]!.high >= gapHigh)) {
        filledIndex = j;
        break;
      }
    }
    const reasons = [
      `${up ? "up" : "down"} gap of ${fmt(size)} (${((size / p.close) * 100).toFixed(2)} %${sizeAtr === undefined ? "" : `, ${sizeAtr.toFixed(2)} ATR`}) between ${fmt(gapLow)} and ${fmt(gapHigh)}`,
      filledIndex === undefined ? `unfilled as of ${bars[at]!.date}` : `filled on ${bars[filledIndex]!.date}`,
    ];
    out.push({
      index: i,
      date: c.date,
      direction: up ? "up" : "down",
      gapLow,
      gapHigh,
      size,
      sizePct: (size / p.close) * 100,
      sizeAtr,
      filled: filledIndex !== undefined,
      filledIndex,
      filledDate: filledIndex === undefined ? undefined : bars[filledIndex]!.date,
      reasons,
    });
  }
  return out;
}

// ---- breakouts ------------------------------------------------------------------------------

export interface Breakout {
  index: number;
  date: string;
  close: number;
  /** Highest high of the `lookback` bars before this one. */
  priorHigh: number;
  breakoutPct: number;
  volume: number;
  /** Mean volume of the `volumeLookback` bars before this one. */
  avgVolume?: number;
  volumeRatio?: number;
  volumeConfirmed: boolean;
  /** The previous bar was not itself a breakout. */
  fresh: boolean;
  reasons: string[];
}

/**
 * Closes above the prior N-day high (bars i − N … i − 1, so the breakout bar
 * never sets its own threshold), confirmed when volume ≥ multiple × the
 * average volume of the previous `volumeLookback` bars.
 */
export function breakouts(bars: readonly Bar[], opts: { lookback?: number; volumeLookback?: number; volumeMultiple?: number; at?: number } = {}): Breakout[] {
  const { lookback = 20, volumeLookback = 50, volumeMultiple = 1.5 } = opts;
  const at = lastIndex(bars, opts.at);
  const out: Breakout[] = [];
  let prevWasBreakout = false;
  for (let i = lookback; i <= at; i++) {
    let priorHigh = -Infinity;
    for (let j = i - lookback; j < i; j++) priorHigh = Math.max(priorHigh, bars[j]!.high);
    const b = bars[i]!;
    if (!(b.close > priorHigh)) {
      prevWasBreakout = false;
      continue;
    }
    const volume = b.volume ?? 0;
    let avgVolume: number | undefined;
    if (i >= volumeLookback) {
      let s = 0;
      for (let j = i - volumeLookback; j < i; j++) s += bars[j]!.volume ?? 0;
      avgVolume = s / volumeLookback;
    }
    const volumeRatio = avgVolume ? volume / avgVolume : undefined;
    const volumeConfirmed = volumeRatio !== undefined && volumeRatio >= volumeMultiple;
    const reasons = [
      `close ${fmt(b.close)} above the prior ${lookback}-bar high ${fmt(priorHigh)} (${pct(b.close / priorHigh - 1)})`,
      volumeRatio === undefined
        ? `volume unconfirmed: no ${volumeLookback}-bar volume average`
        : `volume ${volumeRatio.toFixed(2)}× its ${volumeLookback}-bar average (${volumeConfirmed ? "≥" : "<"} ${volumeMultiple}×)`,
    ];
    out.push({
      index: i,
      date: b.date,
      close: b.close,
      priorHigh,
      breakoutPct: (b.close / priorHigh - 1) * 100,
      volume,
      avgVolume,
      volumeRatio,
      volumeConfirmed,
      fresh: !prevWasBreakout,
      reasons,
    });
    prevWasBreakout = true;
  }
  return out;
}
