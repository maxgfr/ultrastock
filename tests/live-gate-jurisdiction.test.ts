// The live gate (trading/live.ts preconditions) and the risk gate (trading/riskgate.ts) against the user's country
// research: a stablecoin leg the research blocks, whichever side of the pair it is on; and getting out — selling what is
// held passes, with a warning, when a jurisdiction fact is unknown, stale or blocked (buys stay fail-closed). A scripted
// fake venue only; the process's HTTP layer is pinned to an EMPTY fixture, so nothing here can reach a venue, the ECB
// or ESMA.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JURISDICTION } from "../src/core/jurisdiction.js";
import { setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { saveFacts } from "../src/core/researched.js";
import type { BrokerAdapter } from "../src/trading/brokers/types.js";
import { LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";
import { preconditions } from "../src/trading/live.js";
import { type GateContext, type Order, orderFingerprint, riskGate } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, recordCheck } from "../src/trading/tickets.js";
import { installJurisdictionTestFacts, testJurisdictionFile } from "./helpers/jurisdiction-facts.js";
import { testGrid } from "./helpers/venue-rules.js";

/** A venue that answers from a script: no request leaves the process. */
function fakeVenue(opts: { bid?: number; ask?: number; free?: Record<string, number> } = {}): BrokerAdapter {
  return {
    venue: "kraken",
    env: "live",
    bookTop: async () => ({ bid: opts.bid ?? 99.9, ask: opts.ask ?? 100, at: new Date().toISOString() }),
    instrumentRules: testGrid,
    permissions: async () => ({ canTrade: true, canWithdraw: false, source: "apiRestrictions" }),
    balances: async () => Object.entries(opts.free ?? {}).map(([asset, free]) => ({ asset, free, locked: 0 })),
    preview: async () => ({ ok: true }),
    submit: async () => {
      throw new Error("these tests never submit");
    },
    query: async () => undefined,
    cancel: async (_s, id) => ({ state: "cancelled", clientOrderId: id }),
    openOrders: async () => [],
  };
}

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
  await recordCheck(t.id, {
    verdict: "pass",
    checks: [],
    fingerprint: orderFingerprint(o),
    riskReducing: o.side === "sell",
    notionalBase: o.quantity * o.price,
  });
  return loadTicket(t.id);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const FR_CRYPTO = { "crypto-casp": "restricted", "crypto-register": "esma-mica" };

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  // An empty fixture: any read through the process's HTTP layer is a FixtureMiss, never a request.
  setNetMode({ kind: "fixture", dir: mkdtempSync(join(tmpdir(), "us-live-gate-")) });
  saveProfile(defaultProfile("FR", "EUR"));
  requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
});
afterEach(() => setNetMode({ kind: "live" }));

describe("a stablecoin the research blocks for the user's country", () => {
  it("is refused when it is the asset BOUGHT (USDC/EUR), as it is when it is the quote (BTC/USDC)", async () => {
    installJurisdictionTestFacts({ FR: { ...FR_CRYPTO, "stablecoin.usdc": "blocked" } });

    // Control: quoted in USDC, the live gate refuses and names the rule.
    const quoted = await checkedTicket(order({ symbol: "BTCUSDC", currency: "USDC", price: 100, quantity: 1 }));
    const q = await preconditions({ ticket: quoted, venue: "kraken", env: "live", adapter: fakeVenue(), venueSym: "XBTUSDC", micaAuthorised: true });
    expect(q.refusals.filter((r) => r.code === "BLOCKED_JURISDICTION" && /USDC is blocked/.test(r.reason))).toHaveLength(1);

    // The same coin, bought outright with euros on the same venue: USDC/EUR, 100 USDC at 0.86 EUR.
    const bought = await checkedTicket(order({ symbol: "USDCEUR", currency: "EUR", price: 0.86, quantity: 100, stop: 0.8 }));
    const b = await preconditions({
      ticket: bought,
      venue: "kraken",
      env: "live",
      adapter: fakeVenue({ bid: 0.859, ask: 0.86 }),
      venueSym: "USDCEUR",
      micaAuthorised: true,
    });
    expect(b.refusals.filter((r) => r.code === "BLOCKED_JURISDICTION").map((r) => r.reason)).toEqual([expect.stringMatching(/USDC is blocked/)]);
  });

  it("is checked on both legs of a stablecoin-to-stablecoin pair", async () => {
    installJurisdictionTestFacts({ FR: { ...FR_CRYPTO, "stablecoin.usdc": "allowed" } });
    const t = await checkedTicket(order({ symbol: "USDTUSDC", currency: "USDC", price: 1, quantity: 100, stop: 0.95 }));
    const p = await preconditions({
      ticket: t,
      venue: "kraken",
      env: "live",
      adapter: fakeVenue({ bid: 0.999, ask: 1 }),
      venueSym: "USDTUSDC",
      micaAuthorised: true,
    });
    // USDC (the quote) is allowed; USDT (the base) was never researched.
    expect(p.refusals.filter((r) => r.code === "BLOCKED_JURISDICTION").map((r) => r.reason)).toEqual([expect.stringMatching(/^USDT is unknown/)]);
  });
});

