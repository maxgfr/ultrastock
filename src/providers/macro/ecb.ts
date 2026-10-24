// The ECB Data Portal's SDMX REST API — keyless and official (the euro area's
// central bank publishing its own statistics):
//
//   /service/data/<flow>/<key>?lastNObservations=N&format=csvdata&detail=dataonly
//
// A key is the series' dimensions joined by dots; `+` ORs several values in one
// dimension, so one call can carry several series (the three policy rates, a
// whole yield curve, several currencies). The CSV answer has one row per
// observation with the series KEY, TIME_PERIOD and OBS_VALUE.
//
// Note: the ICP dataset (HICP) was discontinued in February 2026 when Eurostat
// moved the HICP to ECOICOP 2; its successor is the HICP flow (key
// M.U2.N.000000.4D0.ANR for the headline annual rate).
import type { Dataset, Point } from "../../core/datasets.js";
import { csvRecords, parseLooseNumber } from "../../core/csv.js";
import { fetchText } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { type Observation, requireOk, seriesPoints, sortObservations } from "./common.js";

export const SOURCE = "ecb";
const BASE = "https://data-api.ecb.europa.eu/service/data";

export interface SdmxSeries {
  /** The full series key, flow included: "FM.B.U2.EUR.4F.KR.DFR.LEV". */
  key: string;
  obs: Observation[];
}

/** The portal's csvdata answer as series (in key order), observations oldest first. */
export function parseSdmxCsv(text: string): SdmxSeries[] {
  const byKey = new Map<string, Observation[]>();
  for (const r of csvRecords(text)) {
    const key = r.KEY;
    const value = parseLooseNumber(r.OBS_VALUE);
    if (!key || !r.TIME_PERIOD || value === undefined) continue;
    const list = byKey.get(key) ?? [];
    list.push({ date: r.TIME_PERIOD, value });
    byKey.set(key, list);
  }
  return [...byKey.entries()].map(([key, obs]) => ({ key, obs: sortObservations(obs) })).sort((a, b) => a.key.localeCompare(b.key));
}

export const ecbUrl = (flow: string, key: string, n: number) =>
  `${BASE}/${encodeURIComponent(flow)}/${key.split(".").map(encodeURIComponent).join(".").replace(/%2B/g, "+")}?lastNObservations=${n}&format=csvdata&detail=dataonly`;

/** Raw series for a flow and key (several when the key ORs values with `+`). */
export async function fetchEcb(flow: string, key: string, n = 12) {
  const url = ecbUrl(flow, key, n);
  const res = await fetchText(url, { accept: "text/csv" });
  if (res.status === 404) throw new ProviderError(SOURCE, `no series ${flow}.${key}`, 404);
  requireOk(SOURCE, res, `series ${flow}.${key}`);
  const series = parseSdmxCsv(res.body);
  if (!series.length) throw new ProviderError(SOURCE, `series ${flow}.${key} returned no observations`);
  return { series, url: res.url, fetchedAt: res.fetchedAt };
}

/** A generic ECB series as a dataset: latest value, change, and every observation read. */
export async function ecbSeries(
  flow: string,
  key: string,
  n = 12,
  opts: { label?: string; unit?: string; pointKey?: string; subject?: string } = {},
): Promise<Dataset> {
  const { series, url, fetchedAt } = await fetchEcb(flow, key, n);
  const points = series.flatMap((s) =>
    seriesPoints(series.length === 1 && opts.pointKey ? opts.pointKey : `ECB.${s.key}`, opts.label ?? `ECB series ${s.key}`, opts.unit, s.obs, {
      history: true,
    }),
  );
  return {
    kind: "macro",
    title: opts.label ?? `ECB ${flow}.${key}`,
    subject: opts.subject ?? "EA",
    points,
    provenance: { source: SOURCE, url, fetchedAt, official: true, asOf: series[0]!.obs[series[0]!.obs.length - 1]?.date },
    notes: [],
  };
}

/** Named presets: [flow, key, label, unit, point key]. */
export const ECB_PRESETS = {
  dfr: ["FM", "B.U2.EUR.4F.KR.DFR.LEV", "ECB deposit facility rate", "%", "EA.rates.dfr"],
  mro: ["FM", "B.U2.EUR.4F.KR.MRR_FR.LEV", "ECB main refinancing rate", "%", "EA.rates.mro"],
  mlf: ["FM", "B.U2.EUR.4F.KR.MLFR.LEV", "ECB marginal lending facility rate", "%", "EA.rates.mlf"],
  estr: ["EST", "B.EU000A2X2A25.WT", "€STR (euro short-term rate)", "%", "EA.rates.estr"],
  hicp: ["HICP", "M.U2.N.000000.4D0.ANR", "Euro area HICP inflation, y/y", "%", "EA.macro.hicp.yoy"],
  hicpCore: ["HICP", "M.U2.N.XEF000.4D0.ANR", "Euro area core HICP (ex energy, food, alcohol, tobacco), y/y", "%", "EA.macro.hicp.core.yoy"],
} as const satisfies Record<string, readonly [string, string, string, string, string]>;
export type EcbPreset = keyof typeof ECB_PRESETS;

