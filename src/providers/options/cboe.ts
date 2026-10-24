// US listed option chains from CBOE's delayed-quotes feed — keyless, published
// by the exchange (official), 15 minutes delayed:
//
//   https://cdn.cboe.com/api/global/delayed_quotes/options/<SYM>.json
//   (redirects to cdn-api.cboe.com; indices take a leading underscore: _SPX, _VIX, _NDX)
//
// One file holds every listed contract of the underlying with bid/ask, last,
// IV, greeks, open interest and volume, plus the underlying's quote and CBOE's
// 30-day IV index. Large underlyings are large files (AAPL ≈ 1.5 MB, SPX ≈
// 13 MB): read once, summarised per expiry, and the raw chain kept typed for
// analytics. An unknown symbol is an S3 "AccessDenied" (403): not found.
import type { Dataset } from "../../core/datasets.js";
import { clockNow, fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { chainDataset, type OptionChain, type OptionContract } from "./chain.js";

const BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options";
export const SOURCE = "cboe";
/** Cash-settled index option roots CBOE lists under a leading underscore. */
const INDEX_ROOTS = new Set(["SPX", "XSP", "NDX", "RUT", "VIX", "DJX", "OEX", "XEO", "MXEA", "MXEF"]);

/** The CBOE file name for a user symbol: AAPL → AAPL, SPX / ^SPX → _SPX. */
export function cboeSymbol(symbol: string): string {
  const s = symbol
    .toUpperCase()
    .trim()
    .replace(/^[\^$]/, "");
  if (s.startsWith("_")) return s;
  return INDEX_ROOTS.has(s) ? `_${s}` : s;
}

/** Parse an OCC option symbol: root, expiry, right, strike (AAPL261023C00110000 → AAPL 2026-10-23 call 110). */
export function parseOccSymbol(occ: string): { root: string; expiry: string; right: "call" | "put"; strike: number } | undefined {
  const m = /^([A-Z0-9.]{1,6}?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ.replace(/\s+/g, ""));
  if (!m) return undefined;
  return { root: m[1]!, expiry: `20${m[2]}-${m[3]}-${m[4]}`, right: m[5] === "C" ? "call" : "put", strike: Number(m[6]) / 1000 };
}

interface CboeOption {
  option: string;
  bid?: number;
  ask?: number;
  iv?: number;
  open_interest?: number;
  volume?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  last_trade_price?: number;
  theo?: number;
}

export interface CboeBody {
  timestamp?: string;
  symbol?: string;
  data?: {
    symbol?: string;
    current_price?: number;
    close?: number;
    prev_day_close?: number;
    iv30?: number;
    last_trade_time?: string;
    options?: CboeOption[];
  };
}

const num = (v: number | undefined) => (v === undefined || v === null || !Number.isFinite(v) ? undefined : v);
const pos = (v: number | undefined) => (num(v) !== undefined && v! > 0 ? v : undefined);

/** The contracts of a CBOE file. A zero IV (deep in the money, no quote) is "unknown", not 0 %. */
export function parseCboeOptions(options: readonly CboeOption[]): OptionContract[] {
  const out: OptionContract[] = [];
  for (const o of options) {
    const occ = parseOccSymbol(o.option);
    if (!occ) continue;
    const iv = pos(o.iv);
    out.push({
      contract: o.option,
      ...occ,
      ...(num(o.bid) !== undefined ? { bid: o.bid } : {}),
      ...(num(o.ask) !== undefined ? { ask: o.ask } : {}),
      ...(pos(o.last_trade_price) !== undefined ? { last: o.last_trade_price } : {}),
      ...(pos(o.theo) !== undefined ? { mark: o.theo } : {}),
      ...(iv !== undefined ? { iv: iv * 100 } : {}),
      ...(num(o.delta) !== undefined ? { delta: o.delta } : {}),
      ...(num(o.gamma) !== undefined ? { gamma: o.gamma } : {}),
      ...(num(o.theta) !== undefined ? { theta: o.theta } : {}),
      ...(num(o.vega) !== undefined ? { vega: o.vega } : {}),
      openInterest: num(o.open_interest) ?? 0,
      volume: num(o.volume) ?? 0,
    });
  }
  return out;
}

/** The whole delayed chain of an underlying, typed. */
export async function cboeChain(symbol: string): Promise<OptionChain & { iv30?: number }> {
  const file = cboeSymbol(symbol);
  const url = `${BASE}/${file}.json`;
  const res = await fetchJson<CboeBody>(url, { maxBytes: 64 * 1024 * 1024, timeoutMs: 60_000 });
  if (!res.ok || !res.data?.data) {
    if (res.status === 403 || res.status === 404) throw new ProviderError(SOURCE, `CBOE lists no options on ${symbol} (${file})`, 404);
    throw new ProviderError(SOURCE, `option chain for ${file} failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  }
  const d = res.data.data;
  const contracts = parseCboeOptions(d.options ?? []);
  const price = num(d.current_price) ?? num(d.close);
  if (!contracts.length || price === undefined) throw new ProviderError(SOURCE, `CBOE's file for ${file} holds no contracts`, 404);
  const underlying = file.replace(/^_/, "");
  const session = d.last_trade_time?.slice(0, 10) ?? res.fetchedAt.slice(0, 10);
  return {
    underlying,
    underlyingPrice: price,
    strikeCurrency: "USD",
    premiumCurrency: "USD",
    asOf: session,
    contracts,
    ...(pos(d.iv30) !== undefined ? { iv30: d.iv30 } : {}),
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "15min", official: true, asOf: session },
    notes: [
      `CBOE delayed quotes (15 minutes); file stamped ${res.data.timestamp ?? "without a time"} (US Eastern, as published)`,
      "premiums per share; one contract is usually 100 shares",
    ],
  };
}

/** The chain summarised per expiry (ATM IV, put/call ratios, OI), with CBOE's 30-day IV index. */
export async function cboeOptions(symbol: string, opts: { now?: Date; maxExpiries?: number } = {}): Promise<{ dataset: Dataset; chain: OptionChain }> {
  const chain = await cboeChain(symbol);
  const dataset = chainDataset(chain, SOURCE, opts.now ?? clockNow(), opts.maxExpiries);
  if (chain.iv30 !== undefined)
    dataset.points.splice(1, 0, {
      key: `${chain.underlying}.opt.iv30`,
      label: `${chain.underlying} 30-day implied volatility (CBOE)`,
      value: chain.iv30,
      unit: "%",
      asOf: chain.asOf,
    });
  return { dataset, chain };
}
