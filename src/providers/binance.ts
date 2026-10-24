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
 * spot has no USD book, and a dollar stablecoin is not the dollar.
 */
export function resolveBinance(symbol: string): { instrument: Instrument; notes: string[] } {
  const s = symbol.toUpperCase();
  const notes: string[] = [];
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
    notes.push(`${base}-USD priced against USDT: Binance spot has no USD book`);
  }
  const pair = `${base}${quote}`;
  return {
    instrument: { symbol: pair, market: "crypto", kind: "crypto", name: `${base}/${quote}`, currency: quote, venueId: pair },
    notes,
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

/** Bars between two instants, paged 1000 at a time. Only CLOSED bars: the one still forming is dropped. */
export async function binanceHistory(instrument: Instrument, interval: Interval, from: Date, to: Date, notes: string[] = []): Promise<PriceSeries> {
  const step = MS[interval];
  const bars: Bar[] = [];
  let start = from.getTime();
  const end = to.getTime();
  let firstUrl = "";
  let fetchedAt = "";
  for (let page = 0; start <= end && page < 50; page++) {
    const url = `${BASE}/api/v3/klines?symbol=${instrument.venueId}&interval=${interval}&startTime=${start}&endTime=${end}&limit=1000`;
    const res = await fetchJson<Kline[]>(url);
    if (!res.ok || !Array.isArray(res.data)) throw refusal(res.status, instrument.venueId);
    if (!firstUrl) {
      firstUrl = res.url;
      fetchedAt = res.fetchedAt;
    }
    const rows = res.data;
    if (!rows.length) break;
    // A kline is closed when its close time (index 6) is in the past at read time.
    const closed = rows.filter((k) => k[6] < Date.parse(res.fetchedAt));
    bars.push(...parseKlines(closed, interval));
    if (rows.length < 1000) break;
    start = rows[rows.length - 1]![0] + step;
  }
  if (!bars.length) throw new ProviderError(SOURCE, `no closed ${interval} bars for ${instrument.venueId} in the window`);
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
  return {
    instrument,
    price: Number(d.lastPrice),
    change: Number(d.priceChange),
    changePct: Number(d.priceChangePercent),
    previousClose: Number(d.prevClosePrice),
    at: new Date(d.closeTime).toISOString(),
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "realtime", official: true },
    notes: [...notes, "24h rolling change (crypto trades around the clock; there is no session close)"],
  };
}
