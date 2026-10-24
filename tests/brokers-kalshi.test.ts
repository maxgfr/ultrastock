import { constants, generateKeyPairSync, verify } from "node:crypto";
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { kalshiAdapter, kalshiSign, parseKalshiCreate, parseKalshiOrder } from "../src/trading/brokers/kalshi.js";
import type { HttpFn } from "../src/trading/brokers/types.js";
import { LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";
import { preconditions, venueSymbol } from "../src/trading/live.js";
import { orderFingerprint, type Order } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, recordCheck } from "../src/trading/tickets.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const creds = { key: "key-id-0123456789", secret: pem };

describe("Kalshi adapter", () => {
  it("signs timestamp + method + path (no query) with RSA-PSS SHA-256", () => {
    const sig = kalshiSign(pem, "1715793600123", "GET", "/trade-api/v2/portfolio/orders?limit=5");
    const ok = verify(
      "sha256",
      Buffer.from("1715793600123GET/trade-api/v2/portfolio/orders"),
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      Buffer.from(sig, "base64"),
    );
    expect(ok).toBe(true);
  });

  it("places on the YES book: a NO buy at 0.30 is an ask at 0.70; one request; a timeout is unknown", async () => {
    const seen: Array<{ url: string; body?: string; headers?: Record<string, string> }> = [];
    const http: HttpFn = async (req) => {
      seen.push(req);
      return {
        status: 201,
        body: JSON.stringify({
          order_id: "O1",
          client_order_id: "c1",
          fill_count: "10.00",
          remaining_count: "0.00",
          average_fill_price: "0.7000",
          average_fee_paid: "0.0147",
        }),
      };
    };
    const a = kalshiAdapter({ env: "test", creds, http, now: () => 1715793600123 });
    const r = await a.submit({ symbol: "FED-26DEC-T4.25:NO", side: "buy", quantity: 10, limitPrice: 0.3, clientOrderId: "c1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://demo-api.kalshi.co/trade-api/v2/portfolio/events/orders");
    expect(JSON.parse(seen[0]!.body!)).toMatchObject({ ticker: "FED-26DEC-T4.25", side: "ask", price: "0.7000", count: "10.00", client_order_id: "c1" });
    expect(seen[0]!.headers!["KALSHI-ACCESS-KEY"]).toBe("key-id-0123456789");
    expect(r).toMatchObject({ state: "filled", filledQuantity: 10, averagePrice: 0.3, fee: 0.147 });
    expect(JSON.stringify(r)).not.toContain("PRIVATE KEY");
    let calls = 0;
    const slow = kalshiAdapter({
      env: "live",
      creds,
      http: async () => {
        calls++;
        throw new Error("timeout after 10000 ms");
      },
    });
    expect((await slow.submit({ symbol: "X-1:YES", side: "buy", quantity: 1, limitPrice: 0.5, clientOrderId: "c2" })).state).toBe("unknown");
    expect(calls).toBe(1);
    expect((await slow.submit({ symbol: "X-1:YES", side: "buy", quantity: 1, limitPrice: 1.2, clientOrderId: "c3" })).state).toBe("rejected");
    expect(calls).toBe(1);
  });

  it("parses orders in the outcome's terms", () => {
    expect(parseKalshiCreate({ order_id: "O", fill_count: "0.00", remaining_count: "5.00" }, "c", "yes").state).toBe("accepted");
    expect(
      parseKalshiOrder(
        { status: "executed", side: "yes", action: "sell", fill_count_fp: "4.00", taker_fill_cost_dollars: "2.80", taker_fees_dollars: "0.06" },
        "c",
        "no",
      ),
    ).toMatchObject({
      state: "filled",
      filledQuantity: 4,
      averagePrice: 0.3,
      fee: 0.06,
    });
    expect(parseKalshiOrder({ status: "canceled", fill_count_fp: "0.00" }, "c").state).toBe("cancelled");
    expect(venueSymbol("kalshi", "KALSHI:fed-1:yes", "USD")).toBe("FED-1:YES");
  });
});

describe("Kalshi live orders and the jurisdiction", () => {
  beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));
  const contract: Order = {
    account: "kalshi",
    symbol: "KALSHI:FED-1:YES",
    side: "buy",
    quantity: 10,
    price: 0.4,
    orderType: "limit",
    currency: "USD",
    assetKind: "prediction",
    venue: "kalshi",
  };
  const adapter = kalshiAdapter({
    env: "live",
    creds,
    http: async (req) =>
      req.url.includes("/orderbook")
        ? { status: 200, body: JSON.stringify({ orderbook_fp: { yes_dollars: [["0.39", "50"]], no_dollars: [["0.60", "40"]] } }) }
        : { status: 200, body: "{}" },
  });

  async function ticket() {
    const t = createTicket(contract);
    await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(contract), riskReducing: false, notionalBase: 4 });
    return loadTicket(t.id);
  }

  it("refuses a French resident live, whatever else holds", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kalshi"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
    const p = await preconditions({ ticket: await ticket(), venue: "kalshi", env: "live", adapter, venueSym: "FED-1:YES" });
    expect(p.refusals.map((r) => r.code)).toContain("BLOCKED_JURISDICTION");
  });

  it("does not refuse a US resident on the jurisdiction (other guards still apply)", async () => {
    saveProfile(defaultProfile("US", "USD"));
    requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kalshi"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
    const p = await preconditions({ ticket: await ticket(), venue: "kalshi", env: "live", adapter, venueSym: "FED-1:YES" });
    const codes = p.refusals.map((r) => r.code);
    expect(codes).not.toContain("BLOCKED_JURISDICTION");
    expect(codes).not.toContain("ASSET");
    expect(codes).toContain("LIVE_OFF");
    expect(p.book).toEqual({ bid: 0.39, ask: 0.4 });
  });
});
