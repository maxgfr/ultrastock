// `technicals <symbol>`: the full technical picture of one instrument, each
// reading an [E#] — trend (moving averages, ADX, Supertrend, Parabolic SAR,
// Ichimoku, Aroon), momentum (RSI, MACD, stochastic, Williams %R, CCI, ROC),
// volatility (ATR, Bollinger %B and bandwidth, Keltner, Donchian, chandelier
// exit), volume (OBV trend, MFI, Chaikin money flow), relative strength against
// a benchmark, and the patterns (52-week range, Minervini's trend template, VCP,
// support and resistance, recent gaps and breakouts, candlesticks) — plus a
// bullish score whose every point says why. Closed bars only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { computeIndicator, type IndicatorParams } from "../analytics/indicators/index.js";
import { breakouts, fiftyTwoWeek, gaps, minerviniTrendTemplate, supportResistance, vcp } from "../analytics/patterns.js";
import { type Dataset, formatDatasets, type Point, registerDatasets } from "../core/datasets.js";
import { EvidenceStore } from "../core/evidence.js";
import { clockNow } from "../core/net.js";
import { writeArtifact } from "../engine.js";
import { getHistory, resolveSymbol } from "../providers/router.js";
import type { Bar, Interval, PriceSeries } from "../providers/types.js";

export interface TechnicalsOptions {
  interval?: Interval;
  /** Extra indicators: "kama", "rsi:period=7", "keltner:period=20;multiplier=2". */
  extra?: string[];
  benchmark?: string;
  now?: Date;
}

const r6 = (x: number) => Number(x.toPrecision(10));

/** The benchmark a listing is measured against. */
export function defaultBenchmark(market: string, mic?: string): string | undefined {
  if (market === "crypto") return undefined;
  if (market === "us") return "SPY";
  return mic === "XPAR" || mic === "ETFP" ? "FR0003500008" : "CW8.PA";
}

/** "rsi:period=7;source=hl2" → name and params. */
export function parseIndicatorSpec(spec: string): { name: string; params: IndicatorParams } {
  const [name, rest] = spec.split(":");
  const params: IndicatorParams = {};
  for (const kv of (rest ?? "").split(";").filter(Boolean)) {
    const [k, v] = kv.split("=");
    if (!k || v === undefined) throw new Error(`indicator parameter "${kv}" is not key=value`);
    params[k.trim()] = Number.isFinite(Number(v)) ? Number(v) : v.trim();
  }
  return { name: name!.trim(), params };
}

interface Reading {
  name: string;
  params?: IndicatorParams;
  label: string;
  fields?: Record<string, { label: string; unit?: "price" | "%" | "ratio" | "x" | "index" | "shares" }>;
}

