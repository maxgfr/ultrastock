// Shared plumbing for the market-context analyses (regime, sectors,
// catalysts): a polite fan-out over daily histories that names every symbol
// it could not read, closed-bar trimming (no look-ahead), date alignment of
// two series, merged provenance for figures computed from several sources,
// and the report printer that heads the evidence listing with a summary
// citing the [E#] ids it just registered.
import { resolve } from "node:path";
import { type Dataset, formatDatasets, type Point, registerDatasets } from "../../core/datasets.js";
import { argValue, type CommandArgs, jsonLine, mapLimit } from "../../engine.js";
import { getHistory, resolveSymbol } from "../../providers/router.js";
import type { Bar, Market, PriceSeries } from "../../providers/types.js";

/** At most this many requests in flight per command. */
export const FETCH_CONCURRENCY = 4;
const DAY = 86_400_000;

export type DatasetProvenance = Dataset["provenance"];

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const shiftDay = (iso: string, days: number) => isoDay(new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY));
export const round4 = (x: number) => Number(x.toFixed(4));

/**
 * Bars whose session is over at `now`: a bar dated today is dropped for a
 * crypto pair (the daily candle is still open) and for a stock market before
 * its close (US 21:15 UTC, Europe 16:45 UTC — after the close in both DST
 * regimes). Later-dated bars never pass.
 */
export function closedBars<T extends { date: string }>(bars: readonly T[], market: Market, now: Date): T[] {
  const today = isoDay(now);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const closedToday = market === "crypto" ? false : market === "us" ? minutes >= 21 * 60 + 15 : minutes >= 16 * 60 + 45;
  return bars.filter((b) => b.date.slice(0, 10) < today || (b.date.slice(0, 10) === today && closedToday));
}

/** Two close series on the dates both have, oldest first. */
export function alignCloses(a: readonly Bar[], b: readonly Bar[]): { dates: string[]; a: number[]; b: number[] } {
  const bm = new Map(b.map((x) => [x.date, x.close]));
  const out = { dates: [] as string[], a: [] as number[], b: [] as number[] };
  for (const x of a) {
    const y = bm.get(x.date);
    if (y === undefined || !(y > 0) || !(x.close > 0)) continue;
    out.dates.push(x.date);
    out.a.push(x.close);
    out.b.push(y);
  }
  return out;
}

/** The provenance of a figure read off several datasets: the least official, oldest-fetched, latest-dated of them. */
export function mergeProvenance(provs: readonly DatasetProvenance[], asOf?: string): DatasetProvenance {
  const sources = [...new Set(provs.map((p) => p.source))];
  const fetchedAt = provs.map((p) => p.fetchedAt).sort()[0] ?? new Date(0).toISOString();
  const asOfs = provs
    .map((p) => p.asOf)
    .filter((x): x is string => !!x)
    .sort();
  const fallback = [...new Set(provs.map((p) => p.fallbackFrom).filter((x): x is string => !!x))];
  return {
    source: sources.join("+"),
    ...(provs.length === 1 && provs[0]!.url ? { url: provs[0]!.url } : {}),
    fetchedAt,
    ...(provs[0]?.delay ? { delay: provs[0].delay } : {}),
    official: provs.length > 0 && provs.every((p) => p.official),
    ...(fallback.length ? { fallbackFrom: fallback.join(", ") } : {}),
    asOf: asOf ?? asOfs[asOfs.length - 1],
  };
}

/** Provenance for a score computed here from other datasets: source "ultrastock", official only if every input is. */
export function derivedProvenance(provs: readonly DatasetProvenance[], asOf?: string): DatasetProvenance {
  const m = mergeProvenance(provs, asOf);
  return { source: "ultrastock", fetchedAt: m.fetchedAt, official: m.official, ...(m.asOf ? { asOf: m.asOf } : {}) };
}

/** A series' provenance dated at its last bar. */
export const seriesProvenance = (s: PriceSeries, asOf?: string): DatasetProvenance => ({ ...s.provenance, asOf: asOf ?? s.bars[s.bars.length - 1]?.date });