describe("getting out must stay possible when the research has gone stale, or even says blocked", () => {
  const sell = () => order({ side: "sell", quantity: 1, price: 99.9, stop: undefined });
  const live = (t: Awaited<ReturnType<typeof checkedTicket>>, free: Record<string, number> = { SOL: 5 }) =>
    preconditions({ ticket: t, venue: "kraken", env: "live", adapter: fakeVenue({ free }), venueSym: "SOLEUR", micaAuthorised: true });

  it("live: a sell of coins held on the venue is not refused because the crypto-casp research is past its 180 days", async () => {
    // Researched 200 days ago: "restricted, ESMA's register". Nothing changed in the law; the fact merely aged out.
    saveFacts(JURISDICTION, testJurisdictionFile("FR", FR_CRYPTO, daysAgo(200)));
    const p = await live(await checkedTicket(sell()));
    expect(p.refusals.filter((r) => r.code === "BLOCKED_JURISDICTION")).toEqual([]);
    // Said, not silent: the warning names the rule and why it passes.
    expect(p.warnings).toEqual([{ code: "BLOCKED_JURISDICTION", reason: expect.stringMatching(/unknown.*selling what is held/) }]);
  });

  it("live: the same stale research still refuses a buy", async () => {
    saveFacts(JURISDICTION, testJurisdictionFile("FR", FR_CRYPTO, daysAgo(200)));
    const p = await live(await checkedTicket(order()));
    expect(p.refusals.filter((r) => r.code === "BLOCKED_JURISDICTION")).toHaveLength(1);
    expect(p.warnings).toEqual([]);
  });

  it("live: a venue or a stablecoin the research blocks lets the coins held be sold, never bought", async () => {
    installJurisdictionTestFacts({ FR: { ...FR_CRYPTO, "cryptoVenue.kraken": "blocked", "stablecoin.usdc": "blocked" } });
    const out = await preconditions({
      ticket: await checkedTicket(order({ symbol: "USDCEUR", side: "sell", quantity: 100, price: 0.859, stop: undefined })),
      venue: "kraken",
      env: "live",
      adapter: fakeVenue({ bid: 0.859, ask: 0.86, free: { USDC: 100 } }),
      venueSym: "USDCEUR",
    });
    expect(out.refusals.filter((r) => r.code === "BLOCKED_JURISDICTION")).toEqual([]);
    expect(out.warnings.map((w) => w.reason)).toEqual([expect.stringMatching(/kraken is blocked/), expect.stringMatching(/USDC is blocked/)]);
    const buy = await preconditions({
      ticket: await checkedTicket(order({ symbol: "USDCEUR", quantity: 100, price: 0.86, stop: 0.8 })),
      venue: "kraken",
      env: "live",
      adapter: fakeVenue({ bid: 0.859, ask: 0.86 }),
      venueSym: "USDCEUR",
    });
    expect(buy.refusals.filter((r) => r.code === "BLOCKED_JURISDICTION")).toHaveLength(2);
  });

  it("live: a sell the risk check did not find held (not risk-reducing) is refused as before", async () => {
    saveFacts(JURISDICTION, testJurisdictionFile("FR", FR_CRYPTO, daysAgo(200)));
    const t = createTicket(sell());
    await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(sell()), riskReducing: false, notionalBase: 99.9 });
    const p = await live(loadTicket(t.id));
    expect(p.refusals.filter((r) => r.code === "BLOCKED_JURISDICTION")).toHaveLength(1);
  });

  const ctx = (c: Partial<GateContext> = {}): GateContext => {
    const profile = defaultProfile("US", "EUR");
    profile.constraints.allowPredictionMarkets = true;
    return {
      profile,
      equityBase: 50_000,
      cashBase: 20_000,
      fxToBase: 1,
      positionValueBase: 60,
      heldQuantity: 100,
      cryptoValueBase: 0,
      openSymbols: ["KALSHI:FED-26DEC-T4.25:YES"],
      pendingBuysBase: {},
      ordersToday: 0,
      lastPrice: 0.6,
      quoteAt: new Date(Date.now() - 60_000).toISOString(),
      now: new Date(),
      maxQuoteAgeMs: 15 * 60_000,
      breaker: { tripped: false, sizeMultiplier: 1 },
      ...c,
    };
  };
  const exit: Order = {
    account: "kalshi",
    symbol: "KALSHI:FED-26DEC-T4.25:YES",
    side: "sell",
    quantity: 100,
    price: 0.6,
    orderType: "limit",
    currency: "USD",
    assetKind: "prediction",
    venue: "kalshi",
  };

  it("risk gate: selling the Kalshi contracts held passes once the 90-day kalshi research has aged out (as a held US ETF does)", () => {
    // Bought while the research said "allowed"; 100 days later (the key's age limit is 90) it reads as unknown.
    saveFacts(JURISDICTION, testJurisdictionFile("US", { kalshi: "allowed", "us-domiciled-etf": "allowed" }, daysAgo(100)));
    const r = riskGate(exit, ctx());
    expect(r.riskReducing).toBe(true);
    expect(r.checks.filter((c) => c.status === "block").map((c) => c.code)).toEqual([]);
    expect(r.checks.find((c) => c.code === "JURISDICTION")).toMatchObject({ status: "warn", reason: expect.stringMatching(/selling what is held/) });
    // A buy of the same contracts stays blocked.
    const buy = riskGate({ ...exit, side: "buy" }, ctx());
    expect(buy.checks.find((c) => c.code === "JURISDICTION")).toMatchObject({ status: "block" });
  });

  it("risk gate: even a blocked venue lets the contracts held be sold", () => {
    installJurisdictionTestFacts({ US: { kalshi: "blocked" } });
    expect(riskGate(exit, ctx()).checks.find((c) => c.code === "JURISDICTION")).toMatchObject({ status: "warn" });
  });

  it("control: the same aged-out research lets a held US-domiciled ETF be sold — the rule written for exits", () => {
    saveFacts(JURISDICTION, testJurisdictionFile("FR", { "us-domiciled-etf": "restricted" }, daysAgo(200)));
    const p = defaultProfile("FR", "EUR");
    const r = riskGate(
      {
        account: "cto",
        symbol: "SPY",
        side: "sell",
        quantity: 10,
        price: 500,
        orderType: "limit",
        currency: "USD",
        assetKind: "etf",
        domicile: "US",
        venue: "ibkr",
      },
      ctx({ profile: p, heldQuantity: 10, lastPrice: 500, openSymbols: ["SPY"] }),
    );
    expect(r.checks.filter((c) => c.status === "block")).toEqual([]);
    expect(r.checks.find((c) => c.code === "PRIIPS")).toMatchObject({ status: "warn" });
  });
});
