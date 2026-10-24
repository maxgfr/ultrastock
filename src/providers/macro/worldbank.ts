// The World Bank Indicators API (World Development Indicators, source 2) —
// keyless. Marked official: it is the World Bank's own published database,
// compiled from national statistics offices; annual, and a year or more behind.
//
//   https://api.worldbank.org/v2/country/<iso>/indicator/<code>[;<code>…]?format=json&mrnev=N&source=2
//
// `mrnev` = the N most recent NON-EMPTY values per indicator (`mrv` counts empty
// years too). An indicator a country does not report (France's central
// government debt) comes back absent, and is named in the notes.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { type Observation, requireOk, seriesPoints } from "./common.js";

export const SOURCE = "worldbank";
const BASE = "https://api.worldbank.org/v2/country";

type WbRow = { indicator?: { id?: string }; countryiso3code?: string; date?: string; value?: number | null };
type WbAnswer =
  | [{ total?: number; message?: Array<{ value?: string }>; lastupdated?: string | null }, WbRow[] | null]
  | [{ message?: Array<{ value?: string }> }];

export const WB_INDICATORS = {
  gdpGrowth: { code: "NY.GDP.MKTP.KD.ZG", key: "macro.gdp.growth", label: "real GDP growth (annual)", unit: "%" },
  gdp: { code: "NY.GDP.MKTP.CD", key: "macro.gdp.usd", label: "GDP (current US$)", unit: "USD" },
  inflation: { code: "FP.CPI.TOTL.ZG", key: "macro.inflation", label: "consumer price inflation (annual)", unit: "%" },
  debt: { code: "GC.DOD.TOTL.GD.ZS", key: "macro.debt.gdp", label: "central government debt (% of GDP)", unit: "%" },
  unemployment: { code: "SL.UEM.TOTL.ZS", key: "macro.unemployment.ilo", label: "unemployment (ILO modelled, % of labour force)", unit: "%" },
  currentAccount: { code: "BN.CAB.XOKA.GD.ZS", key: "macro.currentAccount.gdp", label: "current account balance (% of GDP)", unit: "%" },
} as const;
export type WbIndicator = keyof typeof WB_INDICATORS;

/** A World Bank answer as observations per indicator code, oldest first. */
export function parseWorldBank(answer: WbAnswer): Map<string, Observation[]> {
  const out = new Map<string, Observation[]>();
  for (const r of (answer[1] as WbRow[] | null | undefined) ?? []) {
    const code = r.indicator?.id;
    if (!code || !r.date || r.value === null || r.value === undefined || !Number.isFinite(r.value)) continue;
    const list = out.get(code) ?? [];
    list.push({ date: r.date, value: r.value });
    out.set(code, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** Annual indicators for a country (ISO2 or ISO3), the `n` most recent reported years each, in one call. */
export async function worldBankIndicators(iso: string, which: readonly WbIndicator[] = ["gdpGrowth", "inflation", "debt"], n = 3): Promise<Dataset> {
  const c = iso.toUpperCase();
  const defs = which.map((w) => WB_INDICATORS[w]);
  const url = `${BASE}/${encodeURIComponent(c)}/indicator/${defs.map((d) => d.code).join(";")}?format=json&mrnev=${n}&source=2&per_page=500`;
  const res = await fetchJson<WbAnswer>(url);
  requireOk(SOURCE, res, `indicators for ${c}`);
  const msg = res.data?.[0]?.message?.[0]?.value;
  if (msg) throw new ProviderError(SOURCE, `${c}: ${msg.slice(0, 160)}`, 400);
  const series = parseWorldBank(res.data!);
  const points: Point[] = [];
  const missing: string[] = [];
  for (const d of defs) {
    const obs = series.get(d.code);
    if (obs?.length) points.push(...seriesPoints(`${c}.${d.key}`, `${c} ${d.label}`, d.unit, obs, { history: true }));
    else missing.push(d.code);
  }
  if (!points.length) throw new ProviderError(SOURCE, `no data for ${c} (${defs.map((d) => d.code).join(", ")}) — check the country code`);
  return {
    kind: "macro",
    title: `${c} World Development Indicators (World Bank)`,
    subject: c,
    points,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, official: true },
    notes: [
      "Annual data compiled by the World Bank from national sources; usually a year or more behind national releases.",
      ...(missing.length ? [`not reported for ${c}: ${missing.join(", ")}`] : []),
    ],
  };
}
