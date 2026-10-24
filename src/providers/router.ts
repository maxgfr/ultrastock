// Which provider answers for a symbol, decided from the symbol's shape:
//
//   MC.PA, ASML.AS, an EU ISIN      → Euronext (official, end of day)
//   BTCUSDT, ETH-EUR, SOL/USDC      → Binance (official, real time)
//   NVDA, QQQ, BRK.B, NVDA.US       → Nasdaq API (unofficial, US)
//
// The choice is explicit and reported in every answer's provenance. A symbol
// no provider covers is a refusal that says so, never a guess at another market.
import { clockNow } from "../core/net.js";
import { binanceHistory, binanceQuote, looksLikeCryptoPair, resolveBinance } from "./binance.js";
import { euronextHistory, resolveEuronext, SUFFIX_MICS } from "./euronext.js";
import { nasdaqHistory, nasdaqQuote, resolveNasdaq } from "./nasdaq.js";
import { type Instrument, type Interval, type PriceSeries, ProviderError, type QuoteResult } from "./types.js";

export interface Resolved {
  instrument: Instrument;
  notes: string[];
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

export function classifySymbol(raw: string): "euronext" | "crypto" | "us" | { unsupported: string } {
  const s = raw.trim().toUpperCase();
  if (ISIN.test(s))
    return s.startsWith("US") ? { unsupported: `${s} is a US ISIN — use the ticker (US ISIN lookup arrives with the OpenFIGI resolver)` } : "euronext";
  const suffix = /\.([A-Z]{1,3})$/.exec(s)?.[1];
  if (suffix && suffix in SUFFIX_MICS) return "euronext";
  if (looksLikeCryptoPair(s)) return "crypto";
  if (!suffix || suffix === "US" || /^[A-Z]{1,5}\.[A-Z]$/.test(s)) return "us";
  return {
    unsupported: `no provider covers the ".${suffix}" market yet — Euronext (${Object.keys(SUFFIX_MICS)
      .map((k) => `.${k}`)
      .join(" ")}), US tickers and crypto pairs are`,
  };
}

export async function resolveSymbol(raw: string): Promise<Resolved> {
  const s = raw.trim().toUpperCase();
  const kind = classifySymbol(s);
  if (typeof kind === "object") throw new ProviderError("router", kind.unsupported);
  if (kind === "euronext") return { instrument: await resolveEuronext(s), notes: [] };
  if (kind === "crypto") return resolveBinance(s);
  return { instrument: await resolveNasdaq(s), notes: [] };
}

export interface HistoryRequest {
  from: Date;
  to: Date;
  interval?: Interval;
}

export async function getHistory(r: Resolved, req: HistoryRequest): Promise<PriceSeries> {
  const interval = req.interval ?? "1d";
  const { instrument } = r;
  if (instrument.market === "crypto") return binanceHistory(instrument, interval, req.from, req.to, r.notes);
  if (interval !== "1d") throw new ProviderError(instrument.market, `only daily bars for ${instrument.symbol} (intraday comes from crypto venues)`);
  const series = instrument.market === "euronext" ? await euronextHistory(instrument, req.from, req.to) : await nasdaqHistory(instrument, req.from, req.to);
  return { ...series, notes: [...r.notes, ...series.notes] };
}

/** The latest price: a live quote for US and crypto, the last official close for Euronext. */
export async function getQuote(r: Resolved, now = clockNow()): Promise<QuoteResult> {
  const { instrument } = r;
  if (instrument.market === "crypto") return binanceQuote(instrument, r.notes);
  if (instrument.market === "us") return nasdaqQuote(instrument);
  const series = await euronextHistory(instrument, new Date(now.getTime() - 14 * 86400_000), now);
  const last = series.bars[series.bars.length - 1]!;
  const prev = series.bars[series.bars.length - 2];
  return {
    instrument,
    price: last.close,
    previousClose: prev?.close,
    change: prev ? Number((last.close - prev.close).toFixed(6)) : undefined,
    changePct: prev ? Number(((last.close / prev.close - 1) * 100).toFixed(4)) : undefined,
    at: last.date,
    provenance: series.provenance,
    notes: [...r.notes, "Euronext official close of the last session (end-of-day data)"],
  };
}
