// INSEE's macro-economic database (BDM) over SDMX 2.1 — keyless and official
// (France's statistics office):
//
//   https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/<idbank>[+<idbank>…]?lastNObservations=N
//
// The answer is SDMX "structure-specific" XML: a <Series IDBANK=… FREQ=…> per
// series and an <Obs TIME_PERIOD=… OBS_VALUE=…/> per observation, newest first;
// `DATE_JO` on an observation is its publication date (kept: point-in-time).
//
// The CPI was rebased to 2025 in January 2026: the base-2015 series (idbank
// 001759970 and its siblings) are "séries arrêtées" ending 2025-12. The current
// headline series are 011814632 (all items, y/y) and 011814630 (index).
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchText } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { type Observation, requireOk, seriesPoints } from "./common.js";

export const SOURCE = "insee";
const BASE = "https://bdm.insee.fr/series/sdmx/data/SERIES_BDM";

export interface InseeSeries {
  idbank: string;
  freq?: string;
  lastUpdate?: string;
  /** Observations oldest first; `published` is the Journal officiel date when INSEE gives one. */
  obs: Array<Observation & { published?: string }>;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** The BDM's SDMX XML as series, observations oldest first (periods as INSEE writes them: 2026-09, 2026-Q2, 2026). */
export function parseInseeSdmx(xml: string): InseeSeries[] {
  const out: InseeSeries[] = [];
  for (const block of xml.split(/<Series\s/).slice(1)) {
    const head = block.slice(0, block.indexOf(">"));
    const a = attrs(head);
    if (!a.IDBANK) continue;
    const obs: InseeSeries["obs"] = [];
    for (const m of block.matchAll(/<Obs\s([^>]*?)\/?>/g)) {
      const o = attrs(m[1]!);
      const value = Number(o.OBS_VALUE);
      if (!o.TIME_PERIOD || o.OBS_VALUE === undefined || o.OBS_VALUE === "" || !Number.isFinite(value)) continue;
      obs.push({ date: o.TIME_PERIOD, value, ...(o.DATE_JO ? { published: o.DATE_JO } : {}) });
    }
    obs.sort((x, y) => x.date.localeCompare(y.date));
    out.push({ idbank: a.IDBANK, freq: a.FREQ, lastUpdate: a.LAST_UPDATE, obs });
  }
  return out;
}

/** Raw series for one or more idbanks. */
export async function fetchInsee(idbanks: readonly string[], n = 13) {
  const url = `${BASE}/${idbanks.map(encodeURIComponent).join("+")}?lastNObservations=${n}`;
  const res = await fetchText(url, { accept: "application/xml" });
  if (res.status === 404) throw new ProviderError(SOURCE, `no BDM series ${idbanks.join(", ")}`, 404);
  requireOk(SOURCE, res, `BDM series ${idbanks.join(", ")}`);
  const series = parseInseeSdmx(res.body);
  if (!series.some((s) => s.obs.length)) throw new ProviderError(SOURCE, `BDM series ${idbanks.join(", ")} returned no observations`);
  return { series, url: res.url, fetchedAt: res.fetchedAt };
}

/** Named presets: idbank, point key, label, unit. */
export const INSEE_PRESETS = {
  cpi: { idbank: "011814632", key: "FR.macro.cpi.yoy", label: "France CPI inflation (all items, base 2025), y/y", unit: "%" },
  cpiIndex: { idbank: "011814630", key: "FR.macro.cpi.index", label: "France CPI index (all items, base 2025)", unit: "index" },
  unemployment: { idbank: "001688527", key: "FR.macro.unemployment.ilo", label: "France ILO unemployment rate (excl. Mayotte, SA)", unit: "%" },
} as const;
export type InseePreset = keyof typeof INSEE_PRESETS;

/** One BDM series as a dataset; presets name the headline CPI and unemployment, any other idbank is cited by its id. */
export async function inseeSeries(idbankOrPreset: string, n = 13): Promise<Dataset> {
  const preset = (INSEE_PRESETS as Record<string, { idbank: string; key: string; label: string; unit: string }>)[idbankOrPreset];
  const idbank = preset?.idbank ?? idbankOrPreset;
  if (!/^\d{9}$/.test(idbank))
    throw new ProviderError(SOURCE, `"${idbankOrPreset}" is neither a preset (${Object.keys(INSEE_PRESETS).join(", ")}) nor a 9-digit idbank`);
  const { series, url, fetchedAt } = await fetchInsee([idbank], n);
  const s = series.find((x) => x.idbank === idbank) ?? series[0]!;
  const key = preset?.key ?? `FR.insee.${idbank}`;
  const label = preset?.label ?? `INSEE BDM series ${idbank}`;
  const points: Point[] = seriesPoints(key, label, preset?.unit, s.obs, { history: true });
  const last = s.obs[s.obs.length - 1];
  if (last?.published)
    points.push({ key: `${key}.published`, label: `${label}, publication date of the latest value`, value: last.published, asOf: last.date });
  return {
    kind: "macro",
    title: label,
    subject: "FR",
    points,
    provenance: { source: SOURCE, url, fetchedAt, official: true, asOf: last?.date },
    notes: s.lastUpdate ? [`series last updated ${s.lastUpdate}`] : [],
  };
}
