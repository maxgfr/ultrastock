// Everything the risk gate needs, gathered from the source of truth: the
// profile (limits), the ledger (positions and cash, marked to market), the
// tickets (pending orders), the audit (orders today), the equity curve
// (breaker) and a fresh quote.
import { mapLimit } from "../engine.js";
import { clockNow } from "../core/net.js";
import { loadProfile, type Profile } from "../core/profile.js";
import { buildBook, readLedger, valueBook } from "../portfolio/ledger.js";
import { ecbFx } from "../providers/macro/ecb.js";
import { frankfurterLatest } from "../providers/macro/frankfurter.js";
import { getQuote, resolveSymbol } from "../providers/router.js";
import type { QuoteResult } from "../providers/types.js";
import { breakerState, closedTradeResults, readEquity, recordEquity } from "./breaker.js";
import type { GateContext, Order } from "./riskgate.js";
import { listTickets, readAudit } from "./tickets.js";

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

export interface BuiltContext {
  ctx: GateContext;
  quote: QuoteResult;
  profile: Profile;
  notes: string[];
  equityBase: number;
}

/** The gate context for `order`, against the `book` ("paper" or "real"). Records an equity snapshot. */
export async function gateContextFor(order: Order, opts: { book?: string; now?: Date; events?: string[] } = {}): Promise<BuiltContext> {
  const now = opts.now ?? clockNow();
  const bookName = opts.book ?? (order.venue === "paper" ? "paper" : "real");
  const profile = loadProfile();
  if (!profile) throw new Error("no profile: run `ultrastock profile init` and `profile suitability` first — the gate enforces the profile's limits");
  const txs = readLedger(bookName);
  const book = buildBook(txs);
  const held = book.positions.filter((p) => p.quantity > 0);
  const resolved = await resolveSymbol(order.symbol);
  const quote = await getQuote(resolved, now);
  const symbols = [...new Set(held.map((p) => p.symbol))].filter((s) => s !== order.symbol).slice(0, 40);
  const notes: string[] = [];
  const prices: Record<string, number> = { [order.symbol]: quote.price };
  const kinds: Record<string, string> = { [order.symbol]: resolved.instrument.market };
  await mapLimit(symbols, 4, async (s) => {
    try {
      const r = await resolveSymbol(s);
      prices[s] = (await getQuote(r, now)).price;
      kinds[s] = r.instrument.market;
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
  recordEquity(bookName, valued.totalBase, now);
  const rate = fx.rates[order.currency] ?? (order.currency === profile.baseCurrency ? 1 : Number.NaN);
  if (!Number.isFinite(rate)) throw new Error(`no ${order.currency}→${profile.baseCurrency} rate: cannot size the order`);
  const pending = listTickets((t) => (t.status === "working" || t.status === "checked") && t.order.side === "buy" && t.order.venue === order.venue);
  const pendingBuysBase: Record<string, number> = {};
  for (const t of pending)
    pendingBuysBase[t.order.symbol] = (pendingBuysBase[t.order.symbol] ?? 0) + t.order.quantity * t.order.price * (fx.rates[t.order.currency] ?? 1);
  const today = now.toISOString().slice(0, 10);
  const ordersToday = readAudit().filter(
    (e) => e.at.startsWith(today) && e.event === "ticket" && (e.to === "filled" || e.to === "submitted" || e.to === "working"),
  ).length;
  const eod = quote.provenance.delay === "eod" || /^\d{4}-\d{2}-\d{2}$/.test(quote.at);
  const ctx: GateContext = {
    profile,
    equityBase: valued.totalBase,
    cashBase: valued.cashBase,
    fxToBase: rate,
    positionValueBase: valued.positions.filter((v) => v.symbol === order.symbol).reduce((s, v) => s + (v.valueBase ?? 0), 0),
    heldQuantity: held.find((p) => p.symbol === order.symbol && p.account === order.account)?.quantity ?? 0,
    cryptoValueBase: valued.positions.filter((v) => kinds[v.symbol] === "crypto").reduce((s, v) => s + (v.valueBase ?? 0), 0),
    openSymbols: [...new Set([...held.map((p) => p.symbol), ...Object.keys(pendingBuysBase)])],
    pendingBuysBase,
    ordersToday,
    lastPrice: quote.price,
    // End-of-day data is "fresh" for its last session: allow a long weekend.
    quoteAt: eod ? `${quote.at.slice(0, 10)}T23:59:59Z` : quote.at,
    now,
    maxQuoteAgeMs: eod ? 4 * 86_400_000 : 15 * 60_000,
    breaker: breakerState(readEquity(bookName), closedTradeResults(txs), profile.limits, now),
    events: opts.events,
  };
  if (eod) notes.push(`${order.symbol}: end-of-day prices — the order is checked against the last official close of ${quote.at.slice(0, 10)}`);
  return { ctx, quote, profile, notes, equityBase: valued.totalBase };
}
