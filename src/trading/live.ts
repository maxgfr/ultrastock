// Live execution: the one place a real order can leave ultrastock, and every
// condition it must meet first. `liveSubmit` refuses unless ALL hold:
//
//   1. env "live": the user's live switch (a file written with an out-of-band
//      code) AND ULTRASTOCK_LIVE=1, Node ≥ 22, the paper record is ready;
//      env "test" (Binance testnet, Kraken validate, Coinbase preview, IBKR
//      paper): none of those, but everything below.
//   2. the venue is switched on in the live limits; live, a crypto platform
//      must be an authorised MiCA CASP serving the profile's country (Binance
//      is not, for France — its testnet stays usable);
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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../engine.js";
import { createHash } from "node:crypto";
import { checkMica, ruleStatus } from "../core/jurisdiction.js";
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
import { killSwitchPath, type Order, orderFingerprint } from "./riskgate.js";
import { audit, executionRefusal, loadTicket, readAudit, type Ticket, type TicketStatus, transition } from "./tickets.js";

export const VENUES: Venue[] = ["binance", "kraken", "coinbase", "ibkr", "kalshi"];
export const CRYPTO_VENUES: Venue[] = ["binance", "kraken", "coinbase"];
export const PRICE_BAND_PCT = 1;

export interface Refusal {
  code: string;
  reason: string;
}

/**
 * The venue's symbol for an order's symbol. An IBKR order names its contract by
 * an id the user gives (`--conid`); everywhere else the symbol follows from the
 * ticket and nothing may replace it — the order that goes is the one checked.
 */
export function venueSymbol(venue: Venue, symbol: string, currency: string, conid?: string): string {
  if (conid) {
    if (venue !== "ibkr") throw new Error(`--conid names an IBKR contract: on ${venue} the symbol comes from the ticket (${symbol}) and cannot be replaced`);
    return conid;
  }
  if (venue === "kalshi") {
    const m = /^KALSHI:(.+):(YES|NO)$/i.exec(symbol);
    if (!m) throw new Error(`a Kalshi order needs a contract symbol KALSHI:<TICKER>:YES|NO, not ${symbol}`);
    return `${m[1]!.toUpperCase()}:${m[2]!.toUpperCase()}`;
  }
  const { base, quote } = splitPair(symbol, currency);
  const q = quote ?? currency.toUpperCase();
  if (venue === "binance") return `${base}${q}`;
  if (venue === "kraken") return `${base === "BTC" ? "XBT" : base}${q}`;
  if (venue === "coinbase") return `${base}-${q}`;
  throw new Error("IBKR orders need the contract id: pass --conid (from the IBKR gateway's contract search)");
}

/**
 * What an approval code approves: this order (every number of it), at this
 * venue, in this environment, as this venue symbol. A code issued while looking
 * at a testnet run is void for the real exchange, and so is one issued for
 * another contract.
 */
export function orderBinding(order: Order, venue: Venue, env: Environment, venueSym: string): string {
  return `${orderFingerprint(order)}|${venue}|${env}|${venueSym}`;
}

/**
 * A stable clientOrderId per ticket and attempt, shaped as a UUID: every venue
 * takes it (Binance ≤ 36 characters, Kraken a UUID or ≤ 18 characters).
 */
