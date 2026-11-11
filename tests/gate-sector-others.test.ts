// 8b619c6 — "real money does not go on an unchecked limit": a sector that could not be looked up blocks a live
// ticket's check. That holds for what the book already holds (or has waiting) too: a share whose sector is unknown is
// left out of the sector's total, so SECTOR_PCT cannot say "pass".
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clockNow } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { gateContextFor } from "../src/trading/context.js";
import { type GateContext, type Order, orderFingerprint, riskGate } from "../src/trading/riskgate.js";
import { createTicket, recordCheck } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";

const buy = (o: Partial<Order> = {}): Order => ({
  account: "cto",
  symbol: "MC.PA",
  side: "buy",
  quantity: 1,
  price: 600,
  orderType: "limit",
  currency: "EUR",
  stop: 560,
  assetKind: "equity",
  venue: "ibkr", // a live venue: the real book
  ...o,
});

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

describe("the sector limit of a live ticket", () => {
  it("is not reported as passed when the sector of another position could not be looked up", async () => {
    const p = defaultProfile("FR", "EUR");
    p.limits.maxSectorPct = 10;
    p.limits.maxPositionPct = 100; // only the sector rule is looked at here
    saveProfile(p);
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "real");
    // Already checked and waiting: Hermès, 1 800 = 9 % of the book — the same sector as LVMH.
    const waiting = buy({ symbol: "RMS.PA", quantity: 1, price: 1800, stop: 1700 });
    const t = createTicket(waiting);
    await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(waiting), riskReducing: false, notionalBase: 1800 });

    await withFixture("trading-paper-mcpa", async () => {
      const next = buy(); // 600 more in the sector: 12 %, over the 10 % limit
      const { ctx, notes } = await gateContextFor(next, {
        now: clockNow(),
        // TradingView answers for the order's share and fails for the other one (a 429, a timeout).
        sectorOf: async (s) => {
          if (s === "MC.PA") return "Consumer Durables";
          throw new Error("TradingView: HTTP 429");
        },
      });
      expect(ctx.pendingBuysBase["RMS.PA"]).toBe(1800);
      expect(notes.join("\n")).toMatch(/sector unknown for RMS\.PA/);
      // What the ticket stores: the limit was not measured on the whole book, so the check must not read "pass".
      const sector = riskGate(next, ctx).checks.find((c) => c.code === "SECTOR_PCT");
      expect(sector?.status).not.toBe("pass");
    });
  });
});

describe("SECTOR_PCT with other shares of unknown sector", () => {
  const ctx = (c: Partial<GateContext> = {}): GateContext => ({
    profile: { ...defaultProfile("FR", "EUR"), limits: { ...defaultProfile("FR", "EUR").limits, maxSectorPct: 10, maxPositionPct: 100 } },
    equityBase: 20_000,
    cashBase: 20_000,
    fxToBase: 1,
    positionValueBase: 0,
    heldQuantity: 0,
    sector: "Consumer Durables",
    sectorValueBase: 600,
    cryptoValueBase: 0,
    openSymbols: [],
    pendingBuysBase: {},
    ordersToday: 0,
    lastPrice: 600,
    quoteAt: "2026-10-24T10:00:00Z",
    now: new Date("2026-10-24T10:05:00Z"),
    maxQuoteAgeMs: 15 * 60_000,
    breaker: { tripped: false, sizeMultiplier: 1 },
    ...c,
  });
  const status = (o: Order, c: GateContext) => riskGate(o, c).checks.find((x) => x.code === "SECTOR_PCT")?.status;

  it("passes when every other share's sector is known, blocks a live ticket and warns a paper one when not", () => {
    expect(status(buy(), ctx())).toBe("pass");
    expect(status(buy(), ctx({ sectorUnknown: ["RMS.PA"] }))).toBe("block");
    expect(status(buy({ venue: "paper" }), ctx({ sectorUnknown: ["RMS.PA"] }))).toBe("warn");
    // Over the limit on what is known: a block whatever the rest.
    expect(status(buy({ venue: "paper", quantity: 4 }), ctx({ sectorUnknown: ["RMS.PA"] }))).toBe("block");
  });
});
