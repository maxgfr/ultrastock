// riskgate.ts says "Orders that only REDUCE risk (selling what is held) pass the breaker and the caps: getting
// out must always be possible", and the profile calls its exclusions "tickers, sectors or themes never to BUY".
import { describe, expect, it } from "vitest";
import { defaultProfile } from "../src/core/profile.js";
import { type GateContext, type Order, riskGate } from "../src/trading/riskgate.js";

const ctx = (c: Partial<GateContext> = {}): GateContext => ({
  profile: defaultProfile("FR", "EUR"),
  equityBase: 50_000,
  cashBase: 20_000,
  fxToBase: 1,
  positionValueBase: 3_810,
  heldQuantity: 10,
  cryptoValueBase: 0,
  openSymbols: ["MC.PA"],
  pendingBuysBase: {},
  ordersToday: 0,
  lastPrice: 381,
  quoteAt: "2026-10-24T10:00:00Z",
  now: new Date("2026-10-24T10:05:00Z"),
  maxQuoteAgeMs: 15 * 60_000,
  breaker: { tripped: false, sizeMultiplier: 1 },
  ...c,
});

const sell = (o: Partial<Order> = {}): Order => ({
  account: "cto",
  symbol: "MC.PA",
  side: "sell",
  quantity: 10,
  price: 381,
  orderType: "limit",
  currency: "EUR",
  assetKind: "equity",
  venue: "ibkr",
  ...o,
});

describe("a sell of what is held", () => {
  it("passes when the share was put on the exclusion list after it was bought", () => {
    const p = defaultProfile("FR", "EUR");
    p.constraints.exclusions = ["MC.PA"]; // `profile set constraints.exclusions MC.PA`: a tightening, in force at once
    const r = riskGate(sell(), ctx({ profile: p }));
    expect(r.riskReducing).toBe(true);
    expect(r.checks.filter((c) => c.status === "block")).toEqual([]);
    expect(r.verdict).toBe("pass");
  });

  it("passes when crypto was switched off in the profile after the coins were bought", () => {
    const p = defaultProfile("FR", "EUR");
    p.constraints.allowCrypto = false; // `profile set constraints.allowCrypto false`
    const r = riskGate(
      sell({ account: "kraken", symbol: "SOLEUR", assetKind: "crypto", venue: "kraken", price: 100 }),
      ctx({ profile: p, lastPrice: 100, openSymbols: ["SOLEUR"], positionValueBase: 1_000, cryptoValueBase: 1_000 }),
    );
    expect(r.riskReducing).toBe(true);
    expect(r.checks.filter((c) => c.status === "block")).toEqual([]);
    expect(r.verdict).toBe("pass");
  });
});
