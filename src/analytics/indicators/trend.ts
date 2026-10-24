// Trend indicators: direction and strength. Stop-and-reverse systems (PSAR,
// Supertrend, PMAX) are path-dependent state machines walked bar by bar, so
// bar i's value is the stop in force after bar i closed — never one that
// depends on bar i + 1.
import type { Bar } from "../../providers/types.js";
import { atr, sma, trueRange } from "../indicators.js";
import { type MaType, movingAverage } from "./averages.js";
import { type Rows, type Series, blank, highsOf, lowsOf, medianPrices } from "./shared.js";
import { rollingMax, rollingMin } from "./stats.js";

export interface AdxPoint {
  adx: number;
  plusDI: number;
  minusDI: number;
  dx: number;
}

/**
 * Wilder's ADX with +DI/−DI (New Concepts in Technical Trading Systems, 1978).
 * +DM/−DM and TR from bar 1; Wilder sums seeded with the first n values
 * (bar n), then S = S − S/n + x; DI = 100·S(DM)/S(TR); DX = 100·|+DI − −DI| /
 * (+DI + −DI); ADX = mean of the first n DX (bar 2n − 1), then Wilder-smoothed.
 */
export function adx(bars: readonly Bar[], n = 14): Rows<AdxPoint> {
  const out: Rows<AdxPoint> = blank(bars.length);
  if (bars.length < 2 * n) return out;
  const tr = trueRange(bars);
  let sTr = 0;
  let sPlus = 0;
  let sMinus = 0;
  let adxValue = 0;
  let dxSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i]!.high - bars[i - 1]!.high;
    const down = bars[i - 1]!.low - bars[i]!.low;
    const plusDM = up > down && up > 0 ? up : 0;
    const minusDM = down > up && down > 0 ? down : 0;
    if (i <= n) {
      sTr += tr[i]!;
      sPlus += plusDM;
      sMinus += minusDM;
      if (i < n) continue;
    } else {
      sTr = sTr - sTr / n + tr[i]!;
      sPlus = sPlus - sPlus / n + plusDM;
      sMinus = sMinus - sMinus / n + minusDM;
    }
    const plusDI = sTr === 0 ? 0 : (100 * sPlus) / sTr;
    const minusDI = sTr === 0 ? 0 : (100 * sMinus) / sTr;
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / diSum;
    if (i < 2 * n - 1) {
      dxSum += dx;
      continue;
    }
    if (i === 2 * n - 1) adxValue = (dxSum + dx) / n;
    else adxValue = (adxValue * (n - 1) + dx) / n;
    out[i] = { adx: adxValue, plusDI, minusDI, dx };
  }
  return out;
}

export interface AroonPoint {
  up: number;
  down: number;
  oscillator: number;
}

/**
 * Chande's Aroon (1995): up = 100·(n − bars since the n-period high)/n over
 * the last n + 1 bars (ties → the most recent bar); down likewise for lows.
 */
export function aroon(bars: readonly Bar[], n = 25): Rows<AroonPoint> {
  const out: Rows<AroonPoint> = blank(bars.length);
  for (let i = n; i < bars.length; i++) {
    let hi = i - n;
    let lo = i - n;
    for (let j = i - n + 1; j <= i; j++) {
      if (bars[j]!.high >= bars[hi]!.high) hi = j;
      if (bars[j]!.low <= bars[lo]!.low) lo = j;
    }
    const up = (100 * (n - (i - hi))) / n;
    const down = (100 * (n - (i - lo))) / n;
    out[i] = { up, down, oscillator: up - down };
  }
  return out;
}

export interface SarPoint {
  sar: number;
  /** +1 long (SAR below price), −1 short. */
  trend: number;
}

/**
 * Wilder's Parabolic SAR (AF step 0.02, max 0.2). SAR for bar i is projected
 * from bar i − 1 (SAR + AF·(EP − SAR)) and clamped to the two prior bars'
 * lows (long) / highs (short) — never to bar i's own range. If bar i
 * penetrates it, the trend flips: SAR = the prior EP (kept outside bars i − 1
 * and i), EP = bar i's extreme, AF resets. The first trend is set from bar 1
 * versus bar 0 directional movement (TA-Lib's rule).
 */
