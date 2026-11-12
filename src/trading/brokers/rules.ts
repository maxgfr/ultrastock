// A venue's price and quantity grid for one instrument, read live from the
// venue (never written here: tick sizes, lot steps and minimums change, and
// differ per pair):
//
//   binance   GET /api/v3/exchangeInfo?symbol=…           PRICE_FILTER tickSize, LOT_SIZE stepSize/minQty/maxQty, NOTIONAL|MIN_NOTIONAL minNotional
//   kraken    GET /0/public/AssetPairs?pair=…             tick_size (else pair_decimals), lot_decimals, ordermin, costmin, status
//   coinbase  GET /api/v3/brokerage/market/products/<id>  price_increment (else quote_increment), base_increment, base_min_size, base_max_size, quote_min_size
//   ibkr      POST /iserver/contract/rules {conid, isBuy}  incrementRules [{lowerEdge, increment}] (else increment), sizeIncrement — through the pinned gateway
//   kalshi    GET /trade-api/v2/markets/<ticker>          price_ranges [{start, end, step}] (else tick_size in cents), fractional_trading_enabled
//
// What this module decides, and in which direction it rounds (a buy plan):
//   entry (buy limit)        down to the tick: never a price above the one planned
//   stop (sell stop, long)   down to the tick: the risk per unit is never understated, so the size is never overstated
//   targets (sell limits)    down to the tick: the reward is never overstated
//   quantity                 down to the step: never more than the limits allow; under the minimum → no order
// A sell limit placed later (an exit) rounds UP for the same reason: never a price below the one decided.
//
// `broker preview` and `broker submit` refuse an order off the grid or under a
// minimum with a named code (`gridRefusals`): ultrastock does not round an order
// the user approved — it is the planned numbers or nothing.
import { fetchText } from "../../core/net.js";
import { plainDecimal } from "./http.js";
import type { HttpFn } from "./types.js";

export interface InstrumentRules {
  venue: string;
  /** The venue's own symbol (BTCUSDT, XBTEUR, BTC-EUR, a conid, TICKER:YES). */
  symbol: string;
  /** The price grid, by band: from `from` (inclusive) up, a limit price is a multiple of `tick`. One band from 0 for most. */
  ticks: Array<{ from: number; tick: number }>;
  /** Quantity grid: a quantity is a multiple of it. */
  step?: number;
  minQuantity?: number;
  maxQuantity?: number;
  /** In the quote currency: price × quantity at least this. */
  minNotional?: number;
  /** False when the venue says the instrument takes no new limit order now (halted, cancel-only…). */
  tradable: boolean;
  /** The venue's own word for the status. */
  status?: string;
  /** Where the rules were read, and when. */
  source: string;
  at: string;
}

export type GridCode = "GRID_PRICE" | "GRID_QUANTITY" | "MIN_QUANTITY" | "MAX_QUANTITY" | "MIN_NOTIONAL" | "NOT_TRADING" | "GRID_UNKNOWN";

