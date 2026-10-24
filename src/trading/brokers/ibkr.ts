// Interactive Brokers adapter over the Client Portal Web API, through the
// gateway the user runs locally (default https://localhost:5000/v1/api) and
// logs into from a browser — no API key here; `creds.key` may name the account.
//
// The gateway serves a self-signed certificate. TLS is verified, never turned
// off: the user's PEM is the only trusted CA and `checkServerIdentity` pins
// the peer certificate's SHA-256 fingerprint (rejected on mismatch).
//
// env "test" is the PAPER account: the selected account must be a paper one
// ("DU…"), and a paper account is refused in env "live". IBKR may answer an
// order with a question ([{ id, message }]) awaiting POST /iserver/reply: it is
// NEVER confirmed here — the order comes back "rejected" with the question's
// text so the human reads it (IBKR drops an unanswered order).
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { timingSafeEqual, X509Certificate } from "node:crypto";
import { type AdapterOptions, BrokerError, DEFAULT_TIMEOUT_MS, notSent, parseBody, toNumber } from "./http.js";
import type { Balance, BrokerAdapter, Environment, HttpFn, LiveOrder, OrderResult, OrderState } from "./types.js";

export const IBKR_DEFAULT_BASE = "https://localhost:5000/v1/api";

export interface IbkrOptions extends AdapterOptions {
  /** The gateway's API root (default https://localhost:5000/v1/api). */
  baseUrl?: string;
  /** The gateway certificate to pin: a PEM file or its text, optionally its SHA-256 fingerprint as well. */
  tls?: { caFile?: string; caPem?: string; fingerprint256?: string };
}

/** Do two SHA-256 fingerprints match? Case, colons and spaces are ignored; constant time. */
export function sameFingerprint(a: string | undefined, b: string | undefined): boolean {
  const clean = (s: string) => s.replace(/[\s:]/g, "").toUpperCase();
  if (!a || !b) return false;
  const x = Buffer.from(clean(a));
  const y = Buffer.from(clean(b));
  return x.length === 64 && x.length === y.length && timingSafeEqual(x, y);
}

/**
 * An HttpFn over node:https trusting only the pinned gateway certificate. A
 * given fingerprint must match the PEM's own; the peer must then present
 * exactly that certificate.
 */
export function pinnedHttps(caPem: string, fingerprint256?: string): HttpFn {
  const own = new X509Certificate(caPem).fingerprint256;
  if (fingerprint256 && !sameFingerprint(own, fingerprint256)) throw new BrokerError("ibkr", "the pinned fingerprint does not match the certificate file");
  return (req) =>
    new Promise((resolve, reject) => {
      const u = new URL(req.url);
      if (u.protocol !== "https:") return reject(new BrokerError("ibkr", "the gateway must be reached over https"));
      const r = httpsRequest(
        {
          method: req.method,
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          headers: req.headers,
          ca: caPem,
          rejectUnauthorized: true,
          agent: false,
          checkServerIdentity: (_host, cert) =>
            sameFingerprint(cert.fingerprint256, own) ? undefined : new Error("the gateway certificate does not match the pinned fingerprint"),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            clearTimeout(timer);
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
          });
          res.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
        },
      );
      const timer = setTimeout(() => r.destroy(new Error(`timeout after ${req.timeoutMs} ms`)), req.timeoutMs);
      r.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new Error(e.message.startsWith("timeout") || e.message.includes("pinned") ? e.message : `network error${e.code ? ` (${e.code})` : ""}`));
      });
      if (req.body !== undefined) r.write(req.body);
      r.end();
    });
}

/** Why this account may not trade in this environment, or undefined when it may. */
export function ibkrAccountRefusal(env: Environment, accountId: string, isPaper?: boolean): string | undefined {
  const paperId = /^DU/i.test(accountId);
  if (env === "test" && (!paperId || isPaper === false)) return `env "test" trades the paper account only ("DU…"), not ${accountId}`;
  if (env === "live" && (/^D/i.test(accountId) || isPaper === true)) return `${accountId} is a paper account: env "live" needs the live account`;
  return undefined;
}

const IBKR_STATES: Record<string, OrderState> = {
  pendingsubmit: "accepted",
  presubmitted: "accepted",
  submitted: "accepted",
  pendingcancel: "accepted",
  precancelled: "accepted",
  filled: "filled",
  cancelled: "cancelled",
  inactive: "rejected",
};