/** The standard panel: each indicator's last value, field by field. */
const PANEL: Reading[] = [
  { name: "sma", params: { period: 20 }, label: "SMA(20)", fields: { value: { label: "20-day simple moving average", unit: "price" } } },
  { name: "sma", params: { period: 50 }, label: "SMA(50)", fields: { value: { label: "50-day simple moving average", unit: "price" } } },
  { name: "sma", params: { period: 200 }, label: "SMA(200)", fields: { value: { label: "200-day simple moving average", unit: "price" } } },
  { name: "ema", params: { period: 21 }, label: "EMA(21)", fields: { value: { label: "21-day exponential moving average", unit: "price" } } },
  {
    name: "adx",
    params: { period: 14 },
    label: "ADX(14)",
    fields: {
      adx: { label: "ADX(14) trend strength", unit: "index" },
      plusDI: { label: "+DI(14)", unit: "index" },
      minusDI: { label: "−DI(14)", unit: "index" },
    },
  },
  {
    name: "supertrend",
    label: "Supertrend",
    fields: { supertrend: { label: "Supertrend line", unit: "price" }, direction: { label: "Supertrend direction (+1 up, −1 down)" } },
  },
  {
    name: "psar",
    label: "Parabolic SAR",
    fields: { sar: { label: "Parabolic SAR stop", unit: "price" }, trend: { label: "Parabolic SAR trend (+1 up, −1 down)" } },
  },
  {
    name: "ichimoku",
    label: "Ichimoku",
    fields: {
      cloudTop: { label: "Ichimoku cloud top", unit: "price" },
      cloudBottom: { label: "Ichimoku cloud bottom", unit: "price" },
      kijun: { label: "Ichimoku kijun-sen", unit: "price" },
    },
  },
  { name: "aroon", params: { period: 25 }, label: "Aroon(25)", fields: { oscillator: { label: "Aroon(25) oscillator", unit: "index" } } },
  { name: "rsi", params: { period: 14 }, label: "RSI(14)", fields: { value: { label: "RSI(14), Wilder", unit: "index" } } },
  {
    name: "macd",
    label: "MACD(12,26,9)",
    fields: {
      macd: { label: "MACD(12,26,9) line", unit: "price" },
      signal: { label: "MACD signal", unit: "price" },
      histogram: { label: "MACD histogram", unit: "price" },
    },
  },
  {
    name: "stochastic",
    label: "Stochastic(14,3)",
    fields: { k: { label: "stochastic %K(14,3)", unit: "index" }, d: { label: "stochastic %D", unit: "index" } },
  },
  { name: "williamsR", label: "Williams %R(14)", fields: { value: { label: "Williams %R(14)", unit: "index" } } },
  { name: "cci", label: "CCI(20)", fields: { value: { label: "CCI(20)", unit: "index" } } },
  { name: "roc", params: { period: 20 }, label: "ROC(20)", fields: { value: { label: "20-day rate of change", unit: "%" } } },
  { name: "atr", params: { period: 14 }, label: "ATR(14)", fields: { value: { label: "ATR(14), Wilder", unit: "price" } } },
  { name: "bollingerPercentB", label: "Bollinger %B(20,2)", fields: { value: { label: "Bollinger %B(20,2)", unit: "ratio" } } },
  { name: "bollingerBandwidth", label: "Bollinger bandwidth(20,2)", fields: { value: { label: "Bollinger bandwidth(20,2)", unit: "ratio" } } },
  { name: "keltner", label: "Keltner", fields: { upper: { label: "Keltner upper", unit: "price" }, lower: { label: "Keltner lower", unit: "price" } } },
  {
    name: "donchian",
    params: { period: 20 },
    label: "Donchian(20)",
    fields: { upper: { label: "Donchian(20) high", unit: "price" }, lower: { label: "Donchian(20) low", unit: "price" } },
  },
  { name: "chandelierExit", label: "Chandelier exit(22,3)", fields: { exitLong: { label: "chandelier exit for a long", unit: "price" } } },
  { name: "mfi", params: { period: 14 }, label: "MFI(14)", fields: { value: { label: "money flow index(14)", unit: "index" } } },
  { name: "cmf", params: { period: 20 }, label: "CMF(20)", fields: { value: { label: "Chaikin money flow(20)", unit: "ratio" } } },
];

export interface BullishScore {
  score: number;
  max: number;
  components: Array<{ id: string; points: number; reason: string }>;
}

/**
 * A bullish-setup score in the open (after staskh's scanner): trend above the
 * 20/50-day averages, RSI zone, MACD cross and slope, EMA(9) vs EMA(21), ADX
 * with +DI leading, and 20-day momentum. A description of the chart, not a forecast.
 */
