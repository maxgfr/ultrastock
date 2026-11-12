// The fee a paper fill pays (src/trading/fees.ts, src/trading/venue-facts.ts) from the schedule researched for an account.
// A paper fill's fee feeds the paper record the live gate measures (trading/paper.ts): a fee that is stale, unusable
// or another product's flatters that record. No network: local facts only.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { feeFor, feeLookup, researchedFee } from "../src/trading/fees.js";
import { venueFact } from "../src/trading/venue-facts.js";
import { installTestVenueFacts } from "./helpers/venue-facts.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
});

describe("the broker researched for one of the user's accounts (account.<id>.*)", () => {
  // venue-facts.ts: "Every fee key is read as unknown 365 days after it was verified."
  it("goes stale after 365 days like every other fee key", () => {
    const old = daysAgo(800);
    installTestVenueFacts({
      date: old,
      values: {
        "kraken.spot.fees": { maker: 0.0025, taker: 0.004 },
        "account.cto.fees": { maker: 0.001, taker: 0.001 },
        "account.cto.perUnit": 0,
        "account.cto.minimum": 2,
      },
    });
    // Control: a registered key verified 800 days ago is unknown.
    expect(venueFact("kraken.spot.fees")).toHaveProperty("missing");
    expect(researchedFee("cto", "euronext", "taker")).toHaveProperty("missing");
  });

  it("is refused, or read as unknown, when it is not the {maker, taker} rates the engine applies", () => {
    // The template asks for account.<id>.fees as {maker, taker}; a bare rate is a natural slip.
    let stored = true;
    try {
      installTestVenueFacts({ values: { "account.cto.fees": 0.001, "account.cto.perUnit": 0, "account.cto.minimum": 0 } });
    } catch {
      stored = false; // refusing the file at `facts set` would be the fix
    }
    if (!stored) return;
    const f = researchedFee("cto", "euronext", "taker");
    const fee = "missing" in f ? undefined : feeFor(f.model, 10, 100);
    expect("missing" in f || Number.isFinite(fee)).toBe(true);
  });
});

describe("a schedule is applied to the product it was researched for", () => {
  it("does not charge a crypto fill on an account named ibkr by IBKR's per-share stock commission", () => {
    // ibkr.fees / ibkr.perUnit / ibkr.minimum are "Interactive Brokers stocks and ETFs" (VENUE_SPEC labels).
    installTestVenueFacts({
      values: { "ibkr.fees": { maker: 0, taker: 0 }, "ibkr.perUnit": 0.005, "ibkr.minimum": 1, "binance.spot.fees": { maker: 0.001, taker: 0.001 } },
    });
    const f = researchedFee("ibkr", "crypto", "taker");
    if ("missing" in f) return; // saying the crypto fee on this account is unknown would be fine
    // 0.5 BTC at 60 000: IBKR's stock schedule gives max(1, 0.005 × 0.5) = 1; the crypto fallback gives 30.
    expect(f.basis).not.toMatch(/^ibkr taker/);
    expect(feeFor(f.model, 0.5, 60_000)).toBeGreaterThan(1);
  });

  it("applies IBKR's stock schedule to a stock, and a crypto platform's spot schedule to crypto only", () => {
    installTestVenueFacts({
      values: {
        "ibkr.fees": { maker: 0, taker: 0 },
        "ibkr.perUnit": 0.005,
        "ibkr.minimum": 1,
        "ibkr.currency": "USD",
        "kraken.spot.fees": { maker: 0.0025, taker: 0.004 },
      },
    });
    expect(researchedFee("ibkr", "us", "taker", { currency: "USD" })).toMatchObject({ basis: expect.stringMatching(/^ibkr taker/) });
    expect(researchedFee("kraken", "crypto", "taker")).toMatchObject({ basis: expect.stringMatching(/^kraken\.spot taker/) });
    expect(researchedFee("kraken", "euronext", "taker")).toHaveProperty("missing");
  });
});

describe("a per-unit commission or a minimum is an amount in one currency", () => {
  const IBKR = { "ibkr.fees": { maker: 0, taker: 0 }, "ibkr.perUnit": 0.005, "ibkr.minimum": 1 };

  it("is applied to orders in its stated currency only", () => {
    installTestVenueFacts({ values: { ...IBKR, "ibkr.currency": "USD" } });
    expect(feeLookup({ account: "ibkr", currency: "USD" }, "us", "taker", { ledger: [] })).toMatchObject({ model: { perUnit: 0.005, min: 1 } });
    // 1 USD is not 1 EUR: a Euronext order on the same schedule has no known fee.
    const eur = feeLookup({ account: "ibkr", currency: "EUR" }, "euronext", "taker", { ledger: [] });
    expect("missing" in eur && eur.missing).toMatch(/in USD, the order is in EUR/);
  });

  it("is not applied at all when no currency is stated for it", () => {
    installTestVenueFacts({ values: IBKR });
    const r = feeLookup({ account: "ibkr", currency: "USD" }, "us", "taker", { ledger: [] });
    expect("missing" in r && r.missing).toMatch(/ibkr\.currency/);
  });

  it("needs no currency when the schedule is a percentage only", () => {
    installTestVenueFacts({ values: { "account.pea.fees": { maker: 0.001, taker: 0.001 }, "account.pea.perUnit": 0, "account.pea.minimum": 0 } });
    expect(feeLookup({ account: "pea", currency: "EUR" }, "euronext", "taker", { ledger: [] })).toMatchObject({ model: { pct: 0.001, min: 0 } });
  });
});
