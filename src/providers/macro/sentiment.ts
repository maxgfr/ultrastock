// Market sentiment gauges, keyless:
//
//   CNN Fear & Greed   https://production.dataviz.cnn.io/index/fearandgreed/graphdata/<start YYYY-MM-DD>
//                      (unofficial, undocumented; wants a browser UA and edition.cnn.com Referer/Origin).
//                      The score (0–100), its rating, the previous close / week / month / year, and the
//                      seven sub-indicators with their own score and raw value. Asking from a start date
//                      keeps the history arrays to a few days instead of a year.
//   alternative.me     https://api.alternative.me/fng/?limit=N — the crypto Fear & Greed index (unofficial).
//   Cboe               https://cdn.cboe.com/api/global/delayed_quotes/quotes/_<SYM>.json — delayed index quotes
//                      for the VIX family (the JSON behind cboe.com; undocumented → unofficial);
//                      https://cdn.cboe.com/api/global/us_indices/daily_prices/<SYM>_History.csv — the
//                      published daily history (official; whole history in one file, hundreds of KB);
//                      https://cdn.cboe.com/data/us/options/market_statistics/daily/<YYYY-MM-DD>_daily_options —
//                      the day's put/call ratios and volumes (403 on a non-trading day).
import type { Dataset, Point } from "../../core/datasets.js";
import { isTradingDay } from "../../core/calendar.js";
import { csvRecords, parseLooseNumber } from "../../core/csv.js";
import { clockNow, fetchJson, fetchText } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { epochDay, isoDate, type Observation, requireOk, seriesPoints, usSlashDate } from "./common.js";

const CNN_HEADERS = { referer: "https://edition.cnn.com/", origin: "https://edition.cnn.com" };
const RATINGS = new Set(["extreme fear", "fear", "neutral", "greed", "extreme greed"]);

interface CnnComponent {
  timestamp?: number;
  score?: number;
  rating?: string;
  data?: Array<{ x: number; y: number; rating?: string }>;
}
export interface CnnAnswer {
  fear_and_greed?: {
    score?: number;
    rating?: string;
    timestamp?: string;
    previous_close?: number;
    previous_1_week?: number;
    previous_1_month?: number;
    previous_1_year?: number;
  };
  [component: string]: unknown;
}

/** The sub-indicators CNN returns: key → [label, unit of the raw value]. */
const CNN_COMPONENTS: Record<string, [string, string | undefined]> = {
  market_momentum_sp500: ["S&P 500 vs its 125-day average (momentum)", "index"],
  stock_price_strength: ["net new 52-week highs vs lows (strength)", undefined],
  stock_price_breadth: ["McClellan volume summation (breadth)", "index"],
  put_call_options: ["5-day average put/call ratio", "ratio"],
  market_volatility_vix: ["VIX vs its 50-day average (volatility)", "index"],
  junk_bond_demand: ["junk bond vs investment grade yield spread", "%"],
  safe_haven_demand: ["stocks vs bonds 20-day return difference (safe haven)", "%"],
};

const rating = (key: string, label: string, r: string | undefined, asOf?: string): Point[] =>
  r ? [{ key, label, value: r, asOf, ...(RATINGS.has(r.toLowerCase()) ? {} : { untrusted: true }) }] : [];

