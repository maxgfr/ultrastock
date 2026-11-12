import { describe, expect, it } from "vitest";
import { cryptoVenueGate, JURISDICTION, jurisdictionKeys, ruleFact, rulesFor, ruleStatus } from "../src/core/jurisdiction.js";
import { defaultProfile } from "../src/core/profile.js";
import { type GateContext, type Order, riskGate } from "../src/trading/riskgate.js";
import { saveFacts } from "../src/core/researched.js";
import { installJurisdictionTestFacts, testJurisdictionFile } from "./helpers/jurisdiction-facts.js";

const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("the jurisdiction domain", () => {
  it("declares each rule with a status type, a query, a source to prefer and an age limit — no value", () => {
    const keys = jurisdictionKeys("FR");
    expect(keys.map((k) => k.key)).toEqual(["polymarket", "kalshi", "us-domiciled-etf", "crypto-casp", "crypto-register", "foreign-accounts"]);
    expect(jurisdictionKeys("US").map((k) => k.key)).toContain("pfic");
    for (const k of keys) {
      expect(k.query).toMatch(/France/);
      expect(k.prefer.length).toBeGreaterThan(5);
      expect(k.maxAgeDays).toBeGreaterThan(0);
    }
    expect(keys.find((k) => k.key === "polymarket")!.maxAgeDays).toBe(90);
    expect(keys.find((k) => k.key === "us-domiciled-etf")!.maxAgeDays).toBe(180);
    expect(keys.find((k) => k.key === "crypto-register")!.values).toEqual(["esma-mica", "other", "none"]);
  });

  it("refuses a value outside the key's statuses and a key it does not know", () => {
    expect(() => saveFacts(JURISDICTION, testJurisdictionFile("FR", { polymarket: "maybe" }))).toThrow(/one of "allowed", "restricted", "blocked", "unknown"/);
    expect(() => saveFacts(JURISDICTION, testJurisdictionFile("FR", { polymarkt: "blocked" }))).toThrow(/not a FR jurisdiction key/);
    // A per-venue key is accepted with its own spec.
    expect(saveFacts(JURISDICTION, testJurisdictionFile("FR", { "cryptoVenue.kraken": "allowed" })).file.facts["cryptoVenue.kraken"]).toBeDefined();
  });

  it("reads unknown, naming the research command, when nothing is researched", () => {
    const r = ruleFact("DE", "polymarket");
    expect(r.status).toBe("unknown");
    expect(r.unresearched).toBe("not researched for DE");
    expect(r.research).toBe("ultrastock facts research jurisdiction --country DE --key polymarket --out <run>");
    expect(ruleFact("DE", "manifold").unresearched).toMatch(/no jurisdiction rule is kept/);
  });

  it("reads a fact past its age limit as unknown, and keeps the newest fact of each key across research dates", () => {
    saveFacts(JURISDICTION, testJurisdictionFile("FR", { polymarket: "blocked", kalshi: "unknown" }, daysAgo(120)));
    // 120 days old: past polymarket's 90 days.
    expect(ruleFact("FR", "polymarket")).toMatchObject({ status: "unknown", unresearched: expect.stringMatching(/stale.*older than 90 days/) });
    // Researching one key on a new day keeps the others' earlier facts.
    saveFacts(JURISDICTION, testJurisdictionFile("FR", { polymarket: "blocked" }, TODAY));
    saveFacts(JURISDICTION, testJurisdictionFile("FR", { "us-domiciled-etf": "restricted" }, daysAgo(10)));
    expect(ruleStatus("FR", "polymarket")).toBe("blocked");
    expect(ruleStatus("FR", "us-domiciled-etf")).toBe("restricted");
    const rules = rulesFor("FR").rules;
    expect(rules.find((r) => r.id === "polymarket")).toMatchObject({ status: "blocked", researched: true });
    expect(rules.find((r) => r.id === "crypto-casp")).toMatchObject({ status: "unknown", researched: false });
  });

  it("reads an expiresAt in the past as unknown", () => {
    const f = testJurisdictionFile("FR", { kalshi: "allowed" });
    (f.facts.kalshi as Record<string, unknown>).expiresAt = daysAgo(1);
    saveFacts(JURISDICTION, f);
    expect(ruleFact("FR", "kalshi").unresearched).toMatch(/expired/);
  });
});

