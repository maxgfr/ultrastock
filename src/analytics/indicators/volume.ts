// Volume-based indicators. A missing `volume` counts as 0, so on a series
// without volume (an index, FX) the ratio indicators come back undefined
// rather than as a made-up number.
import type { Bar } from "../../providers/types.js";
import { ema } from "../indicators.js";
import { rma } from "./averages.js";
import { type Series, blank, chain, typicalPrices, volumesOf, zipWith } from "./shared.js";
import { rollingSum } from "./stats.js";

/** Granville's On-Balance Volume: cumulative ±volume by the sign of the close change, 0 at the first bar. */
export function obv(bars: readonly Bar[]): Series {
  const out: Series = blank(bars.length);
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      const d = bars[i]!.close - bars[i - 1]!.close;
      const v = bars[i]!.volume ?? 0;
      if (d > 0) acc += v;
      else if (d < 0) acc -= v;
    }
    out[i] = acc;
  }
  return out;
}

/** Chaikin's close-location value ((C − L) − (H − C))/(H − L) × volume; 0 for a zero-range bar. */
function moneyFlowVolume(b: Bar): number {
  const r = b.high - b.low;
  return r === 0 ? 0 : ((b.close - b.low - (b.high - b.close)) / r) * (b.volume ?? 0);
}

/** Chaikin's Accumulation/Distribution line: cumulative money-flow volume. */
export function accumulationDistribution(bars: readonly Bar[]): Series {
  let acc = 0;
  return bars.map((b) => {
    acc += moneyFlowVolume(b);
    return acc;
  });
}

/** Chaikin oscillator: EMA(ADL, 3) − EMA(ADL, 10). */
export function chaikinOscillator(bars: readonly Bar[], fast = 3, slow = 10): Series {
  const adl = accumulationDistribution(bars) as number[];
  const f = ema(adl, fast);
  const s = ema(adl, slow);
  return zipWith([f, s], (a, b) => a - b);
}

/** Chaikin Money Flow: Σ money-flow volume / Σ volume over n bars (20), in [−1, 1]. */
export function cmf(bars: readonly Bar[], n = 20): Series {
  const mfv = rollingSum(bars.map(moneyFlowVolume), n);
  const vol = rollingSum(volumesOf(bars), n);
  return zipWith([mfv, vol], (a, v) => (v === 0 ? undefined : a / v));
}

/**
 * Money Flow Index (Quong & Soudack): raw flow = typical price × volume,
 * positive when TP rises, negative when it falls; MFI = 100 − 100/(1 + Σ+/Σ−)
 * over n bars (14), from bar n. 100 with no negative flow, 50 with no flow at all.
 */
export function mfi(bars: readonly Bar[], n = 14): Series {
  const tp = typicalPrices(bars);
  const pos: number[] = [0];
  const neg: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const flow = tp[i]! * (bars[i]!.volume ?? 0);
    pos.push(tp[i]! > tp[i - 1]! ? flow : 0);
    neg.push(tp[i]! < tp[i - 1]! ? flow : 0);
  }
  const p = rollingSum(pos, n);
  const m = rollingSum(neg, n);
  return bars.map((_, i) => {
    if (i < n) return undefined;
    const ps = p[i]!;
    const ns = m[i]!;
    if (ns === 0) return ps === 0 ? 50 : 100;
    return 100 - 100 / (1 + ps / ns);
  });
}

/** Elder's Force Index: EMA((C − C₋₁) × volume, 13). */
export function forceIndex(bars: readonly Bar[], n = 13): Series {
  const raw: Series = bars.map((b, i) => (i === 0 ? undefined : (b.close - bars[i - 1]!.close) * (b.volume ?? 0)));
  return chain(raw, (xs) => ema(xs, n));
}

/**
 * Arms' Ease of Movement: distance = hl2 − hl2₋₁, box ratio = (volume /
 * scale) / (H − L), EMV = SMA(distance / box ratio, n). StockCharts scales
 * volume by 100,000,000; a zero-range or zero-volume bar contributes 0.
 */
