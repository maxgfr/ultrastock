// Live execution: the one place a real order can leave ultrastock, and every
// condition it must meet first. `liveSubmit` refuses unless ALL hold:
//
//   1. env "live": ULTRASTOCK_LIVE=1, Node ≥ 22, the paper record is ready;
//      env "test" (Binance testnet, Kraken validate, Coinbase preview, IBKR
//      paper): none of those, but everything below.
//   2. the venue is switched on in the live limits, and allowed for the
//      profile's jurisdiction (a crypto platform must be an authorised MiCA
//      CASP serving that country: Binance is not, for France);
//   3. no kill switch, the breaker is not tripped;
//   4. the ticket is checked by the risk gate, unchanged since, within 15 min;
//   5. a limit order (no market orders live), spot, no short: a sell needs
//      the asset in the venue balance;
//   6. the order's notional fits the per-order and per-day limits of the
//      experience tier;
//   7. the key cannot withdraw (asked to the venue, or attested by the user);
//   8. the limit price is within 1 % of the venue's book right now;
//   9. a valid out-of-band code bound to this ticket's fingerprint.
//
// Then: a lock, an audit line BEFORE, exactly one request, an audit line
// AFTER. A timeout is "unknown": the ticket stays submitted and nothing is
// sent again until `reconcile` has asked the venue by clientOrderId.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkMica } from "../core/jurisdiction.js";
import { withFileLock } from "../core/lock.js";
import { homeDir } from "../core/paths.js";
import { loadProfile } from "../core/profile.js";
import { appendTransactions, readLedger } from "../portfolio/ledger.js";
import { splitPair } from "../tax/regime.js";
import { breakerState, closedTradeResults, readEquity } from "./breaker.js";
import type { BrokerAdapter, Environment, LiveOrder, OrderResult, Venue } from "./brokers/types.js";
import { fxToBase } from "./context.js";
import { effectiveLimits } from "./limits.js";
import { verifyCode } from "./otp.js";
import { readiness } from "./paper.js";
import { killSwitchPath, orderFingerprint } from "./riskgate.js";
import { audit, executionRefusal, loadTicket, readAudit, type Ticket, transition } from "./tickets.js";

export const VENUES: Venue[] = ["binance", "kraken", "coinbase", "ibkr"];
export const CRYPTO_VENUES: Venue[] = ["binance", "kraken", "coinbase"];
export const PRICE_BAND_PCT = 1;

export interface Refusal {
  code: string;
  reason: string;
}

/** The venue's symbol for an order's symbol (an IBKR conid must be given). */
export function venueSymbol(venue: Venue, symbol: string, currency: string, override?: string): string {
  if (override) return override;
  const { base, quote } = splitPair(symbol, currency);
  const q = quote ?? currency.toUpperCase();
  if (venue === "binance") return `${base}${q}`;
  if (venue === "kraken") return `${base === "BTC" ? "XBT" : base}${q}`;
  if (venue === "coinbase") return `${base}-${q}`;
  throw new Error("IBKR orders need the contract id: pass --conid (from the IBKR gateway's contract search)");
}

/** A stable clientOrderId per ticket and attempt (≤ 32 chars, [a-z0-9-]). */
export const clientOrderIdFor = (ticketId: string, attempt: number) => `us${createHash("sha256").update(ticketId).digest("hex").slice(0, 20)}-${attempt}`;

/** Live fills so far (the experience tier) and today's live notional. */
export function liveActivity(now = new Date()): { fills: number; todayNotional: number } {
  const day = now.toISOString().slice(0, 10);
  let fills = 0;
  let todayNotional = 0;
  for (const e of readAudit()) {
    if (e.event === "live-result" && e.env === "live" && (e.state === "filled" || e.state === "partially-filled")) fills++;
    if (e.event === "live-intent" && e.env === "live" && String(e.at).slice(0, 10) === day) todayNotional += Number(e.notional ?? 0);
  }
  return { fills, todayNotional };
}

export interface PreconditionInput {
  ticket: Ticket;
  venue: Venue;
  env: Environment;
  adapter: BrokerAdapter;
  venueSym: string;
  code?: string;
  now?: Date;
  /** For tests: skip the network-bound jurisdiction lookup with a fixed answer. */
  micaAuthorised?: boolean;
}

