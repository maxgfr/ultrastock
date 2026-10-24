// Crypto spot prices from Kraken's public REST API — keyless, official for its
// own venue, and a regulated EU exchange (MiCA-licensed entity): the fallback
// when Binance refuses (HTTP 451) or has no book for the pair.
//
//   /0/public/AssetPairs?pair=<BTCEUR>                     the venue's pair name (XXBTZEUR) and quote
//   /0/public/OHLC?pair=<XXBTZEUR>&interval=<min>&since=<s> at most the 720 most recent bars, whatever `since` says
//   /0/public/Ticker?pair=<XXBTZEUR>                         last trade, today's open (00:00 UTC)
//
// Kraken reports errors in the body with HTTP 200 ({"error":["EQuery:Unknown
// asset pair"]}): those are read here, never mistaken for an empty success.
// Bitcoin is XBT on Kraken; the user's BTC is accepted and mapped.
import { cachedJson, TTL } from "../../core/cache.js";
import { fetchJson } from "../../core/net.js";
import { type Bar, type Instrument, type Interval, type PriceSeries, ProviderError, type QuoteResult } from "../types.js";
import { splitCryptoPair } from "./coinbase.js";

const BASE = "https://api.kraken.com/0/public";
export const SOURCE = "kraken";
const PACE = { hostIntervalMs: 1000 };
const MINUTES: Record<Interval, number> = { "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };

interface KrakenBody<T> {
  error?: string[];
  result?: T;
}

/** The ProviderError for Kraken's in-body errors: unknown pair is definitive, throttling and outages transient. */
export function krakenFailure(status: number, errors: string[] | undefined, what: string): ProviderError {
  const e = errors?.join("; ") ?? "";
  if (/Unknown asset pair|Invalid arguments/i.test(e)) return new ProviderError(SOURCE, `${what} is not a Kraken pair (${e})`, 404);
  if (/Too many requests|Rate limit/i.test(e)) return new ProviderError(SOURCE, `Kraken throttled the request for ${what} (${e})`, 429);
  if (/EService/i.test(e)) return new ProviderError(SOURCE, `Kraken is unavailable (${e})`, 503);
  return new ProviderError(SOURCE, `request for ${what} failed (${status}${e ? `, ${e}` : ""})`, status === 200 ? 502 : status);
}

async function call<T>(path: string, what: string): Promise<{ result: T; url: string; fetchedAt: string }> {
  const res = await fetchJson<KrakenBody<T>>(`${BASE}${path}`, PACE);
  if (!res.ok || !res.data?.result || res.data.error?.length) throw krakenFailure(res.status, res.data?.error ?? (res.error ? [res.error] : undefined), what);
  return { result: res.data.result, url: res.url, fetchedAt: res.fetchedAt };
}

const display = (asset: string) => (asset === "XBT" ? "BTC" : asset === "XDG" ? "DOGE" : asset);

/** The Kraken pair for a user symbol (BTC-EUR → XXBTZEUR), read from AssetPairs and cached. */
export async function resolveKraken(symbol: string): Promise<Instrument> {
  const p = splitCryptoPair(symbol);
  if (!p) throw new ProviderError(SOURCE, `${symbol} is not a crypto pair (write BASE-QUOTE, e.g. BTC-EUR)`, 400);
  const query = `${p.base}${p.quote}`;
  const found = await cachedJson(`kraken:pair:${query}`, TTL.reference, async () => {
    const { result } = await call<Record<string, { altname: string; wsname?: string; base: string; quote: string; status?: string }>>(
      `/AssetPairs?pair=${encodeURIComponent(query)}`,
      symbol,
    );
    const [id, info] = Object.entries(result)[0] ?? [];
    if (!id || !info) throw new ProviderError(SOURCE, `${symbol} is not a Kraken pair`, 404);
    return { id, wsname: info.wsname ?? info.altname, status: info.status };
  });
  const [b, q] = (found!.wsname.includes("/") ? found!.wsname.split("/") : [p.base, p.quote]) as [string, string];
  const base = display(b);
  const quote = display(q);
  return { symbol: `${base}-${quote}`, market: "crypto", kind: "crypto", name: `${base}/${quote}`, currency: quote, venueId: found!.id };
}

type OhlcRow = [number, string, string, string, string, string, string, number];

/** [time, open, high, low, close, vwap, volume, count] → bars. */
export function parseKrakenOhlc(rows: OhlcRow[], interval: Interval): Bar[] {
  return rows.map(([t, o, h, l, c, vwap, v, n]) => {
    const iso = new Date(t * 1000).toISOString();
    return {
      date: interval === "1d" || interval === "1w" ? iso.slice(0, 10) : iso,
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(v),
      vwap: Number(vwap),
      trades: n,
    };
  });
}

/**
 * Bars between two instants. Kraken keeps only the 720 most recent bars per
 * interval: an older start is reported in the notes, not papered over. Only
 * CLOSED bars: the one still forming is dropped.
 */
export async function krakenHistory(instrument: Instrument, interval: Interval, from: Date, to: Date, notes: string[] = []): Promise<PriceSeries> {
  const step = MINUTES[interval] * 60;
  const since = Math.floor(from.getTime() / 1000) - step;
  const res = await call<Record<string, OhlcRow[] | number>>(
    `/OHLC?pair=${instrument.venueId}&interval=${MINUTES[interval]}&since=${since}`,
    instrument.venueId,
  );
  const rows = Object.entries(res.result).find(([k, v]) => k !== "last" && Array.isArray(v))?.[1] as OhlcRow[] | undefined;
  const readAt = Date.parse(res.fetchedAt) / 1000;
  const lo = from.getTime() / 1000;
  const hi = to.getTime() / 1000;
  const kept = (rows ?? []).filter((r) => r[0] + step <= readAt && r[0] + step > lo && r[0] <= hi);
  const bars = parseKrakenOhlc(kept, interval);
  if (!bars.length) throw new ProviderError(SOURCE, `no closed ${interval} bars for ${instrument.venueId} in the window (Kraken keeps the last 720)`);
  const out = [...notes];
  const first = rows?.[0]?.[0];
  if (first !== undefined && first > lo + step) out.push(`Kraken serves the 720 most recent ${interval} bars only: history starts ${bars[0]!.date}`);
  return {
    instrument,
    interval,
    bars,
    adjusted: false,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "realtime", official: true },
    notes: out,
  };
}

/** The last trade, with the change from today's open (00:00 UTC). */
export async function krakenQuote(instrument: Instrument, notes: string[] = []): Promise<QuoteResult> {
  const res = await call<Record<string, { c: [string, string]; o: string }>>(`/Ticker?pair=${instrument.venueId}`, instrument.venueId);
  const t = Object.values(res.result)[0];
  if (!t) throw new ProviderError(SOURCE, `no ticker for ${instrument.venueId}`, 404);
  const price = Number(t.c[0]);
  const open = Number(t.o);
  return {
    instrument,
    price,
    ...(open > 0 ? { previousClose: open, change: price - open, changePct: ((price - open) / open) * 100 } : {}),
    at: res.fetchedAt,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "realtime", official: true },
    notes: [...notes, "change against today's open at 00:00 UTC (crypto has no session close); time is the read time, Kraken's ticker carries none"],
  };
}
