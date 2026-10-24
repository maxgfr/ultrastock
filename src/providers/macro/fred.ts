// FRED, the St. Louis Fed's economic database — official (a Federal Reserve
// Bank; many series are republished from BLS, BEA, ICE BofA…, which FRED names
// on each series page).
//
//   with a key  https://api.stlouisfed.org/fred/series/observations?series_id=…&api_key=…&file_type=json&observation_start=…
//   keyless     https://fred.stlouisfed.org/graph/fredgraph.csv?id=…&cosd=YYYY-MM-DD
//
// The key is free (ULTRASTOCK_FRED_API_KEY or FRED_API_KEY). Without one, the
// graph CSV export serves the same observations; if that endpoint is refused
// the error says to set a key. Missing observations are "." (JSON) or empty (CSV).
// FRED's edge resets connections that present a browser User-Agent from a
// non-browser client, so both calls identify themselves (politeUa).
import type { Dataset } from "../../core/datasets.js";
import { csvRecords } from "../../core/csv.js";
import { clockNow, fetchJson, fetchText, politeUa } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { isoDate, type Observation, seriesPoints } from "./common.js";

export const SOURCE = "fred";

export const FRED_PRESETS: Record<string, { label: string; unit: string; freq: "d" | "w" | "m" }> = {
  DGS10: { label: "US 10-year Treasury constant-maturity yield", unit: "%", freq: "d" },
  DGS2: { label: "US 2-year Treasury constant-maturity yield", unit: "%", freq: "d" },
  T10Y2Y: { label: "US 10Y minus 2Y Treasury spread", unit: "%", freq: "d" },
  BAMLH0A0HYM2: { label: "ICE BofA US high yield option-adjusted spread", unit: "%", freq: "d" },
  BAMLC0A0CM: { label: "ICE BofA US corporate (IG) option-adjusted spread", unit: "%", freq: "d" },
  DFF: { label: "Effective federal funds rate", unit: "%", freq: "d" },
  CPIAUCSL: { label: "US CPI-U all items (SA)", unit: "index", freq: "m" },
  CPILFESL: { label: "US CPI-U less food and energy (SA)", unit: "index", freq: "m" },
  UNRATE: { label: "US unemployment rate", unit: "%", freq: "m" },
  PAYEMS: { label: "US nonfarm payrolls (thousands)", unit: "thousands", freq: "m" },
  ICSA: { label: "US initial jobless claims (SA)", unit: "count", freq: "w" },
  M2SL: { label: "US M2 money stock (billions USD, SA)", unit: "USD bn", freq: "m" },
  WALCL: { label: "Fed total assets (millions USD, weekly)", unit: "USD mn", freq: "w" },
};

export const fredKey = (): string | undefined => process.env.ULTRASTOCK_FRED_API_KEY || process.env.FRED_API_KEY || undefined;

/** FRED's graph CSV ("observation_date,<ID>") as observations, oldest first; blanks and "." skipped. */
export function parseFredCsv(text: string, id: string): Observation[] {
  return csvRecords(text)
    .flatMap((r) => {
      const date = r.observation_date ?? r.DATE ?? "";
      const raw = r[id] ?? "";
      const value = Number(raw);
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && raw !== "" && raw !== "." && Number.isFinite(value) ? [{ date, value }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The API's observations JSON as observations, oldest first. */
export function parseFredJson(data: { observations?: Array<{ date: string; value: string }> }): Observation[] {
  return (data.observations ?? [])
    .flatMap((o) => (o.value !== "." && Number.isFinite(Number(o.value)) ? [{ date: o.date, value: Number(o.value) }] : []))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** A FRED series' observations since `days` ago (default: a year for monthly, 60 days for daily/weekly). */
export async function fredSeries(id: string, opts: { days?: number; now?: Date; history?: boolean } = {}): Promise<Dataset> {
  const sid = id.toUpperCase();
  const preset = FRED_PRESETS[sid];
  const days = opts.days ?? (preset?.freq === "m" ? 400 : preset?.freq === "w" ? 120 : 60);
  const start = isoDate(new Date((opts.now ?? clockNow()).getTime() - days * 86_400_000));
  const key = fredKey();
  let obs: Observation[];
  let url: string;
  let fetchedAt: string;
  const notes: string[] = [];
  if (key) {
    const apiUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(sid)}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${start}`;
    const res = await fetchJson<{ observations?: Array<{ date: string; value: string }>; error_message?: string }>(apiUrl, { userAgent: politeUa() });
    if (!res.ok || !res.data) throw new ProviderError(SOURCE, `${sid}: API answered HTTP ${res.status}`, res.status);
    obs = parseFredJson(res.data);
    url = `https://fred.stlouisfed.org/series/${sid}`;
    fetchedAt = res.fetchedAt;
  } else {
    const csvUrl = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(sid)}&cosd=${start}`;
    const res = await fetchText(csvUrl, { accept: "text/csv", userAgent: politeUa() });
    if (res.status === 404 || (res.ok && !/observation_date|DATE/.test(res.body.slice(0, 80))))
      throw new ProviderError(SOURCE, `no FRED series ${sid}`, res.status === 404 ? 404 : 400);
    if (!res.ok) throw new ProviderError(SOURCE, `${sid}: keyless CSV export refused (HTTP ${res.status}) — set FRED_API_KEY (free)`, res.status);
    obs = parseFredCsv(res.body, sid);
    url = res.url;
    fetchedAt = res.fetchedAt;
    notes.push("read keyless from FRED's graph CSV export; set FRED_API_KEY (free) to use the documented API");
  }
  if (!obs.length) throw new ProviderError(SOURCE, `${sid}: no observations since ${start}`);
  return {
    kind: "macro",
    title: preset ? `${preset.label} (FRED ${sid})` : `FRED series ${sid}`,
    subject: "US",
    points: seriesPoints(`US.fred.${sid}`, preset?.label ?? `FRED series ${sid}`, preset?.unit, obs, { history: opts.history ?? true }),
    provenance: { source: SOURCE, url, fetchedAt, official: true, asOf: obs[obs.length - 1]!.date },
    notes,
  };
}
