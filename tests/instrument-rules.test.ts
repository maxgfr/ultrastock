// Each venue's price and quantity grid, read from an answer shaped like the
// venue's documented one (fake transports: no network), the rounding the plan
// does, and the refusal preview/submit give an order off the grid.
import { generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clockNow } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { binanceAdapter } from "../src/trading/brokers/binance.js";
import { coinbaseAdapter } from "../src/trading/brokers/coinbase.js";
import { ibkrAdapter } from "../src/trading/brokers/ibkr.js";
import { kalshiAdapter } from "../src/trading/brokers/kalshi.js";
import { krakenAdapter } from "../src/trading/brokers/kraken.js";
import { gridRefusals, type InstrumentRules, onGrid, publicInstrumentRules, snap, tickAt } from "../src/trading/brokers/rules.js";
import type { BrokerAdapter, HttpFn } from "../src/trading/brokers/types.js";
import { LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";
import { preconditions } from "../src/trading/live.js";
import { planTrade } from "../src/trading/plan.js";
import type { Order } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, recordCheck } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";

/** A transport answering each URL (by substring) with a JSON body, recording what it was asked. */
function fakeHttp(routes: Record<string, unknown>, status = 200): HttpFn & { asked: string[] } {
  const asked: string[] = [];
  const fn = (async (req) => {
    asked.push(`${req.method} ${req.url}${req.body ? ` ${req.body}` : ""}`);
    const hit = Object.entries(routes).find(([k]) => req.url.includes(k));
    return hit ? { status, body: JSON.stringify(hit[1]) } : { status: 404, body: "{}" };
  }) as HttpFn & { asked: string[] };
  fn.asked = asked;
  return fn;
}

const creds = { key: "test-key-123456", secret: "dGVzdC1zZWNyZXQtMTIzNDU2" };
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "sec1", format: "pem" }).toString();