/** The decimals of a step written as a plain decimal (0.00001 → 5, 0.5 → 1, 1 → 0). */
export function decimalsOf(x: number): number {
  const s = plainDecimal(x);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/** `x` on the grid of `step`, rounded the way asked, without floating-point residue (365.95, not 365.95000000000005). */
export function snap(x: number, step: number, dir: "down" | "up" | "nearest"): number {
  if (!(step > 0)) throw new RangeError(`a grid step is > 0 (got ${step})`);
  const n = x / step;
  const tol = 1e-9 * Math.max(1, Math.abs(n));
  const k = dir === "down" ? Math.floor(n + tol) : dir === "up" ? Math.ceil(n - tol) : Math.round(n);
  return Number((k * step).toFixed(Math.min(20, decimalsOf(step))));
}

/** Whether `x` is a whole number of `step`s (within float noise). */
export function onGrid(x: number, step: number): boolean {
  const n = x / step;
  return Math.abs(n - Math.round(n)) <= 1e-9 * Math.max(1, Math.abs(n));
}

/** The tick that applies at `price` (the band it falls in); undefined when the venue gave none. */
export function tickAt(r: Pick<InstrumentRules, "ticks">, price: number): number | undefined {
  let t: number | undefined;
  for (const b of [...r.ticks].sort((x, y) => x.from - y.from)) if (price + 1e-12 >= b.from) t = b.tick;
  return t;
}

/** Every reason an order at `price` for `quantity` is off the venue's grid or under its minimums; empty when it fits. */
export function gridRefusals(r: InstrumentRules, o: { price: number; quantity: number }): Array<{ code: GridCode; reason: string }> {
  const out: Array<{ code: GridCode; reason: string }> = [];
  const at = `${r.venue} ${r.symbol}`;
  if (!r.tradable) out.push({ code: "NOT_TRADING", reason: `${at} takes no limit order now (status ${r.status ?? "unknown"}, ${r.source})` });
  const tick = tickAt(r, o.price);
  if (tick === undefined) out.push({ code: "GRID_UNKNOWN", reason: `${r.source} gives no price tick for ${at}: the limit cannot be checked against the grid` });
  else if (!onGrid(o.price, tick))
    out.push({
      code: "GRID_PRICE",
      reason: `the limit ${o.price} is not on ${at}'s price grid (tick ${plainDecimal(tick)}): ${snap(o.price, tick, "down")} or ${snap(o.price, tick, "up")} — plan it again`,
    });
  if (r.step !== undefined && r.step > 0 && !onGrid(o.quantity, r.step))
    out.push({
      code: "GRID_QUANTITY",
      reason: `the quantity ${o.quantity} is not a multiple of ${at}'s step ${plainDecimal(r.step)} (${snap(o.quantity, r.step, "down")} fits) — plan it again`,
    });
  if (r.minQuantity !== undefined && o.quantity + 1e-12 < r.minQuantity)
    out.push({ code: "MIN_QUANTITY", reason: `the quantity ${o.quantity} is under ${at}'s minimum ${plainDecimal(r.minQuantity)}` });
  if (r.maxQuantity !== undefined && r.maxQuantity > 0 && o.quantity > r.maxQuantity + 1e-12)
    out.push({ code: "MAX_QUANTITY", reason: `the quantity ${o.quantity} is above ${at}'s maximum ${plainDecimal(r.maxQuantity)}` });
  if (r.minNotional !== undefined && o.price * o.quantity + 1e-9 < r.minNotional)
    out.push({
      code: "MIN_NOTIONAL",
      reason: `the order is worth ${plainDecimal(Number((o.price * o.quantity).toFixed(8)))} — under ${at}'s minimum order value ${plainDecimal(r.minNotional)}`,
    });
  return out;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : undefined;
};
const positive = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};
const json = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};
const fail = (venue: string, what: string): never => {
  throw new Error(`${venue}: ${what}`);
};

interface Read {
  http: HttpFn;
  timeoutMs: number;
  at: string;
}

// --- Binance -----------------------------------------------------------------------

/** One symbol of Binance's exchangeInfo as rules. */
export function parseBinanceRules(body: unknown, symbol: string, source: string, at: string): InstrumentRules {
  const s = (body as { symbols?: Array<{ symbol?: string; status?: string; filters?: Array<Record<string, unknown>> }> })?.symbols?.find(
    (x) => x.symbol === symbol,
  );
  if (!s) return fail("binance", `exchangeInfo lists no ${symbol}`);
  const filter = (t: string) => s.filters?.find((f) => f.filterType === t);
  const price = filter("PRICE_FILTER");
  const lot = filter("LOT_SIZE");
  const notional = filter("NOTIONAL") ?? filter("MIN_NOTIONAL");
  const tick = positive(price?.tickSize);
  return {
    venue: "binance",
    symbol,
    ticks: tick ? [{ from: 0, tick }] : [],
    step: positive(lot?.stepSize),
    minQuantity: positive(lot?.minQty),
    maxQuantity: positive(lot?.maxQty),
    minNotional: positive(notional?.minNotional),
    tradable: s.status === "TRADING",
    status: s.status,
    source,
    at,
  };
}

export async function binanceRules(base: string, symbol: string, r: Read): Promise<InstrumentRules> {
  const url = `${base}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`;
  const res = await r.http({ method: "GET", url, timeoutMs: r.timeoutMs });
  if (res.status !== 200) fail("binance", `exchangeInfo for ${symbol} answered HTTP ${res.status}`);
  return parseBinanceRules(json(res.body), symbol, url, r.at);
}

// --- Kraken ------------------------------------------------------------------------

