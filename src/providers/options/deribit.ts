// Crypto options and implied volatility from Deribit's public JSON-RPC over
// HTTP — keyless, official for its own venue (the largest crypto options
// exchange), real time:
//
//   /api/v2/public/get_book_summary_by_currency?currency=BTC|ETH&kind=option   every listed option: bid/ask, mark, mark_iv, OI, volume, underlying
//   /api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp&end_timestamp&resolution=1D   DVOL candles (30-day implied vol index)
//   /api/v2/public/get_index_price?index_name=btc_usd                          the spot index options settle against
//
// BTC and ETH options are inverse: premiums are quoted in the coin, strikes in
// USD. Each expiry prices off its own future (`underlying_price`), which is
// what "at the money" is measured against. Linear USDC options (SOL_USDC-…)
// write decimal strikes with a "d" (1d35 = 1.35).
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow, fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { chainDataset, type OptionChain, type OptionContract } from "./chain.js";

const BASE = "https://www.deribit.com/api/v2/public";
export const SOURCE = "deribit";
const PACE = { hostIntervalMs: 100 };
const MONTHS: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

/** Parse a Deribit option name: BTC-27DEC26-100000-C, XRP_USDC-30OCT26-1d35-P. */
export function parseDeribitInstrument(name: string): { root: string; expiry: string; strike: number; right: "call" | "put" } | undefined {
  const m = /^([A-Z0-9_]+)-(\d{1,2})([A-Z]{3})(\d{2})-([0-9d.]+)-([CP])$/.exec(name);
  const month = m ? MONTHS[m[3]!] : undefined;
  if (!m || !month) return undefined;
  return { root: m[1]!, expiry: `20${m[4]}-${month}-${m[2]!.padStart(2, "0")}`, strike: Number(m[5]!.replace("d", ".")), right: m[6] === "C" ? "call" : "put" };
}

export interface DeribitSummary {
  instrument_name: string;
  bid_price?: number | null;
  ask_price?: number | null;
  last?: number | null;
  mark_price?: number | null;
  mark_iv?: number | null;
  open_interest?: number | null;
  volume?: number | null;
  underlying_price?: number | null;
  estimated_delivery_price?: number | null;
  quote_currency?: string;
  base_currency?: string;
}

interface RpcBody<T> {
  result?: T;
  error?: { code: number; message: string; data?: { reason?: string } };
  usOut?: number;
}

const val = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? undefined : v);

/** Book summaries → contracts (IV already in percent at Deribit). */
export function parseDeribitBook(rows: readonly DeribitSummary[]): OptionContract[] {
  const out: OptionContract[] = [];
  for (const r of rows) {
    const p = parseDeribitInstrument(r.instrument_name);
    if (!p) continue;
    const c: OptionContract = { contract: r.instrument_name, ...p, openInterest: val(r.open_interest) ?? 0, volume: val(r.volume) ?? 0 };
    if (val(r.bid_price) !== undefined) c.bid = r.bid_price!;
    if (val(r.ask_price) !== undefined) c.ask = r.ask_price!;
    if (val(r.last) !== undefined) c.last = r.last!;
    if (val(r.mark_price) !== undefined) c.mark = r.mark_price!;
    if (val(r.mark_iv) !== undefined && r.mark_iv! > 0) c.iv = r.mark_iv!;
    if (val(r.underlying_price) !== undefined) c.underlyingPrice = r.underlying_price!;
    out.push(c);
  }
  return out;
}