export function bullishScore(bars: readonly Bar[]): BullishScore | undefined {
  if (bars.length < 60) return undefined;
  const at = bars.length - 1;
  const last = <T>(name: string, params?: IndicatorParams, field = "value") => computeIndicator(name, bars, params).values[at]?.[field] as T | undefined;
  const close = bars[at]!.close;
  const comps: BullishScore["components"] = [];
  const add = (id: string, points: number, reason: string) => comps.push({ id, points, reason });
  const s20 = last<number>("sma", { period: 20 });
  const s50 = last<number>("sma", { period: 50 });
  if (s20 !== undefined) add("sma20", close > s20 ? 1 : 0, `close ${close > s20 ? "above" : "below"} the 20-day average`);
  if (s50 !== undefined) add("sma50", close > s50 ? 1 : 0, `close ${close > s50 ? "above" : "below"} the 50-day average`);
  const rsi = last<number>("rsi", { period: 14 });
  if (rsi !== undefined)
    add(
      "rsi",
      rsi >= 50 && rsi <= 70 ? 1 : rsi >= 30 && rsi < 50 ? 0.5 : rsi < 30 ? 0.25 : 0,
      `RSI(14) ${rsi.toFixed(1)}: ${rsi > 70 ? "overbought" : rsi >= 50 ? "bullish zone" : rsi >= 30 ? "neutral" : "oversold"}`,
    );
  const m = computeIndicator("macd", bars).values;
  const mNow = m[at];
  const mPrev = m[at - 1];
  if (mNow) {
    add("macd", mNow.macd! > mNow.signal! ? 1 : 0, `MACD ${mNow.macd! > mNow.signal! ? "above" : "below"} its signal`);
    if (mPrev) add("macdSlope", mNow.histogram! > mPrev.histogram! ? 0.5 : 0, `histogram ${mNow.histogram! > mPrev.histogram! ? "rising" : "falling"}`);
  }
  const e9 = last<number>("ema", { period: 9 });
  const e21 = last<number>("ema", { period: 21 });
  if (e9 !== undefined && e21 !== undefined) add("ema", e9 > e21 ? 0.5 : -0.25, `EMA(9) ${e9 > e21 ? "above" : "below"} EMA(21)`);
  const adx = computeIndicator("adx", bars, { period: 14 }).values[at];
  if (adx)
    add(
      "adx",
      adx.adx! > 25 && adx.plusDI! > adx.minusDI! ? 1.5 : 0,
      `ADX ${adx.adx!.toFixed(1)}${adx.adx! > 25 ? " (trending)" : " (no trend)"}, +DI ${adx.plusDI! > adx.minusDI! ? "above" : "below"} −DI`,
    );
  const ret20 = close / bars[at - 20]!.close - 1;
  add("momentum", Math.max(-1, Math.min(2, (ret20 * 100) / 20)), `20-day return ${(ret20 * 100).toFixed(1)} %`);
  return { score: comps.reduce((s, c) => s + c.points, 0), max: 7.5, components: comps };
}

export interface TechnicalsResult {
  dir: string;
  symbol: string;
  asOf: string;
  evidence: number;
  score?: number;
  trendTemplate?: string;
  vcp?: string;
  notes: string[];
}

