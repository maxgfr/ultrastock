import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { clockNow } from "../src/core/net.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { setCacheMode } from "../src/engine.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { gateContextFor, tradingviewSector } from "../src/trading/context.js";
import { type GateContext, type Order, orderFingerprint, riskGate } from "../src/trading/riskgate.js";
import { createTicket, recordCheck } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";

const mcpa = (o: Partial<Order> = {}): Order => ({
  account: "cto",
  symbol: "MC.PA",
  side: "buy",
  quantity: 1,
  price: 600,
  orderType: "limit",
  currency: "EUR",
  stop: 560,
  assetKind: "equity",
  venue: "paper",
  ...o,
});

const context = (c: Partial<GateContext> = {}): GateContext => ({
  profile: defaultProfile("FR", "EUR"),
  equityBase: 20_000,
  cashBase: 20_000,
  fxToBase: 1,
  positionValueBase: 0,
  heldQuantity: 0,
  cryptoValueBase: 0,
  openSymbols: [],
  pendingBuysBase: {},
  ordersToday: 0,
  lastPrice: 600,
  quoteAt: new Date().toISOString(),
  now: new Date(),
  maxQuoteAgeMs: 15 * 60_000,
  breaker: { tripped: false, sizeMultiplier: 1 },
  ...c,
});

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

describe("the sector rule", () => {
  it("counts the other pending buys of the order's own symbol in its sector", async () => {
    const p = defaultProfile("FR", "EUR");
    p.limits.maxSectorPct = 10;
    p.limits.maxPositionPct = 100; // only the sector rule is looked at here
    saveProfile(p);
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "paper");
    // A buy already checked and waiting: 3 × 600 = 1 800, 9 % of the book, in the same sector — it is the same share.
    const waiting = mcpa({ quantity: 3 });
    const t = createTicket(waiting);
    await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(waiting), riskReducing: false, notionalBase: 1800 });
    await withFixture("trading-paper-mcpa", async () => {
      const next = mcpa({ quantity: 1 }); // 600 more: 12 % of one sector, over the 10 % limit
      const { ctx } = await gateContextFor(next, { now: clockNow(), sectorOf: async () => "Consumer Durables" });
      expect(ctx.pendingBuysBase["MC.PA"]).toBe(1800);
      expect(ctx.sectorValueBase).toBe(1800);
      expect(riskGate(next, ctx).checks.find((c) => c.code === "SECTOR_PCT")).toMatchObject({ status: "block" });
    });
  });
});

describe("a sector that cannot be looked up", () => {
  it("is not a way round the limit: `ticket check --offline` must leave a trace in the checks, not only a note", async () => {
    setCacheMode({ refresh: false, offline: true });
    try {
      // --offline: no request is made, nothing is cached for a share never checked before → "no sector found".
      const found = await tradingviewSector("MC.PA", { symbol: "MC.PA", market: "euronext", kind: "equity", currency: "EUR", venueId: "FR0000121014-XPAR" });
      expect(found).toBeUndefined();
    } finally {
      setCacheMode({ refresh: false, offline: false });
    }
    // The context gateContextFor then builds: no sector, no sectorValueBase.
    const sectorChecks = riskGate(mcpa(), context()).checks.filter((c) => /SECTOR/.test(c.code));
    // The ticket's stored check says something of the sector: a live submit can tell this check from a complete one.
    expect(sectorChecks.map((c) => c.status)).not.toEqual([]);
  });

  it("warns on paper and blocks for a live venue", () => {
    const sector = (o: Order) => riskGate(o, context()).checks.find((c) => c.code === "SECTOR_PCT");
    expect(sector(mcpa())).toMatchObject({ status: "warn", reason: expect.stringMatching(/not checked/) });
    expect(sector(mcpa({ venue: "ibkr" }))).toMatchObject({ status: "block" });
    // A sell, an ETF or a crypto-asset has no sector rule to miss.
    expect(sector(mcpa({ assetKind: "etf" }))).toBeUndefined();
  });
});
