// Frankfurter — a free, keyless JSON mirror of the ECB's euro reference rates
// (and a few other central banks' fixings), used as the FX fallback when the
// ECB portal is slow. A third-party service, so not official itself; the rates
// it carries are the ECB's.
//
//   https://api.frankfurter.dev/v1/latest?base=EUR[&symbols=USD,GBP]
//   https://api.frankfurter.dev/v1/<YYYY-MM-DD>..<YYYY-MM-DD>?base=EUR&symbols=…
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow, fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { isoDate, type Observation, requireOk, seriesPoints } from "./common.js";

export const SOURCE = "frankfurter";
const BASE = "https://api.frankfurter.dev/v1";

interface Latest {
  base: string;
  date: string;
  rates: Record<string, number>;
}
interface Range {
  base: string;
  start_date: string;
  end_date: string;
  rates: Record<string, Record<string, number>>;
}

/** A range answer as observations per currency, oldest first. */
export function parseFrankfurterRange(r: Range): Map<string, Observation[]> {
  const out = new Map<string, Observation[]>();
  for (const date of Object.keys(r.rates).sort())
    for (const [ccy, v] of Object.entries(r.rates[date] ?? {})) {
      const list = out.get(ccy) ?? [];
      list.push({ date, value: v });
      out.set(ccy, list);
    }
  return out;
}

const sym = (symbols?: readonly string[]) => (symbols?.length ? `&symbols=${symbols.map((s) => s.toUpperCase()).join(",")}` : "");

/** The latest reference rates: units of each currency per one `base`. */
export async function frankfurterLatest(base = "EUR", symbols?: readonly string[]): Promise<Dataset> {
  const b = base.toUpperCase();
  const res = await fetchJson<Latest>(`${BASE}/latest?base=${b}${sym(symbols)}`);
  if (res.status === 404 || res.status === 422) throw new ProviderError(SOURCE, `unknown currency in ${b}${sym(symbols)}`, res.status);
  requireOk(SOURCE, res, `latest rates for ${b}`);
  const d = res.data!;
  const points: Point[] = Object.entries(d.rates).map(([ccy, v]) => ({
    key: `${b}.fx.${ccy}`,
    label: `${ccy} per ${b} (ECB reference rate)`,
    value: v,
    unit: ccy,
    asOf: d.date,
  }));
  return {
    kind: "fx",
    title: `Euro reference rates via Frankfurter — ${d.date}`,
    subject: b,
    points,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "eod", official: false, asOf: d.date },
    notes: ["ECB reference rates relayed by frankfurter.dev; cross rates for a non-EUR base are derived from the euro rates."],
  };
}

/** Daily reference rates over the last `days` calendar days, each observation a point. */
export async function frankfurterHistory(symbols: readonly string[], days = 30, base = "EUR", now: Date = clockNow()): Promise<Dataset> {
  const b = base.toUpperCase();
  const from = isoDate(new Date(now.getTime() - days * 86_400_000));
  const res = await fetchJson<Range>(`${BASE}/${from}..${isoDate(now)}?base=${b}${sym(symbols)}`);
  requireOk(SOURCE, res, `rates for ${b} since ${from}`);
  const series = parseFrankfurterRange(res.data!);
  const points = [...series.entries()].flatMap(([ccy, obs]) =>
    seriesPoints(`${b}.fx.${ccy}`, `${ccy} per ${b} (ECB reference rate)`, ccy, obs, { history: true }),
  );
  if (!points.length) throw new ProviderError(SOURCE, `no rates for ${symbols.join(", ")} since ${from}`);
  return {
    kind: "fx",
    title: `Euro reference rates via Frankfurter — since ${from}`,
    subject: b,
    points,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "eod", official: false, asOf: res.data!.end_date },
    notes: [],
  };
}