describe("the grid, read from each venue", () => {
  it("Binance exchangeInfo: PRICE_FILTER, LOT_SIZE, NOTIONAL", async () => {
    const http = fakeHttp({
      "/api/v3/exchangeInfo?symbol=BTCUSDT": {
        symbols: [
          {
            symbol: "BTCUSDT",
            status: "TRADING",
            filters: [
              { filterType: "PRICE_FILTER", minPrice: "0.01000000", maxPrice: "1000000.00000000", tickSize: "0.01000000" },
              { filterType: "LOT_SIZE", minQty: "0.00001000", maxQty: "9000.00000000", stepSize: "0.00001000" },
              { filterType: "NOTIONAL", minNotional: "5.00000000", applyMinToMarket: true, maxNotional: "9000000.00000000" },
            ],
          },
        ],
      },
    });
    const r = await binanceAdapter({ env: "test", creds, http }).instrumentRules("BTCUSDT");
    expect(r).toMatchObject({ ticks: [{ from: 0, tick: 0.01 }], step: 0.00001, minQuantity: 0.00001, maxQuantity: 9000, minNotional: 5, tradable: true });
    expect(http.asked[0]).toBe("GET https://testnet.binance.vision/api/v3/exchangeInfo?symbol=BTCUSDT");
    // An older pair carries MIN_NOTIONAL instead; a halted one is not tradable.
    const old = fakeHttp({
      exchangeInfo: {
        symbols: [
          {
            symbol: "ETHBTC",
            status: "BREAK",
            filters: [
              { filterType: "MIN_NOTIONAL", minNotional: "0.0001" },
              { filterType: "PRICE_FILTER", tickSize: "0.000001" },
            ],
          },
        ],
      },
    });
    const o = await binanceAdapter({ env: "live", creds, http: old }).instrumentRules("ETHBTC");
    expect(o).toMatchObject({ minNotional: 0.0001, tradable: false, status: "BREAK" });
    expect(gridRefusals(o, { price: 0.05, quantity: 1 }).map((g) => g.code)).toEqual(["NOT_TRADING"]);
  });

  it("Kraken AssetPairs: tick_size, lot_decimals, ordermin, costmin — keyed by Kraken's own pair name", async () => {
    const http = fakeHttp({
      "/0/public/AssetPairs?pair=XBTEUR": {
        error: [],
        result: {
          XXBTZEUR: { altname: "XBTEUR", pair_decimals: 1, lot_decimals: 8, ordermin: "0.00005", costmin: "0.5", tick_size: "0.1", status: "online" },
        },
      },
    });
    const r = await krakenAdapter({ env: "test", creds, http }).instrumentRules("XBTEUR");
    expect(r).toMatchObject({ ticks: [{ from: 0, tick: 0.1 }], step: 0.00000001, minQuantity: 0.00005, minNotional: 0.5, tradable: true });
    const limitOnly = fakeHttp({
      AssetPairs: { error: [], result: { SOLEUR: { altname: "SOLEUR", pair_decimals: 2, lot_decimals: 8, status: "cancel_only" } } },
    });
    const c = await krakenAdapter({ env: "test", creds, http: limitOnly }).instrumentRules("SOLEUR");
    expect(c).toMatchObject({ ticks: [{ from: 0, tick: 0.01 }], tradable: false, status: "cancel_only" });
    await expect(
      krakenAdapter({ env: "test", creds, http: fakeHttp({ AssetPairs: { error: ["EQuery:Unknown asset pair"] } }) }).instrumentRules("NOPE"),
    ).rejects.toThrow(/Unknown asset pair/);
  });

  it("Coinbase product: price_increment, base_increment, base_min_size, quote_min_size — on the public endpoint", async () => {
    const http = fakeHttp({
      "/api/v3/brokerage/market/products/BTC-EUR": {
        product_id: "BTC-EUR",
        price_increment: "0.01",
        quote_increment: "0.01",
        base_increment: "0.00000001",
        base_min_size: "0.00000001",
        base_max_size: "3400",
        quote_min_size: "1",
        status: "online",
        trading_disabled: false,
      },
    });
    const r = await coinbaseAdapter({ env: "test", creds: { key: "organizations/x/apiKeys/y", secret: ec }, http }).instrumentRules("BTC-EUR");
    expect(r).toMatchObject({ ticks: [{ tick: 0.01 }], step: 0.00000001, minNotional: 1, maxQuantity: 3400, tradable: true });
    expect(http.asked[0]).toBe("GET https://api.coinbase.com/api/v3/brokerage/market/products/BTC-EUR");
  });

  it("IBKR contract rules through the gateway: price bands by lowerEdge, the size increment", async () => {
    const http = fakeHttp({
      "/iserver/contract/rules": {
        increment: 0.01,
        incrementDigits: 2,
        incrementRules: [
          { lowerEdge: 0, increment: 0.0001 },
          { lowerEdge: 1, increment: 0.01 },
        ],
        sizeIncrement: 1,
      },
    });
    const a = ibkrAdapter({ env: "test", creds: { key: "DU123", secret: "" }, http, baseUrl: "https://localhost:5000/v1/api" });
    const r = await a.instrumentRules("265598");
    expect(tickAt(r, 0.5)).toBe(0.0001);
    expect(tickAt(r, 180)).toBe(0.01);
    expect(r.step).toBe(1);
    expect(http.asked[0]).toBe('POST https://localhost:5000/v1/api/iserver/contract/rules {"conid":265598,"isBuy":true}');
    await expect(a.instrumentRules("AAPL")).rejects.toThrow(/conid/);
  });

  it("Kalshi market: price ranges (mirrored for NO), fractional contracts, the legacy cent tick", async () => {
    const http = fakeHttp({
      "/trade-api/v2/markets/FED-26DEC-T4.25": {
        market: {
          ticker: "FED-26DEC-T4.25",
          status: "active",
          price_ranges: [
            { start: "0.0000", end: "0.1000", step: "0.0010" },
            { start: "0.1000", end: "0.9000", step: "0.0100" },
            { start: "0.9000", end: "1.0000", step: "0.0010" },
          ],
          fractional_trading_enabled: true,
        },
      },
    });
    const a = kalshiAdapter({ env: "test", creds: { key: "k-123456789", secret: rsa }, http });
    const yes = await a.instrumentRules("FED-26DEC-T4.25:YES");
    expect(tickAt(yes, 0.05)).toBe(0.001);
    expect(tickAt(yes, 0.5)).toBe(0.01);
    expect(yes.step).toBe(0.01);
    // A NO at 0.95 sits at YES 0.05: the fine band.
    const no = await a.instrumentRules("FED-26DEC-T4.25:NO");
    expect(tickAt(no, 0.95)).toBe(0.001);
    expect(tickAt(no, 0.5)).toBe(0.01);
    const legacy = fakeHttp({ markets: { market: { ticker: "X", status: "active", tick_size: 1 } } });
    const l = await kalshiAdapter({ env: "test", creds: { key: "k-123456789", secret: rsa }, http: legacy }).instrumentRules("X:YES");
    expect(l).toMatchObject({ ticks: [{ from: 0, tick: 0.01 }], step: 1 });
    expect(gridRefusals(l, { price: 0.405, quantity: 1.5 }).map((g) => g.code)).toEqual(["GRID_PRICE", "GRID_QUANTITY"]);
  });

  it("the public reader for a plan reads the same endpoints, IBKR excepted", async () => {
    const http = fakeHttp({
      exchangeInfo: { symbols: [{ symbol: "SOLEUR", status: "TRADING", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }] }] },
    });
    expect((await publicInstrumentRules("binance", "SOLEUR", { http }))?.ticks).toEqual([{ from: 0, tick: 0.01 }]);
    expect(http.asked[0]).toMatch(/^GET https:\/\/api\.binance\.com\/api\/v3\/exchangeInfo/);
    expect(await publicInstrumentRules("ibkr", "265598", { http })).toBeUndefined();
  });
});

