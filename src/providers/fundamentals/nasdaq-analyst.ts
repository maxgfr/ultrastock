// Analyst consensus, short interest and dividends for US stocks from the API
// behind nasdaq.com — keyless, undocumented (unofficial). The estimates are
// Zacks' consensus; the short interest is FINRA's twice-monthly settlement
// figure as Nasdaq republishes it:
//
//   /api/analyst/<SYM>/targetprice          consensus target, buy/hold/sell counts
//   /api/analyst/<SYM>/ratings              mean rating
//   /api/analyst/<SYM>/earnings-forecast    EPS consensus by fiscal quarter and year
//   /api/analyst/<SYM>/estimate-momentum    consensus now, a week and a month ago
//   /api/company/<SYM>/earnings-surprise    reported EPS vs consensus, last 4 quarters
//   /api/quote/<SYM>/short-interest?assetClass=stocks
//   /api/quote/<SYM>/dividends?assetclass=stocks
//
// Every endpoint answers HTTP 200 with `data: null` for an unknown symbol.
import type { Dataset, Point } from "../../core/datasets.js";
import { parseLooseNumber } from "../../core/csv.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { finiteNumber, mdyToIso, monthYearToIso } from "./util.js";

export const NASDAQ_ANALYST_SOURCE = "nasdaq";
const BASE = "https://api.nasdaq.com/api";

const num = (v: unknown) => (typeof v === "string" ? parseLooseNumber(v) : finiteNumber(v));

async function get<T>(path: string) {
  const url = `${BASE}/${path}`;
  const res = await fetchJson<{ data?: T | null }>(url, { headers: { referer: "https://www.nasdaq.com/" } });
  return { url, res, data: res.ok ? (res.data?.data ?? undefined) : undefined };
}

const usSym = (s: string) => s.trim().toUpperCase().replace(/\.US$/, "");

const dataset = (kind: string, title: string, subject: string, points: Point[], url: string, fetchedAt: string, notes: string[] = []): Dataset => ({
  kind,
  title,
  subject,
  points,
  provenance: { source: NASDAQ_ANALYST_SOURCE, url, fetchedAt, official: false },
  notes,
});

// ─── parsers ───────────────────────────────────────────────────────────────

export interface TargetPrice {
  mean?: number;
  high?: number;
  low?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  /** Date of the latest monthly consensus snapshot, when given. */
  asOf?: string;
}

export function parseTargetPrice(data: any): TargetPrice {
  const c = data?.consensusOverview ?? {};
  const hist: any[] = Array.isArray(data?.historicalConsensus) ? data.historicalConsensus : [];
  const asOf = mdyToIso(hist[hist.length - 1]?.z?.date);
  const out: TargetPrice = {
    mean: num(c.priceTarget),
    high: num(c.highPriceTarget),
    low: num(c.lowPriceTarget),
    buy: num(c.buy),
    hold: num(c.hold),
    sell: num(c.sell),
  };
  if (asOf) out.asOf = asOf;
  return out;
}

export interface EpsForecast {
  /** Fiscal period end month, YYYY-MM. */
  fiscalEnd: string;
  mean?: number;
  high?: number;
  low?: number;
  estimates?: number;
  revisionsUp?: number;
  revisionsDown?: number;
}

export function parseEarningsForecast(data: any): { quarterly: EpsForecast[]; yearly: EpsForecast[] } {
  const rows = (t: any): EpsForecast[] =>
    (Array.isArray(t?.rows) ? t.rows : []).flatMap((r: any) => {
      const fiscalEnd = monthYearToIso(r.fiscalEnd);
      if (!fiscalEnd) return [];
      return [
        {
          fiscalEnd,
          mean: num(r.consensusEPSForecast),
          high: num(r.highEPSForecast),
          low: num(r.lowEPSForecast),
          estimates: num(r.noOfEstimates),
          revisionsUp: num(r.up),
          revisionsDown: num(r.down),
        },
      ];
    });
  return { quarterly: rows(data?.quarterlyForecast), yearly: rows(data?.yearlyForecast) };
}

export interface EstimateMomentum {
  quarterEnd?: string;
  yearEnd?: string;
  quarter: { current?: number; weekAgo?: number; monthAgo?: number };
  year: { current?: number; weekAgo?: number; monthAgo?: number };
}