/** Every reason the order may not go now; empty when it may. */
export async function preconditions(p: PreconditionInput): Promise<{ refusals: Refusal[]; notional: number; book?: { bid: number; ask: number } }> {
  const now = p.now ?? new Date();
  const o = p.ticket.order;
  const R: Refusal[] = [];
  const no = (code: string, reason: string) => R.push({ code, reason });
  const profile = loadProfile();
  if (!profile) no("NO_PROFILE", "no investor profile: `ultrastock profile init` first");

  if (p.env === "live") {
    if (process.env.ULTRASTOCK_LIVE !== "1") no("LIVE_OFF", "live trading is off: the user sets ULTRASTOCK_LIVE=1 in their own shell to allow it");
    if (Number(process.versions.node.split(".")[0]) < 22) no("NODE", `live trading needs Node ≥ 22 (this is ${process.versions.node})`);
    const txs = readLedger("paper");
    const r = readiness(closedTradeResults(txs), readEquity("paper"), txs.find((t) => t.type === "buy")?.date, now);
    if (!r.ready)
      no(
        "NOT_READY",
        `the paper record is not ready: ${r.criteria
          .filter((c) => !c.pass)
          .map((c) => c.reason)
          .join("; ")}`,
      );
  }
  const { fills, todayNotional } = liveActivity(now);
  const { limits, tier } = effectiveLimits(fills, now);
  if (!limits.venues.includes(p.venue)) no("VENUE_OFF", `${p.venue} is not switched on for live orders (\`broker limits set --venues …\`)`);
  if (o.venue !== p.venue) no("VENUE_MISMATCH", `the ticket was planned for ${o.venue}, not ${p.venue}`);
  if (profile && CRYPTO_VENUES.includes(p.venue) && profile.jurisdiction !== "US") {
    let ok = p.micaAuthorised;
    if (ok === undefined) {
      try {
        ok = (await checkMica(p.venue, profile.jurisdiction)).authorised.length > 0;
      } catch {
        ok = false;
      }
    }
    if (!ok)
      no(
        "BLOCKED_JURISDICTION",
        `${p.venue} is not an authorised MiCA crypto-asset service provider for ${profile.jurisdiction} in ESMA's register: no live orders there`,
      );
  }
  if (existsSync(killSwitchPath())) no("KILL_SWITCH", `the kill switch is on (${killSwitchPath()})`);
  if (profile) {
    const book = p.env === "live" ? "real" : "live-test";
    const b = breakerState(readEquity(book), closedTradeResults(readLedger(book)), profile.limits, now);
    if (b.tripped) no("BREAKER", `circuit breaker: ${b.reason ?? "loss limit"}`);
  }
  const refusal = executionRefusal(p.ticket, now);
  if (refusal) no("TICKET", refusal);
  if (o.orderType !== "limit") no("MARKET_ORDER", "live orders are limit orders only");
  if (!["crypto", "equity", "etf"].includes(o.assetKind))
    no("ASSET", `${o.assetKind} is not tradable live in this version (spot shares, ETFs and crypto only)`);

  // Notional in the base currency against the tier's limits.
  let notional = o.quantity * o.price;
  if (profile && o.currency !== profile.baseCurrency) {
    const fx = await fxToBase([o.currency], profile.baseCurrency).catch(() => undefined);
    const rate = fx?.rates[o.currency];
    if (!rate) no("FX", `no ${o.currency}→${profile.baseCurrency} rate to size the order against the limits`);
    else notional *= rate;
  }
  if (notional > limits.maxOrder) no("ORDER_LIMIT", `the order is ${notional.toFixed(2)} — above the per-order limit ${limits.maxOrder} (tier "${tier}")`);
  if (todayNotional + notional > limits.maxDaily)
    no("DAILY_LIMIT", `today's live orders would reach ${(todayNotional + notional).toFixed(2)} — above the daily limit ${limits.maxDaily} (tier "${tier}")`);

  // The venue: withdrawal rights, holdings for a sell, the book.
  let book: { bid: number; ask: number } | undefined;
  try {
    const perms = await p.adapter.permissions();
    if (perms.canWithdraw) no("WITHDRAW_RIGHT", `this ${p.venue} key can withdraw funds: create a key with trading only`);
    if (perms.source === "attested" && !limits.attestedNoWithdraw.includes(p.venue))
      no("ATTEST", `${p.venue} cannot be asked about the key's rights: the user attests the key has no withdrawal right (\`broker attest ${p.venue}\`)`);
    if (!perms.canTrade) no("TRADE_RIGHT", `this ${p.venue} key cannot trade`);
    if (o.side === "sell") {
      const asset = p.venue === "ibkr" ? undefined : splitPair(o.symbol, o.currency).base;
      if (asset) {
        const bal = (await p.adapter.balances()).find((b) => b.asset.toUpperCase() === asset.toUpperCase());
        if (!bal || bal.free + 1e-12 < o.quantity)
          no("NO_SHORT", `selling ${o.quantity} ${asset} while ${bal?.free ?? 0} is free on ${p.venue}: no short selling`);
      }
    }
    const top = await p.adapter.bookTop(p.venueSym);
    book = { bid: top.bid, ask: top.ask };
    const ref = o.side === "buy" ? top.ask : top.bid;
    const off = (o.price / ref - 1) * 100;
    if ((o.side === "buy" && off > PRICE_BAND_PCT) || (o.side === "sell" && off < -PRICE_BAND_PCT) || Math.abs(off) > 10)
      no(
        "PRICE_BAND",
        `the limit ${o.price} is ${off.toFixed(2)} % from the ${o.side === "buy" ? "ask" : "bid"} ${ref} — outside the ${PRICE_BAND_PCT} % band`,
      );
  } catch (e) {
    no("VENUE", `${p.venue} could not be read: ${(e as Error).message}`);
  }

  if (!R.length || R.every((r) => r.code === "CODE")) {
    const v = verifyCode(p.ticket.id, orderFingerprint(o), p.code, now);
    if (!v.ok) no("CODE", v.reason);
  } else if (!p.code) no("CODE", "an out-of-band approval code is needed (`broker code <ticket>`), once the other conditions hold");
  return { refusals: R, notional, book };
}

