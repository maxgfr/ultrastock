// The facts and tax commands' small promises:
// - `facts template tax --key k` and `facts show tax --key k` printed every key: the flag was read for the other
//   domains only (tax is routed to `tax rules`, which ignored it);
// - `facts template tax --currency` was refused as an unknown flag though `tax rules template` takes it;
// - `tax export --format koinly` built the FR / US engine — refusing without researched rules — for a transaction list
//   that reads none, and was refused for any other country;
// - a research dated by the user's own calendar (ahead of UTC east of Greenwich) was refused as "in the future".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { factsInvocation } from "../src/commands/facts.js";
import { JURISDICTION } from "../src/core/jurisdiction.js";
import { loadLatestFacts, saveFacts } from "../src/core/researched.js";
import type { CommandArgs } from "../src/engine.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { validateRules } from "../src/tax/rules.js";
import { clearTestFacts } from "./helpers/facts.js";
import { clearTaxRules, installTaxTestRules } from "./helpers/tax-rules.js";

async function cli(argv: string[]) {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await main(argv);
  } finally {
    vi.restoreAllMocks();
  }
  return out;
}
const args = (positional: string[], values: Record<string, string>): CommandArgs => ({ command: "facts", positional, values, bools: new Set() });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  clearTaxRules();
  clearTestFacts(JURISDICTION);
});
afterEach(() => vi.restoreAllMocks());

describe("facts template|show tax --key", () => {
  it("the template holds the keys asked only", async () => {
    const t = JSON.parse(await cli(["facts", "template", "tax", "--country", "US", "--year", "2025", "--key", "ltcg.rates,washSale.windowDays"]));
    expect(Object.keys(t.facts)).toEqual(["ltcg.rates", "washSale.windowDays"]);
  });

  it("show prints the keys asked only, and refuses a key the country does not have", async () => {
    installTaxTestRules([2025]);
    const shown = JSON.parse(await cli(["facts", "show", "tax", "--country", "US", "--year", "2025", "--key", "ltcg.rates", "--json"]));
    expect(Object.keys(shown.rules.facts)).toEqual(["ltcg.rates"]);
    const text = await cli(["facts", "show", "tax", "--country", "US", "--year", "2025", "--key", "washSale.windowDays"]);
    expect(text).toMatch(/washSale\.windowDays = /);
    expect(text).not.toMatch(/ltcg\.rates = /);
  });
});

describe("facts template tax --currency", () => {
  it("is the tax template's flag: accepted there, refused clearly elsewhere", async () => {
    expect(() => factsInvocation(args(["template", "tax"], { country: "DE", currency: "EUR" }))).not.toThrow();
    const t = JSON.parse(await cli(["facts", "template", "tax", "--country", "DE", "--year", "2025", "--currency", "eur"]));
    expect(t.currency).toBe("EUR");
    expect(() => factsInvocation(args(["template", "jurisdiction"], { country: "FR", currency: "EUR" }))).toThrow(
      /--currency sets the currency of a tax template/,
    );
    expect(() => factsInvocation(args(["show", "tax"], { country: "FR", currency: "EUR" }))).toThrow(/--currency/);
  });
});

describe("tax export --format koinly", () => {
  it("needs no researched rule, whatever the country", async () => {
    await appendTransactions(
      [{ date: "2025-01-02", type: "buy", account: "cb", currency: "EUR", symbol: "ETHEUR", quantity: 2, price: 1000, origin: "manual" }],
      "koinly",
    );
    for (const country of ["FR", "DE"]) {
      const csv = await cli(["tax", "export", "--format", "koinly", "--country", country, "--year", "2025", "--book", "koinly"]);
      expect(csv.split("\r\n")[1]).toMatch(/^2025-01-02 00:00 UTC,2000,EUR,2,ETH,/);
    }
  });
});

describe("the date of a research, in the user's calendar", () => {
  const file = (at: string) => ({
    country: "US",
    year: 2025,
    currency: "USD",
    researchedAt: at,
    facts: {
      "longTerm.holdingYears": { value: 1, label: "TEST DATA — not law", sources: ["https://www.irs.gov/taxtopics/tc409"], verifiedAt: at, confidence: "high" },
    },
  });
  it("tomorrow in UTC is today somewhere: accepted; the day after is the future", () => {
    expect(() => validateRules(file(day(1)))).not.toThrow();
    expect(() => validateRules(file(day(2)))).toThrow(/in the future/);
  });
  it("a date-period file dated tomorrow in UTC is stored and read", () => {
    const f = (v: string) => ({ value: v, label: "TEST DATA", sources: ["https://example.invalid/t"], verifiedAt: day(1), confidence: "high" });
    const v = saveFacts(JURISDICTION, { country: "FR", date: day(1), researchedAt: day(1), facts: { polymarket: f("blocked") } });
    expect(v.file.period).toBe(day(1));
    expect(loadLatestFacts(JURISDICTION, "FR").current.polymarket?.value).toBe("blocked");
    expect(() => saveFacts(JURISDICTION, { country: "FR", date: day(2), researchedAt: day(1), facts: { polymarket: f("blocked") } })).toThrow(/future/);
  });
});
