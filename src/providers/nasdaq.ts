// US stocks, ETFs and indices from the API behind nasdaq.com — keyless, not a
// documented public API (marked unofficial), and generous: ten years of
// split-adjusted daily bars in one call.
//
//   /api/quote/<SYM>/info?assetclass=stocks|etf|index
//   /api/quote/<SYM>/historical?assetclass=…&fromdate=…&todate=…&limit=9999
import { cachedJson, TTL } from "../core/cache.js";
import { parseLooseNumber } from "../core/csv.js";
import { fetchJson } from "../core/net.js";
import { type AssetKind, type Bar, type Instrument, type PriceSeries, ProviderError, type QuoteResult } from "./types.js";

const BASE = "https://api.nasdaq.com/api";
export const SOURCE = "nasdaq";
const ASSET_CLASSES = ["stocks", "etf", "index"] as const;
type AssetClass = (typeof ASSET_CLASSES)[number];

const KIND: Record<AssetClass, AssetKind> = { stocks: "equity", etf: "etf", index: "index" };

interface InfoData {
  symbol: string;
  companyName?: string;
  exchange?: string;
  stockType?: string;
  primaryData?: { lastSalePrice?: string; netChange?: string; percentageChange?: string; lastTradeTimestamp?: string; isRealTime?: boolean };
}

async function info(symbol: string, assetClass: AssetClass) {
  const url = `${BASE}/quote/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`;
  const res = await fetchJson<{ data: InfoData | null; status?: { rCode?: number } }>(url, { headers: { referer: "https://www.nasdaq.com/" } });
  return { res, data: res.data?.data ?? undefined };
}

/** The instrument for a US ticker, trying stock, then ETF, then index. */
export async function resolveNasdaq(symbol: string): Promise<Instrument> {
  const sym = symbol.toUpperCase().replace(/\.US$/, "");
  const found = await cachedJson(`nasdaq:resolve:${sym}`, TTL.reference, async () => {
    for (const ac of ASSET_CLASSES) {
      const { data } = await info(sym, ac);
      if (data?.symbol) return { assetClass: ac, name: data.companyName, exchange: data.exchange };
    }
    return undefined;
  });
  if (!found) throw new ProviderError(SOURCE, `no US listing for ${sym}`);
  return {
    symbol: sym,
    market: "us",
    kind: KIND[found.assetClass],
    name: found.name,
    mic: found.exchange,
    currency: "USD",
    venueId: `${sym}|${found.assetClass}`,
  };
}

const assetClassOf = (i: Instrument) => (i.venueId.split("|")[1] ?? "stocks") as AssetClass;

/** "10/23/2026" → "2026-10-23". */
function usDate(s: string): string | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : undefined;
}

export function parseNasdaqHistory(rows: Array<Record<string, string>>): Bar[] {
  const bars: Bar[] = [];
  for (const r of rows) {
    const date = usDate(r.date ?? "");
    const close = parseLooseNumber(r.close);
    if (!date || close === undefined) continue;
    const open = parseLooseNumber(r.open) ?? close;
    const bar: Bar = { date, open, high: parseLooseNumber(r.high) ?? Math.max(open, close), low: parseLooseNumber(r.low) ?? Math.min(open, close), close };
    const volume = parseLooseNumber(r.volume);
    if (volume !== undefined) bar.volume = volume;
    bars.push(bar);
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "Oct 22, 2026" (optionally followed by a time) → "2026-10-22", without going through the local time zone. */
export function monthDayYear(s: string): string | undefined {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(s.trim());
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
  return m && month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : undefined;
}

export async function nasdaqHistory(instrument: Instrument, from: Date, to: Date): Promise<PriceSeries> {
  const sym = instrument.venueId.split("|")[0]!;
  const url = `${BASE}/quote/${encodeURIComponent(sym)}/historical?assetclass=${assetClassOf(instrument)}&fromdate=${isoDay(from)}&todate=${isoDay(to)}&limit=9999`;
  const res = await fetchJson<{ data: { tradesTable?: { rows?: Array<Record<string, string>> } } | null }>(url, {
    headers: { referer: "https://www.nasdaq.com/" },
  });
  const rows = res.data?.data?.tradesTable?.rows;
  if (!res.ok || !Array.isArray(rows))
    throw new ProviderError(SOURCE, `historical prices unavailable for ${sym} (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const bars = parseNasdaqHistory(rows);
  if (!bars.length) throw new ProviderError(SOURCE, `no bars for ${sym} between ${isoDay(from)} and ${isoDay(to)}`);
  return {
    instrument,
    interval: "1d",
    bars,
    adjusted: true,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "eod", official: false },
    notes: [],
  };
}

/** The last sale (Nasdaq Last Sale, or the delayed consolidated price when the API says it is not real time). */
export async function nasdaqQuote(instrument: Instrument): Promise<QuoteResult> {
  const sym = instrument.venueId.split("|")[0]!;
  const { res, data } = await info(sym, assetClassOf(instrument));
  const p = data?.primaryData;
  const price = parseLooseNumber(p?.lastSalePrice);
  if (!data || price === undefined) throw new ProviderError(SOURCE, `no quote for ${sym} (${res.status})`, res.status);
  const change = parseLooseNumber(p?.netChange);
  const changePct = parseLooseNumber(p?.percentageChange);
  return {
    instrument,
    price,
    change,
    changePct,
    previousClose: change !== undefined ? Number((price - change).toFixed(6)) : undefined,
    at: monthDayYear(p?.lastTradeTimestamp ?? "") ?? res.fetchedAt.slice(0, 10),
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: p?.isRealTime ? "realtime-nls" : "delayed", official: false },
    notes: [],
  };
}
