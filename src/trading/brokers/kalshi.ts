// Kalshi Trade API v2, for event contracts. env "test" is Kalshi's demo
// exchange (demo-api.kalshi.co, play money); "live" is the real exchange.
// A request is signed with the user's RSA key: base64(RSA-PSS-SHA256(
// timestamp + METHOD + path)), headers KALSHI-ACCESS-KEY / -TIMESTAMP /
// -SIGNATURE. The symbol is "<TICKER>:YES" or "<TICKER>:NO"; prices are in
// dollars per contract (0–1), sent as fixed-point strings on the V2 order
// endpoints (/portfolio/events/orders), which quote everything on the YES book.
//
// Whether a resident may trade Kalshi at all is decided before this adapter is
// reached (trading/live.ts): live needs the jurisdiction's "allowed" — never
// the case for France today.
import { constants, createPrivateKey, sign } from "node:crypto";
import { type AdapterOptions, BrokerError, credentialStrings, DEFAULT_TIMEOUT_MS, fetchHttp, scrubSecrets } from "./http.js";
import type { BrokerAdapter, OrderResult } from "./types.js";

const LIVE = "https://api.elections.kalshi.com";
const DEMO = "https://demo-api.kalshi.co";
const ROOT = "/trade-api/v2";

/** base64(RSA-PSS-SHA256(timestamp + method + path)), salt the digest's length — Kalshi's scheme. */
export function kalshiSign(pem: string, timestampMs: string, method: string, path: string): string {
  const key = createPrivateKey(pem.replace(/\\n/g, "\n"));
  return sign("sha256", Buffer.from(`${timestampMs}${method}${path.split("?")[0]}`), {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

const splitSym = (s: string) => {
  const m = /^([A-Z0-9._-]+):(YES|NO)$/i.exec(s);
  if (!m) throw new BrokerError("kalshi", `"${s}" is not <TICKER>:YES|NO`);
  return { ticker: m[1]!.toUpperCase(), side: m[2]!.toLowerCase() as "yes" | "no" };
};

/** An order as GET /portfolio/orders lists it (fixed-point strings). */
interface KalshiOrder {
  order_id?: string;
  client_order_id?: string;
  ticker?: string;
  side?: "yes" | "no";
  action?: "buy" | "sell";
  status?: "resting" | "canceled" | "executed";
  fill_count_fp?: string;
  remaining_count_fp?: string;
  taker_fill_cost_dollars?: string;
  maker_fill_cost_dollars?: string;
  taker_fees_dollars?: string;
  maker_fees_dollars?: string;
}

const n = (s?: string) => (s === undefined ? 0 : Number(s));

/**
 * An order in OUR outcome's terms: orders are placed on the YES book, so a NO
 * outcome's price is 1 − the YES price.
 */
export function parseKalshiOrder(o: KalshiOrder, clientOrderId: string, outcome: "yes" | "no" = "yes"): OrderResult {
  const filled = n(o.fill_count_fp);
  const remaining = n(o.remaining_count_fp);
  const state: OrderResult["state"] =
    o.status === "executed"
      ? "filled"
      : o.status === "canceled"
        ? filled > 0
          ? "partially-filled"
          : "cancelled"
        : o.status === "resting"
          ? filled > 0
            ? "partially-filled"
            : "accepted"
          : "unknown";
  const cost = n(o.taker_fill_cost_dollars) + n(o.maker_fill_cost_dollars);
  let avg = filled ? cost / filled : undefined;
  if (avg !== undefined && (o.side ?? "yes") !== outcome) avg = 1 - avg;
  return {
    state: state === "partially-filled" && remaining === 0 && o.status === "executed" ? "filled" : state,
    venueOrderId: o.order_id,
    clientOrderId: o.client_order_id ?? clientOrderId,
    filledQuantity: filled || undefined,
    averagePrice: avg === undefined ? undefined : Number(avg.toFixed(6)),
    fee: n(o.taker_fees_dollars) + n(o.maker_fees_dollars) || undefined,
    feeCurrency: "USD",
  };
}

/** The answer of POST /portfolio/events/orders (V2). */
export function parseKalshiCreate(
  r: { order_id?: string; client_order_id?: string; fill_count?: string; remaining_count?: string; average_fill_price?: string; average_fee_paid?: string },
  clientOrderId: string,
  outcome: "yes" | "no",
): OrderResult {
  const filled = n(r.fill_count);
  const remaining = n(r.remaining_count);
  const yesAvg = r.average_fill_price !== undefined ? Number(r.average_fill_price) : undefined;
  return {
    state: filled > 0 ? (remaining > 0 ? "partially-filled" : "filled") : "accepted",
    venueOrderId: r.order_id,
    clientOrderId: r.client_order_id ?? clientOrderId,
    filledQuantity: filled || undefined,
    averagePrice: yesAvg === undefined ? undefined : Number((outcome === "yes" ? yesAvg : 1 - yesAvg).toFixed(6)),
    fee: r.average_fee_paid !== undefined && filled ? Number((Number(r.average_fee_paid) * filled).toFixed(6)) : undefined,
    feeCurrency: "USD",
  };
}

export function kalshiAdapter(opts: AdapterOptions): BrokerAdapter {
  const http = opts.http ?? fetchHttp;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.env === "live" ? LIVE : DEMO;
  const secrets = credentialStrings(opts.creds);

  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; data: unknown; text: string }> {
    const ts = String(now());
    const full = `${ROOT}${path}`;
    let signature: string;
    try {
      signature = kalshiSign(opts.creds.secret, ts, method, full);
    } catch {
      throw new BrokerError("kalshi", "the stored secret is not an RSA private key (PEM)");
    }
    const r = await http({
      method,
      url: `${base}${full}`,
      headers: { "KALSHI-ACCESS-KEY": opts.creds.key, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": signature, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    const text = scrubSecrets(r.body, [...secrets, signature]);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { status: r.status, data, text };
  }
  const message = (d: unknown, text: string) => (d as { error?: { message?: string; code?: string } })?.error?.message ?? text.slice(0, 200);

  async function find(ticker: string, clientOrderId: string): Promise<KalshiOrder | undefined> {
    const r = await call("GET", `/portfolio/orders?ticker=${encodeURIComponent(ticker)}&limit=200`);
    if (r.status !== 200) throw new BrokerError("kalshi", `orders refused: ${message(r.data, r.text)}`, r.status);
    return ((r.data as { orders?: KalshiOrder[] }).orders ?? []).find((o) => o.client_order_id === clientOrderId);
  }

  return {
    venue: "kalshi",
    env: opts.env,
    async bookTop(symbol) {
      const { ticker, side } = splitSym(symbol);
      const r = await http({ method: "GET", url: `${base}${ROOT}/markets/${encodeURIComponent(ticker)}/orderbook`, timeoutMs });
      if (r.status !== 200) throw new BrokerError("kalshi", `orderbook ${ticker}: ${r.status}`, r.status);
      const ob =
        (JSON.parse(r.body) as { orderbook_fp?: { yes_dollars?: [string, string][] | null; no_dollars?: [string, string][] | null } }).orderbook_fp ?? {};
      const best = (rows?: [string, string][] | null) => Math.max(...(rows ?? []).map(([p]) => Number(p)), Number.NEGATIVE_INFINITY);
      const yesBid = best(ob.yes_dollars);
      const noBid = best(ob.no_dollars);
      // Books hold bids only: one side's ask is 1 − the other side's best bid.
      const bid = side === "yes" ? yesBid : noBid;
      const ask = side === "yes" ? 1 - noBid : 1 - yesBid;
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) throw new BrokerError("kalshi", `orderbook ${ticker} is one-sided or empty`);
      return { bid, ask, at: new Date(now()).toISOString() };
    },
    async permissions() {
      // Kalshi's API has no withdrawal endpoint for keys: an API key cannot move money out.
      return { canTrade: true, canWithdraw: false, source: "no withdrawal API" };
    },
    async balances() {
      const r = await call("GET", "/portfolio/balance");
      if (r.status !== 200) throw new BrokerError("kalshi", `balance refused: ${message(r.data, r.text)}`, r.status);
      return [{ asset: "USD", free: ((r.data as { balance?: number }).balance ?? 0) / 100, locked: 0 }];
    },
    async preview() {
      return { ok: false, message: "Kalshi has no order preview: use --env test (the demo exchange)" };
    },
    async submit(o) {
      const { ticker, side: outcome } = splitSym(o.symbol);
      // Everything is quoted on the YES book: buying NO at q is selling YES at 1 − q.
      const yesPrice = outcome === "yes" ? o.limitPrice : 1 - o.limitPrice;
      const bookSide = (outcome === "yes") === (o.side === "buy") ? "bid" : "ask";
      if (!(yesPrice > 0 && yesPrice < 1) || !(o.quantity >= 0.01))
        return { state: "rejected", clientOrderId: o.clientOrderId, message: "Kalshi prices are between 0 and 1, counts at least 0.01" };
      try {
        const r = await call("POST", "/portfolio/events/orders", {
          ticker,
          client_order_id: o.clientOrderId,
          side: bookSide,
          count: o.quantity.toFixed(2),
          price: yesPrice.toFixed(4),
          time_in_force: o.timeInForce === "IOC" ? "immediate_or_cancel" : "good_till_canceled",
          self_trade_prevention_type: "taker_at_cross",
        });
        if (r.status === 201 || r.status === 200) return parseKalshiCreate((r.data ?? {}) as Parameters<typeof parseKalshiCreate>[0], o.clientOrderId, outcome);
        if (r.status >= 500) return { state: "unknown", clientOrderId: o.clientOrderId, message: `Kalshi ${r.status}` };
        return { state: "rejected", clientOrderId: o.clientOrderId, message: message(r.data, r.text) };
      } catch (e) {
        if (e instanceof BrokerError) return { state: "rejected", clientOrderId: o.clientOrderId, message: e.message };
        return { state: "unknown", clientOrderId: o.clientOrderId, message: (e as Error).message };
      }
    },
    async query(symbol, clientOrderId) {
      const { ticker, side } = splitSym(symbol);
      const o = await find(ticker, clientOrderId);
      return o ? parseKalshiOrder(o, clientOrderId, side) : undefined;
    },
    async cancel(symbol, clientOrderId) {
      const { ticker, side } = splitSym(symbol);
      const o = await find(ticker, clientOrderId);
      if (!o?.order_id) return { state: "rejected", clientOrderId, message: "no Kalshi order carries this client_order_id" };
      const r = await call("DELETE", `/portfolio/events/orders/${encodeURIComponent(o.order_id)}`);
      if (r.status === 200)
        return { ...parseKalshiOrder({ ...o, status: "canceled" }, clientOrderId, side), state: n(o.fill_count_fp) > 0 ? "partially-filled" : "cancelled" };
      return { state: "rejected", clientOrderId, message: message(r.data, r.text) };
    },
    async openOrders() {
      const r = await call("GET", "/portfolio/orders?status=resting&limit=200");
      if (r.status !== 200) throw new BrokerError("kalshi", `orders refused: ${message(r.data, r.text)}`, r.status);
      return ((r.data as { orders?: KalshiOrder[] }).orders ?? []).map((o) => parseKalshiOrder(o, o.client_order_id ?? "", o.side ?? "yes"));
    },
  };
}