export function psar(bars: readonly Bar[], step = 0.02, max = 0.2): Rows<SarPoint> {
  const out: Rows<SarPoint> = blank(bars.length);
  if (bars.length < 2) return out;
  const b0 = bars[0]!;
  const b1 = bars[1]!;
  const downMove = b0.low - b1.low;
  let long = !(downMove > 0 && downMove > b1.high - b0.high);
  let sar = long ? b0.low : b0.high;
  let ep = long ? b0.high : b0.low;
  let af = step;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const p1 = bars[i - 1]!;
    const p2 = i >= 2 ? bars[i - 2]! : p1;
    let next = sar + af * (ep - sar);
    if (long) {
      next = Math.min(next, p1.low, p2.low);
      if (b.low <= next) {
        long = false;
        next = Math.max(ep, b.high, p1.high);
        ep = b.low;
        af = step;
      } else if (b.high > ep) {
        ep = b.high;
        af = Math.min(af + step, max);
      }
    } else {
      next = Math.max(next, p1.high, p2.high);
      if (b.high >= next) {
        long = true;
        next = Math.min(ep, b.low, p1.low);
        ep = b.high;
        af = step;
      } else if (b.low < ep) {
        ep = b.low;
        af = Math.min(af + step, max);
      }
    }
    sar = next;
    out[i] = { sar, trend: long ? 1 : -1 };
  }
  return out;
}

export interface SupertrendPoint {
  supertrend: number;
  /** +1 up (line = lower band), −1 down (line = upper band). */
  direction: number;
  upper: number;
  lower: number;
}

/**
 * Supertrend (O. Seban): basic bands hl2 ± m·ATR(n) (Wilder). Final upper =
 * basic upper if it is below the prior final upper or the prior close closed
 * above it, else the prior final upper (mirror for the lower band). Direction
 * flips up when close > final upper, down when close < final lower; the first
 * bar is up when its close ≥ hl2.
 */
export function supertrend(bars: readonly Bar[], n = 10, multiplier = 3): Rows<SupertrendPoint> {
  const out: Rows<SupertrendPoint> = blank(bars.length);
  const a = atr(bars, n);
  let upper = 0;
  let lower = 0;
  let dir = 1;
  let started = false;
  for (let i = 0; i < bars.length; i++) {
    const av = a[i];
    if (av === undefined) continue;
    const b = bars[i]!;
    const mid = (b.high + b.low) / 2;
    const bu = mid + multiplier * av;
    const bl = mid - multiplier * av;
    if (!started) {
      upper = bu;
      lower = bl;
      dir = b.close >= mid ? 1 : -1;
      started = true;
    } else {
      const pc = bars[i - 1]!.close;
      upper = bu < upper || pc > upper ? bu : upper;
      lower = bl > lower || pc < lower ? bl : lower;
      if (dir === -1 && b.close > upper) dir = 1;
      else if (dir === 1 && b.close < lower) dir = -1;
    }
    out[i] = { supertrend: dir === 1 ? lower : upper, direction: dir, upper, lower };
  }
  return out;
}

export interface IchimokuPoint {
  /** Tenkan-sen: midpoint of the last `conversion` bars. */
  tenkan: number;
  /** Kijun-sen: midpoint of the last `base` bars. */
  kijun: number;
  /** Senkou span A of the cloud *at bar i*: (tenkan + kijun)/2 computed at i − displacement. */
  spanA: number;
  /** Senkou span B of the cloud at bar i: the `span`-bar midpoint computed at i − displacement. */
  spanB: number;
  cloudTop: number;
  cloudBottom: number;
  /** Span A computed at bar i — the value charts plot `displacement` bars ahead. Known at i. */
  leadA: number;
  /** Span B computed at bar i — plotted `displacement` bars ahead. Known at i. */
  leadB: number;
}

/**
 * Ichimoku Kinko Hyo (Hosoda; 9/26/52, displacement 26). The forward-shifted
 * spans are exposed where they are *known*: `spanA`/`spanB` at bar i are the
 * values computed at i − 26 (the cloud a chart shows over bar i), `leadA`/
 * `leadB` the values computed at i. The chikou span (close plotted 26 bars
 * back) is deliberately not exposed: as a current-bar value it is just the
 * close, and reading it at its plotted position would need 26 future bars —
 * compare close[i] with close[i − 26] instead.
 */
