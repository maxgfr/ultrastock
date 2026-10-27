// Yahoo Finance's chart API — keyless, undocumented (marked unofficial), the
// broadest free price coverage there is: the European venues Euronext does not
// run (Xetra, London, SIX, Madrid, the Nasdaq Nordic markets, Vienna, Warsaw),
// the rest of the world (São Paulo, Toronto, Mexico, Tokyo, Hong Kong, Seoul,
// Shanghai, Shenzhen, Taipei, Mumbai, Sydney, Johannesburg, Tel Aviv, Riyadh…),
// and a price fallback for US listings.
//
//   https://query1.finance.yahoo.com/v8/finance/chart/<SYM>?period1=…&period2=…&interval=1d&events=div,split
//   (query2.finance.yahoo.com serves the same API and stands in when query1 throttles)
//
// The chart endpoint needs no cookie or crumb (only the quoteSummary endpoints
// do), so none is negotiated. Yahoo answers 429 to scripted clients posing as a
// full desktop browser and serves a short, honest User-Agent, so this module
// identifies itself (politeUa). A 429 is waited out once by the network layer
// (Retry-After is honoured there), then reported as a transient ProviderError.
//
// Bars are split-adjusted at the source (Yahoo's `close`; dividends are not
// folded in — `adjclose` would). London quotes in pence (GBp), Johannesburg in
// cents (ZAc), Tel Aviv in agorot (ILA): converted to GBP, ZAR and ILS here,
// and said so. Splits and dividends come back as their own dataset.
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow, fetchJson, politeUa } from "../../core/net.js";
import { type AssetKind, type Bar, type Instrument, type Interval, type PriceSeries, ProviderError, type QuoteResult } from "../types.js";

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
export const SOURCE = "yahoo";
const DELAY_QUOTE = "delayed (15–20 min on most venues)";

export interface YahooVenue {
  /** Market identifier code of the venue. */
  mic: string;
  name: string;
  country: string;
  /** The currency Yahoo prices in (GBp = pence, ZAc = cents, ILA = agorot). */
  currency: string;
  /** TradingView's exchange prefix for the same venue; absent when TradingView keys it otherwise (Bursa Malaysia by name). */
  tradingview?: string;
  /** The router's market: "europe" for European venues outside Euronext, "world" for the rest. */
  market: "europe" | "world";
  /** The exchange's time zone (IANA). */
  timeZone: string;
  /** Why Yahoo serves a quote but no daily history for this venue, when it does not. */
  quoteOnly?: string;
}

/**
 * The venues Yahoo prices, by suffix: European venues Euronext does not run
 * (market "europe"), then the Americas, Asia, Oceania, the Middle East and
 * Africa (market "world"). Each suffix was checked live (a quote and a year
 * of daily bars for one liquid listing) before it was listed here.
 */
