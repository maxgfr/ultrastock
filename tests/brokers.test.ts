import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { binanceAdapter, binanceSign } from "../src/trading/brokers/binance.js";
import { coinbaseAdapter, coinbaseJwt, pemFromSecret } from "../src/trading/brokers/coinbase.js";
import { plainDecimal, scrubSecrets } from "../src/trading/brokers/http.js";
import { ibkrAccountRefusal, ibkrAdapter, pinnedHttps, sameFingerprint } from "../src/trading/brokers/ibkr.js";
import { krakenAdapter, krakenClientIdOk, krakenSign } from "../src/trading/brokers/kraken.js";
import type { HttpFn, LiveOrder } from "../src/trading/brokers/types.js";

type Req = Parameters<HttpFn>[0];
type Answer = { status: number; body: unknown } | Error | ((req: Req) => { status: number; body: unknown });

/** A mock transport answering in order (the last answer repeats) and recording every request. */
function mockHttp(...answers: Answer[]) {
  const calls: Req[] = [];
  const http: HttpFn = async (req) => {
    calls.push(req);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    const r = typeof a === "function" ? a(req) : a;
    return { status: r.status, body: typeof r.body === "string" ? r.body : JSON.stringify(r.body) };
  };
  return { http, calls };
}

const NOW = 1_700_000_000_000;
const now = () => NOW;
const order = (over: Partial<LiveOrder> = {}): LiveOrder => ({
  symbol: "BTCUSDT",
  side: "buy",
  quantity: 0.001,
  limitPrice: 60000,
  clientOrderId: "us-abc123",
  ...over,
});

// Official vectors.
const BINANCE_SECRET = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
const KRAKEN_SECRET = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==";
const API_KEY = "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A";

/** No credential, and no signature taken from the requests, anywhere in what came back. */
function expectClean(result: unknown, secrets: string[]) {
  const text = JSON.stringify(result);
  for (const s of secrets) expect(text).not.toContain(s);
}

describe("plain decimals and scrubbing", () => {
  it("never prints exponent notation", () => {
    expect(plainDecimal(1e-7)).toBe("0.0000001");
    expect(plainDecimal(1.5e-8)).toBe("0.000000015");
    expect(plainDecimal(0.1)).toBe("0.1");
    expect(plainDecimal(60000)).toBe("60000");
    expect(plainDecimal(1e21)).toBe("1000000000000000000000");
    expect(plainDecimal(-2.5e-7)).toBe("-0.00000025");
    expect(() => plainDecimal(Number.NaN)).toThrow();
  });

  it("scrubs credentials but leaves short strings alone", () => {
    expect(scrubSecrets(`bad key ${API_KEY}`, [API_KEY, "a"])).toBe("bad key [redacted]");
  });
});