/** CNN's answer as points: the index, its history marks, and each sub-indicator's score, rating and raw value. */
export function parseCnnFearGreed(js: CnnAnswer): { points: Point[]; asOf?: string } {
  const fg = js.fear_and_greed;
  if (!fg || typeof fg.score !== "number") throw new ProviderError("cnn", "Fear & Greed answer has no score");
  const asOf = fg.timestamp?.slice(0, 10);
  const k = "US.sentiment.feargreed";
  const points: Point[] = [
    { key: k, label: "CNN Fear & Greed index", value: Number(fg.score.toFixed(1)), unit: "index", asOf },
    ...rating(`${k}.rating`, "CNN Fear & Greed rating", fg.rating, asOf),
  ];
  for (const [f, label] of [
    ["previous_close", "previous close"],
    ["previous_1_week", "one week ago"],
    ["previous_1_month", "one month ago"],
    ["previous_1_year", "one year ago"],
  ] as const) {
    const v = fg[f];
    if (typeof v === "number")
      points.push({
        key: `${k}.${f.replace("previous_", "prev.")}`,
        label: `CNN Fear & Greed index, ${label}`,
        value: Number(v.toFixed(1)),
        unit: "index",
        asOf,
      });
  }
  for (const [name, [label, unit]] of Object.entries(CNN_COMPONENTS)) {
    const c = js[name] as CnnComponent | undefined;
    if (!c || typeof c.score !== "number") continue;
    const at = c.timestamp ? epochDay(c.timestamp) : asOf;
    const base = `${k}.${name}`;
    points.push({ key: `${base}.score`, label: `CNN Fear & Greed component score: ${label}`, value: Number(c.score.toFixed(1)), unit: "index", asOf: at });
    points.push(...rating(`${base}.rating`, `CNN Fear & Greed component rating: ${label}`, c.rating, at));
    const last = c.data?.[c.data.length - 1];
    if (last && Number.isFinite(last.y))
      points.push({ key: `${base}.value`, label: `CNN Fear & Greed input: ${label}`, value: Number(last.y.toPrecision(8)), unit, asOf: epochDay(last.x) });
  }
  return { points, asOf };
}

/** CNN's Fear & Greed index with its seven components (unofficial). */
export async function cnnFearGreed(now: Date = clockNow()): Promise<Dataset> {
  const start = isoDate(new Date(now.getTime() - 7 * 86_400_000));
  const res = await fetchJson<CnnAnswer>(`https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${start}`, { headers: CNN_HEADERS });
  requireOk("cnn", res, "Fear & Greed index");
  const { points, asOf } = parseCnnFearGreed(res.data!);
  return {
    kind: "sentiment",
    title: "CNN Fear & Greed index",
    subject: "US",
    points,
    provenance: { source: "cnn", url: "https://edition.cnn.com/markets/fear-and-greed", fetchedAt: res.fetchedAt, delay: "delayed", official: false, asOf },
    notes: ["0 = extreme fear, 100 = extreme greed; an equal-weight blend of the seven components, computed by CNN."],
  };
}