export interface LiveRecord {
  venue: Venue;
  env: Environment;
  clientOrderId: string;
  venueSymbol: string;
  attempt: number;
  state: OrderResult["state"];
  venueOrderId?: string;
  at: string;
  message?: string;
}

const liveOf = (t: Ticket) => (t as Ticket & { live?: LiveRecord }).live;

/** Record a fill in the ledger (real book live, "live-test" book otherwise), once per ticket. */
async function bookFill(t: Ticket, r: OrderResult, rec: LiveRecord, now: Date): Promise<void> {
  if (!r.filledQuantity || !r.averagePrice) return;
  await appendTransactions(
    [
      {
        date: now.toISOString().slice(0, 19),
        type: t.order.side,
        account: t.order.account,
        symbol: t.order.symbol,
        quantity: r.filledQuantity,
        price: r.averagePrice,
        fee: r.feeCurrency && r.feeCurrency !== t.order.currency ? undefined : r.fee,
        currency: t.order.currency,
        note: `${rec.venue} ${rec.env} order ${r.venueOrderId ?? rec.clientOrderId}${r.fee && r.feeCurrency && r.feeCurrency !== t.order.currency ? ` (fee ${r.fee} ${r.feeCurrency})` : ""}`,
        origin: `ticket:${t.id}`,
      },
    ],
    rec.env === "live" ? "real" : "live-test",
  );
}

/** Apply a venue answer to the ticket (status, record, ledger). */
async function applyResult(t: Ticket, r: OrderResult, rec: LiveRecord, now: Date): Promise<Ticket> {
  const next: LiveRecord = { ...rec, state: r.state, venueOrderId: r.venueOrderId ?? rec.venueOrderId, at: now.toISOString(), message: r.message };
  const status = r.state === "filled" ? "filled" : r.state === "cancelled" ? "cancelled" : r.state === "rejected" ? "blocked" : "submitted";
  const updated = await transition(
    t.id,
    status,
    `${rec.venue} ${rec.env}: ${r.state}${r.message ? ` — ${r.message}` : ""}`,
    (x) => {
      (x as Ticket & { live?: LiveRecord }).live = next;
      if (r.state === "filled" && r.filledQuantity && r.averagePrice)
        x.fills.push({
          at: now.toISOString(),
          quantity: r.filledQuantity,
          price: r.averagePrice,
          fee: r.fee ?? 0,
          venue: `${rec.venue}-${rec.env}`,
          method: "venue fill",
        });
    },
    now,
  );
  if (r.state === "filled") await bookFill(t, r, next, now);
  return updated;
}