async function rpc<T>(path: string, what: string): Promise<{ result: T; url: string; fetchedAt: string }> {
  const url = `${BASE}${path}`;
  const res = await fetchJson<RpcBody<T>>(url, PACE);
  if (res.ok && res.data?.result !== undefined) return { result: res.data.result, url: res.url, fetchedAt: res.fetchedAt };
  // Parameter errors come back as HTTP 400 with a JSON-RPC error body; the network layer keeps only the status.
  if (res.status === 400) throw new ProviderError(SOURCE, `Deribit refused ${what} (invalid parameters)`, 400);
  throw new ProviderError(SOURCE, `${what} failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
}

/**
 * Every listed option on one underlying, typed: the raw chain for analytics.
 * `currency` is the settlement currency Deribit files options under (BTC, ETH,
 * or USDC for the linear SOL/XRP/… options); `base` picks the underlying
 * within USDC (SOL, XRP, BTC…) and defaults to the currency itself.
 */
export async function deribitChain(currency: string, base?: string): Promise<OptionChain> {
  const cur = currency.toUpperCase();
  const und = (base ?? cur).toUpperCase();
  const r = await rpc<DeribitSummary[]>(`/get_book_summary_by_currency?currency=${encodeURIComponent(cur)}&kind=option`, `the ${cur} option book`);
  const rows = r.result.filter((x) => (x.base_currency ?? cur) === und);
  const contracts = parseDeribitBook(rows);
  if (!contracts.length) throw new ProviderError(SOURCE, `Deribit lists no ${und} options settled in ${cur}`, 404);
  const spot = rows.find((x) => val(x.estimated_delivery_price) !== undefined)?.estimated_delivery_price ?? contracts[0]!.underlyingPrice ?? 0;
  const premium = rows[0]?.quote_currency ?? cur;
  return {
    underlying: und,
    underlyingPrice: spot,
    strikeCurrency: premium === und ? "USD" : premium,
    premiumCurrency: premium,
    asOf: r.fetchedAt,
    contracts,
    provenance: { source: SOURCE, url: r.url, fetchedAt: r.fetchedAt, delay: "realtime", official: true, asOf: r.fetchedAt.slice(0, 10) },
    notes: [
      premium === und ? `premiums quoted in ${und} (inverse options), strikes in USD; one contract = 1 ${und}` : `premiums and strikes in ${premium}`,
      "each expiry prices off its own future: ATM is the strike nearest that expiry's underlying",
      "underlying price shown is Deribit's estimated delivery (index) price",
    ],
  };
}

/** An option chain summarised per expiry (BTC, ETH; or USDC with `base`). */
export async function deribitOptions(
  currency: string,
  opts: { base?: string; now?: Date; maxExpiries?: number } = {},
): Promise<{ dataset: Dataset; chain: OptionChain }> {
  const chain = await deribitChain(currency, opts.base);
  return { dataset: chainDataset(chain, SOURCE, opts.now ?? clockNow(), opts.maxExpiries), chain };
}

export interface DvolCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** [ms, open, high, low, close] rows → candles (daily dates). */
export function parseDvol(rows: ReadonlyArray<[number, number, number, number, number]>): DvolCandle[] {
  return rows
    .map(([t, open, high, low, close]) => ({ date: new Date(t).toISOString().slice(0, 10), open, high, low, close }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** DVOL points: the latest close, its change over the window, and the window's range. */
export function dvolPoints(currency: string, candles: readonly DvolCandle[]): Point[] {
  const last = candles[candles.length - 1];
  const first = candles[0];
  if (!last || !first) return [];
  const k = `${currency}.deriv.dvol`;
  return [
    { key: k, label: `${currency} DVOL (Deribit 30-day implied volatility index)`, value: last.close, unit: "index", asOf: last.date },
    {
      key: `${k}.change`,
      label: `${currency} DVOL change since ${first.date}`,
      value: last.close - first.open,
      unit: "index",
      asOf: last.date,
      formula: "last close − first open",
    },
    { key: `${k}.high`, label: `${currency} DVOL high since ${first.date}`, value: Math.max(...candles.map((c) => c.high)), unit: "index", asOf: last.date },
    { key: `${k}.low`, label: `${currency} DVOL low since ${first.date}`, value: Math.min(...candles.map((c) => c.low)), unit: "index", asOf: last.date },
  ];
}

/** DVOL daily history over the last `days` days (≤ 1000 candles per call). */
export async function deribitDvol(currency: string, days = 90, now: Date = clockNow()): Promise<{ dataset: Dataset; candles: DvolCandle[] }> {
  const cur = currency.toUpperCase();
  const end = Math.floor(now.getTime() / 86_400_000) * 86_400_000;
  const start = end - days * 86_400_000;
  const r = await rpc<{ data: Array<[number, number, number, number, number]> }>(
    `/get_volatility_index_data?currency=${encodeURIComponent(cur)}&start_timestamp=${start}&end_timestamp=${end}&resolution=1D`,
    `DVOL for ${cur}`,
  );
  const candles = parseDvol(r.result.data ?? []);
  if (!candles.length) throw new ProviderError(SOURCE, `no DVOL candles for ${cur}`, 404);
  return {
    candles,
    dataset: {
      kind: "volatility",
      title: `${cur} DVOL (Deribit)`,
      subject: cur,
      points: dvolPoints(cur, candles),
      provenance: { source: SOURCE, url: r.url, fetchedAt: r.fetchedAt, delay: "realtime", official: true, asOf: candles[candles.length - 1]!.date },
      notes: ["DVOL is Deribit's 30-day forward implied volatility index, annualised (a VIX-style measure); the latest candle may still be forming"],
    },
  };
}

/** Deribit's spot index price (btc_usd, eth_usd…), the settlement reference of its options. */
export async function deribitIndexPrice(indexName: string): Promise<Dataset> {
  const name = indexName.toLowerCase();
  const r = await rpc<{ index_price: number }>(`/get_index_price?index_name=${encodeURIComponent(name)}`, `index ${name}`);
  const [base, quote] = name.toUpperCase().split("_") as [string, string | undefined];
  return {
    kind: "quote",
    title: `Deribit ${name} index`,
    subject: base,
    points: [{ key: `${base}.deriv.index.deribit`, label: `${base} Deribit index price (${name})`, value: r.result.index_price, unit: quote ?? "USD" }],
    provenance: { source: SOURCE, url: r.url, fetchedAt: r.fetchedAt, delay: "realtime", official: true, asOf: r.fetchedAt.slice(0, 10) },
    notes: ["a composite of spot exchange prices computed by Deribit"],
  };
}
