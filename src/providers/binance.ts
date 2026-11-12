// Crypto spot prices from Binance's public REST API — keyless, official.
//
//   /api/v3/klines?symbol=…&interval=…&startTime=…&endTime=…&limit=1000
//   /api/v3/ticker/24hr?symbol=…
//
// Windows longer than 1000 bars are paged here; bulk exports (years of minute
// bars, futures mark/index/premium klines) go through the maxgfr/binance-
// historical CLI instead, which resumes, checkpoints and honours the weight budget.
// Binance refuses some jurisdictions with HTTP 451: that is reported, never retried around.
import { fetchJson } from "../core/net.js";
import { type Bar, type Instrument, type Interval, type PriceSeries, ProviderError, type QuoteResult } from "./types.js";

const BASE = "https://api.binance.com";
export const SOURCE = "binance";
const QUOTES = ["USDT", "USDC", "FDUSD", "EUR", "BTC", "ETH", "BNB", "TRY", "BRL", "JPY"];
const MS: Record<Interval, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000 };

/** Is this a crypto pair as a user writes one: BTCUSDT, BTC-USDT, BTC/EUR, ETH-USD? */
export function looksLikeCryptoPair(symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (/^[A-Z0-9]{2,12}[-/](USD|USDT|USDC|FDUSD|EUR|BTC|ETH|BNB)$/.test(s)) return true;
  return /^[A-Z0-9]{2,12}$/.test(s) && QUOTES.some((q) => s.endsWith(q) && s.length > q.length + 1);
}

/**
 * The Binance pair for a user symbol. "-USD" becomes USDT, with a note: Binance
 * spot has no USD book, and a dollar stablecoin is not the dollar. `substituted`
 * then keeps the pair as written (and that note), for the venues that do have the book.
 */
export function resolveBinance(symbol: string): { instrument: Instrument; notes: string[]; substituted?: { written: string; note: string } } {
  const s = symbol.toUpperCase();
  const notes: string[] = [];
  let substituted: { written: string; note: string } | undefined;
  let base: string;
  let quote: string;
  const sep = /^([A-Z0-9]+)[-/]([A-Z0-9]+)$/.exec(s);
  if (sep) {
    base = sep[1]!;
    quote = sep[2]!;
  } else {
    quote = QUOTES.find((q) => s.endsWith(q) && s.length > q.length) ?? "USDT";
    base = s.slice(0, s.length - quote.length);
  }
  if (quote === "USD") {
    quote = "USDT";
    substituted = {
      written: `${base}-USD`,
      note: `${base}-USD priced against USDT: Binance spot has no USD book — the figures are in USDT, a dollar stablecoin, not in dollars`,
    };
    notes.push(substituted.note);
  }
  const pair = `${base}${quote}`;
  return {
    instrument: { symbol: pair, market: "crypto", kind: "crypto", name: `${base}/${quote}`, currency: quote, venueId: pair },
    notes,
    ...(substituted ? { substituted } : {}),
  };
}

type Kline = [number, string, string, string, string, string, number, string, number, string, string, string];

export function parseKlines(rows: Kline[], interval: Interval): Bar[] {
  return rows.map((k) => {
    const iso = new Date(k[0]).toISOString();
    return {
      date: interval === "1d" || interval === "1w" ? iso.slice(0, 10) : iso,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      trades: k[8],
    };
  });
}

function refusal(status: number, pair: string): ProviderError {
  if (status === 451) return new ProviderError(SOURCE, `Binance refuses requests from this location (HTTP 451) for ${pair}`, status);
  if (status === 400) return new ProviderError(SOURCE, `${pair} is not a Binance spot pair`, status);
  return new ProviderError(SOURCE, `request for ${pair} failed (${status})`, status);
}

/** The most pages one history read asks for: 50 000 bars. */
export const BINANCE_MAX_PAGES = 50;

/**
 * Bars between two instants, paged 1000 at a time. Only CLOSED bars: the one still forming is dropped.
 * A window longer than `maxPages` pages is read from its start and stops short of `to`: the series says so.
 */
export async function binanceHistory(
  instrument: Instrument,
  interval: Interval,
  from: Date,
  to: Date,
  notes: string[] = [],
  maxPages = BINANCE_MAX_PAGES,
): Promise<PriceSeries> {
  const step = MS[interval];
  const bars: Bar[] = [];
  let start = from.getTime();
  const end = to.getTime();
  let firstUrl = "";
  let fetchedAt = "";
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    if (start > end) {
      complete = true;
      break;
    }
    const url = `${BASE}/api/v3/klines?symbol=${instrument.venueId}&interval=${interval}&startTime=${start}&endTime=${end}&limit=1000`;
    const res = await fetchJson<Kline[]>(url);
    if (!res.ok || !Array.isArray(res.data)) throw refusal(res.status, instrument.venueId);
    if (!firstUrl) {
      firstUrl = res.url;
      fetchedAt = res.fetchedAt;
    }
    const rows = res.data;
    // A kline is closed when its close time (index 6) is in the past at read time.
    const closed = rows.filter((k) => k[6] < Date.parse(res.fetchedAt));
    bars.push(...parseKlines(closed, interval));
    if (rows.length < 1000) {
      complete = true;
      break;
    }
    start = rows[rows.length - 1]![0] + step;
  }
  if (!bars.length) throw new ProviderError(SOURCE, `no closed ${interval} bars for ${instrument.venueId} in the window`);
  if (!complete && start <= end)
    notes.push(
      `the window holds more than ${maxPages * 1000} ${interval} bars: the series stops at ${bars[bars.length - 1]!.date}, short of ${to.toISOString().slice(0, 10)} — ask for a shorter window or a longer interval`,
    );
  return {
    instrument,
    interval,
    bars,
    adjusted: false,
    provenance: { source: SOURCE, url: firstUrl, fetchedAt, delay: "realtime", official: true },
    notes,
  };
}

export async function binanceQuote(instrument: Instrument, notes: string[] = []): Promise<QuoteResult> {
  const url = `${BASE}/api/v3/ticker/24hr?symbol=${instrument.venueId}`;
  const res = await fetchJson<{ lastPrice: string; priceChange: string; priceChangePercent: string; prevClosePrice: string; closeTime: number }>(url);
  if (!res.ok || !res.data) throw refusal(res.status, instrument.venueId);
  const d = res.data;
  // A field Binance leaves out reads as NaN, which the evidence register refuses: it is left out here too.
  const finite = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const price = finite(d.lastPrice);
  if (price === undefined) throw new ProviderError(SOURCE, `no last price for ${instrument.venueId}`);
  return {
    instrument,
    price,
    change: finite(d.priceChange),
    changePct: finite(d.priceChangePercent),
    previousClose: finite(d.prevClosePrice),
    at: new Date(d.closeTime).toISOString(),
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "realtime", official: true },
    notes: [...notes, "24h rolling change (crypto trades around the clock; there is no session close)"],
  };
}
