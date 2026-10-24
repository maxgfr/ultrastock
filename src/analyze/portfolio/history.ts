// Price histories for the portfolio analytics, and the arithmetic that lines
// them up: daily closes per holding, converted to the base currency with the
// ECB's daily reference rates, aligned on one calendar of weekdays.
//
// Depth differs by source — Euronext keeps two years, Nasdaq ten, Binance
// since 2017 — so a window older than the primary source keeps goes straight
// to Yahoo (unofficial, said in the provenance and the notes). A series that
// does not reach back far enough is reported, never padded.
import type { Dataset } from "../../core/datasets.js";
import { fetchEcb } from "../../providers/macro/ecb.js";
import { resolveYahoo, yahooHistory } from "../../providers/markets/yahoo.js";
import { getHistory, type Resolved } from "../../providers/router.js";
import type { PriceSeries } from "../../providers/types.js";

const DAY = 86_400_000;

/** How far back each primary source reaches, in days (a little under what it keeps). */
const DEPTH_DAYS: Record<string, number> = { euronext: 725, us: 3640, europe: 100_000, crypto: 100_000 };

/**
 * Daily bars between two dates, from the router's source when it reaches
 * that far back, from Yahoo otherwise. Nasdaq's API also answers nothing for a
 * window that ends in the past (it serves "from X to today"), so a closed
 * historical window of a US listing goes to Yahoo too. The notes say which.
 */
export async function dailyHistory(r: Resolved, from: Date, to: Date, now: Date): Promise<PriceSeries> {
  const age = (now.getTime() - from.getTime()) / DAY;
  const ended = (now.getTime() - to.getTime()) / DAY;
  const market = r.instrument.market;
  const tooOld = age > (DEPTH_DAYS[market] ?? 100_000);
  const pastWindow = (market === "us" || market === "euronext") && ended > 30;
  if (tooOld || pastWindow) {
    const y = await yahooHistory(await resolveYahoo(r.instrument.symbol), "1d", from, to);
    const src = market === "us" ? "Nasdaq" : "Euronext";
    return {
      ...y,
      notes: [
        ...y.notes,
        `${r.instrument.symbol}: Yahoo used — ${tooOld ? `the ${src} history does not reach back to ${iso(from)}` : `${src} serves windows ending today, not one ending ${iso(to)}`}`,
      ],
    };
  }
  return getHistory(r, { from, to, interval: "1d" });
}

export const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Daily closes keyed by date (YYYY-MM-DD), oldest first. */
export type Closes = Array<{ date: string; close: number }>;

export const closesOf = (s: PriceSeries): Closes => s.bars.map((b) => ({ date: b.date.slice(0, 10), close: b.close })).filter((c) => c.close > 0);

/**
 * The ECB daily reference rates for `currencies` over the last `n` business
 * days: per currency, date → base (EUR) per one unit. One official call.
 */
export async function ecbDailyRates(currencies: readonly string[], n: number): Promise<{ rates: Map<string, Map<string, number>>; dataset?: Dataset }> {
  const want = [...new Set(currencies.map((c) => (c === "USDT" || c === "USDC" || c === "FDUSD" ? "USD" : c)).filter((c) => c !== "EUR"))];
  const rates = new Map<string, Map<string, number>>();
  if (!want.length) return { rates };
  const { series, url, fetchedAt } = await fetchEcb("EXR", `D.${want.join("+")}.EUR.SP00.A`, n);
  const points: Dataset["points"] = [];
  for (const s of series) {
    const ccy = s.key.split(".")[2] ?? "";
    const m = new Map<string, number>();
    for (const o of s.obs) if (o.value > 0) m.set(o.date, 1 / o.value);
    rates.set(ccy, m);
    const first = s.obs[0];
    const last = s.obs[s.obs.length - 1];
    if (first && last)
      points.push({
        key: `EUR.fxhist.${ccy}.days`,
        label: `ECB daily reference rates read, ${ccy} per EUR (${first.date} to ${last.date})`,
        value: s.obs.length,
        unit: "count",
        asOf: last.date,
        formula: `daily observations from ${first.date} (${first.value}) to ${last.date} (${last.value})`,
      });
  }
  for (const c of ["USDT", "USDC", "FDUSD"]) if (currencies.includes(c) && rates.has("USD")) rates.set(c, rates.get("USD")!);
  return {
    rates,
    dataset: {
      kind: "fx",
      title: "ECB daily euro reference rates (history)",
      subject: "EUR",
      points,
      provenance: { source: "ecb", url, fetchedAt, delay: "eod", official: true, asOf: points[0]?.asOf },
      notes: [],
    },
  };
}

/** Closes converted to base with daily rates (the last rate on or before each date); dates without a rate yet are dropped. */
export function toBase(closes: Closes, rates: Map<string, number> | undefined): Closes {
  if (!rates) return closes;
  const dates = [...rates.keys()].sort();
  const out: Closes = [];
  let j = -1;
  for (const c of closes) {
    while (j + 1 < dates.length && dates[j + 1]! <= c.date) j++;
    if (j < 0) continue;
    out.push({ date: c.date, close: c.close * rates.get(dates[j]!)! });
  }
  return out;
}

const isWeekday = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6;
};

/**
 * Align several close series on one calendar: every weekday on which at least
 * one series traded, from the latest first date to the earliest last date.
 * Each series is carried forward over its own holidays (a 0 % day, the move
 * landing on the next session it trades). Returns the calendar and one
 * simple-return series per input, aligned.
 */
export function alignReturns(series: readonly Closes[]): { dates: string[]; returns: number[][] } {
  if (!series.length || series.some((s) => s.length < 2)) return { dates: [], returns: series.map(() => []) };
  const start = series
    .map((s) => s[0]!.date)
    .sort()
    .at(-1)!;
  const end = series.map((s) => s[s.length - 1]!.date).sort()[0]!;
  const all = new Set<string>();
  for (const s of series) for (const c of s) if (c.date >= start && c.date <= end && isWeekday(c.date)) all.add(c.date);
  const dates = [...all].sort();
  const levels = series.map((s) => {
    const byDate = new Map(s.map((c) => [c.date, c.close]));
    let last: number | undefined;
    // Seed with the last close on or before the start.
    for (const c of s) if (c.date <= start) last = c.close;
    return dates.map((d) => {
      const v = byDate.get(d);
      if (v !== undefined) last = v;
      return last!;
    });
  });
  const returns = levels.map((lv) => lv.slice(1).map((v, i) => v / lv[i]! - 1));
  return { dates: dates.slice(1), returns };
}

/** The close on or after `from` and the close on or before `to`, when the series covers the window (within `slackDays`). */
export function windowCloses(
  closes: Closes,
  from: string,
  to: string,
  slackDays = 7,
): { start: { date: string; close: number }; end: { date: string; close: number } } | undefined {
  const start = closes.find((c) => c.date >= from);
  const end = [...closes].reverse().find((c) => c.date <= to);
  if (!start || !end || end.date <= start.date) return undefined;
  const gap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
  if (gap(start.date, from) > slackDays || gap(end.date, to) > slackDays) return undefined;
  return { start, end };
}
