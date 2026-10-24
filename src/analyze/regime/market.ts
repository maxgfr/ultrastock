// `regime`: is this a market to be invested in, and how much? The tape read
// through src/analytics/regime.ts — trend, breadth, credit, distribution days,
// follow-through, volatility term structure, sentiment — fed to the exposure
// coach (equities) or the crypto risk-on score. Every signal is registered with
// its reason, every component with its weight, and the verdict with the
// coverage it was computed on: a missing input renormalises the weights and is
// named in the notes, never silently assumed.
//
// Network budget per run (all keyless):
//   us      9 Nasdaq daily histories (≈ 420 calendar days) · Cboe VIX + VIX3M ·
//           CNN Fear & Greed · 2 TradingView counts
//   eu      2 Euronext histories (CAC 40, CW8) · 5 TradingView scans (≤ 300
//           rows each) · ECB AAA curve (2Y, 10Y) · Cboe VIX + VIX3M
//   crypto  Binance BTCUSDT daily · CoinGecko top 50 · Binance futures funding
import {
  type Bar,
  contrarianSentiment,
  cryptoRegime,
  distributionDays,
  type ExposureAdvice,
  exposureCoach,
  type FtdState,
  followThrough,
  ratioSignal,
  type Signal,
  trendSignal,
  vixTermSignal,
  type Weighted,
} from "../../analytics/regime.js";
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow } from "../../core/net.js";
import { binanceFuturesPositioning } from "../../providers/crypto/binance-futures.js";
import { coingeckoMarkets } from "../../providers/crypto/coingecko.js";
import { ecbYieldCurve } from "../../providers/macro/ecb.js";
import { cnnFearGreed, vixTermStructure } from "../../providers/macro/sentiment.js";
import type { PriceSeries } from "../../providers/types.js";
import { breadthSignal, EU_LARGE_CAP, EU_MARKETS, largeCapRows, shareAbove200, usBreadthCount } from "./breadth.js";
import {
  alignCloses,
  type DatasetProvenance,
  dailyHistories,
  derivedProvenance,
  fmt,
  mergeProvenance,
  pickPoints,
  pointNumber,
  type Report,
  round4,
  seriesProvenance,
  settle,
} from "./common.js";

/** Calendar days of daily history read: ≈ 290 sessions, enough for a 200-day average and its one-month slope. */
export const REGIME_HISTORY_DAYS = 420;
/** The US tape: index, equal weight, small caps, credit (HY, IG), consumer cyclicals/staples, long Treasuries, Nasdaq 100. */
export const US_REGIME_SYMBOLS = ["SPY", "RSP", "IWM", "HYG", "LQD", "XLY", "XLP", "TLT", "QQQ"] as const;
/** CAC 40 (Euronext index ISIN) and Amundi MSCI World (CW8, Paris). */
export const CAC40_ISIN = "FR0003500008";
export const EU_WORLD_ETF = "CW8.PA";

/** Points grouped into datasets by section and provenance. */
class Sections {
  private readonly map = new Map<string, Dataset>();
  constructor(private readonly subject: string) {}
  add(title: string, prov: DatasetProvenance, points: Point[], notes: string[] = []): void {
    if (!points.length && !notes.length) return;
    const k = `${title}|${prov.source}|${prov.fallbackFrom ?? ""}|${prov.official}`;
    const ds = this.map.get(k);
    if (ds) {
      ds.points.push(...points);
      ds.provenance = mergeProvenance([ds.provenance, prov]);
      ds.notes.push(...notes.filter((n) => !ds.notes.includes(n)));
    } else this.map.set(k, { kind: "regime", title, subject: this.subject, points: [...points], provenance: prov, notes: [...notes] });
  }
  push(ds: Dataset | undefined): void {
    if (ds) this.map.set(`${ds.title}|${this.map.size}`, ds);
  }
  list(): Dataset[] {
    return [...this.map.values()];
  }
}

/** A signal as two points: its −1…+1 value (with how it was computed) and its reason. */
export function signalPoints(ns: string, s: Signal, formula: string, asOf?: string): Point[] {
  const at = asOf ? { asOf } : {};
  if (s.value === undefined) return [{ key: `${ns}.signal.${s.id}.reason`, label: `${s.label}: not computable`, value: s.reason, ...at }];
  return [
    { key: `${ns}.signal.${s.id}`, label: `${s.label} signal (−1 risk-off … +1 risk-on)`, value: round4(s.value), unit: "score", formula, ...at },
    { key: `${ns}.signal.${s.id}.reason`, label: `${s.label} signal, reason`, value: s.reason, ...at },
  ];
}

/** Volumes usable for distribution days: every one of the last 26 sessions has a positive volume. */
export const hasVolumes = (bars: readonly Bar[]) => bars.length >= 26 && bars.slice(-26).every((b) => (b.volume ?? 0) > 0);

