// Event calendars — economic releases, earnings and dividends — from two
// keyless, undocumented feeds (both unofficial):
//
//   Nasdaq        https://api.nasdaq.com/api/calendar/economicevents?date=YYYY-MM-DD   (actual, consensus, previous; GMT times)
//                 https://api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD
//                 https://api.nasdaq.com/api/calendar/dividends?date=YYYY-MM-DD        (by ex-dividend date)
//   ForexFactory  https://nfs.faireconomy.media/ff_calendar_thisweek.json             (this week only; impact, forecast, previous)
//
// Event names, company names and the figures as the feeds write them ("-775M",
// "1.9%") are external text: each event is ONE untrusted point whose value
// reads "time | country | event | …", and the typed rows are exported for code
// that needs the fields. A calendar says what is scheduled — dates move, and
// an "actual" is only as good as the feed's latency.
import type { Dataset, Point } from "../../core/datasets.js";
import { parseLooseNumber } from "../../core/csv.js";
import { decodeEntities } from "../../engine.js";
import { clockNow, fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { isoDate, requireOk, usSlashDate } from "./common.js";

const NASDAQ = "https://api.nasdaq.com/api/calendar";
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const nasdaqOpts = { headers: { referer: "https://www.nasdaq.com/", origin: "https://www.nasdaq.com" } };

export interface EconEvent {
  /** ISO timestamp (UTC) when the feed gives a time, else the date. */
  at: string;
  country: string;
  event: string;
  impact?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
  source: "nasdaq" | "forexfactory";
}

const clean = (s: unknown): string | undefined => {
  if (typeof s !== "string") return undefined;
  const t = decodeEntities(s).replace(/\s+/g, " ").trim();
  return t ? t : undefined;
};

/** The UTC instant of a wall-clock time in New York (DST from the platform's tz database). */
export function newYorkToUtc(date: string, hh: number, mm: number): string {
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hh, mm);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess + (guess - shown)).toISOString().replace(/\.000Z$/, "Z");
}

/** Nasdaq's economicevents rows for `date` as events ("24H" = all day). The `gmt` field holds New York times despite its name (durable goods at 08:30). */
export function parseNasdaqEconomic(rows: ReadonlyArray<Record<string, unknown>>, date: string): EconEvent[] {
  return rows.flatMap((r) => {
    const event = clean(r.eventName);
    if (!event) return [];
    const t = /^(\d{2}):(\d{2})$/.exec(String(r.gmt ?? "").trim());
    return [
      {
        at: t ? newYorkToUtc(date, Number(t[1]), Number(t[2])) : date,
        country: clean(r.country) ?? "",
        event,
        actual: clean(r.actual),
        forecast: clean(r.consensus),
        previous: clean(r.previous),
        source: "nasdaq" as const,
      },
    ];
  });
}

/** ForexFactory's weekly JSON as events, times converted to UTC. */
export function parseForexFactory(rows: ReadonlyArray<Record<string, unknown>>): EconEvent[] {
  return rows.flatMap((r) => {
    const event = clean(r.title);
    const ms = Date.parse(String(r.date ?? ""));
    if (!event || Number.isNaN(ms)) return [];
    return [
      {
        at: new Date(ms).toISOString().replace(/\.000Z$/, "Z"),
        country: clean(r.country) ?? "",
        event,
        impact: clean(r.impact),
        actual: clean(r.actual),
        forecast: clean(r.forecast),
        previous: clean(r.previous),
        source: "forexfactory" as const,
      },
    ];
  });
}

/** One untrusted point per event, plus the count. */
export function econEventsToDataset(
  events: readonly EconEvent[],
  meta: { title: string; url: string; fetchedAt: string; source: string; notes?: string[] },
): Dataset {
  const points: Point[] = [{ key: "CAL.econ.count", label: "economic events listed", value: events.length, unit: "count" }];
  events.forEach((e, i) => {
    const fields = [
      e.impact ? `impact: ${e.impact}` : "",
      e.actual ? `actual: ${e.actual}` : "",
      e.forecast ? `forecast: ${e.forecast}` : "",
      e.previous ? `previous: ${e.previous}` : "",
    ].filter(Boolean);
    points.push({
      key: `CAL.econ.${e.at.slice(0, 10)}.${i + 1}`,
      label: `economic event ${i + 1} (${e.at.length > 10 ? `${e.at.slice(11, 16)} UTC` : "all day"})`,
      value: [e.country, e.event, ...fields].join(" | "),
      untrusted: true,
      asOf: e.at.slice(0, 10),
    });
  });
  return {
    kind: "calendar",
    title: meta.title,
    points,
    provenance: { source: meta.source, url: meta.url, fetchedAt: meta.fetchedAt, official: false },
    notes: meta.notes ?? [],
  };
}

