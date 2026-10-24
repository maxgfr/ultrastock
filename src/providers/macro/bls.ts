// The US Bureau of Labor Statistics public API, version 1 — keyless and
// official, but tight: 25 queries a day per IP, up to 25 series per query and
// the last three years of data.
//
//   GET  https://api.bls.gov/publicAPI/v1/timeseries/data/<seriesId>
//   POST https://api.bls.gov/publicAPI/v1/timeseries/data/   {"seriesid": [...]}
//
// Each observation is { year, period: "M01".."M12" (M13 = annual average), value }.
// The CPI series are index levels, so the year-on-year rate is computed here
// (formula point), as BLS itself does: index[t] / index[t−12] − 1.
//
// BLS's edge (Akamai) answers some networks with 403 or a 503 "website is busy"
// page whatever the User-Agent; that is a refusal, not data — the error says so
// and points at FRED, which republishes the same series (CPIAUCSL, CPILFESL,
// UNRATE, PAYEMS).
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson, politeUa } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { type Observation, seriesPoints } from "./common.js";

export const SOURCE = "bls";
const BASE = "https://api.bls.gov/publicAPI/v1/timeseries/data/";

interface BlsAnswer {
  status?: string;
  message?: string[];
  Results?: { series?: Array<{ seriesID: string; data?: Array<{ year: string; period: string; value: string }> }> };
}

/** A BLS answer as monthly observations per series id ("YYYY-MM"), oldest first; annual averages (M13) dropped. */
export function parseBls(answer: BlsAnswer): Map<string, Observation[]> {
  const out = new Map<string, Observation[]>();
  for (const s of answer.Results?.series ?? []) {
    const obs: Observation[] = [];
    for (const d of s.data ?? []) {
      const m = /^M(0[1-9]|1[0-2])$/.exec(d.period);
      const value = Number(d.value);
      if (m && /^\d{4}$/.test(d.year) && d.value !== "-" && Number.isFinite(value)) obs.push({ date: `${d.year}-${m[1]}`, value });
    }
    out.set(
      s.seriesID,
      obs.sort((a, b) => a.date.localeCompare(b.date)),
    );
  }
  return out;
}

/** Year-on-year % change of a monthly index series, for every month that has the same month a year earlier. */
export function yoyFromIndex(obs: readonly Observation[]): Observation[] {
  const byDate = new Map(obs.map((o) => [o.date, o.value]));
  const out: Observation[] = [];
  for (const o of obs) {
    const [y, m] = o.date.split("-");
    const prev = byDate.get(`${Number(y) - 1}-${m}`);
    if (prev) out.push({ date: o.date, value: Number(((o.value / prev - 1) * 100).toFixed(2)) });
  }
  return out;
}

export const BLS_SERIES = {
  cpi: { id: "CUUR0000SA0", key: "US.macro.cpi", label: "US CPI-U all items (NSA)", yoy: true },
  coreCpi: { id: "CUUR0000SA0L1E", key: "US.macro.cpi.core", label: "US CPI-U less food and energy (NSA)", yoy: true },
  unemployment: { id: "LNS14000000", key: "US.macro.unemployment", label: "US unemployment rate (SA)", yoy: false },
  payrolls: { id: "CES0000000001", key: "US.macro.payrolls", label: "US nonfarm payrolls (SA)", yoy: false },
} as const;
export type BlsPreset = keyof typeof BLS_SERIES;

/** Raw observations for up to 25 series ids in one query (GET for one, POST for several). */
export async function fetchBls(ids: readonly string[]) {
  const opts = { userAgent: politeUa(process.env.ULTRASTOCK_SEC_CONTACT), retries: 1 };
  const res =
    ids.length === 1
      ? await fetchJson<BlsAnswer>(`${BASE}${encodeURIComponent(ids[0]!)}`, opts)
      : await fetchJson<BlsAnswer>(BASE, { ...opts, method: "POST", json: { seriesid: ids } });
  if (!res.ok || !res.data) {
    const hint =
      res.status === 403 || res.status === 503 ? " — BLS's edge refuses this network; FRED republishes these series (CPIAUCSL, CPILFESL, UNRATE, PAYEMS)" : "";
    throw new ProviderError(SOURCE, `API unavailable (HTTP ${res.status})${hint}`, res.status);
  }
  if (res.data.status !== "REQUEST_SUCCEEDED") {
    const msg = (res.data.message ?? []).join("; ").slice(0, 200);
    throw new ProviderError(SOURCE, `request not served: ${msg || res.data.status}`, /threshold|daily/i.test(msg) ? 429 : 400);
  }
  return { series: parseBls(res.data), url: res.url, fetchedAt: res.fetchedAt };
}

/** The BLS headline series (CPI and core CPI with their computed y/y, unemployment, payrolls with the monthly change) in one query. */
export async function blsHeadlines(which: readonly BlsPreset[] = ["cpi", "coreCpi", "unemployment", "payrolls"]): Promise<Dataset> {
  const presets = which.map((w) => BLS_SERIES[w]);
  const { series, url, fetchedAt } = await fetchBls(presets.map((p) => p.id));
  const points: Point[] = [];
  const notes: string[] = [];
  for (const p of presets) {
    const obs = series.get(p.id) ?? [];
    if (!obs.length) {
      notes.push(`no data for ${p.id}`);
      continue;
    }
    if (p.yoy) {
      const last = obs[obs.length - 1]!;
      points.push({ key: `${p.key}.index`, label: `${p.label}, index`, value: last.value, unit: "index", asOf: last.date });
      const yoy = yoyFromIndex(obs);
      for (const [i, suffix] of [
        [yoy.length - 1, ""],
        [yoy.length - 2, ".prev"],
      ] as const) {
        const y = yoy[i];
        if (!y) continue;
        const base = `${Number(y.date.slice(0, 4)) - 1}${y.date.slice(4)}`;
        points.push({
          key: `${p.key}.yoy${suffix}`,
          label: `${p.label}, y/y${suffix ? ` (${y.date})` : ""}`,
          value: y.value,
          unit: "%",
          asOf: y.date,
          formula: `(index ${y.date} / index ${base} − 1) × 100`,
        });
      }
    } else if (p.id === "CES0000000001") {
      const persons = obs.map((o) => ({ date: o.date, value: o.value * 1000 }));
      points.push(...seriesPoints(p.key, `${p.label}, employees`, "count", persons));
    } else points.push(...seriesPoints(p.key, p.label, "%", obs));
  }
  if (!points.length) throw new ProviderError(SOURCE, `no observations for ${presets.map((p) => p.id).join(", ")}`);
  return {
    kind: "macro",
    title: "US labour and price statistics (BLS)",
    subject: "US",
    points,
    provenance: { source: SOURCE, url, fetchedAt, official: true },
    notes: [
      ...notes,
      "Monthly data; the latest month is the last release (no revisions history). Payroll changes are the first-difference of the published level.",
    ],
  };
}

/** Any BLS series id as a dataset of its monthly observations (last three years). */
export async function blsSeries(id: string): Promise<Dataset> {
  const { series, url, fetchedAt } = await fetchBls([id]);
  const obs = series.get(id) ?? [];
  if (!obs.length) throw new ProviderError(SOURCE, `no data for series ${id}`);
  return {
    kind: "macro",
    title: `BLS series ${id}`,
    subject: "US",
    points: seriesPoints(`US.bls.${id}`, `BLS series ${id}`, undefined, obs, { history: true }),
    provenance: { source: SOURCE, url, fetchedAt, official: true, asOf: obs[obs.length - 1]!.date },
    notes: [],
  };
}