interface IbkrOrder {
  orderId?: number | string;
  order_ref?: string;
  status?: string;
  filledQuantity?: number | string;
  remainingQuantity?: number | string;
  avgPrice?: string;
}

/** An entry of /iserver/account/orders as an OrderResult. */
export function parseIbkrOrder(o: IbkrOrder, clientOrderId: string): OrderResult {
  const filled = toNumber(o.filledQuantity) ?? 0;
  let state = IBKR_STATES[(o.status ?? "").toLowerCase()] ?? "unknown";
  if (state === "accepted" && filled > 0) state = "partially-filled";
  const r: OrderResult = { state, venueOrderId: o.orderId === undefined ? undefined : String(o.orderId), clientOrderId: o.order_ref ?? clientOrderId, raw: o };
  if (filled > 0) {
    r.filledQuantity = filled;
    r.averagePrice = toNumber(o.avgPrice);
  }
  if (o.status === "Inactive") r.message = "Inactive: IBKR did not accept the order";
  return r;
}

/** The answer to an order POST: an acknowledgement, a question (never answered here) or an error. */
export function parseIbkrSubmit(status: number, body: unknown, clientOrderId: string): OrderResult {
  const first = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
  if (status === 200 && first?.order_id !== undefined) {
    const state = IBKR_STATES[String(first.order_status ?? "").toLowerCase()] ?? "accepted";
    return { state, venueOrderId: String(first.order_id), clientOrderId, raw: body };
  }
  if (status === 200 && first?.id !== undefined && Array.isArray(first.message)) {
    return { state: "rejected", clientOrderId, message: `IBKR asks for a confirmation, not given: ${(first.message as string[]).join(" ")}`, raw: body };
  }
  const err = (body as { error?: string })?.error;
  return { state: status >= 500 ? "unknown" : "rejected", clientOrderId, message: err ?? `HTTP ${status}`, raw: body };
}

