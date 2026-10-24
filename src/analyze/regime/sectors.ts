// `sectors`: which parts of the market lead, and what the leadership says.
//
//   us  the 11 SPDR sector ETFs against SPY (Nasdaq daily closes, 12
//       histories, ≤ 4 at a time): 1/3/6-month relative performance, a
//       relative-strength rank, position against the 50/200-day averages
//   eu  TradingView's screener over France, Germany, the Netherlands, Italy
//       and Spain (primary large caps above 5 bn, 5 scans): per sector the
//       median 1/3/6-month performance and the share above the 200-day
//
// The rotation reading is a rule in the open: defensives (staples, utilities,
// health care) holding two or more of the top four places is risk-off;
// cyclicals holding three or more is risk-on; anything else is mixed.
import { sma } from "../../analytics/indicators.js";
import { quantile } from "../../analytics/stats.js";
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow } from "../../core/net.js";
import { EU_LARGE_CAP, EU_MARKETS, largeCapRows, TV_SECTORS, type TvStockRow } from "./breadth.js";
import { alignCloses, dailyHistories, derivedProvenance, fmt, mergeProvenance, type Report, round4, seriesProvenance } from "./common.js";

export const SECTOR_ETFS: Record<string, { name: string; side: "defensive" | "cyclical" | "neutral" }> = {
  XLK: { name: "technology", side: "cyclical" },
  XLF: { name: "financials", side: "cyclical" },
  XLV: { name: "health care", side: "defensive" },
  XLY: { name: "consumer discretionary", side: "cyclical" },
  XLP: { name: "consumer staples", side: "defensive" },
  XLE: { name: "energy", side: "neutral" },
  XLI: { name: "industrials", side: "cyclical" },
  XLB: { name: "materials", side: "cyclical" },
  XLU: { name: "utilities", side: "defensive" },
  XLRE: { name: "real estate", side: "neutral" },
  XLC: { name: "communication services", side: "neutral" },
};
/** Sessions in a month, a quarter and a half-year. */
export const WINDOWS = { "1m": 21, "3m": 63, "6m": 126 } as const;
/** Relative-strength composite: the 3- and 6-month windows weigh most, the last month least (it mean-reverts). */
export const RS_WEIGHTS = { "1m": 0.2, "3m": 0.4, "6m": 0.4 } as const;
type Win = keyof typeof WINDOWS;

const ret = (xs: readonly number[], n: number) => (xs.length > n ? (xs[xs.length - 1]! / xs[xs.length - 1 - n]! - 1) * 100 : undefined);

export interface SectorStat {
  id: string;
  name: string;
  side: "defensive" | "cyclical" | "neutral";
  /** % returns per window (the ETF's, or the sector median). */
  perf: Partial<Record<Win, number>>;
  /** % relative to the benchmark: (1 + r) / (1 + r_bench) − 1. */
  rel: Partial<Record<Win, number>>;
  above50?: boolean;
  above200?: boolean;
  /** Share of members above their 200-day (EU), in %. */
  pctAbove200?: number;
  members?: number;
  composite?: number;
  rank?: number;
}

/** One ETF against its benchmark over aligned sessions. */
export function etfVsBenchmark(id: string, closes: readonly number[], bench: readonly number[]): SectorStat {
  const meta = SECTOR_ETFS[id] ?? { name: id, side: "neutral" as const };
  const perf: SectorStat["perf"] = {};
  const rel: SectorStat["rel"] = {};
  for (const [w, n] of Object.entries(WINDOWS) as Array<[Win, number]>) {
    const r = ret(closes, n);
    const b = ret(bench, n);
    if (r === undefined || b === undefined) continue;
    perf[w] = r;
    rel[w] = ((1 + r / 100) / (1 + b / 100) - 1) * 100;
  }
  const c = closes[closes.length - 1];
  const s50 = sma(closes, 50)[closes.length - 1];
  const s200 = sma(closes, 200)[closes.length - 1];
  return {
    id,
    name: meta.name,
    side: meta.side,
    perf,
    rel,
    ...(c !== undefined && s50 !== undefined && Number.isFinite(s50) ? { above50: c > s50 } : {}),
    ...(c !== undefined && s200 !== undefined && Number.isFinite(s200) ? { above200: c > s200 } : {}),
  };
}

/** Composite = Σ weight × relative performance over the available windows (renormalised); rank 1 = strongest. */
export function rankSectors(stats: SectorStat[]): SectorStat[] {
  for (const s of stats) {
    let w = 0;
    let v = 0;
    for (const k of Object.keys(RS_WEIGHTS) as Win[]) {
      const x = s.rel[k];
      if (x === undefined) continue;
      w += RS_WEIGHTS[k];
      v += RS_WEIGHTS[k] * x;
    }
    if (w > 0) s.composite = v / w;
  }
  const ranked = stats.filter((s) => s.composite !== undefined).sort((a, b) => b.composite! - a.composite!);
  ranked.forEach((s, i) => (s.rank = i + 1));
  return [...ranked, ...stats.filter((s) => s.composite === undefined)];
}