/** Nasdaq's economic calendar for one day (GMT times; actual, consensus, previous). */
export async function nasdaqEconomicCalendar(date: string = isoDate(clockNow())): Promise<Dataset> {
  const res = await fetchJson<{ data?: { rows?: Array<Record<string, unknown>> | null } | null }>(`${NASDAQ}/economicevents?date=${date}`, nasdaqOpts);
  requireOk("nasdaq", res, `economic calendar for ${date}`);
  const rows = res.data?.data?.rows;
  if (!Array.isArray(rows)) throw new ProviderError("nasdaq", `economic calendar for ${date}: unexpected answer`);
  const events = parseNasdaqEconomic(rows, date);
  return econEventsToDataset(events, { title: `Economic calendar — ${date} (Nasdaq)`, url: res.url, fetchedAt: res.fetchedAt, source: "nasdaq" });
}

const IMPACT_RANK: Record<string, number> = { holiday: 0, low: 1, medium: 2, high: 3 };

/** This week's ForexFactory calendar from `now` on, at or above `minImpact` (low | medium | high). */
export async function forexFactoryCalendar(opts: { now?: Date; minImpact?: "low" | "medium" | "high"; includePast?: boolean } = {}): Promise<Dataset> {
  const res = await fetchJson<Array<Record<string, unknown>>>(FF_URL);
  requireOk("forexfactory", res, "this week's calendar");
  if (!Array.isArray(res.data)) throw new ProviderError("forexfactory", "calendar: unexpected answer");
  const now = (opts.now ?? clockNow()).toISOString();
  const min = IMPACT_RANK[opts.minImpact ?? "medium"] ?? 2;
  const all = parseForexFactory(res.data);
  const events = all.filter((e) => (IMPACT_RANK[(e.impact ?? "").toLowerCase()] ?? 0) >= min && (opts.includePast || e.at >= now));
  return econEventsToDataset(events, {
    title: `Economic calendar — this week, ${opts.minImpact ?? "medium"} impact and above (ForexFactory)`,
    url: res.url,
    fetchedAt: res.fetchedAt,
    source: "forexfactory",
    notes: [
      `${events.length} of ${all.length} events this week${opts.includePast ? "" : " still to come"}; countries are currency codes (USD, EUR…); the feed carries no actuals.`,
    ],
  });
}

export interface EarningsRow {
  symbol: string;
  name: string;
  /** "pre-market", "after-hours" or "not-supplied". */
  time: string;
  marketCap?: number;
  epsForecast?: string;
  estimates?: number;
  fiscalQuarter?: string;
  lastYearEps?: string;
}

/** Nasdaq's earnings rows, largest market cap first. */
export function parseNasdaqEarnings(rows: ReadonlyArray<Record<string, unknown>>): EarningsRow[] {
  return rows
    .flatMap((r) => {
      const symbol = clean(r.symbol);
      if (!symbol) return [];
      const row: EarningsRow = { symbol, name: clean(r.name) ?? "", time: (clean(r.time) ?? "").replace(/^time-/, "") };
      const cap = parseLooseNumber(clean(r.marketCap));
      if (cap !== undefined) row.marketCap = cap;
      const eps = clean(r.epsForecast);
      if (eps) row.epsForecast = eps;
      const n = parseLooseNumber(clean(r.noOfEsts));
      if (n !== undefined) row.estimates = n;
      const fq = clean(r.fiscalQuarterEnding);
      if (fq) row.fiscalQuarter = fq;
      const ly = clean(r.lastYearEPS);
      if (ly) row.lastYearEps = ly;
      return [row];
    })
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
}