export function clientOrderIdFor(ticketId: string, attempt: number): string {
  const h = createHash("sha256").update(`${ticketId}#${attempt}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The live switch. Real money needs both a file under the state directory and
 * ULTRASTOCK_LIVE=1. The variable alone was the switch, and an agent allowed
 * to run `broker submit` can put it in front of that one command; the file is
 * written only by `broker live on --code`, with a code sent out of band to the
 * user (`broker code live`), so turning live on is the user's act, not a word
 * on a command line. It stays on until `broker live off` (no code: switching
 * off is always allowed) removes it.
 */
export const liveSwitchPath = () => join(homeDir(), "state", "live-switch.json");
export const LIVE_SWITCH_SUBJECT = "live-switch";
export const LIVE_SWITCH_BINDING = "live-switch|on";

/** Whether the user switched live on (the file); the environment variable is checked apart. */
export function liveSwitchOn(): boolean {
  try {
    return (JSON.parse(readFileSync(liveSwitchPath(), "utf8")) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
}

/** Switch live on with the code `broker code live` sent the user; throws with the reason otherwise. */
export function switchLiveOn(code: string | undefined, now = new Date()): void {
  if (!code) throw new Error("switching live trading on needs the out-of-band code: `broker code live`, then `broker live on --code <code>`");
  const v = verifyCode(LIVE_SWITCH_SUBJECT, LIVE_SWITCH_BINDING, code, now);
  if (!v.ok) throw new Error(`live trading stays off: ${v.reason}`);
  mkdirSync(dirname(liveSwitchPath()), { recursive: true });
  writeFileAtomic(liveSwitchPath(), `${JSON.stringify({ on: true, at: now.toISOString() })}\n`, 0o600);
  audit({ event: "live-switch", on: true });
}

export function switchLiveOff(): void {
  rmSync(liveSwitchPath(), { force: true });
  audit({ event: "live-switch", on: false });
}

/** Why live is off, or undefined when both the user's switch and ULTRASTOCK_LIVE=1 are on. */
export function liveOffReason(): string | undefined {
  const missing = [
    ...(liveSwitchOn() ? [] : ["the user switches it on with `broker code live`, then `broker live on --code <code>` (a code sent out of band)"]),
    ...(process.env.ULTRASTOCK_LIVE === "1" ? [] : ["the user sets ULTRASTOCK_LIVE=1 in their own shell"]),
  ];
  return missing.length ? `live trading is off: ${missing.join("; and ")}` : undefined;
}

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
    const off = liveOffReason();
    if (off) no("LIVE_OFF", off);
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
  // The authorisation matters for real money; a testnet or a validate-only call moves none.
  if (profile && p.env === "live" && CRYPTO_VENUES.includes(p.venue) && profile.jurisdiction !== "US") {
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
  if (p.ticket.check?.replayed)
    no("REPLAY", "the ticket was checked against a fixture, not the market: check it again without --fixture or --record before any live order");
  if (o.orderType !== "limit") no("MARKET_ORDER", "live orders are limit orders only");
  if (o.assetKind === "prediction") {
    // Event contracts: Kalshi only (Polymarket's order signing is not implemented), and only where the jurisdiction allows it.
    if (p.venue !== "kalshi") no("ASSET", "event contracts trade live on Kalshi only in this version");
    const status = profile ? ruleStatus(profile.jurisdiction, "kalshi") : "unknown";
    if (p.env === "live" && status !== "allowed")
      no("BLOCKED_JURISDICTION", `Kalshi is ${status} for residents of ${profile?.jurisdiction ?? "an unknown country"}: no live orders (paper only)`);
  } else if (!["crypto", "equity", "etf"].includes(o.assetKind))
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
      const asset = p.venue === "ibkr" || p.venue === "kalshi" ? undefined : splitPair(o.symbol, o.currency).base;
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

  // The code is checked last, and only when nothing else stands in the way: a refused order must not use up a try.
  if (!R.length) {
    const v = verifyCode(p.ticket.id, orderBinding(o, p.venue, p.env, p.venueSym), p.code, now);
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

/** Where a ticket's order went and what the venue last said of it, when it ever left. */
export const liveRecordOf = (t: Ticket): LiveRecord | undefined => (t as Ticket & { live?: LiveRecord }).live;
const liveOf = liveRecordOf;

/**
 * An order is only ever asked about, or cancelled, where it went. Another
 * environment of the same venue has never heard of it: its "no such order"
 * would read as "never placed" and free the ticket for a second send.
 */
function assertSameVenue(ticketId: string, rec: LiveRecord, adapter: BrokerAdapter): void {
  if (adapter.venue !== rec.venue || adapter.env !== rec.env)
    throw new Error(`ticket ${ticketId} went to ${rec.venue} ${rec.env}: it cannot be followed on ${adapter.venue} ${adapter.env}`);
}

/** An answer that ends the order with something filled: a fill, or a cancel that came after a partial one. */
const settledFill = (r: OrderResult): boolean => (r.state === "filled" || r.state === "cancelled") && !!r.filledQuantity && !!r.averagePrice;

interface Filled {
  quantity: number;
  price: number;
  fee: number;
}

/**
 * What a venue answer adds to what is already recorded for the order. A venue
 * reports the order's whole fill so far (quantity, average price, fee): a cancel
 * that came after a partial fill, then a "filled" once the venue caught up, is
 * one order — only the rest is new, at the price that makes the average the
 * venue's. Nothing when the answer adds nothing.
 */
function fillDelta(prior: readonly Filled[], r: OrderResult): Filled | undefined {
  if (!settledFill(r)) return undefined;
  const q0 = prior.reduce((s, f) => s + f.quantity, 0);
  const quantity = r.filledQuantity! - q0;
  if (quantity <= 1e-12) return undefined;
  if (!prior.length) return { quantity, price: r.averagePrice!, fee: r.fee ?? 0 };
  const rest = (r.filledQuantity! * r.averagePrice! - prior.reduce((s, f) => s + f.quantity * f.price, 0)) / quantity;
  return {
    quantity,
    price: Number.isFinite(rest) && rest > 0 ? rest : r.averagePrice!,
    fee: Math.max(0, (r.fee ?? 0) - prior.reduce((s, f) => s + f.fee, 0)),
  };
}

/** The ledger a ticket's venue fills are booked in: the real book live, "live-test" otherwise. */
const fillBook = (rec: LiveRecord) => (rec.env === "live" ? "real" : "live-test");

/**
 * Book in the ledger what a venue answer adds to what the ledger already holds
 * for this ticket (origin `ticket:<id>`): a fill is never booked twice, and a
 * fill reported late — after a cancel — is booked once.
 */
async function bookFill(t: Ticket, r: OrderResult, rec: LiveRecord, now: Date): Promise<void> {
  const book = fillBook(rec);
  const foreignFee = !!r.feeCurrency && r.feeCurrency !== t.order.currency;
  const booked = readLedger(book)
    .filter((x) => x.origin === `ticket:${t.id}`)
    .map((x) => ({ quantity: x.quantity ?? 0, price: x.price ?? 0, fee: x.fee ?? 0 }));
  const d = fillDelta(booked, foreignFee ? { ...r, fee: 0 } : r);
  if (!d) return;
  const { duplicates } = await appendTransactions(
    [
      {
        date: now.toISOString().slice(0, 19),
        type: t.order.side,
        account: t.order.account,
        symbol: t.order.symbol,
        quantity: d.quantity,
        price: d.price,
        fee: foreignFee || r.fee === undefined ? undefined : d.fee,
        currency: t.order.currency,
        note: `${rec.venue} ${rec.env} order ${r.venueOrderId ?? rec.clientOrderId}${r.fee && foreignFee ? ` (fee ${r.fee} ${r.feeCurrency} for the whole order)` : ""}`,
        origin: `ticket:${t.id}`,
      },
    ],
    book,
  );
  // Only an identical row of this very ticket in the same second (two equal partial fills) is a duplicate: the
  // ticket's fills and the ledger now differ by it — say so where the user reads what happened.
  if (duplicates)
    audit({
      event: "live-fill-not-booked",
      ticket: t.id,
      book,
      quantity: d.quantity,
      price: d.price,
      reason: "an identical row of this ticket was booked in the same second: add this fill to the ledger by hand (`portfolio add`)",
    });
}

/**
 * The states of a ticket whose order went to a venue and may still be heard of:
 * sent, cancelled (a fill may surface after), declared never placed or checked
 * again since. A filled one is final.
 */
const FOLLOWED: readonly TicketStatus[] = ["submitted", "cancelled", "blocked", "checked"];

/** Apply a venue answer to the ticket (status, record, ledger). */
async function applyResult(t: Ticket, r: OrderResult, rec: LiveRecord, now: Date): Promise<Ticket> {
  const next: LiveRecord = { ...rec, state: r.state, venueOrderId: r.venueOrderId ?? rec.venueOrderId, at: now.toISOString(), message: r.message };
  // A dry run the venue accepted placed nothing: the ticket is over, not waiting on an order that will never exist.
  if (r.validatedOnly && r.state === "accepted") {
    const done: LiveRecord = { ...next, state: "cancelled", message: r.message ?? "validated only" };
    return transition(
      t.id,
      "cancelled",
      `${rec.venue} ${rec.env}: validated only — nothing was placed`,
      (x) => {
        (x as Ticket & { live?: LiveRecord }).live = done;
      },
      now,
      ["submitted"],
    );
  }
  const status = r.state === "filled" ? "filled" : r.state === "cancelled" ? "cancelled" : r.state === "rejected" ? "blocked" : "submitted";
  // The ledger is booked under the ticket's lock, before the ticket is saved: a crash in between books nothing twice (the
  // ledger's own entries for the ticket are what the next answer is measured against).
  return transition(
    t.id,
    status,
    `${rec.venue} ${rec.env}: ${r.state}${r.message ? ` — ${r.message}` : ""}`,
    async (x) => {
      (x as Ticket & { live?: LiveRecord }).live = next;
      const d = fillDelta(x.fills, r);
      if (d) x.fills.push({ at: now.toISOString(), ...d, venue: `${rec.venue}-${rec.env}`, method: "venue fill" });
      await bookFill(x, r, next, now);
    },
    now,
    FOLLOWED,
  );
}

/**
 * One live operation at a time per ticket — a submit, a reconcile or a cancel.
 * Each reads the ticket under it, so two of them cannot both apply one venue
 * answer (a fill pushed and booked twice). A ticket's own lock only: a cancel
 * (`broker panic`) never waits on a slow venue answering about another ticket.
 * A cancel waits longer than the default for its own ticket: a request in
 * flight can take its full timeout. Not re-entrant: none of them calls another.
 */
const ticketLiveLock = <T>(ticketId: string, fn: () => Promise<T>, waitMs?: number): Promise<T> => {
  loadTicket(ticketId); // a valid ticket id, before it names a file
  return withFileLock(join(homeDir(), "state", "live", `${ticketId}.lock`), fn, waitMs);
};
const CANCEL_WAIT_MS = 60_000;

/**
 * Sends, one at a time across tickets: each reads today's live notional and the
 * tier's limits before its request, so two sends at once could both fit a limit
 * only one of them fits. Taken before the ticket's own lock, never after it.
 */
const sendLock = <T>(fn: () => Promise<T>): Promise<T> => withFileLock(join(homeDir(), "state", "live.lock"), fn);

/** Send a checked, approved ticket to the venue: once. */
export async function liveSubmit(p: PreconditionInput): Promise<{ ticket: Ticket; result?: OrderResult; refusals: Refusal[] }> {
  const now = p.now ?? new Date();
  return sendLock(() => ticketLiveLock(p.ticket.id, () => submitLocked(p, now)));
}

async function submitLocked(p: PreconditionInput, now: Date): Promise<{ ticket: Ticket; result?: OrderResult; refusals: Refusal[] }> {
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
  // The kill switch was read before the slow reads of the venue: `broker panic` may have set it since.
  const killed = (): { ticket: Ticket; refusals: Refusal[] } | undefined => {
    if (!existsSync(killSwitchPath())) return undefined;
    const refusals = [{ code: "KILL_SWITCH", reason: `the kill switch was set while the order was being checked (${killSwitchPath()}): nothing was sent` }];
    audit({ event: "live-refused", ticket: t.id, venue: p.venue, env: p.env, refusals });
    return { ticket: loadTicket(t.id), refusals };
  };
  const before = killed();
  if (before) return before;
  audit({ event: "live-intent", ticket: t.id, venue: p.venue, env: p.env, clientOrderId: order.clientOrderId, order, notional, fingerprint: t.fingerprint });
  // Mark the ticket as submitted BEFORE the request: a crash in flight leaves it "unknown", never resendable.
  // Checked under the ticket's lock: a cancel by the user since the preconditions read it stops the send.
  await transition(
    t.id,
    "submitted",
    `sending to ${p.venue} ${p.env} as ${order.clientOrderId}`,
    (x) => {
      (x as Ticket & { live?: LiveRecord }).live = rec;
    },
    undefined,
    ["checked"],
  );
  // Read once more now that the ticket is "submitted": a panic that set the switch after this read lists the ticket
  // among those to cancel (and waits on its lock for the send to end); one that set it before is seen here.
  if (existsSync(killSwitchPath())) {
    await transition(
      t.id,
      "blocked",
      "the kill switch was set before the send: nothing was sent",
      (x) => {
        (x as Ticket & { live?: LiveRecord }).live = { ...rec, state: "rejected", message: "kill switch: never sent" };
      },
      undefined,
      ["submitted"],
    );
    return killed()!;
  }
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
}

/** How long after a send "the venue does not list it" can still mean "not yet": a request in flight, an index catching up. */
export const NOT_PLACED_WAIT_MS = 10 * 60_000;

/** What the code that declares an order never placed approves: that order, there, and nothing else. */
export function notPlacedBinding(rec: Pick<LiveRecord, "venue" | "env" | "clientOrderId">): string {
  return `not-placed|${rec.venue}|${rec.env}|${rec.clientOrderId}`;
}

/**
 * Ask the venue what became of a ticket's order (after "unknown", or to follow a working order).
 *
 * An answer changes the ticket. An absence does not, on its own: every venue's
 * lookup covers a window (a few pages of history, the current session, a
 * search index that lags a send by seconds), and "not found" read as "never
 * placed" frees the ticket for a second, real order. The ticket is only freed
 * when the venue's open orders do not hold it either, ten minutes have passed
 * since the send, and the user — who can see the venue's own order history —
 * says so with an out-of-band code (`broker code <ticket> --not-placed`).
 */
export async function reconcile(
  ticketId: string,
  adapter: BrokerAdapter,
  now = new Date(),
  opts: { notPlacedCode?: string } = {},
): Promise<{ ticket: Ticket; result?: OrderResult; note: string }> {
  return ticketLiveLock(ticketId, () => reconcileLocked(ticketId, adapter, now, opts));
}

async function reconcileLocked(
  ticketId: string,
  adapter: BrokerAdapter,
  now: Date,
  opts: { notPlacedCode?: string },
): Promise<{ ticket: Ticket; result?: OrderResult; note: string }> {
  const t = loadTicket(ticketId);
  const rec = liveOf(t);
  if (!rec) return { ticket: t, note: "this ticket never went to a venue" };
  assertSameVenue(t.id, rec, adapter);
  let r = await adapter.query(rec.venueSymbol, rec.clientOrderId);
  // The lookup by id missed it: the list of what is working now may still hold it.
  let openUnread: string | undefined;
  if (!r && rec.state === "unknown")
    try {
      r = (await adapter.openOrders()).find((o) => o.clientOrderId === rec.clientOrderId);
    } catch (e) {
      openUnread = (e as Error).message;
    }
  audit({
    event: "live-reconcile",
    ticket: t.id,
    venue: rec.venue,
    env: rec.env,
    clientOrderId: rec.clientOrderId,
    state: r?.state ?? (openUnread === undefined ? "not-found" : "open-orders-unreadable"),
  });
  if (!r) {
    if (rec.state !== "unknown") return { ticket: t, note: `${rec.venue} does not know ${rec.clientOrderId} any more` };
    // A failed read is not an absence: the order may be working there right now. Nothing changes, and a code given is not used up.
    if (openUnread !== undefined)
      return {
        ticket: t,
        note: `not found at ${rec.venue} by its id, and its open orders could not be read (${openUnread}): the cross-check could not be made, so the order stays of unknown fate. Nothing is resent. Ask again later`,
      };
    const readyAt = Date.parse(rec.at) + NOT_PLACED_WAIT_MS;
    const how = `look at ${rec.venue}'s own order history, then \`broker code ${t.id} --not-placed\` and \`broker reconcile ${t.id} --code <code>\``;
    if (now.getTime() < readyAt)
      return {
        ticket: t,
        note: `not found at ${rec.venue} yet — that is not proof it was never placed. Nothing is resent. Ask again after ${new Date(readyAt).toISOString().slice(11, 16)} UTC; if it is still absent, ${how}`,
      };
    if (!opts.notPlacedCode)
      return {
        ticket: t,
        note: `not found at ${rec.venue}, ${Math.round((now.getTime() - Date.parse(rec.at)) / 60_000)} minutes after the send. Nothing is resent on that alone: ${how}`,
      };
    const v = verifyCode(t.id, notPlacedBinding(rec), opts.notPlacedCode, now);
    if (!v.ok) return { ticket: t, note: `not found at ${rec.venue}, and the code does not declare it never placed: ${v.reason}` };
    audit({ event: "live-not-placed", ticket: t.id, venue: rec.venue, env: rec.env, clientOrderId: rec.clientOrderId });
    const ticket = await transition(
      t.id,
      "blocked",
      `${rec.venue} has no order ${rec.clientOrderId} and the user declared it never placed — check and approve again to resend`,
      (x) => {
        (x as Ticket & { live?: LiveRecord }).live = {
          ...rec,
          state: "rejected",
          at: now.toISOString(),
          message: "not found at the venue; declared never placed by the user",
        };
      },
      undefined,
      ["submitted"],
    );
    return { ticket, note: "not found at the venue, declared never placed: the ticket can be checked and approved again" };
  }
  // The same state is still news when it carries a fill not yet recorded: a cancel whose follow-up read of the fills failed.
  if (r.state === rec.state && r.state !== "filled" && !fillDelta(t.fills, r)) return { ticket: t, result: r, note: `still ${r.state}` };
  const ticket = rec.state === "filled" ? t : await applyResult(t, r, rec, now);
  return { ticket, result: r, note: r.state };
}

