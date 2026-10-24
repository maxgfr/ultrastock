import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import type { BrokerAdapter, LiveOrder, OrderResult } from "../src/trading/brokers/types.js";
import { effectiveLimits, isTightening, type LiveLimits, LOOSEN_DELAY_MS, requestLimits, tierFor } from "../src/trading/limits.js";
import { clientOrderIdFor, liveSubmit, preconditions, reconcile, venueSymbol } from "../src/trading/live.js";
import { type Channel, issueCode, verifyCode } from "../src/trading/otp.js";
import { killSwitchPath, type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { readCredentials, redact, setupCommands } from "../src/trading/secrets.js";
import { createTicket, loadTicket, readAudit, recordCheck } from "../src/trading/tickets.js";

/** A venue that answers from a script and counts what it was asked. */
function fakeVenue(
  opts: {
    submit?: (o: LiveOrder) => OrderResult | Promise<OrderResult>;
    query?: OrderResult;
    canWithdraw?: boolean;
    bid?: number;
    ask?: number;
    free?: number;
  } = {},
) {
  const calls = { submit: 0, query: 0, cancel: 0 };
  const a: BrokerAdapter = {
    venue: "kraken",
    env: "test",
    bookTop: async () => ({ bid: opts.bid ?? 99.9, ask: opts.ask ?? 100, at: new Date().toISOString() }),
    permissions: async () => ({ canTrade: true, canWithdraw: opts.canWithdraw ?? false, source: "apiRestrictions" }),
    balances: async () => [{ asset: "SOL", free: opts.free ?? 0, locked: 0 }],
    preview: async () => ({ ok: true }),
    submit: async (o) => {
      calls.submit++;
      return opts.submit ? opts.submit(o) : { state: "accepted", clientOrderId: o.clientOrderId, venueOrderId: "V1" };
    },
    query: async () => {
      calls.query++;
      return opts.query;
    },
    cancel: async (_s, id) => {
      calls.cancel++;
      return { state: "cancelled", clientOrderId: id };
    },
    openOrders: async () => [],
  };
  return { a, calls };
}

let captured: string[] = [];
const capture: Channel = (m) => {
  captured.push(m);
  return true;
};
const codeFrom = () => /^(\d{6})/.exec(captured.at(-1) ?? "")![1]!;

const order = (o: Partial<Order> = {}): Order => ({
  account: "kraken",
  symbol: "SOLEUR",
  side: "buy",
  quantity: 1,
  price: 100,
  orderType: "limit",
  currency: "EUR",
  stop: 90,
  assetKind: "crypto",
  venue: "kraken",
  ...o,
});

async function checkedTicket(o: Order) {
  const t = createTicket(o);
  await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(o), riskReducing: false, notionalBase: o.quantity * o.price });
  return loadTicket(t.id);
}

const switchOn = (extra: Partial<LiveLimits> = {}) =>
  requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [], ...extra }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
  captured = [];
});
afterEach(() => rmSync(killSwitchPath(), { force: true }));

describe("approval codes", () => {
  it("are delivered out of band only, bound to what they approve, single-use, short-lived", async () => {
    const r = await issueCode("t-abc123", "fp1", "a test", [["capture", capture]]);
    expect(r.sentTo).toEqual(["capture"]);
    expect(JSON.stringify(r)).not.toMatch(/\d{6}/);
    const code = codeFrom();
    expect(verifyCode("t-abc123", "fp2", code)).toMatchObject({ ok: false, reason: expect.stringMatching(/different order/) });
    await issueCode("t-abc123", "fp1", "a test", [["capture", capture]]);
    expect(verifyCode("t-abc123", "fp1", "000000" === codeFrom() ? "111111" : "000000")).toMatchObject({ ok: false });
    expect(verifyCode("t-abc123", "fp1", codeFrom())).toEqual({ ok: true });
    expect(verifyCode("t-abc123", "fp1", codeFrom())).toMatchObject({ ok: false, reason: expect.stringMatching(/no code/) });
    await issueCode("t-abc123", "fp1", "a test", [["capture", capture]]);
    expect(verifyCode("t-abc123", "fp1", codeFrom(), new Date(Date.now() + 121_000))).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    await expect(issueCode("t-abc123", "fp1", "x", [["none", () => false]])).rejects.toThrow(/no out-of-band channel/);
  });
});