export function parseEstimateMomentum(data: any): EstimateMomentum {
  const c = data?.changeInConsensus ?? {};
  return {
    quarterEnd: monthYearToIso(/(\w{3} \d{4})$/.exec(c.fiscalQtrEndText ?? "")?.[1]),
    yearEnd: monthYearToIso(/(\w{3} \d{4})$/.exec(c.fiscalYearEndText ?? "")?.[1]),
    quarter: { current: num(c.currentData?.qtrMean), weekAgo: num(c.weekData?.qtrMean), monthAgo: num(c.monthData?.qtrMean) },
    year: { current: num(c.currentData?.yrMean), weekAgo: num(c.weekData?.yrMean), monthAgo: num(c.monthData?.yrMean) },
  };
}

export interface EarningsSurprise {
  fiscalEnd: string;
  reported?: string;
  eps?: number;
  consensus?: number;
  surprisePct?: number;
}

export function parseEarningsSurprise(data: any): EarningsSurprise[] {
  const rows: any[] = Array.isArray(data?.earningsSurpriseTable?.rows) ? data.earningsSurpriseTable.rows : [];
  return rows.flatMap((r) => {
    const fiscalEnd = monthYearToIso(r.fiscalQtrEnd);
    if (!fiscalEnd) return [];
    const reported = mdyToIso(r.dateReported);
    return [{ fiscalEnd, ...(reported ? { reported } : {}), eps: num(r.eps), consensus: num(r.consensusForecast), surprisePct: num(r.percentageSurprise) }];
  });
}

export interface ShortInterestRow {
  settlement: string;
  shares?: number;
  avgDailyVolume?: number;
  daysToCover?: number;
}

export function parseShortInterest(data: any): ShortInterestRow[] {
  const rows: any[] = Array.isArray(data?.shortInterestTable?.rows) ? data.shortInterestTable.rows : [];
  return rows
    .flatMap((r) => {
      const settlement = mdyToIso(r.settlementDate);
      return settlement ? [{ settlement, shares: num(r.interest), avgDailyVolume: num(r.avgDailyShareVolume), daysToCover: num(r.daysToCover) }] : [];
    })
    .sort((a, b) => b.settlement.localeCompare(a.settlement));
}

export interface DividendRow {
  exDate: string;
  type: string;
  amount?: number;
  currency: string;
  declared?: string;
  record?: string;
  paid?: string;
}

export function parseNasdaqDividends(data: any): { yieldPct?: number; annual?: number; rows: DividendRow[] } {
  const rows: any[] = Array.isArray(data?.dividends?.rows) ? data.dividends.rows : [];
  return {
    yieldPct: num(data?.yield),
    annual: num(data?.annualizedDividend),
    rows: rows
      .flatMap((r) => {
        const exDate = mdyToIso(r.exOrEffDate);
        if (!exDate) return [];
        const out: DividendRow = {
          exDate,
          type: String(r.type ?? ""),
          amount: num(r.amount),
          currency: /^[A-Z]{3}$/.test(String(r.currency)) ? String(r.currency) : "USD",
        };
        const declared = mdyToIso(r.declarationDate);
        const record = mdyToIso(r.recordDate);
        const paid = mdyToIso(r.paymentDate);
        if (declared) out.declared = declared;
        if (record) out.record = record;
        if (paid) out.paid = paid;
        return [out];
      })
      .sort((a, b) => b.exDate.localeCompare(a.exDate)),
  };
}

// ─── network ───────────────────────────────────────────────────────────────

const pt = (key: string, label: string, value: number | undefined, unit: string, asOf?: string, formula?: string): Point[] =>
  value === undefined ? [] : [{ key, label, value, unit, ...(asOf ? { asOf } : {}), ...(formula ? { formula } : {}) }];