export function emv(bars: readonly Bar[], n = 14, volumeScale = 100_000_000): Series {
  const raw: Series = bars.map((b, i) => {
    if (i === 0) return undefined;
    const p = bars[i - 1]!;
    const dist = (b.high + b.low) / 2 - (p.high + p.low) / 2;
    const range = b.high - b.low;
    const vol = b.volume ?? 0;
    return range === 0 || vol === 0 ? 0 : (dist * range * volumeScale) / vol;
  });
  return chain(raw, (xs) => {
    const s = rollingSum(xs, n);
    return s.map((x) => (x === undefined ? undefined : x / n));
  });
}

/**
 * Colin Twiggs' Money Flow (21): Chaikin's money flow on the true range —
 * TRH = max(H, C₋₁), TRL = min(L, C₋₁), AD = V·((C − TRL) − (TRH − C))/(TRH − TRL)
 * — with Wilder smoothing (α = 1/n, as Twiggs specifies) of AD and of volume; TMF = their ratio.
 */
export function twiggsMoneyFlow(bars: readonly Bar[], n = 21): Series {
  const ad: Series = bars.map((b, i) => {
    if (i === 0) return undefined;
    const pc = bars[i - 1]!.close;
    const trh = Math.max(b.high, pc);
    const trl = Math.min(b.low, pc);
    return trh === trl ? 0 : ((b.close - trl - (trh - b.close)) / (trh - trl)) * (b.volume ?? 0);
  });
  const vol: Series = bars.map((b, i) => (i === 0 ? undefined : (b.volume ?? 0)));
  const sa = chain(ad, (xs) => rma(xs, n));
  const sv = chain(vol, (xs) => rma(xs, n));
  return zipWith([sa, sv], (a, v) => (v === 0 ? undefined : a / v));
}

/** Volume oscillator: 100·(EMA(volume, fast) − EMA(volume, slow)) / EMA(volume, slow). */
export function volumeOscillator(bars: readonly Bar[], fast = 14, slow = 28): Series {
  const v = volumesOf(bars);
  return zipWith([ema(v, fast), ema(v, slow)], (f, s) => (s === 0 ? undefined : (100 * (f - s)) / s));
}

/**
 * Where a VWAP accumulates from: "session" restarts at each new UTC calendar
 * day of `bar.date` (intraday bars; on daily bars every bar is its own
 * session, so VWAP = typical price), "start" accumulates from the first bar,
 * and a date ("2026-03-02" or an ISO timestamp) anchors at the first bar dated on or after it.
 */
export type VwapAnchor = string;

/** Volume-weighted average price of the typical price, cumulative from its anchor; undefined before the anchor or while volume is 0. */
export function vwap(bars: readonly Bar[], anchor: VwapAnchor = "session"): Series {
  const tp = typicalPrices(bars);
  const out: Series = blank(bars.length);
  let pv = 0;
  let vs = 0;
  let started = anchor === "start" || anchor === "session";
  let session = "";
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (anchor === "session") {
      const day = b.date.slice(0, 10);
      if (day !== session) {
        session = day;
        pv = 0;
        vs = 0;
      }
    } else if (!started && b.date >= anchor) started = true;
    if (!started) continue;
    const v = b.volume ?? 0;
    pv += tp[i]! * v;
    vs += v;
    if (vs > 0) out[i] = pv / vs;
  }
  return out;
}

/** Rolling VWAP: Σ(TP·V)/ΣV over the last n bars. */
export function rollingVwap(bars: readonly Bar[], n = 20): Series {
  const tp = typicalPrices(bars);
  const pv = rollingSum(
    bars.map((b, i) => tp[i]! * (b.volume ?? 0)),
    n,
  );
  const vs = rollingSum(volumesOf(bars), n);
  return zipWith([pv, vs], (a, v) => (v === 0 ? undefined : a / v));
}
