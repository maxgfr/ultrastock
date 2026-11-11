// Everything the risk gate needs, gathered from the source of truth: the
// profile (limits), the ledger (positions and cash, marked to market), the
// tickets (pending orders), the audit (orders today), the equity curve
// (breaker) and a fresh quote.
import { mapLimit } from "../engine.js";
import { clockNow, netMode } from "../core/net.js";
import { loadProfile, type Profile } from "../core/profile.js";
import { buildBook, readLedger, valueBook } from "../portfolio/ledger.js";
import { ecbFx } from "../providers/macro/ecb.js";
import { frankfurterLatest } from "../providers/macro/frankfurter.js";
import { knownSector } from "../analyze/portfolio/risk.js";
import { tvTicker } from "../analyze/portfolio/run-risk.js";
import { cachedJson, TTL } from "../core/cache.js";
import { tradingviewSnapshot } from "../providers/markets/tradingview.js";
import { getQuote, resolveSymbol } from "../providers/router.js";
import type { Instrument, QuoteResult } from "../providers/types.js";
import { parsePredictionSymbol, predictionQuote } from "./prediction.js";
import { breakerState, closedTradeResults, netContributed, readEquity, recordEquity } from "./breaker.js";
import type { GateContext, Order } from "./riskgate.js";
import { listTickets, readAudit, type Ticket } from "./tickets.js";

/** Stablecoins are priced as their dollar: said in the notes. */
const AS_USD = new Set(["USDT", "USDC", "FDUSD"]);

/** Units of `base` per one unit of each currency (ECB reference rates, Frankfurter as fallback). */
export async function fxToBase(currencies: readonly string[], base: string): Promise<{ rates: Record<string, number>; notes: string[] }> {
  const notes: string[] = [];
  const want = [...new Set(currencies.map((c) => (AS_USD.has(c) ? "USD" : c)).filter((c) => c !== base))];
  const rates: Record<string, number> = { [base]: 1 };
  if (currencies.some((c) => AS_USD.has(c))) notes.push("stablecoin amounts converted at the US dollar rate");
  if (!want.length) return { rates, notes };
  if (base !== "EUR") throw new Error(`only a EUR base currency is supported for now (profile says ${base})`);
  const ds = await ecbFx(want).catch(() => frankfurterLatest("EUR", want));
  for (const p of ds.points) {
    const m = /\.fx\.([A-Z]{3})$/.exec(p.key);
    if (m && typeof p.value === "number" && p.value > 0) rates[m[1]!] = 1 / p.value;
  }
  for (const c of currencies) if (AS_USD.has(c) && rates.USD) rates[c] = rates.USD;
  for (const c of want) if (!rates[c]) notes.push(`no ${c}→${base} rate`);
  return { rates, notes };
}

/** The book an order's venue settles in: paper orders in "paper", every live venue in the one "real" book. */
const bookOf = (venue: string): string => (venue === "paper" ? "paper" : "real");

/**
 * The buys that will still draw on `book`: checked and not yet sent, working on
 * paper, or sent to a venue and not yet filled. Every live venue settles in the
 * same book, so an order waiting at one venue counts against the next order at
 * another; a testnet or validate-only order moves no money and is left out.
 */
export function pendingBuys(tickets: readonly Ticket[], book: string, ticketId?: string): Ticket[] {
  return tickets.filter(
    (t) =>
      t.id !== ticketId &&
      t.order.side === "buy" &&
      bookOf(t.order.venue) === book &&
      (t.status === "working" || t.status === "checked" || (t.status === "submitted" && (t as { live?: { env?: string } }).live?.env !== "test")),
  );
}

type Trail = ReadonlyArray<Record<string, unknown> & { at: string }>;

/** The key of one attempt to send a ticket to a venue: the ticket and the client order id of that attempt. */
export const attemptKey = (e: Record<string, unknown>): string => `${String(e.ticket)}|${String(e.clientOrderId)}`;

/**
 * The attempts that placed no order, from the audit trail: refused by the
 * venue, stopped by the kill switch between the intent and the send, or
 * declared never placed by the user. They moved no money. An attempt whose
 * answer was lost (unknown) is not among them: it may be working at the venue.
 */
export function unplacedAttempts(trail: Trail): Set<string> {
  const out = new Set<string>();
  for (const e of trail)
    if (((e.event === "live-result" || e.event === "live-reconcile") && e.state === "rejected") || e.event === "live-not-sent" || e.event === "live-not-placed")
      out.add(attemptKey(e));
  return out;
}

/**
 * The orders placed in `book` today (UTC), from the audit trail. An order sent
 * to a venue counts once per attempt, by the environment of that attempt: a
 * ticket tried on a testnet (or a validate-only endpoint, which moves no money)
 * and then sent for real is one real order, and an attempt that placed nothing
 * (refused by the venue, never sent) is none. A paper order counts once per
 * ticket that reached working or filled today: it moves several times and is
 * still one order. An order in another book does not count.
 */
