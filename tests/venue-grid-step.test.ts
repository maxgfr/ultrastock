// The venue's grid (src/trading/brokers/rules.ts, src/trading/live.ts, src/trading/plan.ts) when its answer lacks a part.
// rules.ts: "`broker preview` and `broker submit` refuse an order off the grid … it is the planned numbers or nothing";
// an unknown price tick is refused by name (GRID_UNKNOWN), and so is an answer missing its QUANTITY step: the
// quantity would go to the venue unchecked, and a plan sized on a made-up lot must not say the grid was "read live".
// Fake transports and a scripted adapter only.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clockNow } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { gridRefusals, type InstrumentRules, parseKrakenRules } from "../src/trading/brokers/rules.js";
import type { BrokerAdapter, HttpFn } from "../src/trading/brokers/types.js";
import { LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";
import { preconditions } from "../src/trading/live.js";
import { planTrade } from "../src/trading/plan.js";
import type { Order } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, recordCheck } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
});

// Kraken's AssetPairs entry with its price rule but no lot rule (lot_decimals absent from the answer).
const NO_LOT = { error: [], result: { SOLEUR: { altname: "SOLEUR", tick_size: "0.01", ordermin: "0.02", costmin: "0.5", status: "online" } } };
// The mirror case: the lot rule but no price rule.
const NO_TICK = { error: [], result: { SOLEUR: { altname: "SOLEUR", lot_decimals: 8, ordermin: "0.02", costmin: "0.5", status: "online" } } };

describe("a venue answer that gives no quantity step", () => {
  it("is refused by name, as an answer that gives no price tick is", () => {
    const at = new Date().toISOString();
    // Control: no tick → GRID_UNKNOWN.
    expect(gridRefusals(parseKrakenRules(NO_TICK, "SOLEUR", "fake", at), { price: 100, quantity: 1 }).map((g) => g.code)).toEqual(["GRID_UNKNOWN"]);
    const rules = parseKrakenRules(NO_LOT, "SOLEUR", "fake", at);
    expect(rules.step).toBeUndefined();
    expect(gridRefusals(rules, { price: 100, quantity: 1.23456789012 }).map((g) => g.code)).not.toEqual([]);
  });

  it("stops the order at preview/submit instead of sending the quantity unchecked", async () => {
    requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
    const order: Order = {
      account: "kraken",
      symbol: "SOLEUR",
      side: "buy",
      quantity: 1.23456789012,
      price: 100,
      orderType: "limit",
      currency: "EUR",
      stop: 90,
      assetKind: "crypto",
      venue: "kraken",
    };
    const t = createTicket(order);
    await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: t.fingerprint, riskReducing: false, notionalBase: 123 });
    const adapter: BrokerAdapter = {
      venue: "kraken",
      env: "test",
      bookTop: async () => ({ bid: 99.9, ask: 100, at: new Date().toISOString() }),
      instrumentRules: async (): Promise<InstrumentRules> => parseKrakenRules(NO_LOT, "SOLEUR", "fake AssetPairs", new Date().toISOString()),
      permissions: async () => ({ canTrade: true, canWithdraw: false, source: "apiRestrictions" }),
      balances: async () => [],
      preview: async () => ({ ok: true }),
      submit: async () => {
        throw new Error("these tests never submit");
      },
      query: async () => undefined,
      cancel: async (_s, id) => ({ state: "cancelled", clientOrderId: id }),
      openOrders: async () => [],
    };
    const pre = await preconditions({ ticket: loadTicket(t.id), venue: "kraken", env: "test", adapter, venueSym: "SOLEUR" });
    expect(pre.refusals.map((r) => r.code).filter((c) => /GRID|RULES/.test(c))).not.toEqual([]);
  });
});

describe("a plan on a live venue whose answer carries no tick and no step", () => {
  const fakeHttp =
    (body: unknown): HttpFn =>
    async () => ({ status: 200, body: JSON.stringify(body) });

  it("does not say the grid was checked: it carries the GRID condition an unreadable answer gets", async () => {
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "real");
    // HTTP 200, the product is online, but neither price_increment/quote_increment nor base_increment.
    const p = await withFixture("trading-paper-mcpa", () =>
      planTrade({ symbol: "MC.PA", account: "cto", venue: "coinbase", entry: 383.3, stop: 366.7, now: clockNow(), rulesHttp: fakeHttp({ status: "online" }) }),
    );
    // Nothing was rounded (no tick), the quantity was sized on the PAPER lot convention (no step)…
    expect(p.entry).toBe(383.3);
    expect(p.grid.checked === false || p.conditions.some((c) => /^GRID/.test(c))).toBe(true);
  });
});