/**
 * Daily histories over the last `days` calendar days, ≤ FETCH_CONCURRENCY at a
 * time, trimmed to closed sessions. A symbol that fails is returned in
 * `failed` with its reason — callers put it in a note, never drop it silently.
 */
export async function dailyHistories(symbols: readonly string[], days: number, now: Date): Promise<{ series: Map<string, PriceSeries>; failed: string[] }> {
  const from = new Date(now.getTime() - days * DAY);
  const rows = await mapLimit(symbols, FETCH_CONCURRENCY, async (s) => {
    try {
      const r = await resolveSymbol(s);
      const series = await getHistory(r, { from, to: now, interval: "1d" });
      const bars = closedBars(series.bars, series.instrument.market, now);
      if (!bars.length) return { s, error: "no closed session in the window" };
      return { s, series: { ...series, bars } };
    } catch (e) {
      return { s, error: (e as Error).message };
    }
  });
  const series = new Map<string, PriceSeries>();
  const failed: string[] = [];
  for (const r of rows) {
    if ("series" in r && r.series) series.set(r.s, r.series);
    else failed.push(`${r.s}: ${"error" in r ? r.error : "no answer"}`);
  }
  return { series, failed };
}

/** Run named tasks, keep what answers, name what did not. */
export async function settle<T>(tasks: Record<string, () => Promise<T>>): Promise<{ ok: Partial<Record<string, T>>; failed: string[] }> {
  const names = Object.keys(tasks);
  const settled = await Promise.allSettled(names.map((n) => tasks[n]!()));
  const ok: Partial<Record<string, T>> = {};
  const failed: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") ok[names[i]!] = s.value;
    else failed.push(`${names[i]}: ${(s.reason as Error)?.message ?? String(s.reason)}`);
  });
  return { ok, failed };
}

/** Points of a dataset whose key is in `keys` (or matches), the dataset's provenance kept. */
export function pickPoints(ds: Dataset, keys: readonly string[] | RegExp, title?: string): Dataset | undefined {
  const points = ds.points.filter((p) => (Array.isArray(keys) ? keys.includes(p.key) : (keys as RegExp).test(p.key)));
  return points.length ? { ...ds, title: title ?? ds.title, points, notes: [] } : undefined;
}

export const pointValue = (ds: Dataset | undefined, key: string): Point["value"] | undefined => ds?.points.find((p) => p.key === key)?.value;
export const pointNumber = (ds: Dataset | undefined, key: string): number | undefined => {
  const v = pointValue(ds, key);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** What a command prints: its datasets, and summary lines written with a lookup of the [E#] each key was registered as. */
export interface Report {
  datasets: Dataset[];
  summary: (cite: (key: string) => string) => string[];
  /** Extra structured fields for --json. */
  json?: Record<string, unknown>;
}

/**
 * Register a report's datasets (with --out) and print them: the summary first,
 * each figure followed by its [E#], then the full numbered listing. --json
 * prints the same shape as every data command, plus `summary`.
 */
export function emitReport(args: CommandArgs, report: Report, asJson: boolean): void {
  const out = argValue(args, "out");
  const dir = out ? resolve(out) : undefined;
  const datasets = report.datasets.filter((d) => d.points.length);
  const registered = registerDatasets(dir, datasets);
  const ids = new Map<string, string>();
  for (const r of registered) r.dataset.points.forEach((p, i) => r.ids[i] && ids.set(p.key, r.ids[i]!));
  const cite = (key: string) => (ids.has(key) ? ` [${ids.get(key)}]` : "");
  if (asJson) {
    process.stdout.write(jsonLine({ dir, ...(report.json ?? {}), datasets: registered.map((r) => ({ ...r.dataset, ids: r.ids, points: r.items })) }));
    return;
  }
  const lines = report.summary(cite);
  process.stdout.write(`${lines.join("\n")}\n\n${formatDatasets(registered)}`);
  if (!out) process.stdout.write("note: no --out, so nothing was registered as evidence — pass --out <dir> to cite these figures\n");
}

/** A number for a summary line: 2 decimals, sign kept. */
export const fmt = (x: number | undefined, d = 2) => (x === undefined || !Number.isFinite(x) ? "n/a" : String(Number(x.toFixed(d))));
