// `catalysts <symbol>`: what can move this instrument in the next N days, as a
// dated timeline — every item an evidence point, external text fenced.
//
//   earnings      US: https://api.nasdaq.com/api/analyst/<SYM>/earnings-date
//                 (keyless, unofficial; Zacks' date, "expected*" = projected
//                 from last year's calendar). Elsewhere, and as the US
//                 fallback: TradingView's screener columns
//                 earnings_release_next_date / _time (unofficial).
//   dividends     US: nasdaqDividends (declared ex-dates; a next ex-date is
//                 projected from the cadence when none is declared). Elsewhere:
//                 TradingView's ex_dividend_date_upcoming.
//   filings       US: important 8-Ks of the last 30 days and the insider
//                 cluster-buy flag (SEC EDGAR, official).
//   macro         high-impact releases for the instrument's currency: Nasdaq's
//                 economic calendar day by day (≤ 10 weekday calls, one at a
//                 time) filtered by the event list below, plus ForexFactory's
//                 high-impact events this week.
//   holidays      the listing venue's closures in the window (src/core/calendar.ts).
//   options       US listings with options: the ATM straddle's expected move to
//                 the first expiry after the window (CBOE delayed chain).
//
// Two or more catalysts (earnings, an ex-date, a macro day) within three
// sessions are flagged as an event cluster: moves compound when news stacks.
import { type ChainOption, expectedMove } from "../../analytics/options.js";
import { type CalendarMarket, holidays, isTradingDay, MARKETS, marketForMic } from "../../core/calendar.js";
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow, fetchJson, netMode } from "../../core/net.js";
import { mapLimit, sleep } from "../../engine.js";
import { nasdaqDividends } from "../../providers/fundamentals/nasdaq-analyst.js";
import { secFilings } from "../../providers/fundamentals/sec.js";
import { secInsiders } from "../../providers/fundamentals/sec-insiders.js";
import { forexFactoryCalendar, nasdaqEconomicCalendar } from "../../providers/macro/calendars.js";
import { toTradingViewTicker, tradingviewScan } from "../../providers/markets/tradingview.js";
import { monthDayYear } from "../../providers/nasdaq.js";
import { cboeChain } from "../../providers/options/cboe.js";
import type { OptionContract } from "../../providers/options/chain.js";
import { resolveSymbol } from "../../providers/router.js";
import { type Instrument, ProviderError } from "../../providers/types.js";
import { type DatasetProvenance, derivedProvenance, fmt, isoDay, pickPoints, pointNumber, type Report, round4, settle, shiftDay } from "./common.js";

/** Nasdaq's economic calendar is read one day per call: at most this many weekdays per run. */
export const MAX_MACRO_DAYS = 10;
/** Catalysts within this many sessions of each other form a cluster. */
export const CLUSTER_SESSIONS = 3;

/** Headline releases any economy has: inflation, GDP, the policy-rate decision, unemployment. */
const HEADLINE = /^(Core )?(CPI|HICP)\b|^GDP\b|Interest Rate Decision|^Unemployment Rate\b/i;

/**
 * The calendars' country names, ForexFactory currency code and the releases
 * kept as high-impact (Nasdaq's calendar has no impact level, so the list is
 * ours, anchored on the event name's start so sub-indices — "ISM Manufacturing
 * Prices", "Spanish PPI" — stay out).
 */