/** The rotation rule over the top four (see the header). */
export function rotationReading(ranked: readonly SectorStat[]): { reading: "risk-off" | "risk-on" | "mixed"; reason: string } {
  const top = ranked.filter((s) => s.rank !== undefined).slice(0, 4);
  const def = top.filter((s) => s.side === "defensive");
  const cyc = top.filter((s) => s.side === "cyclical");
  const names = top.map((s) => s.name).join(", ");
  if (def.length >= 2) return { reading: "risk-off", reason: `defensives lead: ${def.map((s) => s.name).join(", ")} in the top four (${names})` };
  if (cyc.length >= 3) return { reading: "risk-on", reason: `cyclicals lead: ${cyc.length} of the top four (${names})` };
  return { reading: "mixed", reason: `no clear side: top four ${names || "n/a"}` };
}

/** The median (type-7 quantile at 0.5), undefined for no values. */
export const medianOf = (xs: readonly number[]): number | undefined => (xs.length ? quantile(xs, 0.5) : undefined);

const PERF_COLUMNS: Record<Win, string> = { "1m": "Perf.1M", "3m": "Perf.3M", "6m": "Perf.6M" };

/**
 * Screener rows grouped by TradingView sector: median performance per window,
 * relative to the median of every row (so the ranking is against the market),
 * and the share above the 200-day. Sectors outside the fixed table are counted
 * as `unknown`.
 */
export function groupBySector(rows: readonly TvStockRow[]): { stats: SectorStat[]; unknown: number; all: Partial<Record<Win, number>> } {
  const groups = new Map<string, TvStockRow[]>();
  let unknown = 0;
  for (const r of rows) {
    const meta = typeof r.values.sector === "string" ? TV_SECTORS[r.values.sector] : undefined;
    if (!meta) {
      unknown++;
      continue;
    }
    groups.set(meta.id, [...(groups.get(meta.id) ?? []), r]);
  }
  const all: Partial<Record<Win, number>> = {};
  for (const w of Object.keys(WINDOWS) as Win[]) {
    const m = medianOf(rows.map((r) => r.values[PERF_COLUMNS[w]]).filter((x): x is number => typeof x === "number" && Number.isFinite(x)));
    if (m !== undefined) all[w] = m;
  }
  const stats: SectorStat[] = [];
  for (const meta of Object.values(TV_SECTORS)) {
    const g = groups.get(meta.id);
    if (!g?.length) continue;
    const perf: SectorStat["perf"] = {};
    const rel: SectorStat["rel"] = {};
    for (const w of Object.keys(WINDOWS) as Win[]) {
      const m = medianOf(g.map((r) => r.values[PERF_COLUMNS[w]]).filter((x): x is number => typeof x === "number" && Number.isFinite(x)));
      if (m === undefined) continue;
      perf[w] = m;
      if (all[w] !== undefined) rel[w] = ((1 + m / 100) / (1 + all[w]! / 100) - 1) * 100;
    }
    const with200 = g.filter((r) => typeof r.values.close === "number" && typeof r.values.SMA200 === "number" && (r.values.SMA200 as number) > 0);
    const above = with200.filter((r) => (r.values.close as number) > (r.values.SMA200 as number)).length;
    stats.push({
      id: meta.id,
      name: meta.label,
      side: meta.side,
      perf,
      rel,
      members: g.length,
      ...(with200.length ? { pctAbove200: (above / with200.length) * 100 } : {}),
    });
  }
  return { stats, unknown, all };
}

const pctPoint = (key: string, label: string, v: number | undefined, formula: string, asOf?: string): Point[] =>
  v === undefined ? [] : [{ key, label, value: round4(v), unit: "%", formula, ...(asOf ? { asOf } : {}) }];

