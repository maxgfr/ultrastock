// The live gate (trading/live.ts preconditions) against the user's country research: a stablecoin leg the research
// blocks, whichever side of the pair it is on. A scripted fake venue only; the process's HTTP layer is pinned to an
// EMPTY fixture, so nothing here can reach a venue, the ECB or ESMA.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import type { BrokerAdapter } from "../src/trading/brokers/types.js";
import { LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";
import { preconditions } from "../src/trading/live.js";
import { type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, recordCheck } from "../src/trading/tickets.js";
import { installJurisdictionTestFacts } from "./helpers/jurisdiction-facts.js";
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