/** Analyst datasets for a US stock: target price & ratings, EPS consensus, estimate momentum, earnings surprises. */
export async function nasdaqAnalyst(symbol: string): Promise<Dataset[]> {
  const T = usSym(symbol);
  const s = encodeURIComponent(T);
  const [target, ratings, forecast, momentum, surprise] = await Promise.all([
    get<any>(`analyst/${s}/targetprice`),
    get<any>(`analyst/${s}/ratings`),
    get<any>(`analyst/${s}/earnings-forecast`),
    get<any>(`analyst/${s}/estimate-momentum`),
    get<any>(`company/${s}/earnings-surprise`),
  ]);
  const out: Dataset[] = [];
  const missing: string[] = [];

  if (target.data) {
    const t = parseTargetPrice(target.data);
    const day = t.asOf ?? target.res.fetchedAt.slice(0, 10);
    const points = [
      ...pt(`${T}.analyst.target.mean`, `${T} consensus price target`, t.mean, "USD", day),
      ...pt(`${T}.analyst.target.high`, `${T} highest price target`, t.high, "USD", day),
      ...pt(`${T}.analyst.target.low`, `${T} lowest price target`, t.low, "USD", day),
      ...pt(`${T}.analyst.ratings.buy`, `${T} analysts rating buy`, t.buy, "count", day),
      ...pt(`${T}.analyst.ratings.hold`, `${T} analysts rating hold`, t.hold, "count", day),
      ...pt(`${T}.analyst.ratings.sell`, `${T} analysts rating sell`, t.sell, "count", day),
    ];
    const mean = ratings.data?.meanRatingType;
    if (typeof mean === "string" && /^[A-Za-z ]{1,20}$/.test(mean))
      points.push({ key: `${T}.analyst.rating.mean`, label: `${T} mean analyst rating`, value: mean, asOf: day });
    const n = num(/Based on (\d+) analysts/.exec(ratings.data?.ratingsSummary ?? "")?.[1]);
    points.push(...pt(`${T}.analyst.ratings.count`, `${T} analysts offering a recommendation`, n, "count", day));
    if (points.length) out.push(dataset("analyst", `${T} analyst price targets and ratings`, T, points, target.url, target.res.fetchedAt));
  } else missing.push("target price");

  const f = forecast.data ? parseEarningsForecast(forecast.data) : undefined;
  if (f && (f.quarterly.length || f.yearly.length)) {
    const rows = (list: EpsForecast[], kind: "q" | "fy", what: string) =>
      list.flatMap((r) => [
        ...pt(`${T}.est.eps.${kind}.${r.fiscalEnd}.mean`, `${T} consensus EPS, fiscal ${what} ending ${r.fiscalEnd}`, r.mean, "USD"),
        ...pt(`${T}.est.eps.${kind}.${r.fiscalEnd}.high`, `${T} highest EPS estimate, fiscal ${what} ending ${r.fiscalEnd}`, r.high, "USD"),
        ...pt(`${T}.est.eps.${kind}.${r.fiscalEnd}.low`, `${T} lowest EPS estimate, fiscal ${what} ending ${r.fiscalEnd}`, r.low, "USD"),
        ...pt(`${T}.est.eps.${kind}.${r.fiscalEnd}.count`, `${T} EPS estimates, fiscal ${what} ending ${r.fiscalEnd}`, r.estimates, "count"),
      ]);
    out.push(
      dataset(
        "estimates",
        `${T} EPS consensus (Zacks via Nasdaq)`,
        T,
        [...rows(f.quarterly, "q", "quarter"), ...rows(f.yearly, "fy", "year")],
        forecast.url,
        forecast.res.fetchedAt,
        ["forward estimates, not reported figures; asOf is the fetch date"],
      ),
    );
  } else missing.push("earnings forecast");

  if (momentum.data) {
    const m = parseEstimateMomentum(momentum.data);
    const change = (cur?: number, ago?: number) => (cur !== undefined && ago ? ((cur - ago) / Math.abs(ago)) * 100 : undefined);
    const points = [
      ...pt(`${T}.est.momentum.qtr.current`, `${T} quarter EPS consensus now (quarter ending ${m.quarterEnd ?? "?"})`, m.quarter.current, "USD"),
      ...pt(`${T}.est.momentum.qtr.monthAgo`, `${T} quarter EPS consensus a month ago`, m.quarter.monthAgo, "USD"),
      ...pt(
        `${T}.est.momentum.qtr.change1m`,
        `${T} quarter EPS consensus change over a month`,
        change(m.quarter.current, m.quarter.monthAgo),
        "%",
        undefined,
        "(now − month ago) / |month ago|",
      ),
      ...pt(`${T}.est.momentum.fy.current`, `${T} year EPS consensus now (year ending ${m.yearEnd ?? "?"})`, m.year.current, "USD"),
      ...pt(`${T}.est.momentum.fy.monthAgo`, `${T} year EPS consensus a month ago`, m.year.monthAgo, "USD"),
      ...pt(
        `${T}.est.momentum.fy.change1m`,
        `${T} year EPS consensus change over a month`,
        change(m.year.current, m.year.monthAgo),
        "%",
        undefined,
        "(now − month ago) / |month ago|",
      ),
    ];
    if (points.length) out.push(dataset("estimates", `${T} estimate momentum`, T, points, momentum.url, momentum.res.fetchedAt));
  } else missing.push("estimate momentum");

  const sur = surprise.data ? parseEarningsSurprise(surprise.data) : [];
  if (sur.length) {
    const points = sur.flatMap((r) => [
      ...pt(`${T}.eps.actual.${r.fiscalEnd}`, `${T} reported EPS, fiscal quarter ending ${r.fiscalEnd}`, r.eps, "USD", r.reported),
      ...pt(`${T}.eps.consensus.${r.fiscalEnd}`, `${T} consensus EPS before the report, quarter ending ${r.fiscalEnd}`, r.consensus, "USD", r.reported),
      ...pt(`${T}.eps.surprise.${r.fiscalEnd}`, `${T} EPS surprise, quarter ending ${r.fiscalEnd}`, r.surprisePct, "%", r.reported),
    ]);
    out.push(
      dataset("estimates", `${T} earnings surprises`, T, points, surprise.url, surprise.res.fetchedAt, [
        "asOf is the report date; EPS as Zacks adjusts it, not GAAP",
      ]),
    );
  } else missing.push("earnings surprise");

  if (!out.length) {
    const st = [target, forecast, momentum, surprise].map((x) => x.res.status);
    const transient = st.some((x) => x === 0 || x === 429 || x >= 500);
    throw new ProviderError(
      NASDAQ_ANALYST_SOURCE,
      `no analyst data for ${T} (statuses ${st.join("/")})`,
      transient ? (st.find((x) => x === 0 || x === 429 || x >= 500) ?? 0) : 404,
    );
  }
  if (missing.length) out[0]!.notes.push(`unavailable for ${T}: ${missing.join(", ")}`);
  return out;
}