function sectorPoints(ns: string, s: SectorStat, bench: string, asOf?: string): Point[] {
  const k = `${ns}.${s.id}`;
  const out: Point[] = [];
  for (const w of Object.keys(WINDOWS) as Win[]) {
    out.push(...pctPoint(`${k}.perf.${w}`, `${s.name} ${w} performance${s.members ? " (median of members)" : ""}`, s.perf[w], `${WINDOWS[w]} sessions`, asOf));
    out.push(...pctPoint(`${k}.rel.${w}`, `${s.name} ${w} performance relative to ${bench}`, s.rel[w], `(1 + r) / (1 + r ${bench}) − 1, × 100`, asOf));
  }
  if (s.composite !== undefined)
    out.push({
      key: `${k}.rs.composite`,
      label: `${s.name} relative-strength composite`,
      value: round4(s.composite),
      unit: "%",
      formula: "0.2 × rel 1m + 0.4 × rel 3m + 0.4 × rel 6m (renormalised over available windows)",
      ...(asOf ? { asOf } : {}),
    });
  if (s.rank !== undefined)
    out.push({ key: `${k}.rs.rank`, label: `${s.name} relative-strength rank (1 = strongest)`, value: s.rank, unit: "count", ...(asOf ? { asOf } : {}) });
  if (s.above50 !== undefined)
    out.push({ key: `${k}.above50`, label: `${s.name} close above its 50-day average`, value: s.above50, ...(asOf ? { asOf } : {}) });
  if (s.above200 !== undefined)
    out.push({ key: `${k}.above200`, label: `${s.name} close above its 200-day average`, value: s.above200, ...(asOf ? { asOf } : {}) });
  if (s.pctAbove200 !== undefined)
    out.push(...pctPoint(`${k}.above200.pct`, `${s.name} members above their 200-day average`, s.pctAbove200, "count(close > SMA200) / members × 100", asOf));
  if (s.members !== undefined)
    out.push({ key: `${k}.members`, label: `${s.name} large caps in the screen`, value: s.members, unit: "count", ...(asOf ? { asOf } : {}) });
  return out;
}

const tableLine = (s: SectorStat, cite: (k: string) => string, ns: string, extra: string) =>
  `  ${String(s.rank ?? "–").padStart(2)}. ${s.name.padEnd(24)} rel 1m ${fmt(s.rel["1m"], 1).padStart(6)} · 3m ${fmt(s.rel["3m"], 1).padStart(6)} · 6m ${fmt(s.rel["6m"], 1).padStart(6)}${cite(`${ns}.${s.id}.rs.composite`)}  ${extra}`;

/** US sectors: the 11 SPDR ETFs against SPY. */
export async function usSectors(now: Date = clockNow()): Promise<Report> {
  const ns = "US.sector";
  const ids = Object.keys(SECTOR_ETFS);
  const hist = await dailyHistories(["SPY", ...ids], 420, now);
  const notes = hist.failed.map((f) => `history unavailable — ${f}`);
  const spy = hist.series.get("SPY");
  if (!spy) throw new Error(`sectors: SPY history unavailable, nothing to compare against — ${notes.join("; ")}`);
  const datasets: Dataset[] = [];
  const stats: SectorStat[] = [];
  const provs = [seriesProvenance(spy)];
  const asOfById = new Map<string, string | undefined>();
  for (const id of ids) {
    const s = hist.series.get(id);
    if (!s) continue;
    const al = alignCloses(s.bars, spy.bars);
    stats.push(etfVsBenchmark(id, al.a, al.b));
    const p = mergeProvenance([seriesProvenance(s), seriesProvenance(spy)], al.dates[al.dates.length - 1]);
    provs.push(p);
    asOfById.set(id, p.asOf);
  }
  const ranked = rankSectors(stats);
  const rot = rotationReading(ranked);
  for (const s of ranked) {
    const sp = hist.series.get(s.id)!;
    datasets.push({
      kind: "sectors",
      title: `${s.id} (${s.name}) vs SPY`,
      subject: s.id,
      points: sectorPoints(ns, s, "SPY", asOfById.get(s.id)),
      provenance: mergeProvenance([seriesProvenance(sp), seriesProvenance(spy)], asOfById.get(s.id)),
      notes: [],
    });
  }
  const derived = derivedProvenance(provs);
  const leaders = ranked.filter((s) => s.rank !== undefined).slice(0, 3);
  const laggards = ranked.filter((s) => s.rank !== undefined).slice(-3);
  datasets.push({
    kind: "sectors",
    title: "US sector rotation",
    subject: "US",
    points: [
      {
        key: `${ns}.rotation`,
        label: "US sector rotation reading",
        value: rot.reading,
        formula: "≥ 2 defensives (XLP, XLU, XLV) in the top four → risk-off; ≥ 3 cyclicals (XLK, XLF, XLY, XLI, XLB) → risk-on; else mixed",
        asOf: derived.asOf,
      },
      { key: `${ns}.rotation.reason`, label: "US sector rotation, reason", value: rot.reason, asOf: derived.asOf },
      { key: `${ns}.leaders`, label: "US sector leaders (top three by relative strength)", value: leaders.map((s) => s.id).join(", "), asOf: derived.asOf },
      {
        key: `${ns}.laggards`,
        label: "US sector laggards (bottom three by relative strength)",
        value: laggards.map((s) => s.id).join(", "),
        asOf: derived.asOf,
      },
    ],
    provenance: derived,
    notes: [`${ranked.length} of ${ids.length} sector ETFs read`, ...notes],
  });
  return {
    datasets,
    json: { market: "us", asOf: derived.asOf, rotation: rot, ranked },
    summary: (cite) => [
      `# US sectors vs SPY — as of ${derived.asOf ?? "n/a"}`,
      `rotation: ${rot.reading}${cite(`${ns}.rotation`)} — ${rot.reason}`,
      `leaders: ${leaders.map((s) => s.id).join(", ")}${cite(`${ns}.leaders`)} · laggards: ${laggards.map((s) => s.id).join(", ")}${cite(`${ns}.laggards`)}`,
      "relative strength (relative performance in %, rank 1 = strongest):",
      ...ranked.map((s) => tableLine(s, cite, ns, `${s.id} ${s.above50 ? "> 50d" : "< 50d"} ${s.above200 ? "> 200d" : "< 200d"}`)),
      ...(notes.length ? ["notes:", ...notes.map((n) => `  - ${n}`)] : []),
    ],
  };
}