/** One named preset series (deposit rate, €STR, HICP…) over its last `n` observations. */
export async function ecbPreset(name: EcbPreset, n = 12): Promise<Dataset> {
  const [flow, key, label, unit, pointKey] = ECB_PRESETS[name];
  return ecbSeries(flow, key, n, { label, unit, pointKey });
}

const RATE_KEYS: Record<string, [string, string]> = {
  DFR: ["EA.rates.dfr", "ECB deposit facility rate"],
  MRR_FR: ["EA.rates.mro", "ECB main refinancing rate"],
  MLFR: ["EA.rates.mlf", "ECB marginal lending facility rate"],
};

/** The three ECB policy rates in one call; each point is the rate in force since its last change (asOf = the change date). */
export async function ecbPolicyRates(): Promise<Dataset> {
  const { series, url, fetchedAt } = await fetchEcb("FM", "B.U2.EUR.4F.KR.DFR+MRR_FR+MLFR.LEV", 2);
  const points: Point[] = [];
  for (const s of series) {
    const id = s.key.split(".")[6] ?? "";
    const meta = RATE_KEYS[id];
    if (meta) points.push(...seriesPoints(meta[0], meta[1], "%", s.obs));
  }
  return {
    kind: "macro",
    title: "ECB key interest rates",
    subject: "EA",
    points,
    provenance: { source: SOURCE, url, fetchedAt, official: true },
    notes: ["Dates are the dates the current rates took effect; the change is versus the previous decision."],
  };
}

export const EA_TENORS = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"];

/** The euro area AAA government spot curve (Svensson fit) for the latest business day, with the 2s10s spread. */
export async function ecbYieldCurve(tenors: readonly string[] = EA_TENORS): Promise<Dataset> {
  const key = `B.U2.EUR.4F.G_N_A.SV_C_YM.${tenors.map((t) => `SR_${t}`).join("+")}`;
  const { series, url, fetchedAt } = await fetchEcb("YC", key, 1);
  const byTenor = new Map<string, Observation>();
  for (const s of series) {
    const t = s.key.split(".").pop()?.replace(/^SR_/, "");
    const o = s.obs[s.obs.length - 1];
    if (t && o) byTenor.set(t, o);
  }
  const points: Point[] = tenors.flatMap((t) => {
    const o = byTenor.get(t);
    return o ? [{ key: `EA.rates.aaa.${t}`, label: `Euro area AAA spot yield ${t}`, value: Number(o.value.toFixed(4)), unit: "%", asOf: o.date }] : [];
  });
  const y2 = byTenor.get("2Y");
  const y10 = byTenor.get("10Y");
  if (y2 && y10)
    points.push({
      key: "EA.rates.aaa.spread.2s10s",
      label: "Euro area AAA 2s10s spread",
      value: Number(((y10.value - y2.value) * 100).toFixed(2)),
      unit: "bp",
      asOf: y10.date,
      formula: "(EA.rates.aaa.10Y − EA.rates.aaa.2Y) × 100",
    });
  return {
    kind: "macro",
    title: "Euro area AAA government yield curve (ECB)",
    subject: "EA",
    points,
    provenance: { source: SOURCE, url, fetchedAt, delay: "eod", official: true, asOf: y10?.date },
    notes: ["Spot rates fitted by the ECB on AAA-rated euro area central government bonds (Svensson model)."],
  };
}

/** ECB euro reference rates (units of each currency per euro) over the last `n` business days. */
export async function ecbFx(currencies: readonly string[] = ["USD", "GBP", "JPY", "CHF"], n = 5): Promise<Dataset> {
  const ccys = currencies.map((c) => c.toUpperCase());
  const { series, url, fetchedAt } = await fetchEcb("EXR", `D.${ccys.join("+")}.EUR.SP00.A`, n);
  const points = series.flatMap((s) => {
    const ccy = s.key.split(".")[2] ?? "";
    return seriesPoints(`EUR.fx.${ccy}`, `ECB reference rate, ${ccy} per EUR`, ccy, s.obs);
  });
  const missing = ccys.filter((c) => !series.some((s) => s.key.split(".")[2] === c));
  return {
    kind: "fx",
    title: "ECB euro foreign exchange reference rates",
    subject: "EUR",
    points,
    provenance: { source: SOURCE, url, fetchedAt, delay: "eod", official: true },
    notes: [
      "Reference rates set around 14:15 CET each TARGET business day — for information, not a transaction rate.",
      ...(missing.length ? [`no ECB reference rate for: ${missing.join(", ")}`] : []),
    ],
  };
}