const DIST_ORDER = ["normal", "caution", "high", "severe"] as const;
/** The coach's own ranking of follow-through states (its ftdScore), worst first. */
const FTD_ORDER: FtdState[] = ["correction", "failed", "rally-attempt", "uptrend", "follow-through"];
/** The more severe distribution level and the less favourable follow-through state of several indices (conservative). */
export const worstDistribution = (levels: Array<(typeof DIST_ORDER)[number]>) =>
  levels.length ? levels.reduce((a, b) => (DIST_ORDER.indexOf(b) > DIST_ORDER.indexOf(a) ? b : a)) : undefined;
export const worstFtd = (states: FtdState[]) => (states.length ? states.reduce((a, b) => (FTD_ORDER.indexOf(b) < FTD_ORDER.indexOf(a) ? b : a)) : undefined);

const DIST_FORMULA =
  "O'Neil distribution day: close down ≥ 0.2 % on higher volume than the session before, last 25 sessions, voided once the index closes 5 % above it";
const FTD_FORMULA =
  "O'Neil follow-through: after an 8 % correction, a gain ≥ 1.25 % on higher volume on day 4–10 of a rally attempt; undercutting the attempt's low resets it";

/** Distribution days and follow-through state of one index, as points; undefined levels when volumes are missing. */
function tapePoints(
  ns: string,
  sym: string,
  s: PriceSeries,
): { points: Point[]; count?: number; level?: (typeof DIST_ORDER)[number]; ftd?: FtdState; note?: string } {
  const bars: Bar[] = s.bars.map((b) => ({ date: b.date, close: b.close, volume: b.volume, high: b.high, low: b.low }));
  const asOf = bars[bars.length - 1]?.date;
  if (!hasVolumes(bars))
    return {
      points: [],
      note: `${sym}: no session volumes from ${s.provenance.source} — distribution days and follow-through (both volume-based) are unavailable`,
    };
  const d = distributionDays(bars);
  const f = followThrough(bars);
  const points: Point[] = [
    { key: `${ns}.dist.${sym}.count`, label: `${sym} distribution days, last 25 sessions`, value: d.days.length, unit: "count", asOf, formula: DIST_FORMULA },
    { key: `${ns}.dist.${sym}.level`, label: `${sym} distribution level (normal < 3, caution 3–4, high 5–6, severe ≥ 7)`, value: d.level, asOf },
  ];
  if (d.days.length) points.push({ key: `${ns}.dist.${sym}.dates`, label: `${sym} distribution day dates`, value: d.days.map((x) => x.date).join(", "), asOf });
  points.push(
    { key: `${ns}.ftd.${sym}.state`, label: `${sym} follow-through state`, value: f.state, asOf, formula: FTD_FORMULA },
    { key: `${ns}.ftd.${sym}.reason`, label: `${sym} follow-through state, reason`, value: f.reason, asOf },
  );
  if (f.date) points.push({ key: `${ns}.ftd.${sym}.date`, label: `${sym} follow-through day`, value: f.date, asOf });
  return { points, count: d.days.length, level: d.level, ftd: f.state };
}

const COMPONENT_FORMULA: Record<string, string> = {
  trend: "(trend signal + 1) / 2 × 100",
  breadth: "(breadth signal + 1) / 2 × 100",
  credit: "(credit signal + 1) / 2 × 100",
  volatility: "(VIX term signal + 1) / 2 × 100",
  sentiment: "(contrarian sentiment + 1) / 2 × 100",
  distribution: "normal 90, caution 60, high 35, severe 10",
  followThrough: "follow-through 85, uptrend 75, rally attempt 40, failed 25, correction 15",
  btcTrend: "(BTC trend signal + 1) / 2 × 100",
  altBreadth: "share of top coins up over 30 days, as is",
  dominance: "50 − dominance change × 10, clipped 0–100",
  funding: "< −10 %: 30, < 0: 45, ≤ 20 %: 75, ≤ 50 %: 50, above: 20",
  drawdown: "100 + 2 × drawdown %, clipped 0–100",
  momentum: "50 + 2.5 × 30-day return %, clipped 0–100",
};

/** Component scores as points (the unavailable ones named in a note). */
function componentPoints(ns: string, components: readonly Weighted[], asOf?: string): { points: Point[]; missing: string[] } {
  const points: Point[] = [];
  const missing: string[] = [];
  for (const c of components) {
    if (c.score === undefined) {
      missing.push(c.label);
      continue;
    }
    points.push({
      key: `${ns}.coach.${c.id}.score`,
      label: `${c.label} — component score (0–100, weight ${c.weight})`,
      value: round4(c.score),
      unit: "score",
      formula: `${COMPONENT_FORMULA[c.id] ?? "see src/analytics/regime.ts"}; ${c.reason}`,
      ...(asOf ? { asOf } : {}),
    });
  }
  return { points, missing };
}

