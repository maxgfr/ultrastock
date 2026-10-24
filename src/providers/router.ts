// Which provider answers for a symbol, decided from the symbol's shape, and
// which stands in when it cannot:
//
//   MC.PA, ASML.AS, an EU ISIN      → Euronext (official, end of day)      → Yahoo
//   SAP.DE, SHEL.L, NESN.SW, …      → Yahoo (unofficial; other European venues)
//   NVDA, QQQ, BRK.B, NVDA.US       → Nasdaq API (unofficial, US)          → Yahoo
//   BTCUSDT, ETH-EUR, SOL/USDC      → Binance spot (official, real time)   → Kraken → Coinbase
//
// Fallbacks are explicit: the answer's provenance says "fallback for euronext"
// when Euronext did not answer, and a definitive refusal ("no such listing")
// is not routed around. A crypto venue's jurisdiction refusal (HTTP 451) does
// fall through to the next venue: it is that venue's answer, not the market's.
import { firstAnswer } from "../core/fallback.js";
import { clockNow } from "../core/net.js";
import { binanceHistory, binanceQuote, looksLikeCryptoPair, resolveBinance } from "./binance.js";
import { euronextHistory, resolveEuronext, SUFFIX_MICS } from "./euronext.js";
import { coinbaseHistory, coinbaseQuote, resolveCoinbase } from "./markets/coinbase.js";
import { krakenHistory, krakenQuote, resolveKraken } from "./markets/kraken.js";
import { resolveYahoo, yahooHistory, yahooQuote, yahooVenue } from "./markets/yahoo.js";
import { nasdaqHistory, nasdaqQuote, resolveNasdaq } from "./nasdaq.js";
import { type Instrument, type Interval, type PriceSeries, ProviderError, type QuoteResult } from "./types.js";

export interface Resolved {
  instrument: Instrument;
  notes: string[];
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

export function classifySymbol(raw: string): "euronext" | "europe" | "crypto" | "us" | { unsupported: string } {
  const s = raw.trim().toUpperCase();
  if (ISIN.test(s)) return s.startsWith("US") ? { unsupported: `${s} is a US ISIN — use the ticker (\`resolve\` finds it)` } : "euronext";
  const suffix = /\.([A-Z]{1,3})$/.exec(s)?.[1];
  if (suffix && suffix in SUFFIX_MICS) return "euronext";
  if (suffix && yahooVenue(s)) return "europe";
  if (looksLikeCryptoPair(s)) return "crypto";
  if (!suffix || suffix === "US" || /^[A-Z]{1,5}\.[A-Z]$/.test(s)) return "us";
  return {
    unsupported: `no provider covers the ".${suffix}" market — Euronext suffixes, the main European venues (.DE .L .SW .MC .ST .HE .CO .VI .WA), US tickers and crypto pairs are`,
  };
}

export async function resolveSymbol(raw: string): Promise<Resolved> {
  const s = raw.trim().toUpperCase();
  const kind = classifySymbol(s);
  if (typeof kind === "object") throw new ProviderError("router", kind.unsupported);
  if (kind === "euronext") return { instrument: await resolveEuronext(s), notes: [] };
  if (kind === "europe") return { instrument: await resolveYahoo(s), notes: [] };
  if (kind === "crypto") return resolveBinance(s);
  return { instrument: await resolveNasdaq(s), notes: [] };
}

export interface HistoryRequest {
  from: Date;
  to: Date;
  interval?: Interval;
}

/** The Yahoo symbol for an instrument another provider resolved: MC.PA stays, NVDA stays. */
const yahooSymbolOf = (i: Instrument) => i.symbol;

function stamp<T extends { provenance: { source: string; fallbackFrom?: string }; notes: string[] }>(
  value: T,
  failures: Array<{ source: string; error: string }>,
): T {
  if (!failures.length) return value;
  return {
    ...value,
    provenance: { ...value.provenance, fallbackFrom: failures.map((f) => f.source).join(", ") },
    notes: [...value.notes, ...failures.map((f) => `${f.source} did not answer (${f.error}) — ${value.provenance.source} stood in`)],
  };
}

export async function getHistory(r: Resolved, req: HistoryRequest): Promise<PriceSeries> {
  const interval = req.interval ?? "1d";
  const { instrument } = r;
  if (instrument.market === "crypto") {
    const res = await firstAnswer<PriceSeries>(
      [
        { source: "binance", run: () => binanceHistory(instrument, interval, req.from, req.to, r.notes) },
        { source: "kraken", run: async () => krakenHistory(await resolveKraken(instrument.symbol), interval, req.from, req.to, r.notes) },
        { source: "coinbase", run: () => coinbaseHistory(resolveCoinbase(instrument.symbol), interval, req.from, req.to, r.notes) },
      ],
      { fallThroughAll: true },
    );
    return stamp(res.value, res.failures);
  }
  if (interval !== "1d") throw new ProviderError(instrument.market, `only daily bars for ${instrument.symbol} (intraday comes from crypto venues)`);
  const primary =
    instrument.market === "euronext"
      ? { source: "euronext", run: () => euronextHistory(instrument, req.from, req.to) }
      : instrument.market === "us"
        ? { source: "nasdaq", run: () => nasdaqHistory(instrument, req.from, req.to) }
        : undefined;
  const yahoo = {
    source: "yahoo",
    run: async () => yahooHistory(instrument.market === "europe" ? instrument : await resolveYahoo(yahooSymbolOf(instrument)), "1d", req.from, req.to),
  };
  const res = await firstAnswer<PriceSeries>(primary ? [primary, yahoo] : [yahoo]);
  return stamp({ ...res.value, notes: [...r.notes, ...res.value.notes] }, res.failures);
}

/** The latest price: a live quote for US, European and crypto listings, the last official close for Euronext. */
export async function getQuote(r: Resolved, now = clockNow()): Promise<QuoteResult> {
  const { instrument } = r;
  if (instrument.market === "crypto") {
    const res = await firstAnswer<QuoteResult>(
      [
        { source: "binance", run: () => binanceQuote(instrument, r.notes) },
        { source: "kraken", run: async () => krakenQuote(await resolveKraken(instrument.symbol), r.notes) },
        { source: "coinbase", run: () => coinbaseQuote(resolveCoinbase(instrument.symbol), r.notes) },
      ],
      { fallThroughAll: true },
    );
    return stamp(res.value, res.failures);
  }
  if (instrument.market === "europe") return yahooQuote(instrument, now);
  if (instrument.market === "us") {
    const res = await firstAnswer<QuoteResult>([
      { source: "nasdaq", run: () => nasdaqQuote(instrument) },
      { source: "yahoo", run: async () => yahooQuote(await resolveYahoo(yahooSymbolOf(instrument)), now) },
    ]);
    return stamp(res.value, res.failures);
  }
  const res = await firstAnswer<QuoteResult>([
    {
      source: "euronext",
      run: async () => {
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
      },
    },
    { source: "yahoo", run: async () => yahooQuote(await resolveYahoo(yahooSymbolOf(instrument)), now) },
  ]);
  return stamp(res.value, res.failures);
}
