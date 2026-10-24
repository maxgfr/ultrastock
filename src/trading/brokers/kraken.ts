// Kraken Spot REST adapter — LIMIT orders on the spot book, nothing else.
//
// Kraken has no spot testnet: env "test" sends every AddOrder with
// validate=true, so the engine checks the order and places nothing (the
// answer says "validated only"). Private calls are form-encoded POSTs carrying
// a strictly increasing `nonce`, signed
//   API-Sign = base64(HMAC-SHA512(path + SHA256(nonce + postdata), base64decode(secret)))
// Kraken answers HTTP 200 with `{ error: [...], result }`: a non-empty error is
// a refusal, except the service-side ones (Unavailable, Busy, Deadline
// elapsed, Internal error), after which the order's fate is "unknown".
//
// Kraken exposes no query of a key's rights, so `permissions` returns
// source "attested": the caller must have the user attest the key cannot
// withdraw before it goes live.
import { createHash, createHmac } from "node:crypto";
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
import type { Balance, BrokerAdapter, LiveOrder, OrderResult } from "./types.js";

const KRAKEN_BASE = "https://api.kraken.com";
const UNKNOWN_ERRORS = /^(EService:(Unavailable|Busy|Deadline elapsed)|EGeneral:Internal error)/;

/** Kraken's legacy asset codes → the usual tickers. Anything else passes through. */
const KRAKEN_ASSETS: Record<string, string> = {
  XXBT: "BTC",
  XBT: "BTC",
  XETH: "ETH",
  XXRP: "XRP",
  XLTC: "LTC",
  XXLM: "XLM",
  XXMR: "XMR",
  XZEC: "ZEC",
  XETC: "ETC",
  XREP: "REP",
  XMLN: "MLN",
  XXDG: "DOGE",
  XDG: "DOGE",
  ZEUR: "EUR",
  ZUSD: "USD",
  ZGBP: "GBP",
  ZCAD: "CAD",
  ZJPY: "JPY",
  ZCHF: "CHF",
  ZAUD: "AUD",
};

/** The API-Sign header for a private call. */
export function krakenSign(path: string, nonce: string, postdata: string, secretB64: string): string {
  const digest = createHash("sha256")
    .update(nonce + postdata)
    .digest();
  return createHmac("sha512", Buffer.from(secretB64, "base64"))
    .update(Buffer.concat([Buffer.from(path), digest]))
    .digest("base64");
}

/** Kraken's cl_ord_id: a UUID (long or 32-hex short form) or free text of at most 18 characters. */
export function krakenClientIdOk(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^[0-9a-f]{32}$/i.test(id) || (id.length > 0 && id.length <= 18);
}

interface KrakenOrder {
  status?: string;
  vol?: string;
  vol_exec?: string;
  price?: string;
  fee?: string;
  cl_ord_id?: string | null;
  reason?: string | null;
}

/** One entry of OpenOrders / ClosedOrders as an OrderResult. `price` is Kraken's average execution price. */
export function parseKrakenOrder(txid: string, o: KrakenOrder, clientOrderId: string): OrderResult {
  const filled = toNumber(o.vol_exec) ?? 0;
  const volume = toNumber(o.vol) ?? 0;
  let state: OrderResult["state"];
  if (o.status === "pending" || o.status === "open") state = filled > 0 ? "partially-filled" : "accepted";
  else if (o.status === "closed") state = volume > 0 && filled < volume ? "partially-filled" : "filled";
  else if (o.status === "canceled" || o.status === "expired") state = "cancelled";
  else state = "unknown";
  const r: OrderResult = { state, venueOrderId: txid, clientOrderId: o.cl_ord_id ?? clientOrderId, raw: o };
  if (filled > 0) {
    r.filledQuantity = filled;
    r.averagePrice = toNumber(o.price);
    r.fee = toNumber(o.fee);
  }
  if (o.reason) r.message = o.reason;
  else if (o.status === "expired") r.message = "expired";
  return r;
}

