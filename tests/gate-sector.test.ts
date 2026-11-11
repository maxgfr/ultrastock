import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile } from "../src/core/profile.js";
import { setCacheMode } from "../src/engine.js";
import { tradingviewSector } from "../src/trading/context.js";
import { type GateContext, type Order, riskGate } from "../src/trading/riskgate.js";

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