function adviceSummary(ns: string, a: ExposureAdvice, cite: (k: string) => string): string[] {
  return [
    `zone: ${a.zone}${cite(`${ns}.coach.zone`)} · score ${fmt(a.score, 1)}/100${cite(`${ns}.coach.score`)} on ${fmt(a.coverage * 100, 0)} % of the weights${cite(`${ns}.coach.coverage`)}`,
    `max exposure: ${a.maxExposurePct === undefined ? "n/a (coverage under 50 %)" : `${a.maxExposurePct} %`}${cite(`${ns}.coach.maxExposure`)} · new entries: ${a.newEntries}${cite(`${ns}.coach.newEntries`)}`,
    `components: ${
      a.components
        .map(
          (c) => `${c.id} ${c.score === undefined ? "n/a" : fmt(c.score, 0)}${c.score === undefined ? "" : cite(`${ns}.coach.${c.id}.score`)} (w ${c.weight})`,
        )
        .join(", ") || "none"
    }`,
  ];
}

function advicePoints(ns: string, a: ExposureAdvice, asOf?: string): Point[] {
  const at = asOf ? { asOf } : {};
  const points: Point[] = [];
  if (a.score !== undefined)
    points.push({
      key: `${ns}.coach.score`,
      label: "exposure coach score (0–100)",
      value: round4(a.score),
      unit: "score",
      formula: "weighted mean of the available component scores, weights renormalised over them",
      ...at,
    });
  points.push(
    {
      key: `${ns}.coach.coverage`,
      label: "share of the coach's weights that were computable",
      value: round4(a.coverage * 100),
      unit: "%",
      formula: "Σ weights available / Σ weights",
      ...at,
    },
    {
      key: `${ns}.coach.zone`,
      label: "exposure zone",
      value: a.zone,
      formula: "score ≥ 80 risk-on, ≥ 65 constructive, ≥ 50 neutral, ≥ 35 defensive, else risk-off; unknown under 50 % coverage",
      ...at,
    },
  );
  if (a.maxExposurePct !== undefined)
    points.push({
      key: `${ns}.coach.maxExposure`,
      label: "suggested ceiling of capital at risk",
      value: a.maxExposurePct,
      unit: "%",
      formula: "score ≥ 80 → 100 %, ≥ 65 → 80 %, ≥ 50 → 60 %, ≥ 35 → 40 %, else 20 % — a ceiling, the profile's limits still apply",
      ...at,
    });
  points.push({
    key: `${ns}.coach.newEntries`,
    label: "new entries",
    value: a.newEntries,
    formula: "allowed ≥ 65, selective ≥ 50 or unknown, avoid below",
    ...at,
  });
  return points;
}