describe("the risk gate on a US-domiciled ETF", () => {
  const etf: Order = {
    account: "cto",
    symbol: "VOO",
    side: "buy",
    quantity: 1,
    price: 500,
    orderType: "limit",
    currency: "USD",
    assetKind: "etf",
    venue: "paper",
    domicile: "US",
  };
  const ctx = (j: string, held = 0): GateContext => ({
    profile: defaultProfile(j, "EUR"),
    equityBase: 100_000,
    cashBase: 50_000,
    fxToBase: 0.9,
    positionValueBase: held * 450,
    heldQuantity: held,
    cryptoValueBase: 0,
    openSymbols: [],
    pendingBuysBase: {},
    ordersToday: 0,
    lastPrice: 500,
    quoteAt: new Date().toISOString(),
    now: new Date(),
    maxQuoteAgeMs: 15 * 60_000,
    breaker: { tripped: false, sizeMultiplier: 1 },
  });
  const priips = (o: Order, c: GateContext) => riskGate(o, c).checks.find((x) => x.code === "PRIIPS");
  it("blocks a buy until the research says allowed, naming the command; a sell of what is held passes", () => {
    expect(priips(etf, ctx("DE"))).toMatchObject({ status: "block", reason: expect.stringContaining("--country DE --key us-domiciled-etf") });
    expect(priips({ ...etf, side: "sell" }, ctx("DE", 1))).toMatchObject({ status: "warn", reason: expect.stringMatching(/selling what is held passes/) });
    installJurisdictionTestFacts();
    expect(priips(etf, ctx("FR"))).toMatchObject({ status: "block", reason: expect.stringMatching(/retail access is restricted — TEST conclusion for FR/) });
    expect(priips(etf, ctx("US"))).toBeUndefined();
  });
});

describe("crypto platforms: the researched regime, then its register", () => {
  it("refuses until the regime is researched, and when it is blocked", async () => {
    expect((await cryptoVenueGate("kraken", "DE")).reason).toMatch(
      /not researched for DE — research it: `ultrastock facts research jurisdiction --country DE --key crypto-casp/,
    );
    installJurisdictionTestFacts({ DE: { "crypto-casp": "blocked" } });
    expect(await cryptoVenueGate("kraken", "DE")).toMatchObject({ ok: false, reason: expect.stringMatching(/blocked for residents of DE/) });
  });
  it("passes where no authorisation is needed, and checks ESMA's register only when the research names it", async () => {
    installJurisdictionTestFacts({ US: { "crypto-casp": "allowed" }, FR: { "crypto-casp": "restricted", "crypto-register": "esma-mica" } });
    expect((await cryptoVenueGate("kraken", "US")).ok).toBe(true);
    expect(await cryptoVenueGate("kraken", "FR", { micaAuthorised: true })).toMatchObject({ ok: true });
    expect(await cryptoVenueGate("binance", "FR", { micaAuthorised: false })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not in ESMA's MiCA register for FR/),
    });
  });
  it("needs the venue's own fact when the register is one ultrastock cannot read", async () => {
    installJurisdictionTestFacts({ GB: { "crypto-casp": "restricted", "crypto-register": "other" } });
    const no = await cryptoVenueGate("kraken", "GB", { micaAuthorised: true });
    expect(no.ok).toBe(false);
    expect(no.reason).toContain("--key cryptoVenue.kraken");
    installJurisdictionTestFacts({ GB: { "crypto-casp": "restricted", "crypto-register": "other", "cryptoVenue.kraken": "allowed" } });
    expect((await cryptoVenueGate("kraken", "GB")).ok).toBe(true);
    expect((await cryptoVenueGate("binance", "GB")).ok).toBe(false);
    // Restricted with no register to check is a contradiction to settle, not a pass.
    installJurisdictionTestFacts({ GB: { "crypto-casp": "restricted", "crypto-register": "none" } });
    expect((await cryptoVenueGate("kraken", "GB")).ok).toBe(false);
  });
});