describe("rounding and refusals on the grid", () => {
  it("snaps without residue, in the direction asked", () => {
    expect(snap(365.954, 0.05, "down")).toBe(365.95);
    expect(snap(365.951, 0.05, "up")).toBe(366);
    expect(snap(0.3, 0.1, "down")).toBe(0.3);
    expect(snap(0.123456789, 0.00001, "down")).toBe(0.12345);
    expect(onGrid(100.1, 0.1)).toBe(true);
    expect(onGrid(100.15, 0.1)).toBe(false);
  });

  it("names every way an order misses the grid or a minimum", () => {
    const r: InstrumentRules = {
      venue: "binance",
      symbol: "BTCUSDT",
      ticks: [{ from: 0, tick: 0.01 }],
      step: 0.00001,
      minQuantity: 0.0001,
      minNotional: 5,
      maxQuantity: 10,
      tradable: true,
      source: "test",
      at: "2026-11-01T00:00:00Z",
    };
    expect(gridRefusals(r, { price: 70_000.01, quantity: 0.001 })).toEqual([]);
    expect(gridRefusals(r, { price: 70_000.005, quantity: 0.000015 }).map((g) => g.code)).toEqual([
      "GRID_PRICE",
      "GRID_QUANTITY",
      "MIN_QUANTITY",
      "MIN_NOTIONAL",
    ]);
    expect(gridRefusals(r, { price: 100, quantity: 0.0001 }).map((g) => g.code)).toEqual(["MIN_NOTIONAL"]);
    expect(gridRefusals(r, { price: 100, quantity: 11 }).map((g) => g.code)).toEqual(["MAX_QUANTITY"]);
    expect(gridRefusals({ ...r, ticks: [] }, { price: 100, quantity: 1 }).map((g) => g.code)).toEqual(["GRID_UNKNOWN"]);
  });
});

