// Fees with no built-in schedule: the user's own (real ledger), else the venue's
// as researched, else nothing — paper refuses to fill, a backtest asks for its
// costs. Slippage is an assumption and every output that uses it says so.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { backtestCosts } from "../src/backtest/run.js";
import { clockNow } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions, type Transaction } from "../src/portfolio/ledger.js";
import { feeLookup, ownFeeRate, researchedFee } from "../src/trading/fees.js";
import { paperSubmit } from "../src/trading/paper.js";
import { planTrade } from "../src/trading/plan.js";
import { createTicket, loadTicket, recordCheck } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";
import { FIXTURE_SAFE_DATE, installTestVenueFacts } from "./helpers/venue-facts.js";

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
});

const fill = (i: number, fee: number | undefined, o: Partial<Transaction> = {}): Transaction =>
  ({
    id: `t${i}`,
    date: `2026-09-0${i + 1}`,
    type: "buy",
    account: "cto",
    symbol: "MC.PA",
    quantity: 2,
    price: 500,
    fee,
    currency: "EUR",
    origin: "import",
    ...o,
  }) as Transaction;

describe("which fee a fill pays", () => {
  it("the user's own fees on the account, from three fills with a fee recorded", () => {
    const own = ownFeeRate("cto", "EUR", [fill(0, 2), fill(1, 3), fill(2, 1), fill(3, undefined), fill(4, 9, { account: "pea" })]);
    expect(own?.model.pct).toBeCloseTo(6 / 3000, 12);
    expect(own?.basis).toMatch(/your own fees on cto: 0\.2000 % of the notional over your last 3 EUR fill\(s\)/);
    expect(ownFeeRate("cto", "EUR", [fill(0, 2), fill(1, 3)])).toBeUndefined();
    installTestVenueFacts();
    // Own fees win over the researched schedule; with too few, the schedule.
    expect(feeLookup({ account: "cto", currency: "EUR" }, "euronext", "taker", { ledger: [fill(0, 2), fill(1, 3), fill(2, 1)] })).toMatchObject({
      source: "ledger",
    });
    expect(feeLookup({ account: "cto", currency: "EUR" }, "euronext", "taker", { ledger: [] })).toMatchObject({
      source: "researched",
      model: { pct: 0.001, perUnit: 0, min: 2 },
    });
  });

  it("the venue an account names, else Binance's for a crypto fill (its book is walked), maker or taker", () => {
    installTestVenueFacts();
    expect(researchedFee("kraken", "crypto", "maker")).toMatchObject({ model: { pct: 0.0025, min: 0 } });
    expect(researchedFee("ledger-wallet", "crypto", "taker")).toMatchObject({ model: { pct: 0.001 } });
    expect(researchedFee("ibkr", "us", "taker")).toMatchObject({ model: { pct: 0, perUnit: 0.005, min: 1 } });
    const none = researchedFee("boursorama", "euronext", "taker");
    expect("missing" in none && none.missing).toMatch(
      /no fee is known for account\.boursorama\.fees, account\.boursorama\.perUnit, account\.boursorama\.minimum: .*ultrastock facts research venues --country FR/,
    );
  });

  it("nothing known: says to research the venue or import the account", () => {
    const r = feeLookup({ account: "cto", currency: "EUR" }, "euronext", "taker", { ledger: [] });
    expect("missing" in r && r.missing).toMatch(/no venue facts are stored for FR .*facts research venues.*or import the cto account's statements/);
  });
});

describe("a paper fill needs its fee", () => {
  it("refuses to fill without one: the ticket stays checked", async () => {
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "paper");
    await withFixture("trading-paper-mcpa", async () => {
      const p = await planTrade({ symbol: "MC.PA", account: "cto", now: clockNow() });
      // The plan says it before the ticket is submitted.
      expect(p.notes.join("\n")).toMatch(
        /fees: none known for a paper fill on cto, so `ultrastock paper submit` refuses the ticket until one is — no fee is known/,
      );
      const t = createTicket(p.order);
      await recordCheck(t.id, p.gate);
      await expect(paperSubmit(t.id, clockNow())).rejects.toThrow(/no paper fill: no fee is known for account\.cto\.fees/);
      expect(loadTicket(t.id).status).toBe("checked");
    });
  });

  it("fills with the researched fee, and calls its slippage an assumption", async () => {
    installTestVenueFacts({ date: FIXTURE_SAFE_DATE });
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "paper");
    await withFixture("trading-paper-mcpa", async () => {
      const p = await planTrade({ symbol: "MC.PA", account: "cto", now: clockNow() });
      expect(p.notes.join("\n")).toMatch(/fees: a paper fill on cto pays .*account\.cto/);
      const t = createTicket(p.order);
      await recordCheck(t.id, p.gate);
      const r = await paperSubmit(t.id, clockNow());
      if (r.outcome.kind !== "fill") throw new Error(r.outcome.reason);
      expect(r.outcome.fill.method).toMatch(
        /bp slippage \(an assumption, not measured\); fee: account\.cto taker 0\.1000 % \+ 0 per unit, minimum 2 — researched/,
      );
      expect(r.outcome.fill.fee).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("a backtest's costs", () => {
  it("as given, said so; slippage an assumption unless given", () => {
    const g = backtestCosts(false, false, { makerPct: 0.05, takerPct: 0.1 });
    expect(g.costs).toEqual({ makerPct: 0.05, takerPct: 0.1, slippagePct: 0.05 });
    expect(g.notes).toEqual([
      "fees as given: maker 0.05 %, taker 0.1 % per side",
      "slippage 0.05 % per side on market orders is an ASSUMPTION (a convention, not measured): --slippage sets it",
    ]);
    expect(backtestCosts(false, false, { makerPct: 0, takerPct: 0, slippagePct: 0.2 }).notes[1]).toBe("slippage 0.2 % per side as given");
  });

  it("crypto: Binance's researched schedule (spot, or USDⓈ-M for a perpetual), named", () => {
    installTestVenueFacts();
    const spot = backtestCosts(true, false);
    expect(spot.costs).toMatchObject({ makerPct: 0.1, takerPct: 0.1 });
    expect(spot.notes[0]).toMatch(/^fees: maker 0\.1 %, taker 0\.1 % per side — researched binance\.spot\.fees in .*venues/);
    expect(backtestCosts(true, true).costs).toMatchObject({ makerPct: 0.02, takerPct: 0.05 });
    expect(backtestCosts(true, false, { takerPct: 0.2 }).notes[0]).toMatch(/partly as given, the rest from researched/);
  });

  it("refuses to run without fees: a listed security needs the flags, crypto the flags or the research", () => {
    expect(() => backtestCosts(false, false)).toThrow(
      /a backtest of a listed security needs its trading costs: --fee <percent per side> \(or --maker and --taker\)/,
    );
    expect(() => backtestCosts(true, false)).toThrow(/the backtest's fees are unknown: no fee is known for binance\.spot\.fees.*facts research venues.*--fee/);
  });
});
