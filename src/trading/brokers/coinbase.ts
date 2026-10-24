// Coinbase Advanced Trade adapter — GTC LIMIT orders on the spot book, nothing else.
//
//   https://api.coinbase.com/api/v3/brokerage
//
// Auth is a CDP API key: every request carries a fresh ES256 JWT (2 minutes,
// `uri` = "<METHOD> api.coinbase.com<path>", query string excluded) signed with
// the key's EC private key. Advanced Trade has no spot sandbox: env "test"
// makes `submit` call /orders/preview only and say "preview only" — nothing
// is placed. `bookTop` uses the public market ticker, so no credential is sent
// for prices. Coinbase cannot look an order up by client_order_id: `query`
// pages through the product's recent orders and matches it.
import { randomBytes, sign as cryptoSign } from "node:crypto";
import {
  type AdapterOptions,
  BrokerError,
  credentialStrings,
  DEFAULT_TIMEOUT_MS,
  fetchHttp,
  notSent,
  parseBody,
  plainDecimal,
  scrubSecrets,
  toNumber,
} from "./http.js";
import type { Balance, BrokerAdapter, LiveOrder, OrderResult, OrderState } from "./types.js";

const COINBASE_HOST = "api.coinbase.com";
const COINBASE_PREFIX = "/api/v3/brokerage";
const MAX_PAGES = 5;

function base64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64url");
}

/** A PEM pasted into an env var or a JSON file often arrives with literal "\n": restore real newlines. */
export function pemFromSecret(secret: string): string {
  return `${secret.replace(/\\n/g, "\n").trim()}\n`;
}

/** The Bearer JWT for one request (ES256, raw r||s signature). `uri` is "<METHOD> api.coinbase.com<path>". */
export function coinbaseJwt(keyName: string, pem: string, uri: string, nowSec: number, nonce: string = randomBytes(16).toString("hex")): string {
  const header = { alg: "ES256", kid: keyName, nonce, typ: "JWT" };
  const payload = { sub: keyName, iss: "cdp", nbf: nowSec, exp: nowSec + 120, uri };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sig = cryptoSign("sha256", Buffer.from(data), { key: pemFromSecret(pem), dsaEncoding: "ieee-p1363" });
  return `${data}.${base64url(sig)}`;
}

const COINBASE_STATES: Record<string, OrderState> = {
  PENDING: "accepted",
  QUEUED: "accepted",
  OPEN: "accepted",
  CANCEL_QUEUED: "accepted",
  EDIT_QUEUED: "accepted",
  FILLED: "filled",
  CANCELLED: "cancelled",
  EXPIRED: "cancelled",
  FAILED: "rejected",
};

interface CoinbaseOrder {
  order_id?: string;
  client_order_id?: string;
  status?: string;
  filled_size?: string;
  average_filled_price?: string;
  total_fees?: string;
  product_id?: string;
  reject_message?: string;
  cancel_message?: string;
}

/** An order of /orders/historical as an OrderResult. */
export function parseCoinbaseOrder(o: CoinbaseOrder): OrderResult {
  const filled = toNumber(o.filled_size) ?? 0;
  let state = COINBASE_STATES[o.status ?? ""] ?? "unknown";
  if (state === "accepted" && filled > 0) state = "partially-filled";
  const r: OrderResult = { state, venueOrderId: o.order_id, clientOrderId: o.client_order_id ?? "", raw: o };
  if (filled > 0) {
    r.filledQuantity = filled;
    r.averagePrice = toNumber(o.average_filled_price);
    r.fee = toNumber(o.total_fees);
    // Fees are charged in the quote currency (BTC-EUR → EUR).
    if (o.product_id?.includes("-")) r.feeCurrency = o.product_id.split("-")[1];
  }
  const why = o.reject_message || o.cancel_message;
  if (why) r.message = why;
  return r;
}