/** Euro-area sectors from the screener: median performance and the share above the 200-day, ranked against all large caps. */
export async function euSectors(): Promise<Report> {
  const ns = "EU.sector";
  const tv = await largeCapRows(EU_MARKETS, EU_LARGE_CAP, ["close", "SMA200", "sector", "Perf.1M", "Perf.3M", "Perf.6M"]);
  if (!tv.datasets.length) throw new Error(`sectors: no TradingView market answered — ${tv.failed.join("; ")}`);
  const prov = mergeProvenance(tv.datasets.map((d) => d.provenance));
  const { stats, unknown, all } = groupBySector(tv.rows);
  const ranked = rankSectors(stats);
  const rot = rotationReading(ranked);
  const notes = [
    `${tv.rows.length} primary large caps above 5 bn in ${tv.datasets.length} of ${EU_MARKETS.length} markets (${EU_MARKETS.join(", ")})`,
    "performance is TradingView's (price only); medians, ranked against the median of every large cap in the screen",
    ...(unknown ? [`${unknown} stock(s) with a sector outside TradingView's known taxonomy left out`] : []),
    ...(ranked.some((s) => (s.members ?? 0) < 3) ? ["sectors with fewer than 3 members are noisy — read their rank with care"] : []),
    ...tv.failed.map((f) => `unavailable — ${f}`),
  ];
  const leaders = ranked.filter((s) => s.rank !== undefined).slice(0, 3);
  const laggards = ranked.filter((s) => s.rank !== undefined).slice(-3);
  const points: Point[] = [
    ...pctPoint(`${ns}.all.perf.3m`, "euro-area large caps, median 3-month performance", all["3m"], "median of Perf.3M over the screen", prov.asOf),
    ...ranked.flatMap((s) => sectorPoints(ns, s, "the large-cap median", prov.asOf)),
    {
      key: `${ns}.rotation`,
      label: "euro-area sector rotation reading",
      value: rot.reading,
      formula: "≥ 2 defensives (utilities, health, consumer non-durables, communications) in the top four → risk-off; ≥ 3 cyclicals → risk-on; else mixed",
      asOf: prov.asOf,
    },
    { key: `${ns}.rotation.reason`, label: "euro-area sector rotation, reason", value: rot.reason, asOf: prov.asOf },
    { key: `${ns}.leaders`, label: "euro-area sector leaders (top three)", value: leaders.map((s) => s.name).join(", "), asOf: prov.asOf },
    { key: `${ns}.laggards`, label: "euro-area sector laggards (bottom three)", value: laggards.map((s) => s.name).join(", "), asOf: prov.asOf },
  ];
  return {
    datasets: [{ kind: "sectors", title: "Euro-area sectors (TradingView screener, unofficial)", subject: "EU", points, provenance: prov, notes }],
    json: { market: "eu", asOf: prov.asOf, rotation: rot, ranked },
    summary: (cite) => [
      `# Euro-area sectors — as of ${prov.asOf ?? "n/a"}`,
      `rotation: ${rot.reading}${cite(`${ns}.rotation`)} — ${rot.reason}`,
      `leaders: ${leaders.map((s) => s.name).join(", ")}${cite(`${ns}.leaders`)} · laggards: ${laggards.map((s) => s.name).join(", ")}${cite(`${ns}.laggards`)}`,
      "relative strength (median performance relative to all large caps, in %; rank 1 = strongest):",
      ...ranked.map((s) => tableLine(s, cite, ns, `${s.members} stocks, ${fmt(s.pctAbove200, 0)} % > 200d${cite(`${ns}.${s.id}.above200.pct`)}`)),
      ...(notes.length ? ["notes:", ...notes.map((n) => `  - ${n}`)] : []),
    ],
  };
}