export const MACRO_REGIONS: Record<string, { countries: string[]; ff: string; events: RegExp }> = {
  USD: {
    countries: ["United States"],
    ff: "USD",
    events:
      /^(Core )?(CPI|PPI|PCE Price Index)\b|^(ADP )?Non-?farm (Payrolls|Employment Change)|^Unemployment Rate\b|^Average Hourly Earnings|^Fed Interest Rate Decision|^FOMC (Statement|Press Conference|Meeting Minutes)|^Fed Chair|^GDP\b|^(Core )?Retail Sales\b|^ISM (Manufacturing|Non-Manufacturing|Services) PMI$|^JOLTS? Job Openings|^Initial Jobless Claims/i,
  },
  EUR: {
    countries: ["Euro Zone", "Germany"],
    ff: "EUR",
    events:
      /^(Core )?(CPI|HICP)\b|^GDP\b|^(ECB )?(Interest Rate Decision|Deposit Facility Rate)|^ECB (Press Conference|President)|^(HCOB )?(Manufacturing|Services|Composite) PMI$|^Unemployment Rate\b|^German (CPI|GDP|Ifo Business Climate|HCOB (Manufacturing|Services|Composite) PMI)/i,
  },
  GBP: { countries: ["United Kingdom"], ff: "GBP", events: HEADLINE },
  CHF: { countries: ["Switzerland"], ff: "CHF", events: HEADLINE },
  JPY: { countries: ["Japan"], ff: "JPY", events: HEADLINE },
  NOK: { countries: ["Norway"], ff: "NOK", events: HEADLINE },
  SEK: { countries: ["Sweden"], ff: "SEK", events: HEADLINE },
  DKK: { countries: ["Denmark"], ff: "DKK", events: HEADLINE },
  CAD: { countries: ["Canada"], ff: "CAD", events: HEADLINE },
};
/** Stablecoin quotes move with the dollar's calendar. */
const currencyOf = (i: Instrument) => (i.market === "crypto" ? "USD" : /^(USDT|USDC|FDUSD|BUSD)$/.test(i.currency) ? "USD" : i.currency);

export interface EarningsDate {
  date: string;
  timing: "after market close" | "before market open" | "not supplied";
  projected: boolean;
}

/** Nasdaq's earnings-date answer: the date (mm/dd/yyyy in the text, or the "Mon dd, yyyy" announcement), its timing, and whether it is projected. */
export function parseNasdaqEarningsDate(data: { reportText?: string; announcement?: string } | null | undefined): EarningsDate | undefined {
  const text = data?.reportText ?? "";
  const m = /report earnings on\s+(\d{2})\/(\d{2})\/(\d{4})/i.exec(text);
  const ann = /:\s*([A-Za-z]{3}[a-z]* \d{1,2}, \d{4})/.exec(data?.announcement ?? "")?.[1];
  const date = m ? `${m[3]}-${m[1]}-${m[2]}` : ann ? monthDayYear(ann) : undefined;
  if (!date) return undefined;
  const timing = /after market close/i.test(text) ? "after market close" : /before market open|pre-market/i.test(text) ? "before market open" : "not supplied";
  return { date, timing, projected: /expected\*/i.test(text) || /\*/.test(data?.announcement ?? "") };
}

/** The next earnings date for a US ticker from Nasdaq; the report text is kept as untrusted. */
export async function nasdaqEarningsDate(symbol: string): Promise<{ parsed: EarningsDate; text?: string; prov: DatasetProvenance }> {
  const url = `https://api.nasdaq.com/api/analyst/${encodeURIComponent(symbol)}/earnings-date`;
  const res = await fetchJson<{ data?: { reportText?: string; announcement?: string } | null }>(url, { headers: { referer: "https://www.nasdaq.com/" } });
  if (!res.ok) throw new ProviderError("nasdaq", `earnings date for ${symbol} unavailable (HTTP ${res.status})`, res.status);
  const parsed = parseNasdaqEarningsDate(res.data?.data);
  if (!parsed) throw new ProviderError("nasdaq", `no upcoming earnings date for ${symbol}`, 404);
  return {
    parsed,
    text: res.data?.data?.reportText?.replace(/\s+/g, " ").trim(),
    prov: { source: "nasdaq", url, fetchedAt: res.fetchedAt, delay: "daily", official: false, asOf: res.fetchedAt.slice(0, 10) },
  };
}

/** TradingView's code for the release time: 1 after the close, −1 before the open, anything else not supplied. */
export const tvTiming = (code: unknown): EarningsDate["timing"] => (code === 1 ? "after market close" : code === -1 ? "before market open" : "not supplied");

/** The TradingView ticker of a resolved instrument (US tickers need their exchange; Nasdaq writes NYSE Arca as "PSE", which TradingView files under AMEX). */
export function tvTickerFor(i: Instrument): string | undefined {
  if (i.market === "us") {
    const mic = i.mic ?? "";
    const ex = /NASDAQ|XNAS/i.test(mic) ? "NASDAQ" : /ARCA|AMEX|AMERICAN|BATS|CBOE|^PSE$|MKT/i.test(mic) ? "AMEX" : /NYSE|XNYS/i.test(mic) ? "NYSE" : undefined;
    return ex ? `${ex}:${i.symbol}` : undefined;
  }
  return i.market === "crypto" ? undefined : toTradingViewTicker(i.symbol);
}

