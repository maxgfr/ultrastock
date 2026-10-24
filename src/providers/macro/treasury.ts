// US Treasury daily par yield curve, read from the Treasury's own CSV export —
// keyless and official (the Office of Debt Management publishes it each
// business day around 18:00 ET):
//
//   /resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/<YEAR>/all
//     ?type=daily_treasury_yield_curve&field_tdr_date_value=<YEAR>&page&_format=csv
//
// One file per calendar year, newest row first, tenors 1M … 30Y as columns (the
// set has changed over time: 1.5M, 4M and 20Y were added later; a blank cell is
// a tenor not quoted that day). A window crossing 1 January reads two files.
import type { Dataset, Point } from "../../core/datasets.js";
import { csvRecords, parseLooseNumber } from "../../core/csv.js";
import { clockNow, fetchText } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { isoDate, type Observation, requireOk, seriesPoints, usSlashDate } from "./common.js";

export const SOURCE = "us-treasury";
const BASE = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv";

export interface CurveRow {
  date: string;
  /** Par yield in %, by tenor ("1M", "1.5M", "3M", "2Y", "10Y"…). */
  yields: Record<string, number>;
}

export const treasuryCsvUrl = (year: number) => `${BASE}/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;

/** "1 Mo" → "1M", "1.5 Month" → "1.5M", "10 Yr" → "10Y"; undefined for a non-tenor column. */
export function tenorOf(header: string): string | undefined {
  const m = /^([\d.]+)\s*(mo|month|months|yr|year|years)$/i.exec(header.trim());
  return m ? `${m[1]}${m[2]!.toLowerCase().startsWith("m") ? "M" : "Y"}` : undefined;
}

/** The Treasury's CSV as curve rows, oldest first. */
export function parseTreasuryCsv(text: string): CurveRow[] {
  const rows: CurveRow[] = [];
  for (const r of csvRecords(text)) {
    const date = usSlashDate(r.Date);
    if (!date) continue;
    const yields: Record<string, number> = {};
    for (const [h, v] of Object.entries(r)) {
      const tenor = tenorOf(h);
      const n = parseLooseNumber(v);
      if (tenor && n !== undefined) yields[tenor] = n;
    }
    if (Object.keys(yields).length) rows.push({ date, yields });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

async function readYear(year: number): Promise<{ rows: CurveRow[]; url: string; fetchedAt: string }> {
  const res = await fetchText(treasuryCsvUrl(year), { accept: "text/csv" });
  requireOk(SOURCE, res, `the ${year} par yield curve`);
  return { rows: parseTreasuryCsv(res.body), url: res.url, fetchedAt: res.fetchedAt };
}

/** Curve rows covering the last `days` calendar days before `now` (reads the previous year's file when the window crosses 1 January). */
export async function treasuryRows(days: number, now: Date = clockNow()) {
  const from = isoDate(new Date(now.getTime() - days * 86_400_000));
  const year = now.getUTCFullYear();
  const cur = await readYear(year);
  let rows = cur.rows;
  if (from.slice(0, 4) < String(year) || !rows.length) rows = [...(await readYear(year - 1)).rows, ...rows];
  rows = rows.filter((r) => r.date >= from);
  if (!rows.length) throw new ProviderError(SOURCE, `no par yield curve published since ${from}`);
  return { rows, url: cur.url, fetchedAt: cur.fetchedAt };
}

const spread = (key: string, label: string, long: string, short: string, row: CurveRow): Point | undefined => {
  const a = row.yields[long];
  const b = row.yields[short];
  if (a === undefined || b === undefined) return undefined;
  return {
    key,
    label,
    value: Number(((a - b) * 100).toFixed(2)),
    unit: "bp",
    asOf: row.date,
    formula: `(US.rates.ust.${long} − US.rates.ust.${short}) × 100`,
  };
};

/** Curve points for one row: every tenor plus the 2s10s and 3m10y spreads (bp). */
export function curvePoints(row: CurveRow): Point[] {
  const points: Point[] = Object.entries(row.yields).map(([tenor, v]) => ({
    key: `US.rates.ust.${tenor}`,
    label: `US Treasury ${tenor} par yield`,
    value: v,
    unit: "%",
    asOf: row.date,
  }));
  for (const p of [
    spread("US.rates.ust.spread.2s10s", "US Treasury 2s10s spread", "10Y", "2Y", row),
    spread("US.rates.ust.spread.3m10y", "US Treasury 3m10y spread", "10Y", "3M", row),
  ])
    if (p) points.push(p);
  return points;
}

/** The latest published par yield curve (1M … 30Y) with the 2s10s and 3m10y spreads and the 10Y's daily change. */
export async function treasuryCurve(now: Date = clockNow()): Promise<Dataset> {
  const { rows, url, fetchedAt } = await treasuryRows(14, now);
  const last = rows[rows.length - 1]!;
  const points = curvePoints(last);
  const tenYear: Observation[] = rows.slice(-2).flatMap((r) => (r.yields["10Y"] === undefined ? [] : [{ date: r.date, value: r.yields["10Y"] }]));
  const chg = seriesPoints("US.rates.ust.10Y", "US Treasury 10Y par yield", "%", tenYear).find((p) => p.key.endsWith(".chg"));
  if (chg) points.push(chg);
  return {
    kind: "macro",
    title: `US Treasury par yield curve — ${last.date}`,
    subject: "US",
    points,
    provenance: { source: SOURCE, url, fetchedAt, delay: "eod", official: true, asOf: last.date },
    notes: ["Par yields (bond-equivalent, %), published by the US Treasury each business day after the close."],
  };
}

/** One tenor's daily par yield over the last `days` calendar days, every observation as a point. */
export async function treasuryHistory(tenor = "10Y", days = 30, now: Date = clockNow()): Promise<Dataset> {
  const t = tenor.toUpperCase();
  const { rows, url, fetchedAt } = await treasuryRows(days, now);
  const obs = rows.flatMap((r) => (r.yields[t] === undefined ? [] : [{ date: r.date, value: r.yields[t] }]));
  if (!obs.length) throw new ProviderError(SOURCE, `no ${t} par yield in the last ${days} days (tenors: ${Object.keys(rows[0]!.yields).join(", ")})`);
  return {
    kind: "macro",
    title: `US Treasury ${t} par yield — last ${days} days`,
    subject: "US",
    points: seriesPoints(`US.rates.ust.${t}`, `US Treasury ${t} par yield`, "%", obs, { history: true }),
    provenance: { source: SOURCE, url, fetchedAt, delay: "eod", official: true, asOf: obs[obs.length - 1]!.date },
    notes: [],
  };
}