describe("preview and submit refuse an order off the venue's grid", () => {
  beforeEach(() => {
    rmSync(homeDir(), { recursive: true, force: true });
    saveProfile(defaultProfile("FR", "EUR"));
    requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
  });
  const venue = (rules: () => Promise<InstrumentRules>): BrokerAdapter => ({
    venue: "kraken",
    env: "test",
    bookTop: async () => ({ bid: 99.9, ask: 100, at: new Date().toISOString() }),
    instrumentRules: rules,
    permissions: async () => ({ canTrade: true, canWithdraw: false, source: "apiRestrictions" }),
    balances: async () => [],
    preview: async () => ({ ok: true }),
    submit: async (o) => ({ state: "accepted", clientOrderId: o.clientOrderId }),
    query: async () => undefined,
    cancel: async (_s, id) => ({ state: "cancelled", clientOrderId: id }),
    openOrders: async () => [],
  });
  const order: Order = {
    account: "kraken",
    symbol: "SOLEUR",
    side: "buy",
    quantity: 1.5,
    price: 100.05,
    orderType: "limit",
    currency: "EUR",
    stop: 90,
    assetKind: "crypto",
    venue: "kraken",
  };
  const ticket = async () => {
    const t = createTicket(order);
    await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: t.fingerprint, riskReducing: false, notionalBase: 150 });
    return loadTicket(t.id);
  };
  const grid =
    (o: Partial<InstrumentRules> = {}) =>
    async (): Promise<InstrumentRules> => ({
      venue: "kraken",
      symbol: "SOLEUR",
      ticks: [{ from: 0, tick: 0.1 }],
      step: 1,
      minQuantity: 1,
      tradable: true,
      source: "fake AssetPairs",
      at: new Date().toISOString(),
      ...o,
    });

  it("an off-tick limit and an off-step quantity, each by name", async () => {
    const pre = await preconditions({ ticket: await ticket(), venue: "kraken", env: "test", adapter: venue(grid()), venueSym: "SOLEUR" });
    const codes = pre.refusals.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["GRID_PRICE", "GRID_QUANTITY"]));
    expect(pre.refusals.find((r) => r.code === "GRID_PRICE")!.reason).toMatch(/100\.05 is not on kraken SOLEUR's price grid \(tick 0\.1\): 100 or 100\.1/);
  });

  it("rules that cannot be read: refused, never sent unchecked", async () => {
    const pre = await preconditions({
      ticket: await ticket(),
      venue: "kraken",
      env: "test",
      adapter: venue(async () => {
        throw new Error("timeout after 10000 ms");
      }),
      venueSym: "SOLEUR",
    });
    expect(pre.refusals.find((r) => r.code === "RULES_UNREAD")!.reason).toMatch(/could not be read \(timeout/);
  });

  it("an order on the grid passes the grid check", async () => {
    const pre = await preconditions({
      ticket: await ticket(),
      venue: "kraken",
      env: "test",
      adapter: venue(grid({ ticks: [{ from: 0, tick: 0.01 }], step: 0.1 })),
      venueSym: "SOLEUR",
    });
    expect(pre.refusals.map((r) => r.code).filter((c) => /GRID|MIN_|RULES/.test(c))).toEqual([]);
  });
});

describe("the plan rounds to the venue's grid in the safe direction", () => {
  beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

  it("paper: no venue grid, and the plan says so", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "paper");
    const p = await withFixture("trading-paper-mcpa", () => planTrade({ symbol: "MC.PA", account: "cto", now: clockNow() }));
    expect(p.grid.checked).toBe(false);
    expect(p.notes.join("\n")).toMatch(/paper venue: no venue's price grid or lot step is checked/);
  });

  it("a live venue: entry, stop and targets down to its tick, the quantity down to its step; unreadable → a condition", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "real");
    const rulesHttp = fakeHttp({
      "/market/products/": { price_increment: "0.5", base_increment: "1", base_min_size: "1", quote_min_size: "1", status: "online" },
    });
    const p = await withFixture("trading-paper-mcpa", () =>
      planTrade({ symbol: "MC.PA", account: "cto", venue: "coinbase", entry: 383.3, stop: 366.7, targets: [420.9], now: clockNow(), rulesHttp }),
    );
    expect(p.grid.checked).toBe(true);
    expect(p.entry).toBe(383);
    expect(p.stop).toBe(366.5);
    expect(p.targets).toEqual([420.5]);
    expect(Number.isInteger(p.quantity)).toBe(true);
    expect(p.notes.join("\n")).toMatch(/the entry 383\.3 rounded down to coinbase's tick 0\.5: 383/);
    const unread = await withFixture("trading-paper-mcpa", () =>
      planTrade({ symbol: "MC.PA", account: "cto", venue: "coinbase", now: clockNow(), rulesHttp: fakeHttp({}, 503) }),
    );
    expect(unread.grid.checked).toBe(false);
    expect(unread.conditions.join("\n")).toMatch(/^GRID: coinbase .*could not be read/m);
    expect(unread.verdict).not.toBe("ready");
  });
});