export const YAHOO_VENUES: Record<string, YahooVenue> = {
  DE: { mic: "XETR", name: "Xetra", country: "DE", currency: "EUR", tradingview: "XETR", market: "europe", timeZone: "Europe/Berlin" },
  L: { mic: "XLON", name: "London Stock Exchange", country: "GB", currency: "GBp", tradingview: "LSE", market: "europe", timeZone: "Europe/London" },
  SW: { mic: "XSWX", name: "SIX Swiss Exchange", country: "CH", currency: "CHF", tradingview: "SIX", market: "europe", timeZone: "Europe/Zurich" },
  MC: { mic: "XMAD", name: "Bolsa de Madrid", country: "ES", currency: "EUR", tradingview: "BME", market: "europe", timeZone: "Europe/Madrid" },
  ST: { mic: "XSTO", name: "Nasdaq Stockholm", country: "SE", currency: "SEK", tradingview: "OMXSTO", market: "europe", timeZone: "Europe/Stockholm" },
  HE: { mic: "XHEL", name: "Nasdaq Helsinki", country: "FI", currency: "EUR", tradingview: "OMXHEX", market: "europe", timeZone: "Europe/Helsinki" },
  CO: { mic: "XCSE", name: "Nasdaq Copenhagen", country: "DK", currency: "DKK", tradingview: "OMXCOP", market: "europe", timeZone: "Europe/Copenhagen" },
  VI: { mic: "XWBO", name: "Wiener Börse", country: "AT", currency: "EUR", tradingview: "VIE", market: "europe", timeZone: "Europe/Vienna" },
  WA: { mic: "XWAR", name: "Warsaw Stock Exchange", country: "PL", currency: "PLN", tradingview: "GPW", market: "europe", timeZone: "Europe/Warsaw" },
  // The Americas.
  SA: { mic: "BVMF", name: "B3 (São Paulo)", country: "BR", currency: "BRL", tradingview: "BMFBOVESPA", market: "world", timeZone: "America/Sao_Paulo" },
  MX: { mic: "XMEX", name: "Bolsa Mexicana de Valores", country: "MX", currency: "MXN", tradingview: "BMV", market: "world", timeZone: "America/Mexico_City" },
  TO: { mic: "XTSE", name: "Toronto Stock Exchange", country: "CA", currency: "CAD", tradingview: "TSX", market: "world", timeZone: "America/Toronto" },
  V: { mic: "XTSX", name: "TSX Venture Exchange", country: "CA", currency: "CAD", tradingview: "TSXV", market: "world", timeZone: "America/Toronto" },
  NE: {
    mic: "NEOE",
    name: "Cboe Canada",
    country: "CA",
    currency: "CAD",
    tradingview: "NEO",
    market: "world",
    timeZone: "America/Toronto",
    quoteOnly: "Yahoo keeps no daily history for Cboe Canada (.NE) listings, only the last session — the issuer's home line (.TO, or its US ticker) has one",
  },
  BA: {
    mic: "XBUE",
    name: "Bolsa y Mercados Argentinos (Buenos Aires)",
    country: "AR",
    currency: "ARS",
    tradingview: "BCBA",
    market: "world",
    timeZone: "America/Argentina/Buenos_Aires",
  },
  SN: { mic: "XSGO", name: "Bolsa de Santiago", country: "CL", currency: "CLP", tradingview: "BCS", market: "world", timeZone: "America/Santiago" },
  CL: { mic: "XBOG", name: "Bolsa de Valores de Colombia", country: "CO", currency: "COP", tradingview: "BVC", market: "world", timeZone: "America/Bogota" },
  // Asia.
  T: { mic: "XTKS", name: "Tokyo Stock Exchange", country: "JP", currency: "JPY", tradingview: "TSE", market: "world", timeZone: "Asia/Tokyo" },
  HK: { mic: "XHKG", name: "Hong Kong Stock Exchange", country: "HK", currency: "HKD", tradingview: "HKEX", market: "world", timeZone: "Asia/Hong_Kong" },
  KS: { mic: "XKRX", name: "Korea Exchange (KOSPI)", country: "KR", currency: "KRW", tradingview: "KRX", market: "world", timeZone: "Asia/Seoul" },
  KQ: { mic: "XKOS", name: "Korea Exchange (KOSDAQ)", country: "KR", currency: "KRW", tradingview: "KRX", market: "world", timeZone: "Asia/Seoul" },
  SS: { mic: "XSHG", name: "Shanghai Stock Exchange", country: "CN", currency: "CNY", tradingview: "SSE", market: "world", timeZone: "Asia/Shanghai" },
  SZ: { mic: "XSHE", name: "Shenzhen Stock Exchange", country: "CN", currency: "CNY", tradingview: "SZSE", market: "world", timeZone: "Asia/Shanghai" },
  TW: { mic: "XTAI", name: "Taiwan Stock Exchange", country: "TW", currency: "TWD", tradingview: "TWSE", market: "world", timeZone: "Asia/Taipei" },
  TWO: { mic: "ROCO", name: "Taipei Exchange (TPEx)", country: "TW", currency: "TWD", tradingview: "TPEX", market: "world", timeZone: "Asia/Taipei" },
  SI: { mic: "XSES", name: "Singapore Exchange", country: "SG", currency: "SGD", tradingview: "SGX", market: "world", timeZone: "Asia/Singapore" },
  KL: { mic: "XKLS", name: "Bursa Malaysia", country: "MY", currency: "MYR", market: "world", timeZone: "Asia/Kuala_Lumpur" },
  JK: { mic: "XIDX", name: "Indonesia Stock Exchange", country: "ID", currency: "IDR", tradingview: "IDX", market: "world", timeZone: "Asia/Jakarta" },
  BK: { mic: "XBKK", name: "Stock Exchange of Thailand", country: "TH", currency: "THB", tradingview: "SET", market: "world", timeZone: "Asia/Bangkok" },
  NS: { mic: "XNSE", name: "National Stock Exchange of India", country: "IN", currency: "INR", tradingview: "NSE", market: "world", timeZone: "Asia/Kolkata" },
  BO: { mic: "XBOM", name: "BSE (Bombay Stock Exchange)", country: "IN", currency: "INR", tradingview: "BSE", market: "world", timeZone: "Asia/Kolkata" },
  // Oceania.
  AX: {
    mic: "XASX",
    name: "Australian Securities Exchange",
    country: "AU",
    currency: "AUD",
    tradingview: "ASX",
    market: "world",
    timeZone: "Australia/Sydney",
  },
  NZ: { mic: "XNZE", name: "NZX (New Zealand)", country: "NZ", currency: "NZD", tradingview: "NZX", market: "world", timeZone: "Pacific/Auckland" },
  // The Middle East and Africa.
  JO: {
    mic: "XJSE",
    name: "Johannesburg Stock Exchange",
    country: "ZA",
    currency: "ZAc",
    tradingview: "JSE",
    market: "world",
    timeZone: "Africa/Johannesburg",
  },
  TA: { mic: "XTAE", name: "Tel Aviv Stock Exchange", country: "IL", currency: "ILA", tradingview: "TASE", market: "world", timeZone: "Asia/Jerusalem" },
  IS: { mic: "XIST", name: "Borsa Istanbul", country: "TR", currency: "TRY", tradingview: "BIST", market: "world", timeZone: "Europe/Istanbul" },
  SR: { mic: "XSAU", name: "Saudi Exchange (Tadawul)", country: "SA", currency: "SAR", tradingview: "TADAWUL", market: "world", timeZone: "Asia/Riyadh" },
  QA: { mic: "DSMD", name: "Qatar Stock Exchange", country: "QA", currency: "QAR", tradingview: "QSE", market: "world", timeZone: "Asia/Qatar" },
};