/** Next ex-date projected from the cadence of past ones: the last ex-date plus the median gap (needs three). */
export function projectNextExDate(pastExDates: readonly string[]): { date: string; gapDays: number } | undefined {
  const d = [...new Set(pastExDates)].sort();
  if (d.length < 3) return undefined;
  const gaps = d.slice(1).map((x, i) => Math.round((Date.parse(x) - Date.parse(d[i]!)) / 86_400_000));
  const sorted = [...gaps].sort((a, b) => a - b);
  const gap = sorted[Math.floor(sorted.length / 2)]!;
  return gap > 0 ? { date: shiftDay(d[d.length - 1]!, gap), gapDays: gap } : undefined;
}

/** OptionChain contracts as the analytics' ChainOption: years to expiry from `now`, IV from percent to a fraction. */
export function toChainOptions(contracts: readonly OptionContract[], now: Date): ChainOption[] {
  return contracts.map((c) => ({
    right: c.right,
    strike: c.strike,
    t: Math.max(0, (Date.parse(`${c.expiry}T21:00:00Z`) - now.getTime()) / (365 * 86_400_000)),
    expiry: c.expiry,
    ...(c.bid !== undefined ? { bid: c.bid } : {}),
    ...(c.ask !== undefined ? { ask: c.ask } : {}),
    ...(c.last !== undefined ? { last: c.last } : {}),
    ...(c.iv !== undefined ? { iv: c.iv / 100 } : {}),
    ...(c.delta !== undefined ? { delta: c.delta } : {}),
    ...(c.gamma !== undefined ? { gamma: c.gamma } : {}),
    openInterest: c.openInterest,
    volume: c.volume,
  }));
}

/** Session ordinal of a date on a venue (weekdays when the venue has no calendar here); a closed day maps to the next session. */
export function sessionOrdinal(date: string, from: string, market: CalendarMarket | undefined): number {
  let n = 0;
  let d = from;
  const open = (x: string) => (market ? isTradingDay(market, x) : ![0, 6].includes(new Date(`${x}T00:00:00Z`).getUTCDay()));
  for (let guard = 0; d < date && guard < 800; guard++, d = shiftDay(d, 1)) if (open(d)) n++;
  return n;
}

export interface Catalyst {
  date: string;
  kind: "earnings" | "ex-dividend" | "macro";
  key: string;
}

/** Groups of ≥ 2 catalysts whose first and last fall within CLUSTER_SESSIONS sessions (macro events count once per day). */
export function eventClusters(items: readonly Catalyst[], from: string, market: CalendarMarket | undefined): Catalyst[][] {
  const perDay = new Map<string, Catalyst>();
  const list: Catalyst[] = [];
  for (const c of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    if (c.kind === "macro") {
      if (perDay.has(c.date)) continue;
      perDay.set(c.date, c);
    }
    list.push(c);
  }
  const ord = list.map((c) => sessionOrdinal(c.date, from, market));
  const clusters: Catalyst[][] = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && ord[j + 1]! - ord[i]! <= CLUSTER_SESSIONS - 1) j++;
    if (j > i) {
      clusters.push(list.slice(i, j + 1));
      i = j + 1;
    } else i++;
  }
  return clusters;
}

/**
 * Nasdaq's economic calendar for each day, one call at a time. The API answers
 * "no record found" for some busy days when called in a burst: those days are
 * asked once more after a pause (live only), and a day that still fails stays
 * an Error for the caller to name.
 */
async function macroCalendar(days: readonly string[]): Promise<Array<Dataset | Error>> {
  const ask = (d: string) => nasdaqEconomicCalendar(d).catch((e: Error) => e);
  const out = await mapLimit(days, 1, ask);
  if (out.some((x) => x instanceof Error) && netMode().kind === "live") {
    await sleep(2000);
    for (let i = 0; i < days.length; i++) if (out[i] instanceof Error) out[i] = await ask(days[i]!);
  }
  return out;
}

interface TimelineEntry {
  date: string;
  text: string;
  keys: string[];
}

