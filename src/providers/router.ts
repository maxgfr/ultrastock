// Which provider answers for a symbol, decided from the symbol's shape, and
// which stands in when it cannot:
//
//   MC.PA, ASML.AS, an EU ISIN      → Euronext (official, end of day)      → Yahoo
//   an ISIN Euronext does not list  → FT fund pages (unofficial, daily NAV): an OPCVM, a SICAV
//   SAP.DE, SHEL.L, NESN.SW, …      → Yahoo (unofficial; other European venues)
//   PETR4.SA, 7203.T, 0700.HK, BHP.AX, NPN.JO, … → Yahoo (unofficial; the rest of the world)
//   NVDA, QQQ, BRK.B, NVDA.US       → Nasdaq API (unofficial, US)          → Yahoo
//   BTCUSDT, ETH-EUR, SOL/USDC      → Binance spot (official, real time)   → Kraken → Coinbase
//   BTC-USD                         → Binance prices it against USDT (said); Kraken and Coinbase, which
//                                     have a dollar book, are asked for BTC-USD when they stand in
//
// Fallbacks are explicit: the answer's provenance says "fallback for euronext"
// when Euronext did not answer, and a definitive refusal ("no such listing")
// is not routed around. A crypto venue's jurisdiction refusal (HTTP 451) does
// fall through to the next venue: it is that venue's answer, not the market's.
import { failureNote, firstAnswer, type SourceFailure } from "../core/fallback.js";
import { clockNow } from "../core/net.js";
import { binanceHistory, binanceQuote, looksLikeCryptoPair, resolveBinance } from "./binance.js";
import { euronextHistory, resolveEuronext, SUFFIX_MICS } from "./euronext.js";
import { ftFundHistory, resolveFtFund } from "./funds/ft.js";
import { coinbaseHistory, coinbaseQuote, resolveCoinbase } from "./markets/coinbase.js";
import { krakenHistory, krakenQuote, resolveKraken } from "./markets/kraken.js";
import { resolveYahoo, yahooHistory, yahooQuote, yahooUnpriced, yahooVenue } from "./markets/yahoo.js";
import { nasdaqHistory, nasdaqQuote, resolveNasdaq } from "./nasdaq.js";
import { type Instrument, type Interval, type PriceSeries, ProviderError, type QuoteResult } from "./types.js";