describe("live limits", () => {
  it("tighten at once, loosen only with approval and after 24 hours, capped by the experience tier", () => {
    expect(tierFor(0).maxOrder).toBe(250);
    expect(tierFor(150).name).toBe("experienced");
    const now = new Date("2026-10-24T10:00:00Z");
    expect(requestLimits({ maxOrder: 100, maxDaily: 200, venues: [], attestedNoWithdraw: [] }, false, now)).toEqual({ applied: true });
    expect(requestLimits({ maxOrder: 200, maxDaily: 400, venues: ["kraken"], attestedNoWithdraw: [] }, false, now)).toMatchObject({
      applied: false,
      reason: expect.stringMatching(/approval code/),
    });
    const r = requestLimits({ maxOrder: 200, maxDaily: 400, venues: ["kraken"], attestedNoWithdraw: [] }, true, now);
    expect(r.effectiveAt).toBe("2026-10-25T10:00:00.000Z");
    expect(effectiveLimits(0, new Date("2026-10-25T09:00:00Z")).limits.maxOrder).toBe(100);
    expect(effectiveLimits(0, new Date("2026-10-25T10:00:01Z")).limits).toMatchObject({ maxOrder: 200, venues: ["kraken"] });
    // The tier caps whatever is set.
    requestLimits({ maxOrder: 9000, maxDaily: 9000, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date("2026-10-26T00:00:00Z"));
    expect(effectiveLimits(0, new Date("2026-10-28T00:00:00Z")).limits.maxOrder).toBe(250);
    expect(
      isTightening(
        { maxOrder: 1, maxDaily: 1, venues: ["kraken"], attestedNoWithdraw: [] },
        { maxOrder: 1, maxDaily: 1, venues: ["kraken", "binance"], attestedNoWithdraw: [] },
      ),
    ).toBe(false);
  });
});

describe("live preconditions and the single submission", () => {
  it("refuses with named reasons: venue off, kill switch, jurisdiction, withdrawal right, price band, limits, no code", async () => {
    const t = await checkedTicket(order({ price: 103 }));
    const { a } = fakeVenue({ canWithdraw: true });
    const p = await preconditions({ ticket: t, venue: "kraken", env: "test", adapter: a, venueSym: "SOLEUR", micaAuthorised: false });
    const codes = p.refusals.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["VENUE_OFF", "BLOCKED_JURISDICTION", "WITHDRAW_RIGHT", "PRICE_BAND", "CODE"]));
    switchOn();
    mkdirSync(join(homeDir()), { recursive: true });
    writeFileSync(killSwitchPath(), "");
    const big = await checkedTicket(order({ quantity: 3 }));
    const q = await preconditions({ ticket: big, venue: "kraken", env: "test", adapter: fakeVenue().a, venueSym: "SOLEUR", micaAuthorised: true });
    expect(q.refusals.map((r) => r.code)).toEqual(expect.arrayContaining(["KILL_SWITCH", "ORDER_LIMIT"]));
    // Live needs the switch, Node ≥ 22 and a ready paper record.
    const l = await preconditions({ ticket: t, venue: "kraken", env: "live", adapter: fakeVenue().a, venueSym: "SOLEUR", micaAuthorised: true });
    expect(l.refusals.map((r) => r.code)).toEqual(expect.arrayContaining(["LIVE_OFF", "NOT_READY"]));
    // A sell needs the asset at the venue: no short.
    const s = await checkedTicket(order({ side: "sell", stop: undefined, price: 99.9 }));
    const n = await preconditions({ ticket: s, venue: "kraken", env: "test", adapter: fakeVenue({ free: 0.5 }).a, venueSym: "SOLEUR", micaAuthorised: true });
    expect(n.refusals.map((r) => r.code)).toContain("NO_SHORT");
  });

  it("sends exactly once with a valid code; a timeout is unknown, blocks resending, and reconcile settles it", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, orderFingerprint(t.order), "order", [["capture", capture]]);
    const v = fakeVenue({ submit: () => Promise.reject(new Error("timeout after 10000 ms")) });
    const r = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: v.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
    expect(r.refusals).toEqual([]);
    expect(r.result?.state).toBe("unknown");
    expect(v.calls.submit).toBe(1);
    expect(loadTicket(t.id).status).toBe("submitted");
    // No second send while unknown, whatever the code.
    const again = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: v.a, venueSym: "SOLEUR", code: "123456", micaAuthorised: true });
    expect(again.refusals[0]!.code).toBe("PENDING");
    expect(v.calls.submit).toBe(1);
    // The venue did get it, and it filled.
    const filled = fakeVenue({
      query: {
        state: "filled",
        clientOrderId: clientOrderIdFor(t.id, 1),
        venueOrderId: "V9",
        filledQuantity: 1,
        averagePrice: 99.95,
        fee: 0.26,
        feeCurrency: "EUR",
      },
    });
    const rec = await reconcile(t.id, filled.a);
    expect(rec.note).toBe("filled");
    expect(loadTicket(t.id).status).toBe("filled");
    const events = readAudit().map((e) => e.event);
    expect(events.indexOf("live-intent")).toBeLessThan(events.indexOf("live-result"));
    expect(events).toContain("live-reconcile");
  });

  it("refuses a code issued for another order, and maps symbols per venue", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, "another-fingerprint", "order", [["capture", capture]]);
    const v = fakeVenue();
    const r = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: v.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
    expect(r.refusals.map((x) => x.code)).toEqual(["CODE"]);
    expect(v.calls.submit).toBe(0);
    expect(venueSymbol("kraken", "BTCEUR", "EUR")).toBe("XBTEUR");
    expect(venueSymbol("coinbase", "ETHEUR", "EUR")).toBe("ETH-EUR");
    expect(venueSymbol("binance", "BTCUSDT", "USDT")).toBe("BTCUSDT");
    expect(() => venueSymbol("ibkr", "AAPL", "USD")).toThrow(/conid/);
    expect(clientOrderIdFor("t-x", 1)).toMatch(/^us[0-9a-f]{20}-1$/);
  });

  it("reads credentials from the keychain entries, then the environment, and never needs them on the command line", () => {
    const store: Record<string, string> = { "kraken-test-key": "KEY-abcdef", "kraken-test-secret": "SECRET-abcdef" };
    const r = readCredentials("kraken", "test", (a) => store[a]);
    expect(r?.creds).toMatchObject({ key: "KEY-abcdef", secret: "SECRET-abcdef" });
    expect(readCredentials("kraken", "live", (a) => store[a])).toBeUndefined();
    process.env.ULTRASTOCK_BINANCE_TEST_KEY = "envkey-123456";
    process.env.ULTRASTOCK_BINANCE_TEST_SECRET = "envsecret-123456";
    expect(readCredentials("binance", "test", () => undefined)).toMatchObject({ source: "environment" });
    delete process.env.ULTRASTOCK_BINANCE_TEST_KEY;
    delete process.env.ULTRASTOCK_BINANCE_TEST_SECRET;
    expect(redact("error: key KEY-abcdef rejected", r!.creds)).toBe("error: key [redacted] rejected");
    for (const c of setupCommands("kraken", "live")) expect(c).not.toMatch(/SECRET|KEY-/);
  });
});
