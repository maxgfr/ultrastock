// FINRA Reg SHO daily short-sale volume (official: FINRA is the self-regulatory
// organization the trades are reported to), keyless:
//
//   query API     POST https://api.finra.org/data/group/otcMarket/name/regShoDaily
//                 (per symbol and date range; one row per trade reporting facility)
//   daily files   https://cdn.finra.org/equity/regsho/daily/CNMSshvol<YYYYMMDD>.txt
//                 (pipe-delimited, every NMS symbol, ~0.5 MB a day — the fallback)
//
// Both carry the same consolidated NMS figure (the facilities summed); files
// appear the evening of the session, and weekends and holidays have none (the
// CDN answers 403). Short VOLUME is the share of the day's off-exchange trade
// reports marked short — market makers short to fill buy orders, so 40–50 % is
// ordinary — and is NOT short INTEREST (open positions, twice a month).
import { csvRecords, parseLooseNumber } from "../../core/csv.js";
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow, fetchJson, fetchText } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { isoDayOf } from "./util.js";

export const FINRA_SOURCE = "finra";
const API = "https://api.finra.org/data/group/otcMarket/name/regShoDaily";
const CDN = "https://cdn.finra.org/equity/regsho/daily";

export interface ShortVolumeDay {
  date: string;
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
  /** shortVolume / totalVolume, in %. */
  ratio: number;
}

const day = (date: string, shortVolume: number, shortExemptVolume: number, totalVolume: number): ShortVolumeDay => ({
  date,
  shortVolume,
  shortExemptVolume,
  totalVolume,
  ratio: totalVolume > 0 ? (shortVolume / totalVolume) * 100 : 0,
});

/** API rows (one per facility and day) → one consolidated day each, newest first. OTC (ORF) rows are not NMS and are skipped. */
export function parseRegShoApi(rows: unknown): ShortVolumeDay[] {
  const byDate = new Map<string, { s: number; x: number; t: number }>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const o = r as Record<string, unknown>;
    const date = typeof o.tradeReportDate === "string" ? o.tradeReportDate.slice(0, 10) : undefined;
    if (!date || o.reportingFacilityCode === "ORF") continue;
    const acc = byDate.get(date) ?? { s: 0, x: 0, t: 0 };
    acc.s += Number(o.shortParQuantity) || 0;
    acc.x += Number(o.shortExemptParQuantity) || 0;
    acc.t += Number(o.totalParQuantity) || 0;
    byDate.set(date, acc);
  }
  return [...byDate.entries()].map(([d, a]) => day(d, a.s, a.x, a.t)).sort((a, b) => b.date.localeCompare(a.date));
}

/** One CNMSshvol file → the row of `symbol`, or undefined. */
export function parseRegShoFile(text: string, symbol: string): ShortVolumeDay | undefined {
  const sym = symbol.toUpperCase();
  const row = csvRecords(text, { delimiter: "|" }).find((r) => r.Symbol === sym);
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(row?.Date ?? "");
  const s = parseLooseNumber(row?.ShortVolume);
  const t = parseLooseNumber(row?.TotalVolume);
  if (!row || !d || s === undefined || t === undefined) return undefined;
  return day(`${d[1]}-${d[2]}-${d[3]}`, s, parseLooseNumber(row.ShortExemptVolume) ?? 0, t);
}

async function fromApi(sym: string, sessions: number, now: Date) {
  const start = isoDayOf(new Date(now.getTime() - Math.ceil(sessions * 1.6 + 7) * 86_400_000));
  const body = {
    limit: 5000,
    compareFilters: [{ compareType: "equal", fieldName: "securitiesInformationProcessorSymbolIdentifier", fieldValue: sym }],
    dateRangeFilters: [{ fieldName: "tradeReportDate", startDate: start, endDate: isoDayOf(now) }],
  };
  const res = await fetchJson<unknown>(API, { method: "POST", json: body, accept: "application/json" });
  if (!res.ok || res.data === undefined)
    throw new ProviderError(FINRA_SOURCE, `query API failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  return { days: parseRegShoApi(res.data).slice(0, sessions), url: API, fetchedAt: res.fetchedAt };
}

async function fromFiles(sym: string, sessions: number, now: Date) {
  const days: ShortVolumeDay[] = [];
  let fetchedAt = "";
  let url = "";
  for (let back = 0; back < sessions * 2 + 6 && days.length < sessions; back++) {
    const d = isoDayOf(new Date(now.getTime() - back * 86_400_000)).replace(/-/g, "");
    const u = `${CDN}/CNMSshvol${d}.txt`;
    const res = await fetchText(u, { accept: "text/plain", retries: 0 });
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) continue;
      throw new ProviderError(FINRA_SOURCE, `${u} (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
    }
    const row = parseRegShoFile(res.body, sym);
    if (row) days.push(row);
    url ||= u;
    fetchedAt ||= res.fetchedAt;
  }
  return { days, url, fetchedAt };
}

/** The short-volume ratio of a symbol over its last `sessions` reported sessions (API first, daily files as fallback). */
export async function finraShortVolume(symbol: string, opts: { sessions?: number; now?: Date } = {}): Promise<Dataset> {
  const sym = symbol.trim().toUpperCase().replace(/\.US$/, "");
  const sessions = Math.min(Math.max(opts.sessions ?? 10, 1), 60);
  const now = opts.now ?? clockNow();
  const notes: string[] = [];
  let got: { days: ShortVolumeDay[]; url: string; fetchedAt: string };
  let fallbackFrom: string | undefined;
  try {
    got = await fromApi(sym, sessions, now);
  } catch (e) {
    if (!(e instanceof ProviderError) || !e.transient) throw e;
    notes.push(`query API unavailable (${e.message}); read the daily files instead`);
    fallbackFrom = "finra-api";
    got = await fromFiles(sym, sessions, now);
  }
  if (!got.days.length) throw new ProviderError(FINRA_SOURCE, `no Reg SHO short-volume rows for ${sym} in the last ${sessions} sessions`, 404);
  const points: Point[] = got.days.map((d) => ({
    key: `${sym}.shortvol.ratio.${d.date}`,
    label: `${sym} short-sale volume share of reported volume, ${d.date}`,
    value: d.ratio,
    unit: "%",
    asOf: d.date,
    formula: `short volume ${Math.round(d.shortVolume)} / total ${Math.round(d.totalVolume)}`,
  }));
  const avg = got.days.reduce((s, d) => s + d.ratio, 0) / got.days.length;
  points.push({
    key: `${sym}.shortvol.ratio.avg`,
    label: `${sym} average short-volume share over ${got.days.length} sessions`,
    value: avg,
    unit: "%",
    asOf: got.days[0]!.date,
    formula: "mean of the daily ratios",
  });
  notes.push("short VOLUME (trade reports marked short, FINRA facilities only — not exchange prints) is not short INTEREST; 40–50 % is ordinary market making");
  if (got.days.length < sessions) notes.push(`only ${got.days.length} of ${sessions} sessions found`);
  return {
    kind: "short-volume",
    title: `${sym} daily short-sale volume (FINRA Reg SHO)`,
    subject: sym,
    points,
    provenance: {
      source: FINRA_SOURCE,
      url: got.url,
      fetchedAt: got.fetchedAt,
      delay: "eod",
      official: true,
      asOf: got.days[0]!.date,
      ...(fallbackFrom ? { fallbackFrom } : {}),
    },
    notes,
  };
}