export function ichimoku(bars: readonly Bar[], conversion = 9, base = 26, span = 52, displacement = 26): Rows<IchimokuPoint> {
  const h = highsOf(bars);
  const l = lowsOf(bars);
  const mid = (n: number): Series => {
    const hh = rollingMax(h, n);
    const ll = rollingMin(l, n);
    return hh.map((x, i) => (x === undefined ? undefined : (x + ll[i]!) / 2));
  };
  const tenkan = mid(conversion);
  const kijun = mid(base);
  const senkouB = mid(span);
  const leadA: Series = tenkan.map((t, i) => (t === undefined || kijun[i] === undefined ? undefined : (t + kijun[i]!) / 2));
  const out: Rows<IchimokuPoint> = blank(bars.length);
  for (let i = displacement; i < bars.length; i++) {
    const t = tenkan[i];
    const k = kijun[i];
    const a = leadA[i - displacement];
    const b = senkouB[i - displacement];
    const la = leadA[i];
    const lb = senkouB[i];
    if (t === undefined || k === undefined || a === undefined || b === undefined || la === undefined || lb === undefined) continue;
    out[i] = { tenkan: t, kijun: k, spanA: a, spanB: b, cloudTop: Math.max(a, b), cloudBottom: Math.min(a, b), leadA: la, leadB: lb };
  }
  return out;
}

export interface VortexPoint {
  plusVI: number;
  minusVI: number;
}

/** Botes & Siepman's Vortex indicator (2010): Σ|H − L₋₁| / ΣTR and Σ|L − H₋₁| / ΣTR over n bars. */
export function vortex(bars: readonly Bar[], n = 14): Rows<VortexPoint> {
  const out: Rows<VortexPoint> = blank(bars.length);
  const tr = trueRange(bars);
  for (let i = n; i < bars.length; i++) {
    let vp = 0;
    let vm = 0;
    let st = 0;
    for (let j = i - n + 1; j <= i; j++) {
      vp += Math.abs(bars[j]!.high - bars[j - 1]!.low);
      vm += Math.abs(bars[j]!.low - bars[j - 1]!.high);
      st += tr[j]!;
    }
    out[i] = { plusVI: st === 0 ? 0 : vp / st, minusVI: st === 0 ? 0 : vm / st };
  }
  return out;
}

export interface PmaxPoint {
  pmax: number;
  /** The moving average of hl2 the stops trail. */
  ma: number;
  /** +1 long (PMAX = long stop below the MA), −1 short. */
  direction: number;
  longStop: number;
  shortStop: number;
}

/**
 * Profit Maximizer (K. Özbilgiç): ATR stops trailing a moving average of hl2
 * instead of price — longStop = MA − m·ATR ratchets up while MA > previous
 * longStop, shortStop = MA + m·ATR ratchets down; the direction flips when
 * the MA crosses the previous opposite stop.
 */
export function pmax(bars: readonly Bar[], maPeriod = 10, atrPeriod = 10, multiplier = 3, maType: MaType = "ema"): Rows<PmaxPoint> {
  const out: Rows<PmaxPoint> = blank(bars.length);
  const ma = movingAverage(medianPrices(bars), maPeriod, maType);
  const a = atr(bars, atrPeriod);
  let longStop: number | undefined;
  let shortStop: number | undefined;
  let dir = 1;
  for (let i = 0; i < bars.length; i++) {
    const m = ma[i];
    const av = a[i];
    if (m === undefined || av === undefined) continue;
    let ls = m - multiplier * av;
    let ss = m + multiplier * av;
    const lsPrev = longStop ?? ls;
    const ssPrev = shortStop ?? ss;
    if (m > lsPrev) ls = Math.max(ls, lsPrev);
    if (m < ssPrev) ss = Math.min(ss, ssPrev);
    if (dir === -1 && m > ssPrev) dir = 1;
    else if (dir === 1 && m < lsPrev) dir = -1;
    longStop = ls;
    shortStop = ss;
    out[i] = { pmax: dir === 1 ? ls : ss, ma: m, direction: dir, longStop: ls, shortStop: ss };
  }
  return out;
}

/** Chande's Range Action Verification Index: |SMA(short) − SMA(long)| / SMA(long) × 100 (> 3 = trending). */
export function ravi(values: readonly number[], short = 7, long = 65): Series {
  const s = sma(values, short);
  const l = sma(values, long);
  return values.map((_, i) => {
    const lv = l[i];
    const sv = s[i];
    if (lv === undefined || sv === undefined || lv === 0) return undefined;
    return (Math.abs(sv - lv) / lv) * 100;
  });
}