/** Short interest at the last `limit` settlement dates (FINRA, twice monthly). */
export async function nasdaqShortInterest(symbol: string, opts: { limit?: number } = {}): Promise<Dataset> {
  const T = usSym(symbol);
  const r = await get<any>(`quote/${encodeURIComponent(T)}/short-interest?assetClass=stocks`);
  const rows = r.data ? parseShortInterest(r.data).slice(0, opts.limit ?? 6) : [];
  if (!rows.length) throw new ProviderError(NASDAQ_ANALYST_SOURCE, `no short interest for ${T} (${r.res.status})`, r.res.ok ? 404 : r.res.status);
  const points = rows.flatMap((x) => [
    ...pt(`${T}.short.interest.${x.settlement}`, `${T} short interest, settlement ${x.settlement}`, x.shares, "shares", x.settlement),
    ...pt(
      `${T}.short.daysToCover.${x.settlement}`,
      `${T} days to cover, settlement ${x.settlement}`,
      x.daysToCover,
      "days",
      x.settlement,
      "short interest / average daily volume",
    ),
  ]);
  return dataset("short-interest", `${T} short interest`, T, points, r.url, r.res.fetchedAt, [
    "short INTEREST (open short positions at settlement, reported twice a month, published ~8 business days later) — not daily short VOLUME",
  ]);
}

/** Dividend history (ex-dates, amounts, pay dates), yield and annualized dividend. */
export async function nasdaqDividends(symbol: string, opts: { limit?: number } = {}): Promise<Dataset> {
  const T = usSym(symbol);
  const r = await get<any>(`quote/${encodeURIComponent(T)}/dividends?assetclass=stocks`);
  const d = r.data ? parseNasdaqDividends(r.data) : undefined;
  if (!d || (!d.rows.length && d.annual === undefined))
    throw new ProviderError(NASDAQ_ANALYST_SOURCE, `no dividend data for ${T} (${r.res.status})`, r.res.ok ? 404 : r.res.status);
  const day = r.res.fetchedAt.slice(0, 10);
  const points: Point[] = [
    ...pt(`${T}.div.yield`, `${T} dividend yield (indicated)`, d.yieldPct, "%", day),
    ...pt(`${T}.div.annual`, `${T} annualized dividend per share`, d.annual, "USD", day),
    ...d.rows
      .slice(0, opts.limit ?? 8)
      .flatMap((x) =>
        pt(
          `${T}.div.${x.exDate}`,
          `${T} ${x.type.toLowerCase() || "cash"} dividend per share, ex-date ${x.exDate}${x.paid ? `, paid ${x.paid}` : ""}`,
          x.amount,
          x.currency,
          x.exDate,
        ),
      ),
  ];
  return dataset("dividends", `${T} dividends`, T, points, r.url, r.res.fetchedAt, d.rows.length ? [] : ["no dividend history listed"]);
}