export function ibkrAdapter(opts: IbkrOptions): BrokerAdapter {
  const base = (opts.baseUrl ?? IBKR_DEFAULT_BASE).replace(/\/$/, "");
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let http = opts.http;
  if (!http) {
    const pem = opts.tls?.caPem ?? (opts.tls?.caFile ? readFileSync(opts.tls.caFile, "utf8") : undefined);
    if (!pem) throw new BrokerError("ibkr", "the gateway certificate is required (tls.caFile or tls.caPem): TLS is never disabled");
    http = pinnedHttps(pem, opts.tls?.fingerprint256);
  }
  const send = http;
  let account: string | undefined;

  async function call(method: "GET" | "POST" | "DELETE", path: string, payload?: unknown) {
    const res = await send({
      method,
      url: `${base}${path}`,
      headers: { "Content-Type": "application/json", "User-Agent": "ultrastock" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      timeoutMs,
    });
    return { status: res.status, body: parseBody(res.body) };
  }

  async function mustGet(path: string) {
    const r = await call("GET", path);
    if (r.status !== 200) throw new BrokerError("ibkr", `${path} refused: ${(r.body as { error?: string })?.error ?? `HTTP ${r.status}`}`, r.status);
    return r.body;
  }

  /** The account to trade, checked against the environment once per adapter. */
  async function accountId(): Promise<string> {
    if (account) return account;
    const b = (await mustGet("/iserver/accounts")) as { accounts?: string[]; selectedAccount?: string; isPaper?: boolean };
    const id = opts.creds.key || b.selectedAccount || b.accounts?.[0];
    if (!id) throw new BrokerError("ibkr", "the gateway lists no account: log in first");
    if (b.accounts && !b.accounts.includes(id)) throw new BrokerError("ibkr", `account ${id} is not in this gateway session`);
    const refusal = ibkrAccountRefusal(opts.env, id, b.isPaper);
    if (refusal) throw new BrokerError("ibkr", refusal);
    account = id;
    return id;
  }

  function orderBody(o: LiveOrder) {
    return {
      orders: [
        {
          conid: Number(o.symbol),
          orderType: "LMT",
          side: o.side === "buy" ? "BUY" : "SELL",
          price: o.limitPrice,
          quantity: o.quantity,
          tif: o.timeInForce ?? "DAY",
          cOID: o.clientOrderId,
        },
      ],
    };
  }

  async function liveOrders(): Promise<IbkrOrder[]> {
    return ((await mustGet("/iserver/account/orders")) as { orders?: IbkrOrder[] }).orders ?? [];
  }

  const badConid = (o: LiveOrder) => (/^\d+$/.test(o.symbol) ? undefined : `IBKR orders need a conid, not ${o.symbol}`);

  return {
    venue: "ibkr",
    env: opts.env,

    async bookTop(symbol) {
      const b = (await mustGet(`/iserver/marketdata/snapshot?conids=${encodeURIComponent(symbol)}&fields=84,86`)) as Record<string, string>[];
      const bid = toNumber(b?.[0]?.["84"]);
      const ask = toNumber(b?.[0]?.["86"]);
      // The gateway's first snapshot of a conid often comes back empty while it subscribes.
      if (bid === undefined || ask === undefined)
        throw new BrokerError("ibkr", `no bid/ask yet for conid ${symbol} (the first snapshot is often empty: ask again)`);
      return { bid, ask, at: new Date(now()).toISOString() };
    },

    async permissions() {
      const s = (await mustGet("/iserver/auth/status")) as { authenticated?: boolean; competing?: boolean };
      return { canTrade: s.authenticated === true && s.competing !== true, canWithdraw: false, source: "gateway session (no withdrawal API)" };
    },

    async balances() {
      const acct = await accountId();
      const ledger = (await mustGet(`/portfolio/${acct}/ledger`)) as Record<string, { cashbalance?: number; currency?: string }>;
      const out: Balance[] = Object.entries(ledger)
        .filter(([ccy]) => ccy !== "BASE")
        .map(([ccy, l]) => ({ asset: l.currency ?? ccy, free: toNumber(l.cashbalance) ?? 0, locked: 0 }))
        .filter((b) => b.free !== 0);
      const positions = (await mustGet(`/portfolio/${acct}/positions/0`)) as { conid?: number; position?: number; ticker?: string; contractDesc?: string }[];
      for (const p of positions ?? []) {
        const qty = toNumber(p.position) ?? 0;
        if (qty !== 0) out.push({ asset: p.ticker ?? p.contractDesc ?? String(p.conid), free: qty, locked: 0 });
      }
      return out;
    },

    async preview(o) {
      const refusal = badConid(o);
      if (refusal) return { ok: false, message: refusal };
      const acct = await accountId();
      const r = await call("POST", `/iserver/account/${acct}/orders/whatif`, orderBody(o));
      const b = r.body as { error?: string | null; warn?: string | null };
      if (r.status === 200 && !b?.error) return { ok: true, message: b?.warn ?? undefined, raw: r.body };
      return { ok: false, message: b?.error ?? `HTTP ${r.status}`, raw: r.body };
    },

    async submit(o) {
      const refusal = badConid(o);
      if (refusal) return notSent(o.clientOrderId, refusal);
      let acct: string;
      try {
        acct = await accountId();
      } catch (e) {
        // Nothing was placed: the account lookup failed or was refused.
        return notSent(o.clientOrderId, (e as Error).message);
      }
      let r: { status: number; body: unknown };
      try {
        r = await call("POST", `/iserver/account/${acct}/orders`, orderBody(o));
      } catch (e) {
        return { state: "unknown", clientOrderId: o.clientOrderId, message: (e as Error).message };
      }
      return parseIbkrSubmit(r.status, r.body, o.clientOrderId);
    },

    async query(_symbol, clientOrderId) {
      const hit = (await liveOrders()).find((o) => o.order_ref === clientOrderId);
      return hit ? parseIbkrOrder(hit, clientOrderId) : undefined;
    },

    async cancel(_symbol, clientOrderId) {
      const hit = (await liveOrders()).find((o) => o.order_ref === clientOrderId);
      if (hit?.orderId === undefined) return { state: "rejected", clientOrderId, message: "no IBKR order carries this cOID today" };
      const acct = await accountId();
      const r = await call("DELETE", `/iserver/account/${acct}/order/${hit.orderId}`);
      const b = r.body as { msg?: string; error?: string };
      if (r.status === 200 && b?.msg) return { state: "cancelled", clientOrderId, venueOrderId: String(hit.orderId), message: b.msg, raw: r.body };
      return { state: "rejected", clientOrderId, venueOrderId: String(hit.orderId), message: b?.error ?? `HTTP ${r.status}`, raw: r.body };
    },

    async openOrders() {
      const done = new Set(["filled", "cancelled", "inactive"]);
      return (await liveOrders()).filter((o) => !done.has((o.status ?? "").toLowerCase())).map((o) => parseIbkrOrder(o, o.order_ref ?? ""));
    },
  };
}