/** alternative.me's answer as observations (YYYY-MM-DD), oldest first, with each day's classification. */
export function parseAlternativeMe(js: { data?: Array<{ value: string; value_classification?: string; timestamp: string }> }) {
  return (js.data ?? [])
    .map((d) => ({ date: epochDay(Number(d.timestamp) * 1000), value: Number(d.value), rating: d.value_classification }))
    .filter((d) => Number.isFinite(d.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The crypto Fear & Greed index (alternative.me) over the last `days` days. */
export async function cryptoFearGreed(days = 7): Promise<Dataset> {
  const res = await fetchJson<{ data?: Array<{ value: string; value_classification?: string; timestamp: string }> }>(
    `https://api.alternative.me/fng/?limit=${days}`,
  );
  requireOk("alternative.me", res, "crypto Fear & Greed index");
  const obs = parseAlternativeMe(res.data!);
  const last = obs[obs.length - 1];
  if (!last) throw new ProviderError("alternative.me", "crypto Fear & Greed answer is empty");
  const points = seriesPoints("CRYPTO.sentiment.feargreed", "Crypto Fear & Greed index", "index", obs, { history: true });
  if (last.rating)
    points.splice(1, 0, {
      key: "CRYPTO.sentiment.feargreed.rating",
      label: "Crypto Fear & Greed rating",
      value: last.rating,
      untrusted: true,
      asOf: last.date,
    });
  return {
    kind: "sentiment",
    title: "Crypto Fear & Greed index (alternative.me)",
    subject: "CRYPTO",
    points,
    provenance: { source: "alternative.me", url: res.url, fetchedAt: res.fetchedAt, delay: "daily", official: false, asOf: last.date },
    notes: ["Daily composite of crypto volatility, momentum, social media, dominance and trends; 0 = extreme fear, 100 = extreme greed."],
  };
}

export const VIX_FAMILY = ["VIX9D", "VIX", "VIX3M", "VIX6M", "VVIX", "SKEW"] as const;

interface CboeQuote {
  data?: { symbol?: string; current_price?: number; prev_day_close?: number; price_change?: number; last_trade_time?: string };
}

/** Delayed Cboe index quotes for the VIX family, with the term-structure ratios (VIX9D/VIX, VIX/VIX3M, VIX3M/VIX6M). */
export async function vixTermStructure(symbols: readonly string[] = VIX_FAMILY): Promise<Dataset> {
  const quotes = new Map<string, { price: number; asOf?: string; change?: number }>();
  let fetchedAt = "";
  const notes: string[] = [];
  for (const s of symbols) {
    const res = await fetchJson<CboeQuote>(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/_${encodeURIComponent(s)}.json`);
    const d = res.data?.data;
    if (!res.ok || typeof d?.current_price !== "number") {
      notes.push(`no Cboe quote for ${s} (HTTP ${res.status})`);
      continue;
    }
    fetchedAt ||= res.fetchedAt;
    quotes.set(s, { price: d.current_price, asOf: d.last_trade_time?.slice(0, 10), change: d.price_change });
  }
  if (!quotes.size) throw new ProviderError("cboe", `no VIX-family quote (${notes.join("; ")})`, 0);
  const points: Point[] = [];
  for (const [s, q] of quotes) {
    points.push({ key: `US.vol.${s.toLowerCase()}`, label: `Cboe ${s} index`, value: q.price, unit: "index", asOf: q.asOf });
    if (q.change !== undefined)
      points.push({ key: `US.vol.${s.toLowerCase()}.chg`, label: `Cboe ${s} index, change on the day`, value: q.change, unit: "index", asOf: q.asOf });
  }
  for (const [a, b] of [
    ["VIX9D", "VIX"],
    ["VIX", "VIX3M"],
    ["VIX3M", "VIX6M"],
  ] as const) {
    const qa = quotes.get(a);
    const qb = quotes.get(b);
    if (qa && qb && qb.price > 0)
      points.push({
        key: `US.vol.ratio.${a.toLowerCase()}_${b.toLowerCase()}`,
        label: `${a} / ${b} ratio (above 1 = inverted term structure)`,
        value: Number((qa.price / qb.price).toFixed(4)),
        unit: "ratio",
        asOf: qa.asOf,
        formula: `US.vol.${a.toLowerCase()} / US.vol.${b.toLowerCase()}`,
      });
  }
  return {
    kind: "sentiment",
    title: "VIX term structure (Cboe, delayed)",
    subject: "US",
    points,
    provenance: { source: "cboe", url: "https://www.cboe.com/tradable_products/vix/", fetchedAt, delay: "delayed", official: false },
    notes: [...notes, "VIX/VIX3M below 1 is the usual contango; above 1 (backwardation) marks stress."],
  };
}

/** Cboe's daily history CSV (DATE,OPEN,HIGH,LOW,CLOSE or DATE,<SYM>) as closes, oldest first. */
export function parseCboeHistory(text: string, symbol: string): Observation[] {
  return csvRecords(text)
    .flatMap((r) => {
      const date = usSlashDate(r.DATE);
      const v = parseLooseNumber(r.CLOSE ?? r[symbol]);
      return date && v !== undefined ? [{ date, value: v }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** A VIX-family index's official daily closes over the last `days` calendar days (the file carries the whole history). */
export async function cboeIndexHistory(symbol = "VIX", days = 30, now: Date = clockNow()): Promise<Dataset> {
  const s = symbol.toUpperCase();
  const res = await fetchText(`https://cdn.cboe.com/api/global/us_indices/daily_prices/${encodeURIComponent(s)}_History.csv`, { accept: "text/csv" });
  if (res.status === 403 || res.status === 404) throw new ProviderError("cboe", `no daily history for ${s}`, 404);
  requireOk("cboe", res, `${s} daily history`);
  const from = isoDate(new Date(now.getTime() - days * 86_400_000));
  const obs = parseCboeHistory(res.body, s).filter((o) => o.date >= from);
  if (!obs.length) throw new ProviderError("cboe", `no ${s} close since ${from}`);
  return {
    kind: "sentiment",
    title: `Cboe ${s} index — daily closes since ${from}`,
    subject: "US",
    points: seriesPoints(`US.vol.${s.toLowerCase()}`, `Cboe ${s} index close`, "index", obs, { history: true }),
    provenance: { source: "cboe", url: res.url, fetchedAt: res.fetchedAt, delay: "eod", official: true, asOf: obs[obs.length - 1]!.date },
    notes: [],
  };
}

interface CboeStats {
  ratios?: Array<{ name: string; value: string }>;
  [product: string]: unknown;
}

const PC_KEYS: Record<string, string> = {
  "TOTAL PUT/CALL RATIO": "total",
  "INDEX PUT/CALL RATIO": "index",
  "EQUITY PUT/CALL RATIO": "equity",
  "EXCHANGE TRADED PRODUCTS PUT/CALL RATIO": "etp",
  "CBOE VOLATILITY INDEX (VIX) PUT/CALL RATIO": "vix",
  "SPX + SPXW PUT/CALL RATIO": "spx",
};

/** The day's headline put/call ratios from Cboe's market statistics JSON. */
export function parseCboePutCall(js: CboeStats, date: string): Point[] {
  const points: Point[] = [];
  for (const r of js.ratios ?? []) {
    const id = PC_KEYS[r.name.trim().toUpperCase()];
    const v = parseLooseNumber(r.value);
    if (id && v !== undefined)
      points.push({ key: `US.options.putcall.${id}`, label: `Cboe ${id} put/call ratio (volume)`, value: v, unit: "ratio", asOf: date });
  }
  const total = (js["SUM OF ALL PRODUCTS"] as Array<{ name: string; call: number; put: number }> | undefined)?.find((x) => x.name === "VOLUME");
  if (total) {
    points.push({ key: "US.options.volume.call", label: "Cboe options call volume (all products)", value: total.call, unit: "contracts", asOf: date });
    points.push({ key: "US.options.volume.put", label: "Cboe options put volume (all products)", value: total.put, unit: "contracts", asOf: date });
  }
  return points;
}

/** The NYSE session before `day` (YYYY-MM-DD). */
export function previousSession(day: string): string {
  let d = new Date(`${day}T00:00:00Z`);
  for (let guard = 0; guard < 15; guard++) {
    d = new Date(d.getTime() - 86_400_000);
    if (isTradingDay("XNYS", isoDate(d))) break;
  }
  return isoDate(d);
}

/** The latest published session's Cboe put/call ratios (total, index, equity, ETP, VIX, SPX), walking back over non-trading days. */
export async function cboePutCall(now: Date = clockNow()): Promise<Dataset> {
  // The day's file appears after the close (≈ 22:00 UTC); before that, ask for the previous session.
  let day = isoDate(now);
  if (!isTradingDay("XNYS", day) || now.getUTCHours() < 22) day = previousSession(day);
  let lastStatus = 0;
  for (let i = 0; i < 3; i++, day = previousSession(day)) {
    const res = await fetchJson<CboeStats>(`https://cdn.cboe.com/data/us/options/market_statistics/daily/${day}_daily_options`);
    lastStatus = res.status;
    if (!res.ok || !res.data) continue;
    const points = parseCboePutCall(res.data, day);
    if (!points.length) continue;
    return {
      kind: "sentiment",
      title: `Cboe put/call ratios — ${day}`,
      subject: "US",
      points,
      provenance: {
        source: "cboe",
        url: "https://www.cboe.com/us/options/market_statistics/daily/",
        fetchedAt: res.fetchedAt,
        delay: "eod",
        official: false,
        asOf: day,
      },
      notes: ["Volume-based ratios for Cboe's own options exchanges, not the whole US options market."],
    };
  }
  throw new ProviderError("cboe", `no put/call statistics for the last 3 sessions (HTTP ${lastStatus})`, lastStatus === 403 ? 404 : lastStatus);
}
