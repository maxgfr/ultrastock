// Dollar stablecoins at their live USD price, not their peg: a depeg is said and
// blocks a live order; an unreadable rate degrades to a note (and the peg) off
// the live path, and is refused on it. Kraken and Coinbase are stubbed.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stablecoinKey } from "../src/core/jurisdiction.js";
import { setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import type { BrokerAdapter } from "../src/trading/brokers/types.js";
import { fxToBase } from "../src/trading/context.js";
import { preconditions } from "../src/trading/live.js";
import { pegNotes, readPegs } from "../src/trading/stablecoins.js";
import { createTicket, loadTicket, recordCheck } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";
import { installJurisdictionTestFacts } from "./helpers/jurisdiction-facts.js";
import { testGrid } from "./helpers/venue-rules.js";

/** Kraken's public AssetPairs and Ticker as documented, with a last trade per coin; Coinbase refuses. */
function venues(last: Record<string, string>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(String(url));
    const pair = u.searchParams.get("pair") ?? "";
    const coin = Object.keys(last).find((c) => pair.startsWith(c));
    if (u.hostname === "api.kraken.com" && coin && u.pathname.endsWith("/AssetPairs"))
      return Response.json({ error: [], result: { [`${coin}ZUSD`]: { altname: `${coin}USD`, wsname: `${coin}/USD`, base: coin, quote: "ZUSD" } } });
    if (u.hostname === "api.kraken.com" && coin && u.pathname.endsWith("/Ticker"))
      return Response.json({ error: [], result: { [`${coin}ZUSD`]: { c: [last[coin], "1.0"], o: "1.0000" } } });
    return new Response("{}", { status: 404 });
  });
}

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  setNetMode({ kind: "live" });
});
afterEach(() => vi.unstubAllGlobals());

describe("stablecoin rates", () => {
  it("reads each coin's USD price; off its peg by more than 0.5 % is a depeg, said so", async () => {
    venues({ USDT: "0.9992", USDC: "0.9910" });
    const [usdt, usdc] = await readPegs(["USDT", "USDC", "EUR"]);
    expect(usdt).toMatchObject({ coin: "USDT", usd: 0.9992, depegged: false });
    expect(usdc).toMatchObject({ coin: "USDC", usd: 0.991, depegged: true });
    const notes = pegNotes([usdt!, usdc!]);
    expect(notes[0]).toMatch(/USDT amounts converted at its live rate 0\.9992 USD \(kraken USDT\/USD/);
    expect(notes[1]).toMatch(/USDC trades at 0\.991 USD .*-0\.90 % off its 1 USD peg, beyond the 0\.5 % treated as a depeg \(an assumption\)/);
  }, 30_000);

  it("converts at the live rate, not at one dollar", async () => {
    venues({ USDT: "0.9900" });
    const fx = await fxToBase(["USDT"], "USD");
    expect(fx.rates.USDT).toBe(0.99);
    expect(fx.notes.join("\n")).toMatch(/USDT trades at 0\.99 USD/);
  }, 30_000);

  it("unreadable in a fixture replay: a note and the peg, never a throw", async () => {
    await withFixture("trading-paper-mcpa", async () => {
      const [r] = await readPegs(["USDT"]);
      expect(r!.usd).toBeUndefined();
      expect(pegNotes([r!])[0]).toMatch(/USDT's USD rate could not be read .*converted at its 1 USD peg, unverified/);
    });
  });
});

describe("the live gate and a stablecoin off its peg", () => {
  const adapter: BrokerAdapter = {
    venue: "kraken",
    env: "test",
    bookTop: async () => ({ bid: 99.9, ask: 100, at: new Date().toISOString() }),
    instrumentRules: testGrid,
    permissions: async () => ({ canTrade: true, canWithdraw: false, source: "apiRestrictions" }),
    balances: async () => [],
    preview: async () => ({ ok: true }),
    submit: async (o) => ({ state: "accepted", clientOrderId: o.clientOrderId }),
    query: async () => undefined,
    cancel: async (_s, id) => ({ state: "cancelled", clientOrderId: id }),
    openOrders: async () => [],
  };
  // A ticket id is its creation second + the order's fingerprint: the same order
  // twice within one second collides, so each ticket here gets its own second.
  let created = 0;
  const ticket = async () => {
    const t = createTicket(
      {
        account: "kraken",
        symbol: "SOLUSDT",
        side: "buy",
        quantity: 1,
        price: 100,
        orderType: "limit",
        currency: "USDT",
        stop: 90,
        assetKind: "crypto",
        venue: "kraken",
      },
      { now: new Date(Date.now() + 1000 * created++) },
    );
    await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: t.fingerprint, riskReducing: false, notionalBase: 100 });
    return loadTicket(t.id);
  };

  it("refuses an order priced in a depegged coin, and in one whose rate cannot be read", async () => {
    saveProfile(defaultProfile("US", "USD"));
    venues({ USDT: "0.9800" });
    const depeg = await preconditions({ ticket: await ticket(), venue: "kraken", env: "test", adapter, venueSym: "SOLUSDT" });
    expect(depeg.refusals.find((r) => r.code === "PEG")!.reason).toMatch(/USDT trades at 0\.98 USD, -2\.00 % off its peg/);
    setNetMode({ kind: "live" });
    venues({});
    const unread = await preconditions({ ticket: await ticket(), venue: "kraken", env: "test", adapter, venueSym: "SOLUSDT" });
    expect(unread.refusals.find((r) => r.code === "PEG")!.reason).toMatch(/USDT's USD rate could not be read/);
    setNetMode({ kind: "live" });
    venues({ USDT: "0.9995" });
    const fine = await preconditions({ ticket: await ticket(), venue: "kraken", env: "test", adapter, venueSym: "SOLUSDT" });
    expect(fine.refusals.map((r) => r.code)).not.toContain("PEG");
  }, 60_000);

  it("refuses a real order priced in a stablecoin the user's country research does not allow", async () => {
    saveProfile(defaultProfile("US", "USD"));
    venues({ USDT: "0.9995" });
    const t = await ticket();
    const coinRefusal = async (env: "live" | "test") =>
      (await preconditions({ ticket: t, venue: "kraken", env, adapter: { ...adapter, env }, venueSym: "SOLUSDT" })).refusals.find((r) =>
        r.reason.startsWith("USDT is"),
      );
    expect((await coinRefusal("live"))?.reason).toMatch(
      /USDT is unknown for residents of US: not researched for US — research it: `ultrastock facts research jurisdiction --country US --key stablecoin\.usdt --out <run>`/,
    );
    expect(await coinRefusal("test")).toBeUndefined(); // a testnet moves no real money
    installJurisdictionTestFacts({ US: { [stablecoinKey("USDT")]: "allowed" } });
    expect(await coinRefusal("live")).toBeUndefined();
  }, 60_000);
});