export function ordersToday(trail: Trail, book: string, now: Date): number {
  const today = now.toISOString().slice(0, 10);
  const sentToVenue = new Set(trail.filter((e) => e.event === "live-intent").map((e) => String(e.ticket)));
  const unplaced = unplacedAttempts(trail);
  const attempts = new Set<string>();
  const ids = new Set<string>();
  for (const e of trail) {
    if (!e.at.startsWith(today)) continue;
    if (e.event === "live-intent") {
      if (e.env !== "test" && bookOf(String(e.venue)) === book && !unplaced.has(attemptKey(e))) attempts.add(attemptKey(e));
      continue;
    }
    if (e.event !== "ticket" || !(e.to === "filled" || e.to === "submitted" || e.to === "working")) continue;
    const venue = (e.order as { venue?: string } | undefined)?.venue;
    if (venue === undefined || bookOf(venue) !== book || sentToVenue.has(String(e.id))) continue;
    ids.add(String(e.id));
  }
  return attempts.size + ids.size;
}

/**
 * The sector of a listed share, in TradingView's classification (the one the
 * portfolio risk report uses), or undefined when it cannot be told. Kept a
 * week: a company rarely changes sector.
 */
export type SectorLookup = (symbol: string, instrument: Instrument) => Promise<string | undefined>;

export const tradingviewSector: SectorLookup = async (symbol, instrument) => {
  const ticker = tvTicker({ symbol, instrument });
  if (!ticker) return undefined;
  const label = await cachedJson<string>(`gate:sector:${ticker}`, TTL.reference, async () => {
    const ds = await tradingviewSnapshot(ticker, { columns: ["sector"] });
    return knownSector(ds.points.find((p) => p.key.endsWith(".tv.sector"))?.value);
  });
  return label;
};

export interface BuiltContext {
  ctx: GateContext;
  quote: QuoteResult;
  profile: Profile;
  notes: string[];
  equityBase: number;
}

/**
 * The gate context for `order`, against the `book` ("paper" or "real"). Records an equity snapshot.
 * `ticketId` names the ticket being re-checked, so its own order is not also counted as pending.
 */
