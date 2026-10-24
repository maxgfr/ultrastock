// Eurostat's dissemination API, JSON-stat 2.0 — keyless and official (the EU's
// statistics office):
//
//   /eurostat/api/dissemination/statistics/1.0/data/<dataset>?geo=FR&<dim>=<code>&lastTimePeriod=N
//
// A JSON-stat answer is a cube: `id` names the dimensions in order, `size` their
// lengths, each dimension's `category.index` maps a code to its position, and
// `value` is a SPARSE object keyed by the flat row-major index — a missing key
// is a missing observation (France's unemployment for the latest month before
// its release), never a zero.
//
// The HICP moved to ECOICOP 2 in February 2026: prc_hicp_manr stops at 2025-12
// and prc_hicp_minr (unit=RCH_A, coicop18=TOTAL) carries the annual rate since.
import type { Dataset } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { type Observation, requireOk, seriesPoints } from "./common.js";

export const SOURCE = "eurostat";
const BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";

export interface JsonStat {
  label?: string;
  updated?: string;
  id: string[];
  size: number[];
  value: Record<string, number | null> | Array<number | null>;
  dimension: Record<string, { label?: string; category: { index: Record<string, number> | string[]; label?: Record<string, string> } }>;
  error?: Array<{ label?: string }>;
}

export interface JsonStatSeries {
  /** The non-time dimension codes of this series: { geo: "FR", unit: "RCH_A", … }. */
  dims: Record<string, string>;
  obs: Observation[];
}

const indexOf = (cat: { index: Record<string, number> | string[] }): Array<[string, number]> =>
  Array.isArray(cat.index) ? cat.index.map((c, i) => [c, i]) : Object.entries(cat.index);

/** A JSON-stat cube as one series per combination of its non-time dimensions, observations oldest first. */
export function parseJsonStat(js: JsonStat, timeDim = "time"): JsonStatSeries[] {
  const { id, size } = js;
  const strides = id.map((_, i) => size.slice(i + 1).reduce((a, b) => a * b, 1));
  const codes = id.map((d) => {
    const cat = js.dimension[d]?.category;
    const out: string[] = [];
    if (cat) for (const [c, i] of indexOf(cat)) out[i] = c;
    return out;
  });
  const t = id.indexOf(timeDim);
  if (t < 0) throw new ProviderError(SOURCE, `JSON-stat answer has no "${timeDim}" dimension`);
  const series = new Map<string, JsonStatSeries>();
  const entries: Array<[number, number | null]> = Array.isArray(js.value)
    ? js.value.map((v, i) => [i, v] as [number, number | null])
    : Object.entries(js.value).map(([k, v]) => [Number(k), v] as [number, number | null]);
  for (const [flat, v] of entries) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const pos = id.map((_, i) => Math.floor(flat / strides[i]!) % size[i]!);
    const dims: Record<string, string> = {};
    id.forEach((d, i) => {
      if (i !== t) dims[d] = codes[i]![pos[i]!] ?? String(pos[i]);
    });
    const sk = JSON.stringify(dims);
    const s = series.get(sk) ?? { dims, obs: [] };
    s.obs.push({ date: codes[t]![pos[t]!] ?? String(pos[t]), value: v });
    series.set(sk, s);
  }
  for (const s of series.values()) s.obs.sort((a, b) => a.date.localeCompare(b.date));
  return [...series.values()];
}

/** Query a dataset with dimension filters (a list ORs codes); `lastTimePeriod` bounds the answer. */
export async function eurostatQuery(dataset: string, filters: Record<string, string | readonly string[]>, lastTimePeriod = 13) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) for (const code of typeof v === "string" ? [v] : v) qs.append(k, code);
  qs.set("lastTimePeriod", String(lastTimePeriod));
  const url = `${BASE}/${encodeURIComponent(dataset)}?${qs}`;
  const res = await fetchJson<JsonStat>(url);
  if (res.status === 400 || res.status === 404) throw new ProviderError(SOURCE, `no data for ${dataset} with ${qs}`, res.status);
  requireOk(SOURCE, res, `dataset ${dataset}`);
  if (!res.data?.id) throw new ProviderError(SOURCE, `dataset ${dataset}: not a JSON-stat answer`);
  return { series: parseJsonStat(res.data), updated: res.data.updated, url: res.url, fetchedAt: res.fetchedAt };
}

interface Indicator {
  dataset: string;
  filters: Record<string, string>;
  key: string;
  label: string;
  unit: string;
  note?: string;
}

export type EurostatIndicator = "hicp" | "unemployment" | "gdpQoq" | "gdpYoy";

/** The headline indicators, by name. */
export const EUROSTAT_INDICATORS: Record<EurostatIndicator, Indicator> = {
  hicp: { dataset: "prc_hicp_minr", filters: { unit: "RCH_A", coicop18: "TOTAL" }, key: "macro.hicp.yoy", label: "HICP inflation, y/y", unit: "%" },
  unemployment: {
    dataset: "une_rt_m",
    filters: { s_adj: "SA", age: "TOTAL", sex: "T", unit: "PC_ACT" },
    key: "macro.unemployment",
    label: "unemployment rate (seasonally adjusted)",
    unit: "%",
  },
  gdpQoq: {
    dataset: "namq_10_gdp",
    filters: { na_item: "B1GQ", unit: "CLV_PCH_PRE", s_adj: "SCA" },
    key: "macro.gdp.qoq",
    label: "real GDP growth, q/q",
    unit: "%",
  },
  gdpYoy: {
    dataset: "namq_10_gdp",
    filters: { na_item: "B1GQ", unit: "CLV_PCH_SM", s_adj: "SCA" },
    key: "macro.gdp.yoy",
    label: "real GDP growth, y/y",
    unit: "%",
  },
};

/** One headline indicator for a country (geo code: FR, DE, EA20, EU27_2020…), its last `n` periods. */
export async function eurostatIndicator(name: EurostatIndicator, geo = "FR", n = 13): Promise<Dataset> {
  const ind = EUROSTAT_INDICATORS[name];
  if (!ind) throw new ProviderError(SOURCE, `unknown indicator ${name}`);
  const g = geo.toUpperCase();
  const { series, updated, url, fetchedAt } = await eurostatQuery(ind.dataset, { ...ind.filters, geo: g }, n);
  const obs = series.find((s) => s.dims.geo === g)?.obs ?? [];
  if (!obs.length) throw new ProviderError(SOURCE, `${ind.dataset}: no observation for ${g}`);
  return {
    kind: "macro",
    title: `${g} ${ind.label} (Eurostat ${ind.dataset})`,
    subject: g,
    points: seriesPoints(`${g}.${ind.key}`, `${g} ${ind.label}`, ind.unit, obs, { history: true }),
    provenance: { source: SOURCE, url, fetchedAt, official: true, asOf: obs[obs.length - 1]!.date },
    notes: updated ? [`dataset last updated ${updated.slice(0, 10)}`] : [],
  };
}