/** Kraken's AssetPairs entry (keyed by its own name, XXBTZEUR for XBTEUR: the only entry is taken) as rules. */
export function parseKrakenRules(body: unknown, symbol: string, source: string, at: string): InstrumentRules {
  const b = body as { error?: string[]; result?: Record<string, Record<string, unknown>> };
  if (b?.error?.length) fail("kraken", `AssetPairs ${symbol}: ${b.error.join("; ")}`);
  const entries = Object.entries(b?.result ?? {});
  const hit = entries.find(([k, v]) => k === symbol || v.altname === symbol) ?? (entries.length === 1 ? entries[0] : undefined);
  if (!hit) return fail("kraken", `AssetPairs lists no ${symbol}`);
  const p = hit[1];
  const pairDecimals = num(p.pair_decimals);
  const lotDecimals = num(p.lot_decimals);
  const tick = positive(p.tick_size) ?? (pairDecimals !== undefined ? 10 ** -pairDecimals : undefined);
  const status = typeof p.status === "string" ? p.status : undefined;
  return {
    venue: "kraken",
    symbol,
    ticks: tick ? [{ from: 0, tick: Number(tick.toPrecision(12)) }] : [],
    step: lotDecimals !== undefined ? Number((10 ** -lotDecimals).toPrecision(12)) : undefined,
    minQuantity: positive(p.ordermin),
    minNotional: positive(p.costmin),
    // "online" and "limit_only" take a limit order; "cancel_only", "post_only", "reduce_only" and "delisted" do not take ours.
    tradable: status === undefined || status === "online" || status === "limit_only",
    status,
    source,
    at,
  };
}

export async function krakenRules(symbol: string, r: Read): Promise<InstrumentRules> {
  const url = `https://api.kraken.com/0/public/AssetPairs?pair=${encodeURIComponent(symbol)}`;
  const res = await r.http({ method: "GET", url, timeoutMs: r.timeoutMs });
  if (res.status !== 200) fail("kraken", `AssetPairs for ${symbol} answered HTTP ${res.status}`);
  return parseKrakenRules(json(res.body), symbol, url, r.at);
}

// --- Coinbase ----------------------------------------------------------------------

export function parseCoinbaseRules(body: unknown, symbol: string, source: string, at: string): InstrumentRules {
  const p = body as Record<string, unknown> | undefined;
  if (!p || (p.product_id !== undefined && p.product_id !== symbol)) return fail("coinbase", `no product ${symbol}`);
  const tick = positive(p.price_increment) ?? positive(p.quote_increment);
  const disabled = p.trading_disabled === true || p.is_disabled === true || p.cancel_only === true || p.view_only === true;
  const status = typeof p.status === "string" ? p.status : undefined;
  return {
    venue: "coinbase",
    symbol,
    ticks: tick ? [{ from: 0, tick }] : [],
    step: positive(p.base_increment),
    minQuantity: positive(p.base_min_size),
    maxQuantity: positive(p.base_max_size),
    minNotional: positive(p.quote_min_size),
    tradable: !disabled && (status === undefined || status === "online"),
    status: disabled ? `${status ?? "?"} (trading disabled)` : status,
    source,
    at,
  };
}