export function coinbaseAdapter(opts: AdapterOptions): BrokerAdapter {
  const http = opts.http ?? fetchHttp;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const keyName = opts.creds.keyName ?? opts.creds.key;
  const pem = pemFromSecret(opts.creds.secret);
  // The PEM's base64 lines too: a venue echoing a fragment of the key must not leak it.
  const secrets = [...credentialStrings(opts.creds), pem.trim(), ...pem.split("\n").filter((l) => l.length >= 16 && !l.startsWith("-----"))];

  /** Sign one request (throws a credential-free error when the secret is not an EC private key). */
  function prepare(method: "GET" | "POST", path: string, query = "", payload?: unknown) {
    let jwt: string;
    try {
      jwt = coinbaseJwt(keyName, pem, `${method} ${COINBASE_HOST}${COINBASE_PREFIX}${path}`, Math.floor(now() / 1000));
    } catch {
      throw new BrokerError("coinbase", "cannot sign: the secret is not a PEM EC private key");
    }
    const req = {
      method,
      url: `https://${COINBASE_HOST}${COINBASE_PREFIX}${path}${query ? `?${query}` : ""}`,
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      timeoutMs,
    };
    return { req, jwt };
  }

  /** Send a prepared request; the answer is scrubbed of the key and this JWT. */
  async function send(p: ReturnType<typeof prepare>) {
    const res = await http(p.req);
    return { status: res.status, body: parseBody(scrubSecrets(res.body, [...secrets, p.jwt])) };
  }

  async function authed(method: "GET" | "POST", path: string, query = "", payload?: unknown) {
    return send(prepare(method, path, query, payload));
  }

  function venueError(status: number, body: unknown): string {
    const b = body as { error?: string; message?: string; error_response?: { new_order_failure_reason?: string; message?: string; error_details?: string } };
    const e = b?.error_response;
    if (e) return [e.new_order_failure_reason, e.message, e.error_details].filter(Boolean).join(": ") || `HTTP ${status}`;
    return [b?.error, b?.message].filter(Boolean).join(": ") || `HTTP ${status}`;
  }

  async function mustGet(path: string, query = "") {
    const r = await authed("GET", path, query);
    if (r.status !== 200) throw new BrokerError("coinbase", `${path} refused: ${venueError(r.status, r.body)}`, r.status);
    return r.body;
  }

  function orderBody(o: LiveOrder) {
    return {
      product_id: o.symbol,
      side: o.side === "buy" ? "BUY" : "SELL",
      order_configuration: { limit_limit_gtc: { base_size: plainDecimal(o.quantity), limit_price: plainDecimal(o.limitPrice), post_only: false } },
    };
  }

  /** Recent orders (newest first), at most MAX_PAGES pages; stops early once `stop` matches. */
  async function listOrders(query: string, stop?: (o: CoinbaseOrder) => boolean): Promise<CoinbaseOrder[]> {
    const out: CoinbaseOrder[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = (await mustGet("/orders/historical/batch", `${query}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)) as {
        orders?: CoinbaseOrder[];
        has_next?: boolean;
        cursor?: string;
      };
      out.push(...(body.orders ?? []));
      if ((stop && body.orders?.some(stop)) || !body.has_next || !body.cursor) break;
      cursor = body.cursor;
    }
    return out;
  }

  async function findOrder(symbol: string, clientOrderId: string): Promise<CoinbaseOrder | undefined> {
    const match = (o: CoinbaseOrder) => o.client_order_id === clientOrderId;
    return (await listOrders(`product_ids=${encodeURIComponent(symbol)}`, match)).find(match);
  }

  const gtcOnly = (o: LiveOrder) => (o.timeInForce && o.timeInForce !== "GTC" ? "this adapter places GTC limit orders only on Coinbase" : undefined);

  return {
    venue: "coinbase",
    env: opts.env,

    async bookTop(symbol) {
      // Public: no JWT, no key on the wire for a price.
      const url = `https://${COINBASE_HOST}${COINBASE_PREFIX}/market/products/${encodeURIComponent(symbol)}/ticker?limit=1`;
      const res = await http({ method: "GET", url, timeoutMs });
      const b = parseBody(res.body) as { best_bid?: string; best_ask?: string };
      const bid = toNumber(b?.best_bid);
      const ask = toNumber(b?.best_ask);
      if (res.status !== 200 || bid === undefined || ask === undefined)
        throw new BrokerError("coinbase", `no book for ${symbol} (HTTP ${res.status})`, res.status);
      return { bid, ask, at: new Date(now()).toISOString() };
    },

    async permissions() {
      const b = (await mustGet("/key_permissions")) as { can_trade?: boolean; can_transfer?: boolean };
      return { canTrade: b.can_trade === true, canWithdraw: b.can_transfer !== false, source: "key_permissions" };
    },

    async balances() {
      const out: Balance[] = [];
      let cursor = "";
      for (let page = 0; page < MAX_PAGES; page++) {
        const b = (await mustGet("/accounts", `limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)) as {
          accounts?: { currency: string; available_balance?: { value: string }; hold?: { value: string } }[];
          has_next?: boolean;
          cursor?: string;
        };
        for (const a of b.accounts ?? []) {
          const free = toNumber(a.available_balance?.value) ?? 0;
          const locked = toNumber(a.hold?.value) ?? 0;
          if (free > 0 || locked > 0) out.push({ asset: a.currency, free, locked });
        }
        if (!b.has_next || !b.cursor) break;
        cursor = b.cursor;
      }
      return out;
    },

    async preview(o) {
      const refusal = gtcOnly(o);
      if (refusal) return { ok: false, message: refusal };
      const r = await authed("POST", "/orders/preview", "", orderBody(o));
      const errs = (r.body as { errs?: string[] })?.errs ?? [];
      if (r.status === 200 && !errs.length) return { ok: true, raw: r.body };
      return { ok: false, message: errs.length ? errs.join("; ") : venueError(r.status, r.body), raw: r.body };
    },

    async submit(o) {
      const refusal = gtcOnly(o);
      if (refusal) return notSent(o.clientOrderId, refusal);
      const previewOnly = opts.env === "test";
      let prepared: ReturnType<typeof prepare>;
      try {
        prepared = previewOnly
          ? prepare("POST", "/orders/preview", "", orderBody(o))
          : prepare("POST", "/orders", "", { client_order_id: o.clientOrderId, ...orderBody(o) });
      } catch (e) {
        return notSent(o.clientOrderId, (e as Error).message);
      }
      let r: { status: number; body: unknown };
      try {
        r = await send(prepared);
      } catch (e) {
        return { state: "unknown", clientOrderId: o.clientOrderId, message: (e as Error).message };
      }
      if (previewOnly) {
        const errs = (r.body as { errs?: string[] })?.errs ?? [];
        const ok = r.status === 200 && !errs.length;
        const why = ok ? "" : `: ${errs.length ? errs.join("; ") : venueError(r.status, r.body)}`;
        return { state: ok ? "accepted" : "rejected", clientOrderId: o.clientOrderId, message: `preview only${why}`, raw: r.body };
      }
      const b = r.body as { success?: boolean; success_response?: { order_id?: string } };
      if (r.status === 200 && b?.success === true) {
        return { state: "accepted", clientOrderId: o.clientOrderId, venueOrderId: b.success_response?.order_id, raw: r.body };
      }
      return { state: r.status >= 500 ? "unknown" : "rejected", clientOrderId: o.clientOrderId, message: venueError(r.status, r.body), raw: r.body };
    },

    async query(symbol, clientOrderId) {
      const o = await findOrder(symbol, clientOrderId);
      return o ? parseCoinbaseOrder(o) : undefined;
    },

    async cancel(symbol, clientOrderId) {
      const o = await findOrder(symbol, clientOrderId);
      if (!o?.order_id) return { state: "rejected", clientOrderId, message: "no Coinbase order carries this client_order_id" };
      const r = await authed("POST", "/orders/batch_cancel", "", { order_ids: [o.order_id] });
      const res = (r.body as { results?: { success?: boolean; failure_reason?: string }[] })?.results?.[0];
      if (r.status === 200 && res?.success) return { state: "cancelled", clientOrderId, venueOrderId: o.order_id, raw: r.body };
      return { state: "rejected", clientOrderId, venueOrderId: o.order_id, message: res?.failure_reason ?? venueError(r.status, r.body), raw: r.body };
    },

    async openOrders() {
      return (await listOrders("order_status=OPEN")).map(parseCoinbaseOrder);
    },
  };
}
