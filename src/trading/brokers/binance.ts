// Binance Spot REST adapter — LIMIT orders on the spot book, nothing else.
//
//   live  https://api.binance.com        test  https://testnet.binance.vision (fake funds)
//
// Signed calls carry every parameter in the query string, `timestamp` and
// `recvWindow=5000`, then `signature` = HMAC-SHA256(query, secret) in hex, and
// the key in the X-MBX-APIKEY header. Binance documents HTTP 5xx and codes
// -1006/-1007 on an order as "execution status unknown": those become state
// "unknown", for the transport to reconcile by origClientOrderId.
import { createHmac } from "node:crypto";
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

const BINANCE_LIVE = "https://api.binance.com";
const BINANCE_TEST = "https://testnet.binance.vision";
const UNKNOWN_CODES = new Set([-1006, -1007]);

/** The `signature` parameter: HMAC-SHA256 of the exact query string, hex. */
export function binanceSign(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

const BINANCE_STATES: Record<string, OrderState> = {
  NEW: "accepted",
  PENDING_NEW: "accepted",
  PENDING_CANCEL: "accepted",
  PARTIALLY_FILLED: "partially-filled",
  FILLED: "filled",
  CANCELED: "cancelled",
  EXPIRED: "cancelled",
  EXPIRED_IN_MATCH: "cancelled",
  REJECTED: "rejected",
};

interface BinanceOrder {
  orderId?: number;
  clientOrderId?: string;
  origClientOrderId?: string;
  status?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  fills?: { price: string; qty: string; commission: string; commissionAsset: string }[];
}

/** An order answer (FULL response, order query, cancel) as an OrderResult. */
export function parseBinanceOrder(o: BinanceOrder, clientOrderId: string): OrderResult {
  const state = BINANCE_STATES[o.status ?? ""] ?? "unknown";
  const filled = toNumber(o.executedQty) ?? 0;
  // On a cancel, clientOrderId is the cancel's own id and origClientOrderId is ours.
  const r: OrderResult = { state, clientOrderId: o.origClientOrderId ?? o.clientOrderId ?? clientOrderId, raw: o };
  if (o.orderId !== undefined) r.venueOrderId = String(o.orderId);
  if (filled > 0) r.filledQuantity = filled;
  const fills = o.fills ?? [];
  const fillQty = fills.reduce((s, f) => s + Number(f.qty), 0);
  if (fillQty > 0) r.averagePrice = fills.reduce((s, f) => s + Number(f.price) * Number(f.qty), 0) / fillQty;
  else if (filled > 0 && toNumber(o.cummulativeQuoteQty)) r.averagePrice = toNumber(o.cummulativeQuoteQty)! / filled;
  if (fills.length) {
    // Commissions are summed in the first fill's asset; a mixed-asset fee (BNB on some fills only) is said so.
    const asset = fills[0]!.commissionAsset;
    r.fee = fills.filter((f) => f.commissionAsset === asset).reduce((s, f) => s + Number(f.commission), 0);
    r.feeCurrency = asset;
    if (fills.some((f) => f.commissionAsset !== asset)) r.message = "fees paid in more than one asset: see raw";
  }
  if (o.status === "EXPIRED" || o.status === "EXPIRED_IN_MATCH") r.message = `expired (${o.status})`;
  return r;
}

export function binanceAdapter(opts: AdapterOptions): BrokerAdapter {
  const http = opts.http ?? fetchHttp;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.env === "live" ? BINANCE_LIVE : BINANCE_TEST;
  const secrets = credentialStrings(opts.creds);

  /** One signed request; the answer is scrubbed of the key, the secret and this signature. */
  async function signed(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string>) {
    const query = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(now()) }).toString();
    const signature = binanceSign(query, opts.creds.secret);
    const res = await http({ method, url: `${base}${path}?${query}&signature=${signature}`, headers: { "X-MBX-APIKEY": opts.creds.key }, timeoutMs });
    const body = parseBody(scrubSecrets(res.body, [...secrets, signature]));
    return { status: res.status, body };
  }

  function venueError(status: number, body: unknown): { code?: number; message: string } {
    const b = body as { code?: number; msg?: string };
    return { code: b?.code, message: b?.msg ? `${b.msg}${b.code !== undefined ? ` (${b.code})` : ""}` : `HTTP ${status}` };
  }

  function orderParams(o: LiveOrder): Record<string, string> {
    return {
      symbol: o.symbol,
      side: o.side === "buy" ? "BUY" : "SELL",
      type: "LIMIT",
      timeInForce: o.timeInForce ?? "GTC",
      quantity: plainDecimal(o.quantity),
      price: plainDecimal(o.limitPrice),
      newClientOrderId: o.clientOrderId,
    };
  }

  return {
    venue: "binance",
    env: opts.env,

    async bookTop(symbol) {
      const res = await http({ method: "GET", url: `${base}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, timeoutMs });
      const b = parseBody(res.body) as { bidPrice?: string; askPrice?: string };
      const bid = toNumber(b?.bidPrice);
      const ask = toNumber(b?.askPrice);
      if (res.status !== 200 || bid === undefined || ask === undefined)
        throw new BrokerError("binance", `no book for ${symbol} (HTTP ${res.status})`, res.status);
      return { bid, ask, at: new Date(now()).toISOString() };
    },

    async permissions() {
      // The testnet has no /sapi: its keys only ever move fake funds.
      if (opts.env === "test") return { canTrade: true, canWithdraw: false, source: "testnet" };
      const { status, body } = await signed("GET", "/sapi/v1/account/apiRestrictions", {});
      if (status !== 200) throw new BrokerError("binance", `apiRestrictions refused: ${venueError(status, body).message}`, status);
      const b = body as { enableSpotAndMarginTrading?: boolean; enableWithdrawals?: boolean };
      return { canTrade: b.enableSpotAndMarginTrading === true, canWithdraw: b.enableWithdrawals !== false, source: "apiRestrictions" };
    },

    async balances() {
      const { status, body } = await signed("GET", "/api/v3/account", {});
      if (status !== 200) throw new BrokerError("binance", `account refused: ${venueError(status, body).message}`, status);
      const rows = (body as { balances?: { asset: string; free: string; locked: string }[] }).balances ?? [];
      return rows.map((b): Balance => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) })).filter((b) => b.free > 0 || b.locked > 0);
    },

    async preview(o) {
      if (o.timeInForce === "DAY") return { ok: false, message: "Binance has no DAY time in force (GTC or IOC)" };
      const { status, body } = await signed("POST", "/api/v3/order/test", orderParams(o));
      if (status === 200) return { ok: true, raw: body };
      return { ok: false, message: venueError(status, body).message, raw: body };
    },

    async submit(o) {
      if (o.timeInForce === "DAY") return notSent(o.clientOrderId, "Binance has no DAY time in force (GTC or IOC)");
      let res: { status: number; body: unknown };
      try {
        res = await signed("POST", "/api/v3/order", { ...orderParams(o), newOrderRespType: "FULL" });
      } catch (e) {
        return { state: "unknown", clientOrderId: o.clientOrderId, message: (e as Error).message };
      }
      if (res.status === 200) return parseBinanceOrder(res.body as BinanceOrder, o.clientOrderId);
      const err = venueError(res.status, res.body);
      const unknown = res.status >= 500 || (err.code !== undefined && UNKNOWN_CODES.has(err.code));
      return { state: unknown ? "unknown" : "rejected", clientOrderId: o.clientOrderId, message: err.message, raw: res.body };
    },

    async query(symbol, clientOrderId) {
      const { status, body } = await signed("GET", "/api/v3/order", { symbol, origClientOrderId: clientOrderId });
      if (status === 200) return parseBinanceOrder(body as BinanceOrder, clientOrderId);
      const err = venueError(status, body);
      if (err.code === -2013) return undefined; // "Order does not exist."
      throw new BrokerError("binance", `order query refused: ${err.message}`, status);
    },

    async cancel(symbol, clientOrderId) {
      const { status, body } = await signed("DELETE", "/api/v3/order", { symbol, origClientOrderId: clientOrderId });
      if (status === 200) return parseBinanceOrder(body as BinanceOrder, clientOrderId);
      return { state: "rejected", clientOrderId, message: venueError(status, body).message, raw: body };
    },

    async openOrders() {
      const { status, body } = await signed("GET", "/api/v3/openOrders", {});
      if (status !== 200) throw new BrokerError("binance", `openOrders refused: ${venueError(status, body).message}`, status);
      return (body as BinanceOrder[]).map((o) => parseBinanceOrder(o, o.clientOrderId ?? ""));
    },
  };
}
