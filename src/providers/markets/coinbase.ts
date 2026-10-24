// Crypto spot prices from Coinbase Exchange's public market-data API — keyless,
// official for its own venue. A fallback when Binance refuses (HTTP 451) or has
// no book for the pair, and the venue with real USD (not USDT) books.
//
//   /products/<BASE-QUOTE>/candles?granularity=<s>&start=<ISO>&end=<ISO>   ≤ 300 candles a call, newest first
//   /products/<BASE-QUOTE>/ticker                                            last trade, bid, ask
//   /products/<BASE-QUOTE>/stats                                             24h open/high/low/volume
//
// Granularities are 1m, 5m, 15m, 1h, 6h and 1d: no 4h or weekly bars here.
// Public endpoints allow about 10 requests/s per IP; calls are paced below that.
import { fetchJson } from "../../core/net.js";
import { type Bar, type Instrument, type Interval, type PriceSeries, ProviderError, type QuoteResult } from "../types.js";

const BASE = "https://api.exchange.coinbase.com";
export const SOURCE = "coinbase";
const PACE = { hostIntervalMs: 150 };
const GRANULARITY: Partial<Record<Interval, number>> = { "15m": 900, "1h": 3600, "1d": 86400 };
const QUOTES = ["USDT", "USDC", "FDUSD", "EUR", "USD", "GBP", "BTC", "ETH", "DAI"];

/** Base and quote of a user pair: BTC-EUR, BTC/USD, BTCUSDT, ETHEUR. */
export function splitCryptoPair(symbol: string): { base: string; quote: string } | undefined {
  const s = symbol.toUpperCase().trim();
  const sep = /^([A-Z0-9]+)[-/_]([A-Z0-9]+)$/.exec(s);
  if (sep) return { base: sep[1]!, quote: sep[2]! };
  const quote = QUOTES.find((q) => s.endsWith(q) && s.length > q.length + 1);
  return quote ? { base: s.slice(0, s.length - quote.length), quote } : undefined;
}

/** The Coinbase product for a user pair (BTCUSDT → BTC-USDT). Existence is checked when it is read. */
export function resolveCoinbase(symbol: string): Instrument {
  const p = splitCryptoPair(symbol);
  if (!p) throw new ProviderError(SOURCE, `${symbol} is not a crypto pair (write BASE-QUOTE, e.g. BTC-EUR)`, 400);
  const id = `${p.base}-${p.quote}`;
  return { symbol: id, market: "crypto", kind: "crypto", name: `${p.base}/${p.quote}`, currency: p.quote, venueId: id };
}

/** [time, low, high, open, close, volume] rows, newest first → bars oldest first. */
export function parseCoinbaseCandles(rows: Array<[number, number, number, number, number, number]>, interval: Interval): Bar[] {
  return rows
    .map(([t, low, high, open, close, volume]) => {
      const iso = new Date(t * 1000).toISOString();
      return { date: interval === "1d" ? iso.slice(0, 10) : iso, open, high, low, close, volume };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function failure(status: number, product: string, body?: { message?: string }, error?: string): ProviderError {
  if (status === 404 || status === 400)
    return new ProviderError(SOURCE, `${product} is not a Coinbase product${body?.message ? ` (${body.message})` : ""}`, status);
  return new ProviderError(SOURCE, `request for ${product} failed (${status}${error ? `, ${error}` : ""})`, status);
}

/** Bars between two instants, paged 300 at a time. Only CLOSED bars: the one still forming is dropped. */
export async function coinbaseHistory(instrument: Instrument, interval: Interval, from: Date, to: Date, notes: string[] = []): Promise<PriceSeries> {
  const g = GRANULARITY[interval];
  if (!g) throw new ProviderError(SOURCE, `Coinbase has no ${interval} candles (1m, 5m, 15m, 1h, 6h, 1d only)`, 400);
  const bars = new Map<string, Bar>();
  let firstUrl = "";
  let fetchedAt = "";
  const end = to.getTime();
  for (let start = from.getTime(), page = 0; start <= end && page < 60; page++) {
    const stop = Math.min(end, start + (300 - 1) * g * 1000);
    const url = `${BASE}/products/${instrument.venueId}/candles?granularity=${g}&start=${new Date(start).toISOString()}&end=${new Date(stop).toISOString()}`;
    const res = await fetchJson<Array<[number, number, number, number, number, number]>>(url, PACE);
    if (!res.ok || !Array.isArray(res.data)) throw failure(res.status, instrument.venueId, res.data as { message?: string } | undefined, res.error);
    if (!firstUrl) {
      firstUrl = res.url;
      fetchedAt = res.fetchedAt;
    }
    const readAt = Date.parse(res.fetchedAt) / 1000;
    const closed = res.data.filter((c) => c[0] + g <= readAt);
    for (const b of parseCoinbaseCandles(closed, interval)) bars.set(b.date, b);
    start = stop + g * 1000;
  }
  if (!bars.size) throw new ProviderError(SOURCE, `no closed ${interval} candles for ${instrument.venueId} in the window`);
  return {
    instrument,
    interval,
    bars: [...bars.values()].sort((a, b) => a.date.localeCompare(b.date)),
    adjusted: false,
    provenance: { source: SOURCE, url: firstUrl, fetchedAt, delay: "realtime", official: true },
    notes,
  };
}

/** The last trade, with the change from the price 24 hours earlier. */
export async function coinbaseQuote(instrument: Instrument, notes: string[] = []): Promise<QuoteResult> {
  const t = await fetchJson<{ price: string; time: string; message?: string }>(`${BASE}/products/${instrument.venueId}/ticker`, PACE);
  if (!t.ok || !t.data?.price) throw failure(t.status, instrument.venueId, t.data, t.error);
  const s = await fetchJson<{ open: string }>(`${BASE}/products/${instrument.venueId}/stats`, PACE);
  const price = Number(t.data.price);
  const open = s.ok && s.data?.open ? Number(s.data.open) : undefined;
  return {
    instrument,
    price,
    ...(open ? { previousClose: open, change: price - open, changePct: ((price - open) / open) * 100 } : {}),
    at: t.data.time,
    provenance: { source: SOURCE, url: t.url, fetchedAt: t.fetchedAt, delay: "realtime", official: true },
    notes: [
      ...notes,
      open ? "24h rolling change against the price 24 hours earlier (crypto has no session close)" : "24h stats unavailable: no change reported",
    ],
  };
}