export function krakenAdapter(opts: AdapterOptions): BrokerAdapter {
  const http = opts.http ?? fetchHttp;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets = credentialStrings(opts.creds);
  let lastNonce = 0;

  /** Strictly increasing even when the clock stalls or two calls share a millisecond. */
  function nextNonce(): string {
    lastNonce = Math.max(now(), lastNonce + 1);
    return String(lastNonce);
  }

  /** One signed private call; the answer is scrubbed of the key, the secret and this signature. */
  async function privateCall(method: string, params: Record<string, string>) {
    const path = `/0/private/${method}`;
    const nonce = nextNonce();
    const form: Record<string, string> = { nonce, ...params };
    if (opts.creds.passphrase) form.otp = opts.creds.passphrase;
    const postdata = new URLSearchParams(form).toString();
    const sign = krakenSign(path, nonce, postdata, opts.creds.secret);
    const res = await http({
      method: "POST",
      url: `${KRAKEN_BASE}${path}`,
      headers: { "API-Key": opts.creds.key, "API-Sign": sign, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: postdata,
      timeoutMs,
    });
    const body = parseBody(scrubSecrets(res.body, [...secrets, sign])) as { error?: string[]; result?: unknown };
    const errors = Array.isArray(body?.error) ? body.error : res.status === 200 ? [] : [`HTTP ${res.status}`];
    return { status: res.status, errors, result: body?.result, raw: body };
  }

  /** Throw unless the call went through. */
  async function mustCall(method: string, params: Record<string, string>) {
    const r = await privateCall(method, params);
    if (r.status !== 200 || r.errors.length) throw new BrokerError("kraken", `${method} refused: ${r.errors.join("; ") || `HTTP ${r.status}`}`, r.status);
    return r.result;
  }

  function orderParams(o: LiveOrder): Record<string, string> {
    const p: Record<string, string> = {
      ordertype: "limit",
      type: o.side,
      volume: plainDecimal(o.quantity),
      price: plainDecimal(o.limitPrice),
      pair: o.symbol,
      cl_ord_id: o.clientOrderId,
    };
    if (o.timeInForce === "IOC") p.timeinforce = "IOC";
    return p;
  }

  function localRefusal(o: LiveOrder): string | undefined {
    if (o.timeInForce === "DAY") return "Kraken has no DAY time in force (GTC or IOC)";
    if (!krakenClientIdOk(o.clientOrderId)) return "Kraken's cl_ord_id must be a UUID or at most 18 characters";
    return undefined;
  }

  async function findOrder(clientOrderId: string): Promise<OrderResult | undefined> {
    for (const [method, key] of [
      ["OpenOrders", "open"],
      ["ClosedOrders", "closed"],
    ] as const) {
      const result = (await mustCall(method, { cl_ord_id: clientOrderId })) as Record<string, Record<string, KrakenOrder>> | undefined;
      const hit = Object.entries(result?.[key] ?? {}).find(([, o]) => (o.cl_ord_id ?? clientOrderId) === clientOrderId);
      if (hit) return parseKrakenOrder(hit[0], hit[1], clientOrderId);
    }
    return undefined;
  }

  return {
    venue: "kraken",
    env: opts.env,

    async bookTop(symbol) {
      const res = await http({ method: "GET", url: `${KRAKEN_BASE}/0/public/Ticker?pair=${encodeURIComponent(symbol)}`, timeoutMs });
      const body = parseBody(res.body) as { error?: string[]; result?: Record<string, { a?: string[]; b?: string[] }> };
      // The result is keyed by Kraken's own pair name (XBTEUR → XXBTZEUR): take the only entry.
      const t = Object.values(body?.result ?? {})[0];
      const bid = toNumber(t?.b?.[0]);
      const ask = toNumber(t?.a?.[0]);
      if (bid === undefined || ask === undefined)
        throw new BrokerError("kraken", `no book for ${symbol}: ${body?.error?.join("; ") || `HTTP ${res.status}`}`, res.status);
      return { bid, ask, at: new Date(now()).toISOString() };
    },

    async permissions() {
      return { canTrade: true, canWithdraw: false, source: "attested" };
    },

    async balances() {
      const result = (await mustCall("Balance", {})) as Record<string, string> | undefined;
      // Balance gives totals only: what open orders hold is not split out (locked = 0).
      return Object.entries(result ?? {})
        .map(([asset, v]): Balance => ({ asset: KRAKEN_ASSETS[asset] ?? asset, free: Number(v), locked: 0 }))
        .filter((b) => b.free > 0);
    },

    async preview(o) {
      const refusal = localRefusal(o);
      if (refusal) return { ok: false, message: refusal };
      const r = await privateCall("AddOrder", { ...orderParams(o), validate: "true" });
      if (r.status === 200 && !r.errors.length) return { ok: true, raw: r.raw };
      return { ok: false, message: r.errors.join("; "), raw: r.raw };
    },

    async submit(o) {
      const refusal = localRefusal(o);
      if (refusal) return notSent(o.clientOrderId, refusal);
      const validateOnly = opts.env === "test";
      const params = orderParams(o);
      if (validateOnly) params.validate = "true";
      let r: Awaited<ReturnType<typeof privateCall>>;
      try {
        r = await privateCall("AddOrder", params);
      } catch (e) {
        return { state: "unknown", clientOrderId: o.clientOrderId, message: (e as Error).message };
      }
      if (r.status === 200 && !r.errors.length) {
        const txid = (r.result as { txid?: string[] } | undefined)?.txid?.[0];
        if (validateOnly) return { state: "accepted", clientOrderId: o.clientOrderId, message: "validated only", raw: r.raw };
        return { state: "accepted", clientOrderId: o.clientOrderId, venueOrderId: txid, raw: r.raw };
      }
      const unknown = r.status >= 500 || r.errors.some((e) => UNKNOWN_ERRORS.test(e));
      const message = r.errors.join("; ") + (validateOnly ? " (validated only)" : "");
      return { state: unknown && !validateOnly ? "unknown" : "rejected", clientOrderId: o.clientOrderId, message, raw: r.raw };
    },

    async query(_symbol, clientOrderId) {
      return findOrder(clientOrderId);
    },

    async cancel(_symbol, clientOrderId) {
      const r = await privateCall("CancelOrder", { cl_ord_id: clientOrderId });
      const result = r.result as { count?: number; pending?: boolean } | undefined;
      if (r.status === 200 && !r.errors.length && (result?.count ?? 0) > 0) {
        return { state: "cancelled", clientOrderId, message: result?.pending ? "cancellation pending" : undefined, raw: r.raw };
      }
      return { state: "rejected", clientOrderId, message: r.errors.join("; ") || "no order cancelled", raw: r.raw };
    },

    async openOrders() {
      const result = (await mustCall("OpenOrders", {})) as { open?: Record<string, KrakenOrder> } | undefined;
      return Object.entries(result?.open ?? {}).map(([txid, o]) => parseKrakenOrder(txid, o, o.cl_ord_id ?? ""));
    },
  };
}