export interface Resolved {
  instrument: Instrument;
  notes: string[];
  /** A crypto pair the first venue prices against another quote than the one written (BTC-USD → BTCUSDT on Binance): the pair as written, and the note in `notes` that says so. */
  substituted?: { written: string; note: string };
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

export function classifySymbol(raw: string): "euronext" | "europe" | "world" | "crypto" | "us" | { unsupported: string } {
  const s = raw.trim().toUpperCase();
  if (ISIN.test(s)) return s.startsWith("US") ? { unsupported: `${s} is a US ISIN — use the ticker (\`resolve\` finds it)` } : "euronext";
  const suffix = /\.([A-Z]{1,3})$/.exec(s)?.[1];
  if (suffix && suffix in SUFFIX_MICS) return "euronext";
  const venue = suffix ? yahooVenue(s) : undefined;
  if (venue) return venue.market;
  const unpriced = suffix ? yahooUnpriced(s) : undefined;
  if (unpriced) return { unsupported: unpriced };
  if (looksLikeCryptoPair(s)) return "crypto";
  if (!suffix || suffix === "US" || /^[A-Z]{1,5}\.[A-Z]$/.test(s)) return "us";
  return {
    unsupported: `no provider covers the ".${suffix}" market — Euronext suffixes, the venues Yahoo prices (Europe .DE .L .SW .MC .ST .HE .CO .VI .WA; Americas .SA .MX .TO .V .NE .BA .SN .CL; Asia .T .HK .KS .KQ .SS .SZ .TW .TWO .SI .KL .JK .BK .NS .BO; Oceania .AX .NZ; Middle East and Africa .JO .TA .IS .SR .QA), US tickers and crypto pairs are`,
  };
}

export async function resolveSymbol(raw: string): Promise<Resolved> {
  const s = raw.trim().toUpperCase();
  const kind = classifySymbol(s);
  if (typeof kind === "object") throw new ProviderError("router", kind.unsupported);
  if (kind === "euronext") {
    if (!ISIN.test(s)) return { instrument: await resolveEuronext(s), notes: [] };
    try {
      return { instrument: await resolveEuronext(s), notes: [] };
    } catch (e) {
      // Not listed on Euronext: a fund that trades on no exchange (an assurance-vie's OPCVM) — its NAV from the FT.
      if (!(e instanceof ProviderError) || !/no Euronext listing/.test(e.message)) throw e;
      return { instrument: await resolveFtFund(s), notes: [`${s} has no Euronext listing: priced as a fund at its daily NAV (FT, unofficial)`] };
    }
  }
  if (kind === "europe" || kind === "world") return { instrument: await resolveYahoo(s), notes: [] };
  if (kind === "crypto") return resolveBinance(s);
  return { instrument: await resolveNasdaq(s), notes: [] };
}

export interface HistoryRequest {
  from: Date;
  to: Date;
  interval?: Interval;
}

/** Yahoo is the provider of record for the European venues outside Euronext and for the rest of the world. */
const viaYahoo = (i: Instrument) => i.market === "europe" || i.market === "world";

/** The Yahoo symbol for an instrument another provider resolved: MC.PA stays, NVDA stays. */
const yahooSymbolOf = (i: Instrument) => i.symbol;

function stamp<T extends { provenance: { source: string; fallbackFrom?: string }; notes: string[] }>(value: T, failures: SourceFailure[]): T {
  if (!failures.length) return value;
  return {
    ...value,
    provenance: { ...value.provenance, fallbackFrom: failures.map((f) => f.source).join(", ") },
    notes: [...value.notes, ...failures.map((f) => failureNote(f, value.provenance.source))],
  };
}

/**
 * What the venues after Binance are asked: the pair the user wrote. When Binance had to price it against another
 * quote, they get the written pair — Kraken and Coinbase have real USD books — and not the note about Binance's
 * substitution, which would be false of their answer.
 */
function asWritten(r: Resolved): { symbol: string; notes: string[] } {
  const sub = r.substituted;
  return sub ? { symbol: sub.written, notes: r.notes.filter((n) => n !== sub.note) } : { symbol: r.instrument.symbol, notes: r.notes };
}

export async function getHistory(r: Resolved, req: HistoryRequest): Promise<PriceSeries> {
  const interval = req.interval ?? "1d";
  const { instrument } = r;
  if (instrument.market === "crypto") {
    const other = asWritten(r);
    const res = await firstAnswer<PriceSeries>(
      [
        { source: "binance", run: () => binanceHistory(instrument, interval, req.from, req.to, r.notes) },
        { source: "kraken", run: async () => krakenHistory(await resolveKraken(other.symbol), interval, req.from, req.to, other.notes) },
        { source: "coinbase", run: () => coinbaseHistory(resolveCoinbase(other.symbol), interval, req.from, req.to, other.notes) },
      ],
      { fallThroughAll: true },
    );
    return stamp(res.value, res.failures);
  }
  if (instrument.market === "fund") {
    if (interval !== "1d") throw new ProviderError("ft", `a fund has one price a day: only daily bars for ${instrument.symbol}`);
    const series = await ftFundHistory(instrument, req.from, req.to);
    return { ...series, notes: [...r.notes, ...series.notes] };
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
    run: async () => yahooHistory(viaYahoo(instrument) ? instrument : await resolveYahoo(yahooSymbolOf(instrument)), "1d", req.from, req.to),
  };
  const res = await firstAnswer<PriceSeries>(primary ? [primary, yahoo] : [yahoo]);
  return stamp({ ...res.value, notes: [...r.notes, ...res.value.notes] }, res.failures);
}

/** The latest price: a live quote for US, European and crypto listings, the last official close for Euronext. */
export async function getQuote(r: Resolved, now = clockNow()): Promise<QuoteResult> {
  const { instrument } = r;
  if (instrument.market === "crypto") {
    const other = asWritten(r);
    const res = await firstAnswer<QuoteResult>(
      [
        { source: "binance", run: () => binanceQuote(instrument, r.notes) },
        { source: "kraken", run: async () => krakenQuote(await resolveKraken(other.symbol), other.notes) },
        { source: "coinbase", run: () => coinbaseQuote(resolveCoinbase(other.symbol), other.notes) },
      ],
      { fallThroughAll: true },
    );
    return stamp(res.value, res.failures);
  }
  if (viaYahoo(instrument)) return yahooQuote(instrument, now);
  if (instrument.market === "fund") {
    const series = await ftFundHistory(instrument, new Date(now.getTime() - 21 * 86400_000), now);
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
      notes: [...r.notes, "the fund's last published net asset value (one price a day)"],
    };
  }
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