/**
 * Cancel a ticket's working order at its venue. Only the venue's word changes
 * the ticket: a refused cancel leaves it pending (the order may be working, or
 * filled a moment ago), so nothing can be sent again on a guess.
 */
export async function liveCancel(ticketId: string, adapter: BrokerAdapter, now = new Date()): Promise<OrderResult | undefined> {
  return ticketLiveLock(ticketId, () => cancelLocked(ticketId, adapter, now), CANCEL_WAIT_MS);
}

async function cancelLocked(ticketId: string, adapter: BrokerAdapter, now: Date): Promise<OrderResult | undefined> {
  const t = loadTicket(ticketId);
  const rec = liveOf(t);
  if (!rec) return undefined;
  assertSameVenue(t.id, rec, adapter);
  if (rec.state === "filled" || rec.state === "cancelled" || rec.state === "rejected")
    throw new Error(`ticket ${t.id} is already ${rec.state} at ${rec.venue}: there is nothing to cancel`);
  audit({ event: "live-cancel-intent", ticket: t.id, venue: rec.venue, env: rec.env, clientOrderId: rec.clientOrderId });
  const r = await adapter.cancel(rec.venueSymbol, rec.clientOrderId);
  audit({ event: "live-cancel-result", ticket: t.id, venue: rec.venue, env: rec.env, clientOrderId: rec.clientOrderId, state: r.state, message: r.message });
  // A cancel answer rarely says what filled before it, and a refusal says nothing of the order: ask for the order itself.
  let unread: string | undefined;
  const seen = await adapter.query(rec.venueSymbol, rec.clientOrderId).catch((e: Error) => {
    unread = e.message;
    return undefined;
  });
  if (r.state === "rejected") {
    if (seen && seen.state !== rec.state && seen.state !== "unknown") await applyResult(t, seen, rec, now);
    return r;
  }
  const done: OrderResult =
    seen && (seen.state === "filled" || seen.state === "cancelled")
      ? seen
      : {
          ...r,
          filledQuantity: r.filledQuantity ?? seen?.filledQuantity,
          averagePrice: r.averagePrice ?? seen?.averagePrice,
          fee: r.fee ?? seen?.fee,
          feeCurrency: r.feeCurrency ?? seen?.feeCurrency,
          // A failed read is not "nothing filled": the record says so, and a reconcile that reads a fill still books it.
          ...(unread !== undefined && !r.filledQuantity
            ? { message: `${r.message ? `${r.message}; ` : ""}what it filled could not be read (${unread}): \`broker reconcile ${t.id}\` settles it` }
            : {}),
        };
  await applyResult(t, done, rec, now);
  return done;
}