const meanOf = (xs: Array<number | undefined>) => {
  const v = xs.filter((x): x is number => x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};

const signalLine = (ns: string, s: Signal, cite: (k: string) => string) =>
  `  - ${s.label}: ${s.value === undefined ? "n/a" : (s.value >= 0 ? "+" : "") + fmt(s.value)}${cite(`${ns}.signal.${s.id}`)} — ${s.reason}`;

/** The US regime: SPY trend, intermarket ratios, SPY/QQQ distribution and follow-through, VIX term, CNN sentiment, large-cap breadth. */
export async function usRegime(now: Date = clockNow()): Promise<Report> {
  const ns = "US.regime";
  const [hist, side] = await Promise.all([
    dailyHistories(US_REGIME_SYMBOLS, REGIME_HISTORY_DAYS, now),
    settle<unknown>({
      "Cboe VIX term structure": () => vixTermStructure(["VIX", "VIX3M"]),
      "CNN Fear & Greed": () => cnnFearGreed(now),
      "TradingView large-cap breadth": () => usBreadthCount(),
    }),
  ]);
  const notes = [...hist.failed.map((f) => `history unavailable — ${f}`), ...side.failed.map((f) => `unavailable — ${f}`)];
  const S = hist.series;
  const sec = new Sections("US");
  const signals: Signal[] = [];
  const context: Signal[] = [];
  const provs: DatasetProvenance[] = [];

  const spy = S.get("SPY");
  let trend: Signal | undefined;
  if (spy) {
    trend = trendSignal(
      "trend.SPY",
      "SPY trend",
      spy.bars.map((b) => b.close),
    );
    signals.push(trend);
    const p = seriesProvenance(spy);
    provs.push(p);
    sec.add(
      "US regime signals from daily closes",
      p,
      signalPoints(ns, trend, "close vs 200-day ±0.4, 50-day vs 200-day ±0.3, 200-day slope over 20 sessions ±0.3", p.asOf),
    );
  }
  const ratio = (id: string, label: string, a: string, b: string, scored: boolean): Signal | undefined => {
    const sa = S.get(a);
    const sb = S.get(b);
    if (!sa || !sb) return undefined;
    const al = alignCloses(sa.bars, sb.bars);
    const s = ratioSignal(`${id}.${a}_${b}`, `${a}/${b} (${label})`, al.a, al.b);
    const p = mergeProvenance([seriesProvenance(sa), seriesProvenance(sb)], al.dates[al.dates.length - 1]);
    provs.push(p);
    sec.add(
      "US regime signals from daily closes",
      p,
      signalPoints(ns, s, `${a}/${b} ratio: above its 50-day ±1/3, 50-day above 200-day ±1/3, 3-month change ±1/3`, p.asOf),
    );
    (scored ? signals : context).push(s);
    return s;
  };
  const breadthRatio = ratio("breadth", "equal weight vs cap weight", "RSP", "SPY", true);
  const credit = ratio("credit", "high yield vs investment grade", "HYG", "LQD", true);
  ratio("size", "small caps vs large caps", "IWM", "SPY", false);
  ratio("cyclicals", "discretionary vs staples", "XLY", "XLP", false);
  ratio("stocksBonds", "equities vs long Treasuries", "SPY", "TLT", false);

  const levels: Array<(typeof DIST_ORDER)[number]> = [];
  const ftds: FtdState[] = [];
  const tape: Record<string, { count: number; ftd: FtdState }> = {};
  for (const sym of ["SPY", "QQQ"]) {
    const s = S.get(sym);
    if (!s) continue;
    const t = tapePoints(ns, sym, s);
    if (t.note) notes.push(t.note);
    if (t.level) levels.push(t.level);
    if (t.ftd) ftds.push(t.ftd);
    if (t.count !== undefined && t.ftd) tape[sym] = { count: t.count, ftd: t.ftd };
    sec.add("US distribution days and follow-through", seriesProvenance(s), t.points);
  }

  const vix = side.ok["Cboe VIX term structure"] as Dataset | undefined;
  let vol: Signal | undefined;
  const vixNow = pointNumber(vix, "US.vol.vix");
  const vix3m = pointNumber(vix, "US.vol.vix3m");
  if (vix && vixNow !== undefined && vix3m !== undefined && vix3m > 0) {
    vol = vixTermSignal(vixNow, vix3m);
    const p = { ...vix.provenance, asOf: vix.points.find((x) => x.key === "US.vol.vix")?.asOf };
    provs.push(p);
    sec.push(pickPoints(vix, ["US.vol.vix", "US.vol.vix3m", "US.vol.ratio.vix_vix3m"], "VIX term structure (Cboe, delayed)"));
    sec.add("US volatility and sentiment signals", p, signalPoints(ns, vol, "VIX/VIX3M ≥ 1.05 → −1, ≥ 1 → −0.5, ≥ 0.9 → +0.2, below → +1", p.asOf));
    signals.push(vol);
  } else if (vix) notes.push("VIX or VIX3M missing from Cboe's answer — volatility component unavailable");

  const cnn = side.ok["CNN Fear & Greed"] as Dataset | undefined;
  let sentiment: number | undefined;
  const fg = pointNumber(cnn, "US.sentiment.feargreed");
  if (cnn && fg !== undefined) {
    sentiment = contrarianSentiment(fg);
    const p = { ...cnn.provenance };
    provs.push(p);
    sec.push(pickPoints(cnn, ["US.sentiment.feargreed", "US.sentiment.feargreed.rating"], "CNN Fear & Greed index"));
    const s: Signal = {
      id: "sentiment",
      label: "CNN Fear & Greed, read contrarian",
      value: sentiment,
      reason: `index ${fmt(fg, 1)} — ${fg <= 20 ? "extreme fear: contrarian risk-on" : fg >= 80 ? "extreme greed: contrarian risk-off" : "between the extremes: a small tilt, mostly noise"}`,
    };
    signals.push(s);
    sec.add("US volatility and sentiment signals", p, signalPoints(ns, s, "≤ 20 → +0.8, ≥ 80 → −0.8, else (50 − index) / 30 × 0.5", p.asOf));
  }

  const tv = side.ok["TradingView large-cap breadth"] as Awaited<ReturnType<typeof usBreadthCount>> | undefined;
  let breadthPct: Signal | undefined;
  if (tv?.pct !== undefined) {
    const p = { ...tv.ds.provenance };
    provs.push(p);
    breadthPct = {
      id: "breadth.above200",
      label: "US large caps above their 200-day",
      value: breadthSignal(tv.pct),
      reason: `${tv.above} of ${tv.total} (${fmt(tv.pct, 1)} %) close above their 200-day average`,
    };
    signals.push(breadthPct);
    sec.add("US large-cap breadth (TradingView, unofficial)", p, [
      {
        key: `${ns}.breadth.above200.pct`,
        label: "US primary-listed stocks above $10 bn closing above their 200-day average",
        value: round4(tv.pct),
        unit: "%",
        formula: "count(close > SMA200) / count(all) × 100",
        asOf: p.asOf,
      },
      { key: `${ns}.breadth.above200.count`, label: "US large caps above their 200-day average", value: tv.above, unit: "count", asOf: p.asOf },
      {
        key: `${ns}.breadth.universe.count`,
        label: "US large caps screened (> $10 bn, primary listing, common stock)",
        value: tv.total,
        unit: "count",
        asOf: p.asOf,
      },
      ...signalPoints(ns, breadthPct, "(% above − 50) / 30, clipped to −1…+1", p.asOf),
    ]);
  }

  const breadth = meanOf([breadthRatio?.value, breadthPct?.value]);
  const advice = exposureCoach({
    trend: trend?.value,
    breadth,
    credit: credit?.value,
    distribution: worstDistribution(levels),
    followThrough: worstFtd(ftds),
    volatility: vol?.value,
    sentiment,
  });
  const derived = derivedProvenance(provs);
  const comp = componentPoints(ns, advice.components, derived.asOf);
  const coachNotes = [
    "breadth = mean of the RSP/SPY signal and the % of large caps above their 200-day signal, when both are available",
    "distribution: the more severe of SPY and QQQ; follow-through: the less favourable of the two (conservative)",
    "IWM/SPY, XLY/XLP and SPY/TLT are context: reported, not scored",
    ...(comp.missing.length ? [`not computable, weights renormalised over the rest: ${comp.missing.join("; ")}`] : []),
    ...notes,
  ];
  sec.add("US exposure coach", derived, [...comp.points, ...advicePoints(ns, advice, derived.asOf)], coachNotes);
  const asOf = derived.asOf ?? "n/a";
  return {
    datasets: sec.list(),
    json: { market: "us", asOf, advice },
    summary: (cite) => [
      `# US market regime — as of ${asOf}`,
      ...adviceSummary(ns, advice, cite),
      "signals (scored):",
      ...signals.map((s) => signalLine(ns, s, cite)),
      ...(Object.keys(tape).length
        ? [
            `tape: ${Object.entries(tape)
              .map(([s, t]) => `${s} ${t.count} distribution day(s)${cite(`${ns}.dist.${s}.count`)}, ${t.ftd}${cite(`${ns}.ftd.${s}.state`)}`)
              .join(" · ")}`,
          ]
        : []),
      "context (not scored):",
      ...context.map((s) => signalLine(ns, s, cite)),
      ...(notes.length ? ["notes:", ...notes.map((n) => `  - ${n}`)] : []),
    ],
  };
}

/** The euro-area regime: CAC 40 trend (and its tape when volumes exist), large-cap breadth, MSCI World trend, AAA curve, VIX term. */
export async function euRegime(now: Date = clockNow()): Promise<Report> {
  const ns = "EU.regime";
  const [hist, tv, side] = await Promise.all([
    dailyHistories([CAC40_ISIN, EU_WORLD_ETF], REGIME_HISTORY_DAYS, now),
    largeCapRows(EU_MARKETS, EU_LARGE_CAP, ["close", "SMA200"]),
    settle<Dataset>({
      "ECB AAA curve": () => ecbYieldCurve(["2Y", "10Y"]),
      "Cboe VIX term structure": () => vixTermStructure(["VIX", "VIX3M"]),
    }),
  ]);
  const notes = [
    ...hist.failed.map((f) => `history unavailable — ${f}`),
    ...tv.failed.map((f) => `unavailable — ${f}`),
    ...side.failed.map((f) => `unavailable — ${f}`),
  ];
  const sec = new Sections("EU");
  const signals: Signal[] = [];
  const context: Signal[] = [];
  const provs: DatasetProvenance[] = [];

  const cac = hist.series.get(CAC40_ISIN);
  let trend: Signal | undefined;
  const levels: Array<(typeof DIST_ORDER)[number]> = [];
  const ftds: FtdState[] = [];
  if (cac) {
    trend = trendSignal(
      "trend.CAC40",
      "CAC 40 trend",
      cac.bars.map((b) => b.close),
    );
    signals.push(trend);
    const p = seriesProvenance(cac);
    provs.push(p);
    sec.add(
      "EU regime signals from daily closes",
      p,
      signalPoints(ns, trend, "close vs 200-day ±0.4, 50-day vs 200-day ±0.3, 200-day slope over 20 sessions ±0.3", p.asOf),
    );
    const t = tapePoints(ns, "CAC40", cac);
    if (t.note) notes.push(t.note.replace(/^CAC40: /, "CAC 40: "));
    if (t.level) levels.push(t.level);
    if (t.ftd) ftds.push(t.ftd);
    sec.add("EU distribution days and follow-through", p, t.points);
  }
  const world = hist.series.get(EU_WORLD_ETF);
  if (world) {
    const s = trendSignal(
      "trend.CW8",
      "CW8 (MSCI World ETF, Paris) trend",
      world.bars.map((b) => b.close),
    );
    context.push(s);
    const p = seriesProvenance(world);
    sec.add(
      "EU regime signals from daily closes",
      p,
      signalPoints(ns, s, "close vs 200-day ±0.4, 50-day vs 200-day ±0.3, 200-day slope over 20 sessions ±0.3", p.asOf),
    );
  }

  let breadthPct: Signal | undefined;
  const b = shareAbove200(tv.rows);
  if (b.pct !== undefined && tv.datasets.length) {
    const p = mergeProvenance(tv.datasets.map((d) => d.provenance));
    provs.push(p);
    breadthPct = {
      id: "breadth.above200",
      label: "euro-area large caps above their 200-day",
      value: breadthSignal(b.pct),
      reason: `${b.above} of ${b.total} (${fmt(b.pct, 1)} %) close above their 200-day average (${tv.datasets.length} of ${EU_MARKETS.length} markets read)`,
    };
    signals.push(breadthPct);
    sec.add("EU large-cap breadth (TradingView, unofficial)", p, [
      {
        key: `${ns}.breadth.above200.pct`,
        label: `primary-listed stocks above 5 bn in ${EU_MARKETS.join(", ")} closing above their 200-day average`,
        value: round4(b.pct),
        unit: "%",
        formula: "count(close > SMA200) / count(rows with both) × 100",
        asOf: p.asOf,
      },
      { key: `${ns}.breadth.above200.count`, label: "euro-area large caps above their 200-day average", value: b.above, unit: "count", asOf: p.asOf },
      {
        key: `${ns}.breadth.universe.count`,
        label: "euro-area large caps screened (> 5 bn, primary listing, common stock)",
        value: b.total,
        unit: "count",
        asOf: p.asOf,
      },
      ...signalPoints(ns, breadthPct, "(% above − 50) / 30, clipped to −1…+1", p.asOf),
    ]);
  }

  const curve = side.ok["ECB AAA curve"];
  const slope = pointNumber(curve, "EA.rates.aaa.spread.2s10s");
  if (curve && slope !== undefined) {
    sec.push(pickPoints(curve, ["EA.rates.aaa.2Y", "EA.rates.aaa.10Y", "EA.rates.aaa.spread.2s10s"], "Euro area AAA curve, 2s10s (ECB)"));
    context.push({
      id: "curve.2s10s",
      label: "euro AAA 2s10s",
      reason: `${fmt(slope, 1)} bp — ${slope < 0 ? "inverted: the market prices cuts ahead, a late-cycle sign" : slope < 50 ? "flat" : "positively sloped"} (context: rates, not credit)`,
    });
  }

  const vix = side.ok["Cboe VIX term structure"];
  let vol: Signal | undefined;
  const vixNow = pointNumber(vix, "US.vol.vix");
  const vix3m = pointNumber(vix, "US.vol.vix3m");
  if (vix && vixNow !== undefined && vix3m !== undefined && vix3m > 0) {
    vol = vixTermSignal(vixNow, vix3m);
    const p = { ...vix.provenance, asOf: vix.points.find((x) => x.key === "US.vol.vix")?.asOf };
    provs.push(p);
    sec.push(pickPoints(vix, ["US.vol.vix", "US.vol.vix3m", "US.vol.ratio.vix_vix3m"], "VIX term structure (Cboe, delayed) — global risk gauge"));
    sec.add("EU volatility signal (global)", p, signalPoints(ns, vol, "VIX/VIX3M ≥ 1.05 → −1, ≥ 1 → −0.5, ≥ 0.9 → +0.2, below → +1", p.asOf));
    signals.push(vol);
  }

  const advice = exposureCoach({
    trend: trend?.value,
    breadth: breadthPct?.value,
    distribution: worstDistribution(levels),
    followThrough: worstFtd(ftds),
    volatility: vol?.value,
  });
  const derived = derivedProvenance(provs);
  const comp = componentPoints(ns, advice.components, derived.asOf);
  const coachNotes = [
    "no euro credit gauge is read (the AAA curve is rates context) and CNN's sentiment is US-only: both components are left out and the weights renormalise",
    "CW8 (MSCI World) and the AAA 2s10s are context: reported, not scored",
    ...(comp.missing.length ? [`not computable, weights renormalised over the rest: ${comp.missing.join("; ")}`] : []),
    ...notes,
  ];
  sec.add("EU exposure coach", derived, [...comp.points, ...advicePoints(ns, advice, derived.asOf)], coachNotes);
  const asOf = derived.asOf ?? "n/a";
  return {
    datasets: sec.list(),
    json: { market: "eu", asOf, advice },
    summary: (cite) => [
      `# Euro-area market regime — as of ${asOf}`,
      ...adviceSummary(ns, advice, cite),
      "signals (scored):",
      ...signals.map((s) => signalLine(ns, s, cite)),
      "context (not scored):",
      ...context.map((s) => (s.id === "curve.2s10s" ? `  - ${s.label}: ${s.reason}${cite("EA.rates.aaa.spread.2s10s")}` : signalLine(ns, s, cite))),
      ...(notes.length ? ["notes:", ...notes.map((n) => `  - ${n}`)] : []),
    ],
  };
}

/** Coins that track a fiat currency: not part of "alt breadth". */
const STABLE_SYMBOLS = new Set([
  "USDT",
  "USDC",
  "DAI",
  "USDE",
  "USDS",
  "FDUSD",
  "TUSD",
  "PYUSD",
  "USD1",
  "BUSD",
  "USDD",
  "FRAX",
  "RLUSD",
  "USDTB",
  "USDF",
  "EURC",
  "BSC-USD",
  "SUSDE",
  "USDG",
  "USD0",
  "GHO",
  "LUSD",
  "CRVUSD",
]);

/**
 * Alt breadth from a CoinGecko markets dataset: the share of the top coins,
 * BTC and stablecoins left out, whose 30-day change is positive. A proxy for
 * "above the 50-day average", which would need a history per coin.
 */
export function altBreadth(ds: Dataset): { up: number; total: number; pct?: number } {
  const subjects = new Set(ds.points.filter((p) => p.key.endsWith(".market.change.30d")).map((p) => p.key.slice(0, -".market.change.30d".length)));
  let up = 0;
  let total = 0;
  for (const s of subjects) {
    if (s === "BTC" || STABLE_SYMBOLS.has(s)) continue;
    const ch = pointNumber(ds, `${s}.market.change.30d`);
    const price = pointNumber(ds, `${s}.market.price`);
    // A coin pinned at ~1 USD that moved under 0.5 % in a month is a stablecoin missing from the list.
    if (ch === undefined || (price !== undefined && price > 0.97 && price < 1.03 && Math.abs(ch) < 0.5)) continue;
    total++;
    if (ch > 0) up++;
  }
  return { up, total, pct: total ? (up / total) * 100 : undefined };
}

/** The crypto regime: BTC trend and 30-day return, alt breadth, funding, drawdown from the high. */
export async function cryptoRegimeReport(now: Date = clockNow()): Promise<Report> {
  const ns = "CRYPTO.regime";
  const [hist, side] = await Promise.all([
    dailyHistories(["BTCUSDT"], REGIME_HISTORY_DAYS, now),
    settle<Dataset | Dataset[]>({
      "CoinGecko top 50": () => coingeckoMarkets({ limit: 50 }),
      "Binance futures funding": () => binanceFuturesPositioning("BTC", { fundingLimit: 21, days: 2 }),
    }),
  ]);
  const notes = [...hist.failed.map((f) => `history unavailable — ${f}`), ...side.failed.map((f) => `unavailable — ${f}`)];
  const sec = new Sections("CRYPTO");
  const signals: Signal[] = [];
  const provs: DatasetProvenance[] = [];
  const inputs: Parameters<typeof cryptoRegime>[0] = {};
  let fundingKey = `${ns}.funding.annualized`;

  const btc = hist.series.get("BTCUSDT");
  if (btc) {
    const closes = btc.bars.map((b) => b.close);
    const t = trendSignal("trend.BTC", "BTC trend", closes);
    signals.push(t);
    inputs.btcTrend = t.value;
    const p = seriesProvenance(btc);
    provs.push(p);
    const pts = signalPoints(ns, t, "close vs 200-day ±0.4, 50-day vs 200-day ±0.3, 200-day slope over 20 days ±0.3", p.asOf);
    const base = closes[closes.length - 31];
    if (base) {
      inputs.btcReturn30dPct = (closes[closes.length - 1]! / base - 1) * 100;
      pts.push({
        key: `${ns}.btc.return30d`,
        label: "BTC 30-day return (BTCUSDT daily closes)",
        value: round4(inputs.btcReturn30dPct),
        unit: "%",
        formula: "(close / close 30 days earlier − 1) × 100",
        asOf: p.asOf,
      });
    }
    sec.add("Crypto regime signals from BTC daily closes", p, pts);
  }

  const cg = side.ok["CoinGecko top 50"] as Dataset | undefined;
  if (cg) {
    const p = { ...cg.provenance };
    provs.push(p);
    const ab = altBreadth(cg);
    const pts: Point[] = [];
    if (ab.pct !== undefined) {
      inputs.altBreadthPct = ab.pct;
      pts.push(
        {
          key: `${ns}.altBreadth.pct`,
          label: "top-50 coins (ex BTC, ex stablecoins) up over 30 days — proxy for above the 50-day average",
          value: round4(ab.pct),
          unit: "%",
          formula: "count(30-day change > 0) / count × 100",
          asOf: p.asOf,
        },
        { key: `${ns}.altBreadth.count`, label: "top-50 coins (ex BTC, ex stablecoins) up over 30 days", value: ab.up, unit: "count", asOf: p.asOf },
        { key: `${ns}.altBreadth.universe`, label: "top-50 coins counted (ex BTC, ex stablecoins)", value: ab.total, unit: "count", asOf: p.asOf },
      );
    }
    const dd = pointNumber(cg, "BTC.market.ath.change");
    if (dd !== undefined) inputs.btcDrawdownPct = dd;
    sec.push(pickPoints(cg, ["BTC.market.price", "BTC.market.ath", "BTC.market.ath.change", "BTC.market.change.30d"], "BTC on CoinGecko"));
    sec.add("Crypto breadth (CoinGecko, unofficial)", p, pts, [
      "wrapped and staked tokens are counted as alts; stablecoins are left out by symbol and by a ~1 USD flat-price test",
    ]);
  }

  const fut = side.ok["Binance futures funding"] as Dataset[] | undefined;
  const fds = fut?.find((d) => d.points.some((p) => p.key === "BTC.deriv.funding.binance"));
  if (fds) {
    const mean = pointNumber(fds, "BTC.deriv.funding.binance.mean");
    const cur = pointNumber(fds, "BTC.deriv.funding.binance.annualized");
    const p = { ...fds.provenance };
    provs.push(p);
    sec.push(
      pickPoints(
        fds,
        ["BTC.deriv.funding.binance", "BTC.deriv.funding.binance.annualized", "BTC.deriv.funding.binance.mean"],
        "BTCUSDT perpetual funding (Binance)",
      ),
    );
    if (mean !== undefined) {
      inputs.fundingAnnualizedPct = mean * 3 * 365;
      sec.add("Crypto funding (Binance futures)", p, [
        {
          key: `${ns}.funding.annualized`,
          label: "BTCUSDT mean funding over the last 21 settlements (≈ 7 days), annualised",
          value: round4(inputs.fundingAnnualizedPct),
          unit: "%",
          formula: "mean funding % per 8 h × 3 × 365",
          asOf: p.asOf,
        },
      ]);
    } else if (cur !== undefined) {
      inputs.fundingAnnualizedPct = cur;
      fundingKey = "BTC.deriv.funding.binance.annualized";
    }
  }

  const r = cryptoRegime(inputs);
  const derived = derivedProvenance(provs);
  const comp = componentPoints(ns, r.components, derived.asOf);
  const points: Point[] = [...comp.points];
  if (r.score !== undefined)
    points.push({
      key: `${ns}.score`,
      label: "crypto risk-on score (0–100)",
      value: round4(r.score),
      unit: "score",
      formula: "weighted mean of the available components (BTC trend 25, alt breadth 20, dominance 15, funding 15, drawdown 15, momentum 10), renormalised",
      asOf: derived.asOf,
    });
  points.push(
    { key: `${ns}.coverage`, label: "share of the score's weights that were computable", value: round4(r.coverage * 100), unit: "%", asOf: derived.asOf },
    {
      key: `${ns}.label`,
      label: "crypto regime",
      value: r.label,
      formula: "score ≥ 70 risk-on, ≥ 55 constructive, ≥ 40 neutral, ≥ 25 defensive, else risk-off",
      asOf: derived.asOf,
    },
  );
  sec.add("Crypto regime score", derived, points, [
    "BTC dominance change over 30 days is not derivable from keyless snapshots (CoinGecko's free /global has no history): omitted, weights renormalised",
    ...(comp.missing.length ? [`not computable: ${comp.missing.join("; ")}`] : []),
    ...notes,
  ]);
  const asOf = derived.asOf ?? "n/a";
  return {
    datasets: sec.list(),
    json: { market: "crypto", asOf, regime: r },
    summary: (cite) => [
      `# Crypto market regime — as of ${asOf}`,
      `regime: ${r.label}${cite(`${ns}.label`)} · score ${fmt(r.score, 1)}/100${cite(`${ns}.score`)} on ${fmt(r.coverage * 100, 0)} % of the weights${cite(`${ns}.coverage`)}`,
      `components: ${r.components.map((c) => `${c.id} ${c.score === undefined ? "n/a" : fmt(c.score, 0) + cite(`${ns}.coach.${c.id}.score`)} (w ${c.weight})`).join(", ")}`,
      "inputs:",
      ...signals.map((s) => signalLine(ns, s, cite)),
      `  - BTC 30-day return: ${fmt(inputs.btcReturn30dPct)} %${cite(`${ns}.btc.return30d`)} · drawdown from ATH: ${fmt(inputs.btcDrawdownPct)} %${cite("BTC.market.ath.change")}`,
      `  - alt breadth (30-day change > 0, proxy for above the 50-day): ${fmt(inputs.altBreadthPct, 1)} %${cite(`${ns}.altBreadth.pct`)}`,
      `  - funding annualised: ${fmt(inputs.fundingAnnualizedPct, 1)} %${cite(fundingKey)}`,
      ...(notes.length ? ["notes:", ...notes.map((n) => `  - ${n}`)] : []),
    ],
  };
}