const calendarFor = (i: Instrument): CalendarMarket | undefined =>
  i.market === "crypto" ? "CRYPTO" : i.market === "us" ? "XNYS" : i.market === "euronext" ? marketForMic(i.mic) : undefined;

/** Everything dated in the window for one instrument. */
export async function catalystsReport(raw: string, days: number, now: Date = clockNow()): Promise<Report> {
  const { instrument: inst } = await resolveSymbol(raw);
  const sym = inst.symbol;
  const ns = `${sym}.cat`;
  const today = isoDay(now);
  const end = shiftDay(today, days);
  const inWindow = (d: string) => d >= today && d <= end;
  const market = calendarFor(inst);
  const us = inst.market === "us";
  const company = us && inst.kind === "equity";
  const ccy = currencyOf(inst);
  const region = MACRO_REGIONS[ccy];
  const datasets: Dataset[] = [];
  const notes: string[] = [];
  const timeline: TimelineEntry[] = [];
  const catalysts: Catalyst[] = [];
  const recent: TimelineEntry[] = [];
  const provs: DatasetProvenance[] = [];
  const push = (title: string, prov: DatasetProvenance, points: Point[], dsNotes: string[] = []) => {
    if (!points.length) return;
    datasets.push({ kind: "catalysts", title, subject: sym, points, provenance: prov, notes: dsNotes });
    provs.push(prov);
  };

  // Weekdays of the window for Nasdaq's day-by-day economic calendar.
  const macroDays: string[] = [];
  for (let d = today; d <= end && macroDays.length < MAX_MACRO_DAYS; d = shiftDay(d, 1))
    if (![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) macroDays.push(d);

  const tvTicker = tvTickerFor(inst);
  // EDGAR asks for a paced client: the filings first, then the insider forms (the ticker map is then cached).
  const sec8k = company ? secFilings(sym, { forms: ["8-K"], days: 30, now, limit: 20 }).catch((e: Error) => e) : undefined;
  const side = await settle<unknown>({
    ...(company ? { "Nasdaq earnings date": () => nasdaqEarningsDate(sym) } : {}),
    ...(company ? { "Nasdaq dividends": () => nasdaqDividends(sym, { limit: 12 }) } : {}),
    ...(sec8k
      ? {
          "SEC 8-K filings": async () => {
            const r = await sec8k;
            if (r instanceof Error) throw r;
            return r;
          },
          "SEC insider filings": async () => {
            await sec8k;
            return secInsiders(sym, { limit: 10, now });
          },
        }
      : {}),
    ...(tvTicker && inst.market !== "us"
      ? {
          "TradingView event dates": () =>
            tradingviewScan("global", {
              tickers: [tvTicker],
              columns: ["earnings_release_next_date", "earnings_release_next_time", "ex_dividend_date_upcoming"],
            }),
        }
      : {}),
    ...(region ? { "ForexFactory high-impact week": () => forexFactoryCalendar({ now, minImpact: "high" }) } : {}),
    ...(region ? { "Nasdaq economic calendar": () => macroCalendar(macroDays) } : {}),
    ...(us ? { "CBOE option chain": () => cboeChain(sym) } : {}),
  });
  const ok = side.ok;
  for (const f of side.failed) {
    if (/SEC 8-K filings: .*no 8-K/.test(f)) notes.push("no 8-K filed in the last 30 days");
    else if (/CBOE option chain: .*lists no options/.test(f)) notes.push(`no listed options on ${sym} at CBOE — no expected move`);
    else notes.push(`unavailable — ${f}`);
  }

  // Earnings
  const ne = ok["Nasdaq earnings date"] as Awaited<ReturnType<typeof nasdaqEarningsDate>> | undefined;
  let tv = ok["TradingView event dates"] as Dataset | undefined;
  const div = ok["Nasdaq dividends"] as Dataset | undefined;
  // US: TradingView stands in for what Nasdaq did not give (its dividend history covers Nasdaq-listed symbols only; ETFs have no earnings).
  if (us && tvTicker && (!company || !ne || !div)) {
    try {
      tv = await tradingviewScan("global", {
        tickers: [tvTicker],
        columns: ["earnings_release_next_date", "earnings_release_next_time", "ex_dividend_date_upcoming"],
      });
      notes.push(
        `${[company && !ne ? "earnings" : "", !div ? "ex-dividend" : ""].filter(Boolean).join(" and ")} date(s) from TradingView, standing in for Nasdaq`,
      );
    } catch (e) {
      notes.push(`unavailable — TradingView event dates: ${(e as Error).message}`);
    }
  }
  const earningsPoints = (e: EarningsDate, src: string): Point[] => [
    {
      key: `${ns}.earnings.date`,
      label: `${sym} next earnings release (${e.projected ? "projected" : "scheduled"}, ${src})`,
      value: e.date,
      asOf: today,
    },
    { key: `${ns}.earnings.timing`, label: `${sym} next earnings release timing`, value: e.timing, asOf: today },
  ];
  let earnings: EarningsDate | undefined;
  if (ne) {
    earnings = ne.parsed;
    push(
      `${sym} next earnings date (Nasdaq)`,
      ne.prov,
      [
        ...earningsPoints(ne.parsed, "Nasdaq/Zacks"),
        ...(ne.text
          ? [{ key: `${ns}.earnings.text`, label: `${sym} earnings-date note as Nasdaq writes it`, value: ne.text, untrusted: true, asOf: today }]
          : []),
      ],
      ne.parsed.projected ? ["Nasdaq marks the date expected*: projected from the company's past calendar, not confirmed by it"] : [],
    );
  }
  const tvNum = (col: string) => (tv && tvTicker ? pointNumber(tv, `${tvTicker}.tv.${col}`) : undefined);
  const tvDate = (col: string) => {
    const t = tvNum(col);
    return t !== undefined && t > 0 ? isoDay(new Date(t * 1000)) : undefined;
  };
  if (!earnings && tv && inst.kind === "equity") {
    const d = tvDate("earnings_release_next_date");
    if (d) {
      earnings = { date: d, timing: tvTiming(tv.points.find((p) => p.key === `${tvTicker}.tv.earnings_release_next_time`)?.value), projected: false };
      push(`${sym} next earnings date (TradingView)`, { ...tv.provenance }, earningsPoints(earnings, "TradingView"), [
        "TradingView's calendar: confirm on the issuer's investor-relations page before acting on the exact day",
      ]);
    } else notes.push("TradingView lists no upcoming earnings date");
  }
  if (!earnings && inst.kind !== "equity")
    notes.push(
      `${sym} is ${({ etf: "an ETF", index: "an index", crypto: "a crypto asset", fund: "a fund" } as Record<string, string>)[inst.kind] ?? "not a company"}: no earnings of its own`,
    );
  if (earnings) {
    if (inWindow(earnings.date)) {
      catalysts.push({ date: earnings.date, kind: "earnings", key: `${ns}.earnings.date` });
      timeline.push({ date: earnings.date, text: `earnings (${earnings.timing}${earnings.projected ? ", projected" : ""})`, keys: [`${ns}.earnings.date`] });
    } else notes.push(`next earnings release ${earnings.date} falls after the window`);
  }

  // Dividends
  if (div) {
    const T = div.subject ?? sym;
    const exDates = div.points.map((p) => /\.div\.(\d{4}-\d{2}-\d{2})$/.exec(p.key)?.[1]).filter((x): x is string => !!x);
    const declared = exDates.filter(inWindow);
    const pts: Point[] = [];
    for (const d of declared) {
      const p = div.points.find((x) => x.key === `${T}.div.${d}`)!;
      pts.push({ ...p, key: `${ns}.exdiv.${d}`, label: `${sym} declared ex-dividend date ${d} (amount per share)` });
      catalysts.push({ date: d, kind: "ex-dividend", key: `${ns}.exdiv.${d}` });
      timeline.push({ date: d, text: `ex-dividend (declared, ${p.value} ${p.unit ?? ""})`.replace(" )", ")"), keys: [`${ns}.exdiv.${d}`] });
    }
    if (!declared.length) {
      const proj = projectNextExDate(exDates.filter((d) => d < today));
      if (proj && inWindow(proj.date)) {
        pts.push({
          key: `${ns}.exdiv.projected`,
          label: `${sym} projected next ex-dividend date (not declared)`,
          value: proj.date,
          formula: `last ex-date + median gap between past ex-dates (${proj.gapDays} days)`,
          asOf: today,
        });
        catalysts.push({ date: proj.date, kind: "ex-dividend", key: `${ns}.exdiv.projected` });
        timeline.push({ date: proj.date, text: "ex-dividend (projected from the cadence, not declared)", keys: [`${ns}.exdiv.projected`] });
      } else if (exDates.length) notes.push("no ex-dividend date declared or projected in the window");
    }
    push(`${sym} ex-dividend dates in the window (Nasdaq)`, { ...div.provenance, asOf: today }, pts);
  } else if (tv) {
    const d = tvDate("ex_dividend_date_upcoming");
    if (d && inWindow(d)) {
      push(`${sym} upcoming ex-dividend date (TradingView)`, { ...tv.provenance }, [
        { key: `${ns}.exdiv.${d}`, label: `${sym} upcoming ex-dividend date (TradingView)`, value: d, asOf: today },
      ]);
      catalysts.push({ date: d, kind: "ex-dividend", key: `${ns}.exdiv.${d}` });
      timeline.push({ date: d, text: "ex-dividend (TradingView)", keys: [`${ns}.exdiv.${d}`] });
    } else notes.push(d ? `next ex-dividend date ${d} falls after the window` : "TradingView lists no upcoming ex-dividend date");
  }

  // Recent 8-Ks and insiders (context, already dated in the past)
  const k8 = ok["SEC 8-K filings"] as Dataset | undefined;
  if (k8) {
    const important = k8.points.filter((p) => p.key.includes(".filing.") && / \[important\]$/.test(p.label));
    const pts = important.map((p) => ({ ...p, key: `${ns}.8k.${p.key.split(".filing.")[1]}` }));
    if (pts.length) {
      push(`${sym} important 8-Ks of the last 30 days (SEC)`, k8.provenance, pts, [
        "item names from Form 8-K's General Instructions; open the filing for what it says",
      ]);
      for (const p of pts) recent.push({ date: p.asOf ?? "", text: `8-K: ${p.label.replace(`${k8.subject} `, "")}`, keys: [p.key] });
    } else notes.push("8-Ks in the last 30 days, none with an important item");
  }
  const ins = ok["SEC insider filings"] as Dataset | undefined;
  if (ins) {
    const T = ins.subject ?? sym;
    const picked = pickPoints(
      ins,
      [`${T}.insider.clusterBuy`, `${T}.insider.buyers30d.count`, `${T}.insider.net90d.value`],
      `${sym} insider activity (SEC Form 4)`,
    );
    if (picked) {
      datasets.push(picked);
      provs.push(picked.provenance);
      if (picked.points.find((p) => p.key === `${T}.insider.clusterBuy`)?.value === true)
        recent.push({
          date: today,
          text: "insider cluster buy: ≥ 3 distinct insiders bought on the open market in 30 days",
          keys: [`${T}.insider.clusterBuy`],
        });
    }
  }

  // Macro
  if (!region) notes.push(`no macro calendar mapping for ${ccy}`);
  const macroPts = new Map<string, { prov: DatasetProvenance; points: Point[] }>();
  const addMacro = (ds: Dataset, filter: (country: string, event: string) => boolean) => {
    const seen = new Set<string>();
    for (const p of ds.points) {
      const m = /^CAL\.econ\.(\d{4}-\d{2}-\d{2})\.\d+$/.exec(p.key);
      if (!m || typeof p.value !== "string") continue;
      const [country = "", event = ""] = p.value.split(" | ");
      const date = m[1]!;
      if (!inWindow(date) || !filter(country, event) || seen.has(`${date}|${country}|${event}`)) continue;
      seen.add(`${date}|${country}|${event}`);
      const entry = macroPts.get(ds.provenance.source) ?? { prov: ds.provenance, points: [] };
      const key = `${ns}.macro.${date}.${entry.points.length + 1}`;
      entry.points.push({
        key,
        label: `${sym} window: high-impact ${ccy} macro release on ${date} (${ds.provenance.source})`,
        value: `${country} | ${event}`,
        untrusted: true,
        asOf: date,
      });
      macroPts.set(ds.provenance.source, entry);
      catalysts.push({ date, kind: "macro", key });
    }
  };
  const ff = ok["ForexFactory high-impact week"] as Dataset | undefined;
  if (ff && region) addMacro(ff, (c) => c === region.ff);
  const nq = ok["Nasdaq economic calendar"] as Array<Dataset | Error> | undefined;
  if (nq && region) {
    const failedDays = nq.map((d, i) => (d instanceof Error ? macroDays[i] : undefined)).filter(Boolean);
    for (const d of nq) if (!(d instanceof Error)) addMacro(d, (c, e) => region.countries.includes(c) && region.events.test(e));
    if (failedDays.length)
      notes.push(
        `Nasdaq's economic calendar gave no usable answer for ${failedDays.join(", ")} (it answers "no record found" for some days): releases on those days may be missing`,
      );
    const lastScanned = macroDays[macroDays.length - 1];
    if (lastScanned && lastScanned < end)
      notes.push(`Nasdaq's economic calendar read for ${macroDays.length} weekdays (to ${lastScanned}); later releases in the window are not listed`);
  }
  for (const [src, e] of macroPts)
    push(`${sym} high-impact ${ccy} macro releases in the window (${src})`, e.prov, e.points, [
      src === "nasdaq"
        ? `Nasdaq's calendar has no impact level: kept by the ${ccy} event list in MACRO_REGIONS (inflation, jobs, central banks, GDP${ccy === "USD" || ccy === "EUR" ? ", retail sales, headline PMIs" : ""})`
        : "ForexFactory's own high-impact flag",
    ]);
  const byDay = new Map<string, string[]>();
  for (const e of macroPts.values()) for (const p of e.points) byDay.set(p.asOf!, [...(byDay.get(p.asOf!) ?? []), p.key]);
  for (const [d, keys] of byDay) timeline.push({ date: d, text: `${keys.length} high-impact ${ccy} macro release(s)`, keys });

  // Holidays
  if (market && market !== "CRYPTO") {
    const years = [...new Set([today.slice(0, 4), end.slice(0, 4)])].map(Number);
    const hol = years.flatMap((y) => holidays(market, y)).filter((h) => inWindow(h.date));
    const pts: Point[] = hol.map((h) => ({
      key: `${ns}.holiday.${h.date}`,
      label: `${MARKETS[market].name} ${h.kind === "closed" ? "closed" : `closes early at ${h.closeAt}`} on ${h.date}`,
      value: h.name,
      asOf: h.date,
    }));
    if (pts.length)
      push(`${MARKETS[market].name} holidays in the window`, { source: "exchange-calendar", fetchedAt: now.toISOString(), official: false, asOf: today }, pts, [
        "computed from the exchange's published rules (src/core/calendar.ts); `ultrastock calendar verify` lists what to check",
      ]);
    for (const h of hol)
      timeline.push({ date: h.date, text: h.kind === "closed" ? "market closed" : `early close ${h.closeAt}`, keys: [`${ns}.holiday.${h.date}`] });
  } else if (!market) notes.push(`no exchange calendar for ${inst.mic ?? inst.market} here: holidays not listed, sessions counted as weekdays`);

  // Options expected move to the first expiry after the window
  const chain = ok["CBOE option chain"] as Awaited<ReturnType<typeof cboeChain>> | undefined;
  if (chain) {
    const expiry = [...new Set(chain.contracts.map((c) => c.expiry))].sort().find((e) => e >= end);
    const em = expiry ? expectedMove(toChainOptions(chain.contracts, now), chain.underlyingPrice, expiry) : undefined;
    if (expiry && em) {
      const at = { asOf: chain.asOf };
      const pts: Point[] = [
        { key: `${ns}.options.expiry`, label: `${sym} first option expiry after the window`, value: expiry, ...at },
        { key: `${ns}.options.spot`, label: `${sym} underlying price in the chain`, value: chain.underlyingPrice, unit: "USD", ...at },
        { key: `${ns}.options.atmStrike`, label: `${sym} at-the-money strike, ${expiry}`, value: em.atmStrike, unit: "USD", ...at },
        {
          key: `${ns}.options.straddle`,
          label: `${sym} ATM straddle (call + put mid), ${expiry}`,
          value: round4(em.straddle),
          unit: "USD",
          formula: "mid(call) + mid(put) at the ATM strike",
          ...at,
        },
        {
          key: `${ns}.options.move1sd`,
          label: `${sym} expected move to ${expiry}, one standard deviation`,
          value: round4(em.move1sd),
          unit: "USD",
          formula: "straddle × √(π/2)",
          ...at,
        },
        {
          key: `${ns}.options.move1sdPct`,
          label: `${sym} expected move to ${expiry}, % of the underlying`,
          value: round4((em.move1sd / chain.underlyingPrice) * 100),
          unit: "%",
          formula: "move1sd / underlying × 100",
          ...at,
        },
        ...(em.atmIv !== undefined
          ? [
              {
                key: `${ns}.options.atmIv`,
                label: `${sym} ATM implied volatility, ${expiry}`,
                value: round4(em.atmIv * 100),
                unit: "%",
                formula: "mean of the ATM call and put IV",
                ...at,
              },
            ]
          : []),
      ];
      push(`${sym} options-implied move (CBOE, delayed)`, { ...chain.provenance }, pts, [
        "mids of a 15-minute delayed chain; a wide spread makes the straddle a rough figure",
      ]);
      timeline.push({
        date: expiry,
        text: `option expiry: ±${fmt(em.move1sd)} USD (±${fmt((em.move1sd / chain.underlyingPrice) * 100, 1)} %) implied to here`,
        keys: [`${ns}.options.move1sd`, `${ns}.options.move1sdPct`],
      });
    } else notes.push(expiry ? `no two-sided ATM quote at ${expiry} — no expected move` : `no option expiry on or after ${end}`);
  } else if (!us) notes.push("options-implied move: US listings only (CBOE)");

  // Clusters
  const clusters = eventClusters(
    catalysts.filter((c) => inWindow(c.date)),
    today,
    market === "CRYPTO" ? undefined : market,
  );
  const derived = derivedProvenance(provs, today);
  const cpts: Point[] = [
    {
      key: `${ns}.cluster`,
      label: `${sym} event cluster in the window (≥ 2 catalysts within ${CLUSTER_SESSIONS} sessions)`,
      value: clusters.length > 0,
      formula: "earnings, ex-dividend dates and high-impact macro days (one per day), grouped when the first and last are ≤ 2 sessions apart",
      asOf: today,
    },
    { key: `${ns}.count`, label: `${sym} dated catalysts in the window`, value: catalysts.length, unit: "count", asOf: today },
    ...clusters.map((c, i) => ({
      key: `${ns}.cluster.${i + 1}`,
      label: `${sym} event cluster ${i + 1}`,
      value: `${c[0]!.date} → ${c[c.length - 1]!.date}: ${c.map((x) => x.kind).join(" + ")}`,
      asOf: c[0]!.date,
    })),
  ];
  datasets.push({
    kind: "catalysts",
    title: `${sym} catalyst window ${today} → ${end}`,
    subject: sym,
    points: cpts,
    provenance: derived,
    notes: [
      ...notes,
      ...(inst.market !== "us" && inst.market !== "crypto"
        ? ["8-K and insider filings: SEC registrants only — no keyless equivalent read for this listing"]
        : []),
    ],
  });

  timeline.sort((a, b) => a.date.localeCompare(b.date));
  return {
    datasets,
    json: { symbol: sym, window: { from: today, to: end }, timeline, clusters, recent },
    summary: (cite) => [
      `# ${sym}${inst.name ? ` — ${inst.name}` : ""}: catalysts ${today} → ${end} (${days} days)`,
      `event cluster: ${clusters.length ? "yes" : "no"}${cite(`${ns}.cluster`)}${clusters.map((c, i) => ` · ${c[0]!.date} → ${c[c.length - 1]!.date} (${c.map((x) => x.kind).join(" + ")})${cite(`${ns}.cluster.${i + 1}`)}`).join("")}`,
      "timeline:",
      ...(timeline.length ? timeline.map((t) => `  ${t.date}  ${t.text}${t.keys.map(cite).join("")}`) : ["  nothing dated in the window"]),
      ...(recent.length ? ["recent (context):", ...recent.map((t) => `  ${t.date}  ${t.text}${t.keys.map(cite).join("")}`)] : []),
      ...(notes.length ? ["notes:", ...notes.map((n) => `  - ${n}`)] : []),
    ],
  };
}