/**
 * Suffixes Yahoo answers for but cannot price: no currency and no last price
 * in the chart metadata. Refused with the reason rather than priced in a
 * guessed currency (Lima lists both PEN and USD lines).
 */
export const YAHOO_UNPRICED: Record<string, string> = {
  LM: "Yahoo serves Lima (.LM) listings with no currency and no last price (it tags them as mutual funds), and Lima lists both PEN and USD lines — not priced here; a Lima issuer's US line (BAP, SCCO, BVN) is",
};

/** Sub-unit currencies Yahoo quotes in, and the unit they divide into. */
const SUBUNITS: Record<string, { currency: string; per: number; name: string }> = {
  GBp: { currency: "GBP", per: 100, name: "pence" },
  GBX: { currency: "GBP", per: 100, name: "pence" },
  ZAc: { currency: "ZAR", per: 100, name: "cents" },
  ILA: { currency: "ILS", per: 100, name: "agorot" },
};

const KINDS: Record<string, AssetKind> = { EQUITY: "equity", ETF: "etf", INDEX: "index", MUTUALFUND: "fund", CRYPTOCURRENCY: "crypto" };

/** A Yahoo symbol's suffix and ticker: 7203.T → T / 7203, 6488.TWO → TWO / 6488. */
function splitSuffix(symbol: string): { ticker: string; suffix: string } | undefined {
  const m = /^(.+)\.([A-Z]{1,3})$/.exec(symbol.toUpperCase());
  return m ? { ticker: m[1]!, suffix: m[2]! } : undefined;
}

/** The venue a Yahoo symbol trades on, when it is one of the venues above. */
export function yahooVenue(symbol: string): (YahooVenue & { suffix: string; ticker: string }) | undefined {
  const parts = splitSuffix(symbol);
  const v = parts ? YAHOO_VENUES[parts.suffix] : undefined;
  return v && parts ? { ...v, ...parts } : undefined;
}

/** Why a Yahoo suffix is refused (Lima), or undefined. */
export function yahooUnpriced(symbol: string): string | undefined {
  const parts = splitSuffix(symbol);
  return parts ? YAHOO_UNPRICED[parts.suffix] : undefined;
}