export async function coinbaseRules(symbol: string, r: Read): Promise<InstrumentRules> {
  // Public: no JWT, no key on the wire for a product's rules.
  const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(symbol)}`;
  const res = await r.http({ method: "GET", url, timeoutMs: r.timeoutMs });
  if (res.status !== 200) fail("coinbase", `product ${symbol} answered HTTP ${res.status}`);
  return parseCoinbaseRules(json(res.body), symbol, url, r.at);
}

// --- IBKR --------------------------------------------------------------------------

/** The answer of POST /iserver/contract/rules (or the `rules` of info-and-rules) as rules. */
export function parseIbkrRules(body: unknown, conid: string, source: string, at: string): InstrumentRules {
  const b = body as Record<string, unknown> | undefined;
  const rules = ((b?.rules as Record<string, unknown> | undefined) ?? b) as Record<string, unknown> | undefined;
  if (!rules || typeof rules !== "object") return fail("ibkr", `no contract rules for conid ${conid}`);
  if (typeof rules.error === "string" && rules.error) fail("ibkr", `contract rules for conid ${conid}: ${rules.error}`);
  const bands = Array.isArray(rules.incrementRules)
    ? (rules.incrementRules as Array<Record<string, unknown>>)
        .map((x) => ({ from: num(x.lowerEdge) ?? 0, tick: positive(x.increment) }))
        .filter((x): x is { from: number; tick: number } => x.tick !== undefined)
    : [];
  const flat = positive(rules.increment);
  const ticks = bands.length ? bands : flat ? [{ from: 0, tick: flat }] : [];
  const step = positive(rules.sizeIncrement);
  return { venue: "ibkr", symbol: conid, ticks, step, minQuantity: step, tradable: true, source, at };
}

export async function ibkrRules(base: string, conid: string, r: Read): Promise<InstrumentRules> {
  const url = `${base}/iserver/contract/rules`;
  const res = await r.http({
    method: "POST",
    url,
    headers: { "Content-Type": "application/json", "User-Agent": "ultrastock" },
    body: JSON.stringify({ conid: Number(conid), isBuy: true }),
    timeoutMs: r.timeoutMs,
  });
  if (res.status !== 200) fail("ibkr", `contract rules for conid ${conid} answered HTTP ${res.status}`);
  return parseIbkrRules(json(res.body), conid, "IBKR gateway /iserver/contract/rules", r.at);
}

// --- Kalshi ------------------------------------------------------------------------

/**
 * A Kalshi market's grid for one outcome. Prices are quoted on the YES book: a
 * NO price q sits at YES 1 − q, so a NO outcome's bands are the YES bands turned
 * around. Contracts are whole unless the market takes fractional trading (then
 * 0.01, the precision orders are sent at).
 */
export function parseKalshiRules(body: unknown, symbol: string, source: string, at: string): InstrumentRules {
  const m = (body as { market?: Record<string, unknown> })?.market;
  if (!m) return fail("kalshi", `no market for ${symbol}`);
  const outcome = /:NO$/i.test(symbol) ? "no" : "yes";
  const ranges = Array.isArray(m.price_ranges)
    ? (m.price_ranges as Array<Record<string, unknown>>)
        .map((x) => ({ start: num(x.start), end: num(x.end), step: positive(x.step) }))
        .filter((x): x is { start: number; end: number; step: number } => x.start !== undefined && x.end !== undefined && x.step !== undefined)
    : [];
  const legacy = positive(m.tick_size);
  let ticks: InstrumentRules["ticks"];
  if (ranges.length)
    ticks =
      outcome === "yes" ? ranges.map((x) => ({ from: x.start, tick: x.step })) : ranges.map((x) => ({ from: Number((1 - x.end).toFixed(6)), tick: x.step }));
  else ticks = legacy ? [{ from: 0, tick: legacy / 100 }] : [];
  const status = typeof m.status === "string" ? m.status : undefined;
  const step = m.fractional_trading_enabled === true ? 0.01 : 1;
  return {
    venue: "kalshi",
    symbol,
    ticks,
    step,
    minQuantity: step,
    tradable: status === undefined || status === "active" || status === "open",
    status,
    source,
    at,
  };
}

export async function kalshiRules(base: string, symbol: string, r: Read): Promise<InstrumentRules> {
  const ticker = symbol.split(":")[0]!;
  const url = `${base}/trade-api/v2/markets/${encodeURIComponent(ticker)}`;
  const res = await r.http({ method: "GET", url, timeoutMs: r.timeoutMs });
  if (res.status !== 200) fail("kalshi", `market ${ticker} answered HTTP ${res.status}`);
  return parseKalshiRules(json(res.body), symbol, url, r.at);
}

// --- Public reads for a plan --------------------------------------------------------

/** The process's HTTP layer (live, recorded or replayed) as an adapter transport: public GETs only. */
export const netHttp: HttpFn = async (req) => {
  if (req.method !== "GET") throw new Error("the public rules reader sends GET requests only");
  const res = await fetchText(req.url, { headers: req.headers, timeoutMs: req.timeoutMs, accept: "application/json" });
  return { status: res.status, body: res.body };
};

/**
 * The live venue's rules for a plan, read on its public endpoints — undefined
 * for IBKR, whose rules come through the user's gateway at preview and submit.
 */
export async function publicInstrumentRules(venue: string, symbol: string, opts: { http?: HttpFn; now?: Date } = {}): Promise<InstrumentRules | undefined> {
  const r: Read = { http: opts.http ?? netHttp, timeoutMs: 10_000, at: (opts.now ?? new Date()).toISOString() };
  if (venue === "binance") return binanceRules("https://api.binance.com", symbol, r);
  if (venue === "kraken") return krakenRules(symbol, r);
  if (venue === "coinbase") return coinbaseRules(symbol, r);
  if (venue === "kalshi") return kalshiRules("https://api.elections.kalshi.com", symbol, r);
  return undefined;
}