/** US earnings scheduled on `date`, the `limit` largest by market cap, one untrusted point each. */
export async function earningsCalendar(date: string = isoDate(clockNow()), limit = 40): Promise<Dataset> {
  const res = await fetchJson<{ data?: { rows?: Array<Record<string, unknown>> | null } | null }>(`${NASDAQ}/earnings?date=${date}`, nasdaqOpts);
  requireOk("nasdaq", res, `earnings calendar for ${date}`);
  const rows = parseNasdaqEarnings(res.data?.data?.rows ?? []);
  const shown = rows.slice(0, limit);
  const points: Point[] = [
    { key: `CAL.earnings.${date}.count`, label: `US earnings reports scheduled on ${date}`, value: rows.length, unit: "count", asOf: date },
  ];
  shown.forEach((r, i) =>
    points.push({
      key: `CAL.earnings.${date}.${i + 1}`,
      label: `earnings report ${i + 1} on ${date}`,
      value: [
        r.symbol,
        r.name,
        r.time,
        r.epsForecast ? `EPS forecast ${r.epsForecast}${r.estimates !== undefined ? ` (${r.estimates} ests)` : ""}` : "",
        r.fiscalQuarter ? `quarter ending ${r.fiscalQuarter}` : "",
        r.lastYearEps ? `last year EPS ${r.lastYearEps}` : "",
        r.marketCap ? `market cap ${(r.marketCap / 1e9).toFixed(1)}B USD` : "",
      ]
        .filter(Boolean)
        .join(" | "),
      untrusted: true,
      asOf: date,
    }),
  );
  return {
    kind: "calendar",
    title: `US earnings calendar — ${date} (Nasdaq)`,
    points,
    provenance: { source: "nasdaq", url: res.url, fetchedAt: res.fetchedAt, official: false, asOf: date },
    notes: rows.length > shown.length ? [`showing the ${shown.length} largest of ${rows.length} by market cap`] : [],
  };
}

export interface DividendRow {
  symbol: string;
  name: string;
  exDate?: string;
  payDate?: string;
  recordDate?: string;
  announced?: string;
  amount?: number;
  annual?: number;
}

/** Nasdaq's dividend rows (dates as YYYY-MM-DD). */
export function parseNasdaqDividends(rows: ReadonlyArray<Record<string, unknown>>): DividendRow[] {
  return rows.flatMap((r) => {
    const symbol = clean(r.symbol);
    if (!symbol) return [];
    const num = (v: unknown) => (typeof v === "number" ? v : parseLooseNumber(clean(v)));
    return [
      {
        symbol,
        name: clean(r.companyName) ?? "",
        exDate: usSlashDate(clean(r.dividend_Ex_Date)),
        payDate: usSlashDate(clean(r.payment_Date)),
        recordDate: usSlashDate(clean(r.record_Date)),
        announced: usSlashDate(clean(r.announcement_Date)),
        amount: num(r.dividend_Rate),
        annual: num(r.indicated_Annual_Dividend),
      },
    ];
  });
}

/** US dividends going ex on `date`, one untrusted point each (symbol, name, amount, pay date). */
export async function dividendsCalendar(date: string = isoDate(clockNow()), limit = 60): Promise<Dataset> {
  const res = await fetchJson<{ data?: { calendar?: { rows?: Array<Record<string, unknown>> | null } } | null }>(
    `${NASDAQ}/dividends?date=${date}`,
    nasdaqOpts,
  );
  requireOk("nasdaq", res, `dividends calendar for ${date}`);
  const rows = parseNasdaqDividends(res.data?.data?.calendar?.rows ?? []);
  const shown = rows.slice(0, limit);
  const points: Point[] = [{ key: `CAL.dividends.${date}.count`, label: `US dividends going ex on ${date}`, value: rows.length, unit: "count", asOf: date }];
  shown.forEach((r, i) =>
    points.push({
      key: `CAL.dividends.${date}.${i + 1}`,
      label: `dividend ${i + 1} going ex on ${date}`,
      value: [
        r.symbol,
        r.name,
        r.amount !== undefined ? `dividend ${r.amount} USD` : "",
        r.annual !== undefined ? `annual ${r.annual} USD` : "",
        r.recordDate ? `record ${r.recordDate}` : "",
        r.payDate ? `paid ${r.payDate}` : "",
        r.announced ? `announced ${r.announced}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
      untrusted: true,
      asOf: r.exDate ?? date,
    }),
  );
  return {
    kind: "calendar",
    title: `US ex-dividend calendar — ${date} (Nasdaq)`,
    points,
    provenance: { source: "nasdaq", url: res.url, fetchedAt: res.fetchedAt, official: false, asOf: date },
    notes: rows.length > shown.length ? [`showing ${shown.length} of ${rows.length}`] : [],
  };
}