export interface YahooMeta {
  currency?: string;
  symbol: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  regularMarketTime?: number;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  gmtoffset?: number;
  longName?: string;
  shortName?: string;
  currentTradingPeriod?: { regular?: { start: number; end: number } };
}

interface ChartResult {
  meta: YahooMeta;
  timestamp?: number[];
  events?: {
    dividends?: Record<string, { amount: number; date: number }>;
    splits?: Record<string, { date: number; numerator: number; denominator: number; splitRatio?: string }>;
  };
  indicators?: {
    quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
}

interface ChartBody {
  chart?: { result?: ChartResult[] | null; error?: { code?: string; description?: string } | null };
}

export interface YahooChart {
  meta: YahooMeta;
  /** The currency after sub-unit conversion (GBp → GBP). */
  currency: string;
  /** The divisor applied to every price (100 for pence, else 1). */
  divisor: number;
  bars: Bar[];
  dividends: Array<{ date: string; amount: number }>;
  splits: Array<{ date: string; numerator: number; denominator: number }>;
  notes: string[];
}

/** The session date of a Yahoo timestamp, in the exchange's own time zone. */
function sessionDate(ts: number, gmtoffset = 0): string {
  return new Date((ts + gmtoffset) * 1000).toISOString().slice(0, 10);
}

/**
 * Parse a chart answer: bars oldest first (rows with no close dropped), the
 * dividend and split events, prices converted out of sub-units. With
 * `closedBefore` (unix seconds), a daily bar whose session is still open at
 * that instant is dropped: only closed sessions are bars.
 */
export function parseYahooChart(body: ChartBody, interval: Interval = "1d", closedBefore?: number): YahooChart | undefined {
  const r = body.chart?.result?.[0];
  if (!r?.meta) return undefined;
  const meta = r.meta;
  const sub = meta.currency ? SUBUNITS[meta.currency] : undefined;
  const divisor = sub?.per ?? 1;
  const currency = sub?.currency ?? meta.currency ?? "";
  const notes: string[] = [];
  if (sub) notes.push(`Yahoo quotes ${meta.symbol} in ${sub.name} (${meta.currency}): prices divided by ${sub.per} and shown in ${sub.currency}`);
  const daily = interval === "1d" || interval === "1w";
  const q = r.indicators?.quote?.[0] ?? {};
  const ts = r.timestamp ?? [];
  const bars: Bar[] = [];
  const regular = meta.currentTradingPeriod?.regular;
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close === null || close === undefined || !Number.isFinite(close)) continue;
    const t = ts[i]!;
    if (closedBefore !== undefined) {
      if (interval === "1w" && t + 7 * 86400 > closedBefore) continue;
      if (interval === "1d" && regular && t >= regular.start && closedBefore < regular.end) continue;
      if (!daily && t > closedBefore) continue;
    }
    const open = q.open?.[i] ?? close;
    const bar: Bar = {
      date: daily ? sessionDate(t, meta.gmtoffset) : new Date(t * 1000).toISOString(),
      open: open / divisor,
      high: (q.high?.[i] ?? Math.max(open, close)) / divisor,
      low: (q.low?.[i] ?? Math.min(open, close)) / divisor,
      close: close / divisor,
    };
    const v = q.volume?.[i];
    if (v !== null && v !== undefined) bar.volume = v;
    bars.push(bar);
  }
  // Yahoo can repeat the last session (a live row after the daily ones): keep the last of each date.
  const byDate = new Map<string, Bar>();
  for (const b of bars) byDate.set(b.date, b);
  const dividends = Object.values(r.events?.dividends ?? {})
    .map((d) => ({ date: sessionDate(d.date, meta.gmtoffset), amount: d.amount / divisor }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const splits = Object.values(r.events?.splits ?? {})
    .map((s) => ({ date: sessionDate(s.date, meta.gmtoffset), numerator: s.numerator, denominator: s.denominator }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { meta, currency, divisor, bars: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), dividends, splits, notes };
}

/** The instrument a chart's metadata describes. */
export function yahooInstrument(symbol: string, meta: YahooMeta): Instrument {
  const sym = symbol.toUpperCase();
  const venue = yahooVenue(sym);
  const sub = meta.currency ? SUBUNITS[meta.currency] : undefined;
  return {
    symbol: sym,
    market: venue ? venue.market : meta.instrumentType === "CRYPTOCURRENCY" ? "crypto" : "us",
    kind: KINDS[meta.instrumentType ?? ""] ?? "equity",
    name: meta.longName ?? meta.shortName,
    mic: venue?.mic,
    currency: sub?.currency ?? meta.currency ?? venue?.currency ?? "USD",
    venueId: sym,
  };
}

/** The ProviderError for a failed chart call: 404 is definitive, 429 and 5xx transient. */
export function yahooFailure(status: number, symbol: string, body?: ChartBody, error?: string): ProviderError {
  const why = body?.chart?.error?.description;
  if (status === 404 || body?.chart?.error?.code === "Not Found")
    return new ProviderError(SOURCE, `no Yahoo listing for ${symbol}${why ? ` (${why})` : ""}`, 404);
  if (status === 429) return new ProviderError(SOURCE, `Yahoo throttled the request for ${symbol} (HTTP 429) — retry later`, 429);
  return new ProviderError(SOURCE, `chart request for ${symbol} failed (${status}${error ? `, ${error}` : ""})`, status);
}

/** One chart call, query1 then query2 when the first throttles or fails to answer. */
async function chart(symbol: string, query: string) {
  let last: ProviderError | undefined;
  for (const host of HOSTS) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
    const res = await fetchJson<ChartBody>(url, { userAgent: politeUa(), retries: 1 });
    if (res.ok && res.data?.chart?.result?.[0]) return { body: res.data, url: res.url, fetchedAt: res.fetchedAt };
    last = yahooFailure(res.status, symbol, res.data, res.error);
    if (!last.transient) throw last;
  }
  throw last!;
}

/** Resolve a Yahoo symbol (SAP.DE, VOD.L, NESN.SW, AAPL) to an instrument from its chart metadata. */
export async function resolveYahoo(symbol: string): Promise<Instrument> {
  const { body } = await chart(symbol.toUpperCase(), "range=5d&interval=1d");
  return yahooInstrument(symbol, body.chart!.result![0]!.meta);
}

const YAHOO_INTERVAL: Partial<Record<Interval, string>> = { "1d": "1d", "1w": "1wk", "1h": "60m", "15m": "15m" };

/** Bars and corporate actions between two instants: the price series and a dataset of dividends and splits. */
export async function yahooChart(
  instrument: Instrument,
  from: Date,
  to: Date,
  interval: Interval = "1d",
): Promise<{ series: PriceSeries; actions: Dataset; chart: YahooChart }> {
  const yi = YAHOO_INTERVAL[interval];
  if (!yi) throw new ProviderError(SOURCE, `Yahoo has no ${interval} bars`, 400);
  const p1 = Math.floor(from.getTime() / 1000);
  const p2 = Math.floor(to.getTime() / 1000);
  const res = await chart(instrument.venueId, `period1=${p1}&period2=${p2}&interval=${yi}&events=div,split`);
  const parsed = parseYahooChart(res.body, interval, Math.floor(Date.parse(res.fetchedAt) / 1000));
  if (!parsed?.bars.length) throw new ProviderError(SOURCE, `no closed ${interval} bars for ${instrument.venueId} in the window`);
  // A quote-only venue answers a history request with the last session alone: no series, said why.
  const quoteOnly = yahooVenue(instrument.venueId)?.quoteOnly;
  if (quoteOnly && parsed.bars.length < 2 && to.getTime() - from.getTime() > 7 * 86_400_000) throw new ProviderError(SOURCE, quoteOnly, 404);
  const provenance = { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "eod", official: false };
  const series: PriceSeries = {
    instrument,
    interval,
    bars: parsed.bars,
    adjusted: true,
    provenance,
    notes: [...parsed.notes, "split-adjusted by Yahoo; dividends are not folded into the prices"],
  };
  return { series, actions: corporateActionsDataset(instrument.symbol, parsed, provenance), chart: parsed };
}

/** Daily (or weekly/intraday) bars only — the shape the price router expects. */
export async function yahooHistory(instrument: Instrument, interval: Interval, from: Date, to: Date): Promise<PriceSeries> {
  return (await yahooChart(instrument, from, to, interval)).series;
}

/** Dividends and splits as points: `SAP.DE.action.dividend.2026-05-13`, `AAPL.action.split.2020-08-31`. */
export function corporateActionsDataset(symbol: string, c: YahooChart, provenance: Dataset["provenance"]): Dataset {
  const points: Point[] = [
    ...c.dividends.map((d) => ({
      key: `${symbol}.action.dividend.${d.date}`,
      label: `${symbol} dividend (ex-date ${d.date})`,
      value: d.amount,
      unit: c.currency,
      asOf: d.date,
    })),
    ...c.splits.map((s) => ({
      key: `${symbol}.action.split.${s.date}`,
      label: `${symbol} ${s.numerator}:${s.denominator} split`,
      value: s.numerator / s.denominator,
      unit: "ratio",
      asOf: s.date,
      formula: "numerator / denominator (new shares per old share)",
    })),
  ];
  const notes = points.length ? [] : ["no dividend or split in the window"];
  if (c.divisor !== 1 && c.dividends.length) notes.push(`dividends converted from ${c.meta.currency} like the prices`);
  return { kind: "corporate-actions", title: `${symbol} dividends and splits`, subject: symbol, points, provenance, notes };
}

/** The latest price from the chart metadata; the previous close is the prior session's. */
export async function yahooQuote(instrument: Instrument, now: Date = clockNow()): Promise<QuoteResult> {
  const res = await chart(instrument.venueId, "range=1d&interval=1d");
  const parsed = parseYahooChart(res.body);
  const meta = res.body.chart!.result![0]!.meta;
  if (!parsed || meta.regularMarketPrice === undefined) throw new ProviderError(SOURCE, `no price for ${instrument.venueId}`);
  const price = meta.regularMarketPrice / parsed.divisor;
  const prevRaw = meta.previousClose ?? meta.chartPreviousClose;
  const previousClose = prevRaw === undefined ? undefined : prevRaw / parsed.divisor;
  const at = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : now.toISOString();
  return {
    instrument,
    price,
    ...(previousClose !== undefined ? { previousClose, change: price - previousClose, changePct: ((price - previousClose) / previousClose) * 100 } : {}),
    at,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: DELAY_QUOTE, official: false },
    notes: parsed.notes,
  };
}