export async function gateContextFor(
  order: Order,
  opts: { book?: string; now?: Date; events?: string[]; ticketId?: string; sectorOf?: SectorLookup } = {},
): Promise<BuiltContext> {
  const now = opts.now ?? clockNow();
  const bookName = opts.book ?? (order.venue === "paper" ? "paper" : "real");
  const profile = loadProfile();
  if (!profile) throw new Error("no profile: run `ultrastock profile init` and `profile suitability` first — the gate enforces the profile's limits");
  // What a reader had to skip (a line a crash cut short) is said with the check.
  const notes: string[] = [];
  const warn = (m: string) => void notes.push(m);
  const txs = readLedger(bookName, warn);
  const book = buildBook(txs);
  const held = book.positions.filter((p) => p.quantity > 0);
  const contract = parsePredictionSymbol(order.symbol);
  const resolved = contract ? undefined : await resolveSymbol(order.symbol);
  const quote = contract ? await predictionQuote(order.symbol) : await getQuote(resolved!, now);
  const symbols = [...new Set(held.map((p) => p.symbol))].filter((s) => s !== order.symbol).slice(0, 40);
  const prices: Record<string, number> = { [order.symbol]: quote.price };
  const kinds: Record<string, string> = { [order.symbol]: resolved?.instrument.market ?? "prediction" };
  const instruments: Record<string, Instrument> = resolved ? { [order.symbol]: resolved.instrument } : {};
  await mapLimit(symbols, 4, async (s) => {
    try {
      if (parsePredictionSymbol(s)) {
        prices[s] = (await predictionQuote(s)).price;
        kinds[s] = "prediction";
        return;
      }
      const r = await resolveSymbol(s);
      prices[s] = (await getQuote(r, now)).price;
      kinds[s] = r.instrument.market;
      instruments[s] = r.instrument;
    } catch (e) {
      notes.push(`could not price ${s}: ${(e as Error).message}`);
    }
  });
  const fx = await fxToBase([...held.map((p) => p.currency), ...book.cash.map((c) => c.currency), order.currency], profile.baseCurrency);
  notes.push(...fx.notes);
  const valued = valueBook(book, prices, fx.rates, profile.baseCurrency);
  notes.push(...valued.missing.map((m) => `missing ${m}: the portfolio total is understated`));
  if (!(valued.totalBase > 0))
    throw new Error(`the ${bookName} book is empty — record a deposit first (\`ultrastock portfolio deposit <account> <amount> --book ${bookName}\`)`);
  // A replayed fixture is not the market, and its clock is the recording's: the equity curve the breaker reads is the
  // real book's history, and a point stamped with a replayed (or invented) time would move its reference points.
  if (netMode().kind === "live") recordEquity(bookName, valued.totalBase, now, netContributed(txs, fx.rates, profile.baseCurrency));
  else notes.push("replaying a fixture: the equity curve is not written");
  const rate = fx.rates[order.currency] ?? (order.currency === profile.baseCurrency ? 1 : Number.NaN);
  if (!Number.isFinite(rate)) throw new Error(`no ${order.currency}→${profile.baseCurrency} rate: cannot size the order`);
  const pending = pendingBuys(listTickets(), bookName, opts.ticketId);
  const pendingBuysBase: Record<string, number> = {};
  for (const t of pending)
    pendingBuysBase[t.order.symbol] = (pendingBuysBase[t.order.symbol] ?? 0) + t.order.quantity * t.order.price * (fx.rates[t.order.currency] ?? 1);
  // The sector cap: what the book (and the buys still to be paid) already holds in the order's sector, shares only.
  let sector = order.sector;
  let sectorValueBase: number | undefined;
  let sectorUnknown: string[] = [];
  if (order.assetKind === "equity" && order.side === "buy") {
    const sectorOf = opts.sectorOf ?? tradingviewSector;
    const ask = async (s: string) => {
      const i = instruments[s] ?? (await resolveSymbol(s).then((r) => r.instrument));
      return i?.kind === "equity" ? sectorOf(s, i) : undefined;
    };
    sector ??= await ask(order.symbol).catch(() => undefined);
    if (!sector) notes.push(`${order.symbol}: no sector found — the sector limit (${profile.limits.maxSectorPct} %) is not checked for this order`);
    else {
      const others = [...new Set([...held.map((p) => p.symbol), ...Object.keys(pendingBuysBase)])].filter((s) => s !== order.symbol && kinds[s] !== "crypto");
      // A share with no sector to be found (the lookup failed, or found none) may be in this one; a fund or a coin is not
      // a share and has none to find.
      const sectors = await mapLimit(others, 4, async (s): Promise<string | null | undefined> => {
        try {
          const i = instruments[s] ?? (await resolveSymbol(s)).instrument;
          return i?.kind === "equity" ? await sectorOf(s, i) : null;
        } catch {
          return undefined;
        }
      });
      const unknown = others.filter((_, i) => sectors[i] === undefined);
      sectorUnknown = unknown;
      const same = new Set([order.symbol, ...others.filter((_, i) => sectors[i] === sector)]);
      sectorValueBase =
        valued.positions.filter((v) => same.has(v.symbol)).reduce((t, v) => t + (v.valueBase ?? 0), 0) +
        // Pending buys of the order's own symbol too: they are the same share, in the same sector (the ticket being re-checked is not among them).
        Object.entries(pendingBuysBase)
          .filter(([s]) => same.has(s))
          .reduce((t, [, v]) => t + v, 0);
      if (unknown.length) notes.push(`sector unknown for ${unknown.join(", ")}: not counted in ${sector}`);
    }
  }
  const eod = quote.provenance.delay === "eod" || /^\d{4}-\d{2}-\d{2}$/.test(quote.at);
  const ctx: GateContext = {
    profile,
    equityBase: valued.totalBase,
    cashBase: valued.cashBase,
    fxToBase: rate,
    positionValueBase: valued.positions.filter((v) => v.symbol === order.symbol).reduce((s, v) => s + (v.valueBase ?? 0), 0),
    heldQuantity: held.find((p) => p.symbol === order.symbol && p.account === order.account)?.quantity ?? 0,
    ...(sector ? { sector } : {}),
    ...(sectorValueBase !== undefined ? { sectorValueBase } : {}),
    ...(sectorUnknown.length ? { sectorUnknown } : {}),
    cryptoValueBase: valued.positions.filter((v) => kinds[v.symbol] === "crypto").reduce((s, v) => s + (v.valueBase ?? 0), 0),
    openSymbols: [...new Set([...held.map((p) => p.symbol), ...Object.keys(pendingBuysBase)])],
    pendingBuysBase,
    ordersToday: ordersToday(readAudit(warn), bookName, now),
    lastPrice: quote.price,
    // End-of-day data is "fresh" for its last session: allow a long weekend.
    quoteAt: eod ? `${quote.at.slice(0, 10)}T23:59:59Z` : quote.at,
    now,
    maxQuoteAgeMs: eod ? 4 * 86_400_000 : 15 * 60_000,
    breaker: breakerState(readEquity(bookName, warn), closedTradeResults(txs), profile.limits, now),
    events: opts.events,
  };
  if (eod) notes.push(`${order.symbol}: end-of-day prices — the order is checked against the last official close of ${quote.at.slice(0, 10)}`);
  return { ctx, quote, profile, notes, equityBase: valued.totalBase };
}