describe("binance", () => {
  it("signs the official vector", () => {
    const q = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(binanceSign(q, BINANCE_SECRET)).toBe("c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });

  const creds = { key: API_KEY, secret: BINANCE_SECRET };

  it("submits one signed LIMIT order to the testnet and parses a FULL answer", async () => {
    const m = mockHttp({
      status: 200,
      body: {
        symbol: "BTCUSDT",
        orderId: 42,
        clientOrderId: "us-abc123",
        status: "FILLED",
        executedQty: "0.00100000",
        cummulativeQuoteQty: "59.9",
        fills: [
          { price: "59900", qty: "0.0006", commission: "0.0000006", commissionAsset: "BTC" },
          { price: "59900", qty: "0.0004", commission: "0.0000004", commissionAsset: "BTC" },
        ],
      },
    });
    const a = binanceAdapter({ env: "test", creds, http: m.http, now });
    const r = await a.submit(order({ quantity: 1e-7 }));
    expect(m.calls).toHaveLength(1);
    const req = m.calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url.startsWith("https://testnet.binance.vision/api/v3/order?")).toBe(true);
    expect(req.url).toContain("type=LIMIT&timeInForce=GTC&quantity=0.0000001&price=60000&newClientOrderId=us-abc123&newOrderRespType=FULL");
    expect(req.url).toContain(`timestamp=${NOW}`);
    expect(req.headers?.["X-MBX-APIKEY"]).toBe(API_KEY);
    const query = req.url.slice(req.url.indexOf("?") + 1, req.url.lastIndexOf("&signature="));
    expect(req.url.endsWith(`&signature=${binanceSign(query, BINANCE_SECRET)}`)).toBe(true);
    expect(r).toMatchObject({
      state: "filled",
      venueOrderId: "42",
      clientOrderId: "us-abc123",
      filledQuantity: 0.001,
      averagePrice: 59900,
      feeCurrency: "BTC",
    });
    expect(r.fee).toBeCloseTo(0.000001, 12);
  });

  it("uses the live base in env live", async () => {
    const m = mockHttp({ status: 200, body: { orderId: 1, clientOrderId: "us-abc123", status: "NEW", executedQty: "0" } });
    const r = await binanceAdapter({ env: "live", creds, http: m.http, now }).submit(order());
    expect(m.calls[0]!.url.startsWith("https://api.binance.com/api/v3/order?")).toBe(true);
    expect(r.state).toBe("accepted");
  });

  it("reports a venue refusal as rejected, with no credential nor signature in it", async () => {
    // A hostile echo: the venue repeats the signature and the key in its message.
    const m = mockHttp((req) => {
      const sig = req.url.slice(req.url.lastIndexOf("=") + 1);
      return { status: 400, body: { code: -2010, msg: `Account has insufficient balance (sig ${sig}, key ${API_KEY})` } };
    });
    const r = await binanceAdapter({ env: "live", creds, http: m.http, now }).submit(order());
    expect(r.state).toBe("rejected");
    expect(r.message).toContain("insufficient balance");
    const sig = m.calls[0]!.url.slice(m.calls[0]!.url.lastIndexOf("=") + 1);
    expectClean(r, [API_KEY, BINANCE_SECRET, sig]);
  });

  it("a timeout or a 5xx is unknown, sent exactly once", async () => {
    const m = mockHttp(new Error("timeout after 10000 ms"));
    const r = await binanceAdapter({ env: "live", creds, http: m.http, now }).submit(order());
    expect(r).toMatchObject({ state: "unknown", clientOrderId: "us-abc123" });
    expect(m.calls).toHaveLength(1);
    const m5 = mockHttp({ status: 503, body: { code: -1007, msg: "Timeout waiting for response from backend server. Send status unknown" } });
    expect((await binanceAdapter({ env: "live", creds, http: m5.http, now }).submit(order())).state).toBe("unknown");
    expect(m5.calls).toHaveLength(1);
  });

  it("queries by origClientOrderId; a missing order is undefined", async () => {
    const m = mockHttp(
      { status: 200, body: { orderId: 7, clientOrderId: "us-abc123", status: "PARTIALLY_FILLED", executedQty: "0.0005", cummulativeQuoteQty: "30" } },
      { status: 400, body: { code: -2013, msg: "Order does not exist." } },
    );
    const a = binanceAdapter({ env: "live", creds, http: m.http, now });
    expect(await a.query("BTCUSDT", "us-abc123")).toMatchObject({ state: "partially-filled", filledQuantity: 0.0005, averagePrice: 60000, venueOrderId: "7" });
    expect(m.calls[0]!.url).toContain("/api/v3/order?symbol=BTCUSDT&origClientOrderId=us-abc123");
    expect(await a.query("BTCUSDT", "nope")).toBeUndefined();
  });

  it("cancels by origClientOrderId and reads permissions (testnet has no /sapi)", async () => {
    const m = mockHttp(
      { status: 200, body: { orderId: 7, origClientOrderId: "us-abc123", clientOrderId: "cancel-1", status: "CANCELED", executedQty: "0" } },
      { status: 200, body: { enableWithdrawals: false, enableSpotAndMarginTrading: true } },
    );
    const a = binanceAdapter({ env: "live", creds, http: m.http, now });
    expect(await a.cancel("BTCUSDT", "us-abc123")).toMatchObject({ state: "cancelled", clientOrderId: "us-abc123" });
    expect(m.calls[0]!.method).toBe("DELETE");
    expect(await a.permissions()).toEqual({ canTrade: true, canWithdraw: false, source: "apiRestrictions" });
    expect(m.calls[1]!.url).toContain("/sapi/v1/account/apiRestrictions?");
    expect(await binanceAdapter({ env: "test", creds, http: mockHttp().http, now }).permissions()).toMatchObject({ canWithdraw: false, source: "testnet" });
  });
});

describe("kraken", () => {
  it("signs the official vector", () => {
    const post = "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25";
    expect(krakenSign("/0/private/AddOrder", "1616492376594", post, KRAKEN_SECRET)).toBe(
      "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==",
    );
  });

  const creds = { key: API_KEY, secret: KRAKEN_SECRET };
  const kOrder = (over: Partial<LiveOrder> = {}) => order({ symbol: "XBTEUR", ...over });

  it("submits a form-encoded AddOrder with cl_ord_id and increasing nonces", async () => {
    const m = mockHttp({ status: 200, body: { error: [], result: { descr: { order: "buy 0.001 XBTEUR @ limit 60000" }, txid: ["OABC-123"] } } });
    const a = krakenAdapter({ env: "live", creds, http: m.http, now });
    const r = await a.submit(kOrder());
    expect(r).toMatchObject({ state: "accepted", venueOrderId: "OABC-123" });
    const req = m.calls[0]!;
    expect(req.url).toBe("https://api.kraken.com/0/private/AddOrder");
    expect(req.body).toBe(`nonce=${NOW}&ordertype=limit&type=buy&volume=0.001&price=60000&pair=XBTEUR&cl_ord_id=us-abc123`);
    expect(req.headers?.["API-Sign"]).toBe(krakenSign("/0/private/AddOrder", String(NOW), req.body!, KRAKEN_SECRET));
    expect(req.body).not.toContain("validate");
    expect(req.body).not.toContain("oflags");
    await a.submit(kOrder());
    expect(m.calls[1]!.body).toContain(`nonce=${NOW + 1}&`);
  });

  it('env "test" validates only', async () => {
    const m = mockHttp({ status: 200, body: { error: [], result: { descr: { order: "buy 0.001 XBTEUR @ limit 60000" } } } });
    const r = await krakenAdapter({ env: "test", creds, http: m.http, now }).submit(kOrder());
    expect(m.calls[0]!.body).toContain("validate=true");
    expect(r).toMatchObject({ state: "accepted", message: "validated only" });
    expect(r.venueOrderId).toBeUndefined();
  });

  it("an error array is a refusal; a service error or a timeout is unknown, sent once", async () => {
    const m = mockHttp((req) => ({ status: 200, body: { error: [`EOrder:Insufficient funds ${req.headers?.["API-Sign"]} ${API_KEY}`] } }));
    const r = await krakenAdapter({ env: "live", creds, http: m.http, now }).submit(kOrder());
    expect(r.state).toBe("rejected");
    expect(r.message).toContain("EOrder:Insufficient funds");
    expectClean(r, [API_KEY, KRAKEN_SECRET, m.calls[0]!.headers!["API-Sign"]!]);

    const busy = mockHttp({ status: 200, body: { error: ["EService:Unavailable"] } });
    expect((await krakenAdapter({ env: "live", creds, http: busy.http, now }).submit(kOrder())).state).toBe("unknown");
    const t = mockHttp(new Error("timeout after 10000 ms"));
    expect((await krakenAdapter({ env: "live", creds, http: t.http, now }).submit(kOrder())).state).toBe("unknown");
    expect(t.calls).toHaveLength(1);
  });

  it("refuses locally a cl_ord_id Kraken would not take", async () => {
    expect(krakenClientIdOk("us-abc123")).toBe(true);
    expect(krakenClientIdOk("0f8c7a2e-1b3d-4c5e-9f60-7a8b9c0d1e2f")).toBe(true);
    const m = mockHttp();
    const r = await krakenAdapter({ env: "live", creds, http: m.http, now }).submit(kOrder({ clientOrderId: "a-much-too-long-client-id-for-kraken" }));
    expect(r.state).toBe("rejected");
    expect(m.calls).toHaveLength(0);
  });

  it("queries OpenOrders then ClosedOrders by cl_ord_id", async () => {
    const m = mockHttp(
      { status: 200, body: { error: [], result: { open: {} } } },
      {
        status: 200,
        body: {
          error: [],
          result: {
            closed: { "OXYZ-1": { status: "closed", vol: "0.001", vol_exec: "0.001", price: "59950", fee: "0.15", cl_ord_id: "us-abc123" } },
            count: 1,
          },
        },
      },
    );
    const r = await krakenAdapter({ env: "live", creds, http: m.http, now }).query("XBTEUR", "us-abc123");
    expect(r).toMatchObject({ state: "filled", venueOrderId: "OXYZ-1", filledQuantity: 0.001, averagePrice: 59950, fee: 0.15 });
    expect(m.calls.map((c) => c.url)).toEqual(["https://api.kraken.com/0/private/OpenOrders", "https://api.kraken.com/0/private/ClosedOrders"]);
    expect(m.calls[0]!.body).toContain("cl_ord_id=us-abc123");
  });

  it("maps legacy asset codes, and has no permission query", async () => {
    const m = mockHttp({ status: 200, body: { error: [], result: { XXBT: "0.5", ZEUR: "1200.50", DOT: "0" } } });
    const a = krakenAdapter({ env: "live", creds, http: m.http, now });
    expect(await a.balances()).toEqual([
      { asset: "BTC", free: 0.5, locked: 0 },
      { asset: "EUR", free: 1200.5, locked: 0 },
    ]);
    expect(await a.permissions()).toEqual({ canTrade: true, canWithdraw: false, source: "attested" });
  });
});

describe("coinbase", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
  const keyName = "organizations/org-1/apiKeys/key-1";
  // As pasted into a JSON file: literal "\n".
  const creds = { key: keyName, keyName, secret: pem.replace(/\n/g, "\\n") };
  const cOrder = (over: Partial<LiveOrder> = {}) => order({ symbol: "BTC-EUR", ...over });

  it("builds an ES256 JWT that verifies with the public key", () => {
    const jwt = coinbaseJwt(keyName, creds.secret, "POST api.coinbase.com/api/v3/brokerage/orders", 1_700_000_000, "abcd");
    const [h, p, s] = jwt.split(".");
    const header = JSON.parse(Buffer.from(h!, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(header).toEqual({ alg: "ES256", kid: keyName, nonce: "abcd", typ: "JWT" });
    expect(payload).toEqual({ sub: keyName, iss: "cdp", nbf: 1_700_000_000, exp: 1_700_000_120, uri: "POST api.coinbase.com/api/v3/brokerage/orders" });
    const sig = Buffer.from(s!, "base64url");
    expect(sig).toHaveLength(64); // raw r||s, not DER
    const pub = createPublicKey(pemFromSecret(creds.secret));
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("submits a limit_limit_gtc order with client_order_id", async () => {
    const m = mockHttp({ status: 200, body: { success: true, success_response: { order_id: "cb-1", client_order_id: "us-abc123" } } });
    const r = await coinbaseAdapter({ env: "live", creds, http: m.http, now }).submit(cOrder({ quantity: 1e-7 }));
    expect(r).toMatchObject({ state: "accepted", venueOrderId: "cb-1" });
    const req = m.calls[0]!;
    expect(req.url).toBe("https://api.coinbase.com/api/v3/brokerage/orders");
    expect(JSON.parse(req.body!)).toEqual({
      client_order_id: "us-abc123",
      product_id: "BTC-EUR",
      side: "BUY",
      order_configuration: { limit_limit_gtc: { base_size: "0.0000001", limit_price: "60000", post_only: false } },
    });
    const jwt = req.headers!.Authorization!.slice("Bearer ".length);
    expect(JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).uri).toBe("POST api.coinbase.com/api/v3/brokerage/orders");
  });

  it('env "test" only previews', async () => {
    const m = mockHttp({ status: 200, body: { order_total: "60", commission_total: "0.36", errs: [], warning: [] } });
    const r = await coinbaseAdapter({ env: "test", creds, http: m.http, now }).submit(cOrder());
    expect(m.calls[0]!.url).toBe("https://api.coinbase.com/api/v3/brokerage/orders/preview");
    expect(r).toMatchObject({ state: "accepted", message: "preview only" });
  });

  it("a refusal is rejected and clean; a timeout is unknown, sent once", async () => {
    const m = mockHttp((req) => ({
      status: 200,
      body: { success: false, error_response: { new_order_failure_reason: "INSUFFICIENT_FUND", message: `no funds ${req.headers?.Authorization}` } },
    }));
    const r = await coinbaseAdapter({ env: "live", creds, http: m.http, now }).submit(cOrder());
    expect(r.state).toBe("rejected");
    expect(r.message).toContain("INSUFFICIENT_FUND");
    expectClean(r, [m.calls[0]!.headers!.Authorization!.slice(7), pem.split("\n")[1]!, keyName]);

    const t = mockHttp(new Error("network error (ECONNRESET)"));
    expect((await coinbaseAdapter({ env: "live", creds, http: t.http, now }).submit(cOrder())).state).toBe("unknown");
    expect(t.calls).toHaveLength(1);
  });

  it("finds an order by client_order_id in the product's recent orders", async () => {
    const m = mockHttp(
      {
        status: 200,
        body: {
          orders: [{ order_id: "x", client_order_id: "other", status: "OPEN" }],
          has_next: true,
          cursor: "c2",
        },
      },
      {
        status: 200,
        body: {
          orders: [
            {
              order_id: "cb-1",
              client_order_id: "us-abc123",
              status: "OPEN",
              filled_size: "0.0004",
              average_filled_price: "59990",
              total_fees: "0.1",
              product_id: "BTC-EUR",
            },
          ],
          has_next: false,
        },
      },
    );
    const r = await coinbaseAdapter({ env: "live", creds, http: m.http, now }).query("BTC-EUR", "us-abc123");
    expect(r).toMatchObject({ state: "partially-filled", venueOrderId: "cb-1", filledQuantity: 0.0004, averagePrice: 59990, fee: 0.1, feeCurrency: "EUR" });
    expect(m.calls[1]!.url).toContain("product_ids=BTC-EUR&limit=100&cursor=c2");
  });

  it("maps key permissions (can_transfer → canWithdraw)", async () => {
    const m = mockHttp({ status: 200, body: { can_view: true, can_trade: true, can_transfer: false } });
    expect(await coinbaseAdapter({ env: "live", creds, http: m.http, now }).permissions()).toEqual({
      canTrade: true,
      canWithdraw: false,
      source: "key_permissions",
    });
  });
});

describe("ibkr", () => {
  const creds = { key: "DU1234567", secret: "" };
  const accounts = { status: 200, body: { accounts: ["DU1234567"], selectedAccount: "DU1234567", isPaper: true } };
  const iOrder = (over: Partial<LiveOrder> = {}) => order({ symbol: "265598", quantity: 5, limitPrice: 150, ...over });
  const posts = (calls: Req[]) => calls.filter((c) => c.method === "POST");

  it("previews with whatif", async () => {
    const m = mockHttp(accounts, { status: 200, body: { amount: { amount: "750 USD" }, warn: null, error: null } });
    const r = await ibkrAdapter({ env: "test", creds, http: m.http, now }).preview(iOrder());
    expect(r.ok).toBe(true);
    expect(m.calls[1]!.url).toBe("https://localhost:5000/v1/api/iserver/account/DU1234567/orders/whatif");
  });

  it("submits a LMT order with cOID and reads the order id", async () => {
    const m = mockHttp(accounts, { status: 200, body: [{ order_id: "1234567890", order_status: "Submitted", encrypt_message: "1" }] });
    const r = await ibkrAdapter({ env: "test", creds, http: m.http, now }).submit(iOrder());
    expect(r).toMatchObject({ state: "accepted", venueOrderId: "1234567890" });
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({
      orders: [{ conid: 265598, orderType: "LMT", side: "BUY", price: 150, quantity: 5, tif: "DAY", cOID: "us-abc123" }],
    });
  });

  it("never answers a confirmation question", async () => {
    const question = [{ id: "07a13a5a", message: ["price exceeds the Percentage constraint of 3%. Are you sure?"], isSuppressed: false }];
    const m = mockHttp(accounts, { status: 200, body: question });
    const r = await ibkrAdapter({ env: "test", creds, http: m.http, now }).submit(iOrder());
    expect(r.state).toBe("rejected");
    expect(r.message).toContain("Percentage constraint");
    expect(r.raw).toEqual(question);
    expect(m.calls.some((c) => c.url.includes("/iserver/reply"))).toBe(false);
    expect(posts(m.calls)).toHaveLength(1);
  });

  it("a gateway refusal is rejected; a timeout is unknown with the order sent once", async () => {
    const m = mockHttp(accounts, { status: 200, body: { error: "We cannot accept an order at the limit price you selected." } });
    expect(await ibkrAdapter({ env: "test", creds, http: m.http, now }).submit(iOrder())).toMatchObject({
      state: "rejected",
      message: expect.stringContaining("limit price"),
    });
    const t = mockHttp(accounts, new Error("timeout after 10000 ms"));
    expect((await ibkrAdapter({ env: "test", creds, http: t.http, now }).submit(iOrder())).state).toBe("unknown");
    expect(posts(t.calls)).toHaveLength(1);
  });

  it("guards paper vs live account ids", async () => {
    expect(ibkrAccountRefusal("test", "DU1234567")).toBeUndefined();
    expect(ibkrAccountRefusal("test", "U1234567")).toMatch(/paper account only/);
    expect(ibkrAccountRefusal("live", "U1234567")).toBeUndefined();
    expect(ibkrAccountRefusal("live", "DU1234567")).toMatch(/paper account/);
    expect(ibkrAccountRefusal("test", "DU1234567", false)).toBeDefined();
    const m = mockHttp({ status: 200, body: { accounts: ["U7654321"], selectedAccount: "U7654321", isPaper: false } });
    const r = await ibkrAdapter({ env: "test", creds: { key: "", secret: "" }, http: m.http, now }).submit(iOrder());
    expect(r.state).toBe("rejected");
    expect(posts(m.calls)).toHaveLength(0);
  });

  it("queries the day's orders by order_ref", async () => {
    const m = mockHttp({
      status: 200,
      body: { orders: [{ orderId: 99, order_ref: "us-abc123", status: "Filled", filledQuantity: 5, remainingQuantity: 0, avgPrice: "149.98" }] },
    });
    const r = await ibkrAdapter({ env: "test", creds, http: m.http, now }).query("265598", "us-abc123");
    expect(r).toMatchObject({ state: "filled", venueOrderId: "99", filledQuantity: 5, averagePrice: 149.98 });
  });

  it("compares certificate fingerprints, and refuses a pin that does not match the PEM", () => {
    const fp = "03:AA:83:A3:44:91:B6:18:57:91:52:6F:A1:05:24:22:06:8E:20:CB:62:47:90:7B:6F:44:AF:0E:E8:2C:91:A9";
    expect(sameFingerprint(fp, fp.replace(/:/g, "").toLowerCase())).toBe(true);
    expect(sameFingerprint(fp, fp.replace("03:AA", "03:AB"))).toBe(false);
    expect(sameFingerprint(fp, undefined)).toBe(false);
    expect(sameFingerprint("AB", "ab")).toBe(false); // not a SHA-256
    expect(() => pinnedHttps(TEST_CERT, fp)).not.toThrow();
    expect(() => pinnedHttps(TEST_CERT, fp.replace("03:AA", "03:AB"))).toThrow(/does not match/);
    expect(() => ibkrAdapter({ env: "test", creds })).toThrow(/certificate is required/);
  });
});

// A throwaway self-signed certificate (public, no key here), SHA-256 03:AA:83:…:91:A9.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBcTCCARigAwIBAgIUOTBXcI7q+vx1Ga66xfumINvs21owCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyNDE3MDMzNloXDTM2MTAyMTE3
MDMzNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE8UW9zaEiadeJ61DlEHnvCwP6sHtih1ar5VI6yBnSdp7Nq63CxY99hIWT
OHH1qhhDAG7S/dvnWINc2aj3YI/LBaNIMEYwHQYDVR0OBBYEFIqZvbjUPdcZq4ml
EJX191Qfp3izMA8GA1UdEwEB/wQFMAMBAf8wFAYDVR0RBA0wC4IJbG9jYWxob3N0
MAoGCCqGSM49BAMCA0cAMEQCIGEgePBN2APbPHOYG7gCnSgirOnp/9c4j1Qz/cFS
Hj9bAiB1aQ5d1HCzPXUMAOA3Wan61aV4vusLKWGOkd/AYyr7xg==
-----END CERTIFICATE-----
`;
