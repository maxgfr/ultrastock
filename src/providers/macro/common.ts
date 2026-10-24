// Shared plumbing for the macro, sentiment, calendar and news providers: the
// observation shape every statistics API reduces to, the dated-series points
// built from it, and the error raised when an answer is not usable. One shape
// so a Treasury yield, an INSEE index and a FRED series cite the same way.
import type { Dataset, Point } from "../../core/datasets.js";
import type { NetResponse } from "../../core/net.js";
import { ProviderError } from "../types.js";

/** One dated value of a series. `date` is YYYY-MM-DD, YYYY-MM (monthly), YYYY-Qn or YYYY (annual) as the source dates it. */
export interface Observation {
  date: string;
  value: number;
}

export type Provenance = Dataset["provenance"];

/** Throw the provider's error when a response is not a usable answer, keeping the HTTP status (0/429/5xx transient). */
export function requireOk(source: string, res: NetResponse, what: string): void {
  if (!res.ok) throw new ProviderError(source, `${what} unavailable (HTTP ${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
}

/** A Date as YYYY-MM-DD (UTC). */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "10/23/2026" (or "9/3/2026") → "2026-10-23", without the local time zone. */
export function usSlashDate(s: string | undefined): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s ?? "").trim());
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : undefined;
}

/** An epoch (ms) as YYYY-MM-DD (UTC). */
export function epochDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A month-level period ("2026-09", "2026-Q2", "2026") as the last day it covers, for comparisons; other strings pass through. */
export function periodEnd(period: string): string {
  let m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) return isoDate(new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)));
  m = /^(\d{4})-?Q([1-4])$/.exec(period);
  if (m) return isoDate(new Date(Date.UTC(Number(m[1]), Number(m[2]) * 3, 0)));
  if (/^\d{4}$/.test(period)) return `${period}-12-31`;
  return period;
}

/**
 * Points for a dated series, oldest first in `obs`: the latest value (keyed
 * `key`), its change from the previous observation (`key.chg`; a rate in % moves
 * in bp) and, with `history`, every observation keyed by its date.
 */
export function seriesPoints(key: string, label: string, unit: string | undefined, obs: readonly Observation[], opts: { history?: boolean } = {}): Point[] {
  const last = obs[obs.length - 1];
  if (!last) return [];
  const points: Point[] = [{ key, label, value: last.value, unit, asOf: last.date }];
  const prev = obs[obs.length - 2];
  if (prev) {
    const bp = unit === "%";
    points.push({
      key: `${key}.chg`,
      label: `${label}, change since ${prev.date}`,
      value: bp ? Number(((last.value - prev.value) * 100).toFixed(4)) : Number((last.value - prev.value).toPrecision(12)),
      unit: bp ? "bp" : unit,
      asOf: last.date,
      formula: bp ? `(${key}@${last.date} − ${key}@${prev.date}) × 100` : `${key}@${last.date} − ${key}@${prev.date}`,
    });
  }
  if (opts.history) for (const o of obs) points.push({ key: `${key}.${o.date}`, label: `${label} (${o.date})`, value: o.value, unit, asOf: o.date });
  return points;
}

/** Sort observations oldest first and drop duplicate dates (the last one read wins). */
export function sortObservations(obs: readonly Observation[]): Observation[] {
  const byDate = new Map<string, number>();
  for (const o of obs) if (Number.isFinite(o.value)) byDate.set(o.date, o.value);
  return [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}