export async function technicalsRun(raw: string, dir: string, opts: TechnicalsOptions = {}): Promise<TechnicalsResult> {
  const now = opts.now ?? clockNow();
  const resolved = await resolveSymbol(raw);
  const inst = resolved.instrument;
  const sym = inst.symbol;
  const interval = opts.interval ?? "1d";
  const days = interval === "1d" ? 729 : interval === "1w" ? 3650 : interval === "4h" ? 330 : interval === "1h" ? 80 : 20;
  const series = await getHistory(resolved, { from: new Date(now.getTime() - days * 86_400_000), to: now, interval });
  const bars = series.bars;
  if (bars.length < 60) throw new Error(`only ${bars.length} bars for ${sym}: technicals need at least 60`);
  const at = bars.length - 1;
  const last = bars[at]!;
  const notes = [...series.notes];
  const prov = { ...series.provenance, asOf: last.date };
  const unitOf = (u?: string) => (u === "price" ? inst.currency : u);
  const pts: Point[] = [{ key: `${sym}.ta.close`, label: `${sym} last close (${interval})`, value: last.close, unit: inst.currency }];

  for (const r of PANEL) {
    let res: ReturnType<typeof computeIndicator>;
    try {
      res = computeIndicator(r.name, bars, r.params);
    } catch (e) {
      notes.push(`${r.label}: ${(e as Error).message}`);
      continue;
    }
    const row = res.values[at];
    if (!row) {
      notes.push(`${r.label}: not enough bars`);
      continue;
    }
    const suffix = r.params ? Object.values(r.params).join("_") : "";
    for (const [field, meta] of Object.entries(r.fields ?? { value: { label: r.label } })) {
      const v = row[field];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      pts.push({
        key: `${sym}.ta.${r.name}${suffix ? `.${suffix}` : ""}.${field}`,
        label: `${sym} ${meta.label}`,
        value: r6(v),
        unit: unitOf(meta.unit),
        formula: `${r.name}(${JSON.stringify(res.params)})`,
      });
    }
  }
  for (const spec of opts.extra ?? []) {
    const { name, params } = parseIndicatorSpec(spec);
    const res = computeIndicator(name, bars, params);
    const row = res.values[at];
    if (!row) {
      notes.push(`${spec}: not enough bars`);
      continue;
    }
    for (const field of res.outputs) {
      const v = row[field];
      if (typeof v === "number" && Number.isFinite(v))
        pts.push({
          key: `${sym}.ta.x.${name}.${JSON.stringify(res.params)}.${field}`,
          label: `${sym} ${name}(${Object.entries(res.params)
            .map(([k, x]) => `${k}=${x}`)
            .join(", ")}) ${field}`,
          value: r6(v),
          formula: `${name}(${JSON.stringify(res.params)})`,
        });
    }
  }

  // Relative strength against a benchmark.
  const benchSym = opts.benchmark ?? defaultBenchmark(inst.market, inst.mic);
  let bench: PriceSeries | undefined;
  if (benchSym && interval === "1d") {
    try {
      bench = await getHistory(await resolveSymbol(benchSym), { from: new Date(now.getTime() - days * 86_400_000), to: now });
      const ms = computeIndicator("mansfieldRs", bars, { benchmark: bench.bars }).values[at]?.value;
      if (ms !== undefined)
        pts.push({
          key: `${sym}.ta.mansfieldRs.${benchSym}`,
          label: `${sym} Mansfield relative strength vs ${benchSym}`,
          value: r6(ms),
          formula: "(RS / SMA52w(RS) − 1) × 100 on weekly-equivalent bars",
        });
      const b = bench.bars;
      const bm = new Map(b.map((x) => [x.date, x.close]));
      const back = bars[at - 126];
      if (back && bm.has(back.date) && bm.has(last.date)) {
        const rel = (last.close / back.close - 1) * 100 - (bm.get(last.date)! / bm.get(back.date)! - 1) * 100;
        pts.push({
          key: `${sym}.ta.rel6m.${benchSym}`,
          label: `${sym} 6-month return minus ${benchSym}'s`,
          value: r6(rel),
          unit: "%",
          formula: "6-month return − benchmark 6-month return (points)",
        });
      }
    } catch (e) {
      notes.push(`benchmark ${benchSym} unavailable (${(e as Error).message}): no relative strength`);
    }
  }

  // Patterns.
  const yr = fiftyTwoWeek(bars);
  if (yr) {
    pts.push(
      { key: `${sym}.ta.high52w`, label: `${sym} 52-week high (${yr.highDate})`, value: yr.high, unit: inst.currency },
      { key: `${sym}.ta.low52w`, label: `${sym} 52-week low (${yr.lowDate})`, value: yr.low, unit: inst.currency },
      { key: `${sym}.ta.fromHigh52w`, label: `${sym} distance from the 52-week high`, value: r6(yr.pctFromHigh), unit: "%" },
      { key: `${sym}.ta.aboveLow52w`, label: `${sym} distance above the 52-week low`, value: r6(yr.pctAboveLow), unit: "%" },
    );
  }
  const tt = minerviniTrendTemplate(bars, { benchmark: bench?.bars });
  if (tt) {
    pts.push({
      key: `${sym}.ta.trendTemplate.passed`,
      label: `${sym} Minervini trend template criteria passed (of ${tt.evaluated} evaluated)`,
      value: tt.passed,
      unit: "count",
    });
    for (const c of tt.criteria)
      pts.push({
        key: `${sym}.ta.trendTemplate.${c.id}`,
        label: `${sym} trend template ${c.id}: ${c.name}`,
        value: c.pass === null ? "n/a" : c.pass,
        formula: c.reason,
      });
  }
  const v = vcp(bars);
  if (v) {
    pts.push({ key: `${sym}.ta.vcp.status`, label: `${sym} volatility contraction pattern`, value: v.status, formula: v.reasons.join("; ") });
    if (v.pivotPrice !== undefined) pts.push({ key: `${sym}.ta.vcp.pivot`, label: `${sym} VCP pivot (buy point)`, value: v.pivotPrice, unit: inst.currency });
    v.contractions.forEach((c, i) =>
      pts.push({
        key: `${sym}.ta.vcp.contraction.${i + 1}`,
        label: `${sym} VCP contraction ${i + 1} depth (${c.highDate} → ${c.lowDate})`,
        value: r6(c.depthPct),
        unit: "%",
      }),
    );
  }
  const sr = supportResistance(bars);
  if (sr) {
    const below = sr.levels
      .filter((l) => l.kind === "support")
      .sort((a, b) => b.price - a.price)
      .slice(0, 2);
    const above = sr.levels
      .filter((l) => l.kind === "resistance")
      .sort((a, b) => a.price - b.price)
      .slice(0, 2);
    [...below, ...above].forEach((l) =>
      pts.push({
        key: `${sym}.ta.level.${l.kind}.${l.price.toFixed(4)}`,
        label: `${sym} ${l.kind} (${l.touches} touches, ${l.firstDate} → ${l.lastDate})`,
        value: r6(l.price),
        unit: inst.currency,
        formula: `${l.distancePct.toFixed(2)} % / ${l.distanceAtr.toFixed(2)} ATR from the close; ${l.reasons.join("; ")}`,
      }),
    );
  }
  for (const g of gaps(bars).filter((x) => x.index >= at - 20))
    pts.push({
      key: `${sym}.ta.gap.${g.date}`,
      label: `${sym} ${g.direction} gap on ${g.date}${g.filled ? " (filled)" : ""}`,
      value: r6(g.sizePct),
      unit: "%",
      formula: g.sizeAtr === undefined ? g.reasons.join("; ") : `${g.sizeAtr.toFixed(2)} ATR`,
    });
  for (const b of breakouts(bars).filter((x) => x.index >= at - 20))
    pts.push({
      key: `${sym}.ta.breakout.${b.date}`,
      label: `${sym} breakout above the prior high on ${b.date}${b.volumeConfirmed ? ", volume confirmed" : ", without volume"}`,
      value: r6(b.priorHigh),
      unit: inst.currency,
      formula: b.reasons.join("; "),
    });
  const candleNames = [
    "doji",
    "hammer",
    "shootingStar",
    "engulfing",
    "harami",
    "morningStar",
    "eveningStar",
    "piercingLine",
    "darkCloudCover",
    "threeSoldiersCrows",
    "marubozu",
    "tweezer",
  ];
  for (const name of candleNames) {
    const vals = computeIndicator(name, bars).values;
    for (let i = Math.max(0, at - 2); i <= at; i++) {
      const sig = vals[i]?.value;
      if (sig)
        pts.push({
          key: `${sym}.ta.candle.${name}.${bars[i]!.date}`,
          label: `${sym} ${name} candle on ${bars[i]!.date} (${sig > 0 ? "bullish" : "bearish"})`,
          value: sig,
        });
    }
  }
  const score = bullishScore(bars);
  if (score) {
    pts.push({
      key: `${sym}.ta.bullishScore`,
      label: `${sym} bullish setup score (of ${score.max})`,
      value: r6(score.score),
      unit: "score",
      formula: score.components.map((c) => `${c.id} ${c.points >= 0 ? "+" : ""}${c.points}: ${c.reason}`).join("; "),
    });
  }

  const ds: Dataset = {
    kind: "technicals",
    title: `${sym}${inst.name ? ` — ${inst.name}` : ""} — technicals (${interval}, ${bars.length} bars to ${last.date})`,
    subject: sym,
    points: pts,
    provenance: prov,
    notes,
  };
  mkdirSync(dir, { recursive: true });
  const store = EvidenceStore.open(dir, { subject: sym, createdAt: now.toISOString() });
  const reg = registerDatasets(store, [ds]);
  writeArtifact(
    join(dir, "TECHNICALS.md"),
    `# ${sym} — technicals\n\nEach figure is an [E#] of this run; formulas and reasons follow each reading.\n\n${formatDatasets(reg)}`,
  );
  return {
    dir,
    symbol: sym,
    asOf: last.date,
    evidence: store.items.length,
    score: score?.score,
    trendTemplate: tt ? `${tt.passed}/${tt.evaluated}` : undefined,
    vcp: v?.status,
    notes,
  };
}