/** Send a checked, approved ticket to the venue: once. */
export async function liveSubmit(p: PreconditionInput): Promise<{ ticket: Ticket; result?: OrderResult; refusals: Refusal[] }> {
  const now = p.now ?? new Date();
  return withFileLock(join(homeDir(), "state", "live.lock"), async () => {
    const t = loadTicket(p.ticket.id);
    const prev = liveOf(t);
    if (prev && (prev.state === "unknown" || prev.state === "accepted" || prev.state === "partially-filled"))
      return {
        ticket: t,
        refusals: [{ code: "PENDING", reason: `this ticket already went to ${prev.venue} (${prev.state}): \`broker reconcile ${t.id}\` before anything else` }],
      };
    const { refusals, notional } = await preconditions({ ...p, ticket: t, now });
    if (refusals.length) {
      audit({ event: "live-refused", ticket: t.id, venue: p.venue, env: p.env, refusals });
      return { ticket: t, refusals };
    }
    const attempt = (prev?.attempt ?? 0) + 1;
    const order: LiveOrder = {
      symbol: p.venueSym,
      side: t.order.side,
      quantity: t.order.quantity,
      limitPrice: t.order.price,
      clientOrderId: clientOrderIdFor(t.id, attempt),
      timeInForce: "GTC",
    };
    const rec: LiveRecord = {
      venue: p.venue,
      env: p.env,
      clientOrderId: order.clientOrderId,
      venueSymbol: p.venueSym,
      attempt,
      state: "unknown",
      at: now.toISOString(),
    };
    audit({ event: "live-intent", ticket: t.id, venue: p.venue, env: p.env, clientOrderId: order.clientOrderId, order, notional, fingerprint: t.fingerprint });
    // Mark the ticket as submitted BEFORE the request: a crash in flight leaves it "unknown", never resendable.
    await transition(t.id, "submitted", `sending to ${p.venue} ${p.env} as ${order.clientOrderId}`, (x) => {
      (x as Ticket & { live?: LiveRecord }).live = rec;
    });
    let result: OrderResult;
    try {
      result = await p.adapter.submit(order);
    } catch (e) {
      result = { state: "unknown", clientOrderId: order.clientOrderId, message: (e as Error).message };
    }
    audit({
      event: "live-result",
      ticket: t.id,
      venue: p.venue,
      env: p.env,
      clientOrderId: order.clientOrderId,
      state: result.state,
      venueOrderId: result.venueOrderId,
      filled: result.filledQuantity,
      price: result.averagePrice,
      message: result.message,
    });
    const ticket = await applyResult(loadTicket(t.id), result, rec, now);
    return { ticket, result, refusals: [] };
  });
}

/** Ask the venue what became of a ticket's order (after "unknown", or to follow a working order). */
export async function reconcile(ticketId: string, adapter: BrokerAdapter, now = new Date()): Promise<{ ticket: Ticket; result?: OrderResult; note: string }> {
  const t = loadTicket(ticketId);
  const rec = liveOf(t);
  if (!rec) return { ticket: t, note: "this ticket never went to a venue" };
  const r = await adapter.query(rec.venueSymbol, rec.clientOrderId);
  audit({ event: "live-reconcile", ticket: t.id, venue: rec.venue, env: rec.env, clientOrderId: rec.clientOrderId, state: r?.state ?? "not-found" });
  if (!r) {
    if (rec.state !== "unknown") return { ticket: t, note: `${rec.venue} does not know ${rec.clientOrderId} any more` };
    // The venue never received it: the ticket may be checked and approved again.
    const ticket = await transition(
      t.id,
      "blocked",
      `${rec.venue} has no order ${rec.clientOrderId}: it was never placed — check and approve again to resend`,
      (x) => {
        (x as Ticket & { live?: LiveRecord }).live = { ...rec, state: "rejected", at: now.toISOString(), message: "not found at the venue" };
      },
    );
    return { ticket, note: "not found at the venue: never placed" };
  }
  if (r.state === rec.state && r.state !== "filled") return { ticket: t, result: r, note: `still ${r.state}` };
  const ticket = rec.state === "filled" ? t : await applyResult(t, r, rec, now);
  return { ticket, result: r, note: r.state };
}

/** Cancel a ticket's working order at its venue. */
export async function liveCancel(ticketId: string, adapter: BrokerAdapter, now = new Date()): Promise<OrderResult | undefined> {
  const t = loadTicket(ticketId);
  const rec = liveOf(t);
  if (!rec) return undefined;
  audit({ event: "live-cancel-intent", ticket: t.id, venue: rec.venue, env: rec.env, clientOrderId: rec.clientOrderId });
  const r = await adapter.cancel(rec.venueSymbol, rec.clientOrderId);
  audit({ event: "live-cancel-result", ticket: t.id, venue: rec.venue, env: rec.env, clientOrderId: rec.clientOrderId, state: r.state, message: r.message });
  await applyResult(t, r, rec, now);
  return r;
}