/**
 * Cross rates Yahoo quotes (`EURTWD=X`): units of each currency per one
 * `base`, for the currencies the ECB does not fix (TWD, SAR, QAR, ARS, CLP,
 * COP…). Unofficial and delayed, keyed like the ECB's (`EUR.fx.TWD`), one
 * call per currency, in the order given; a currency Yahoo does not quote is
 * left out and said so.
 */
export async function yahooFxRates(base: string, currencies: readonly string[]): Promise<Dataset> {
  const b = base.toUpperCase();
  const points: Point[] = [];
  const notes: string[] = ["Yahoo's cross rate (unofficial, delayed): no central-bank fixing for these currencies here"];
  let url = "";
  let fetchedAt = clockNow().toISOString();
  for (const c of currencies.map((x) => x.toUpperCase())) {
    try {
      const res = await chart(`${b}${c}=X`, "range=5d&interval=1d");
      const meta = res.body.chart!.result![0]!.meta;
      if (meta.regularMarketPrice === undefined || !(meta.regularMarketPrice > 0)) throw new ProviderError(SOURCE, "no rate");
      url ||= res.url;
      fetchedAt = res.fetchedAt;
      points.push({
        key: `${b}.fx.${c}`,
        label: `${c} per ${b} (Yahoo cross rate, unofficial)`,
        value: meta.regularMarketPrice,
        unit: c,
        url: res.url,
        ...(meta.regularMarketTime ? { asOf: new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) } : {}),
      });
    } catch (e) {
      notes.push(`no Yahoo rate for ${b}/${c} (${(e as Error).message})`);
    }
  }
  return {
    kind: "fx",
    title: `${b} cross rates — Yahoo (unofficial)`,
    subject: b,
    points,
    provenance: { source: SOURCE, url: url || `${HOSTS[0]}/v8/finance/chart/${b}`, fetchedAt, delay: DELAY_QUOTE, official: false },
    notes,
  };
}
