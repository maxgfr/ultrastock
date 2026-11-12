// Kalshi's fee: the formula and its coefficient researched (venues facts), the
// series' fee_type and fee_multiplier read live — and nothing computed, nor any
// paper fill made, when a part is missing.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { predictAnalysisCommand } from "../src/commands/quant.js";
import { setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import type { CommandArgs } from "../src/engine.js";
import { kalshiTakerTerms, simulatePredictionFill } from "../src/trading/prediction.js";
import { withFixture } from "./helpers/fixtures.js";
import { installTestVenueFacts, TEST_VENUE_VALUES } from "./helpers/venue-facts.js";

/** Kalshi's public API as documented: a market names its event, the event its series, the series its fee terms. */
function kalshiApi(series: Record<string, unknown> = { ticker: "KXFED", fee_type: "quadratic", fee_multiplier: 1 }) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    const u = String(url);
    const body = u.includes("/series/")
      ? { series }
      : u.includes("/events/")
        ? { event: { event_ticker: "KXFED-26DEC", series_ticker: "KXFED" }, markets: [] }
        : u.endsWith("/orderbook")
          ? { orderbook_fp: { yes_dollars: [["0.3800", "50.00"]], no_dollars: [["0.5900", "40.00"]] } }
          : { market: { ticker: "KXFED-26DEC-T4.25", event_ticker: "KXFED-26DEC", status: "active" } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  return asked;
}

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("US", "USD"));
  setNetMode({ kind: "live" });
});
afterEach(() => vi.unstubAllGlobals());

const order = { symbol: "KALSHI:KXFED-26DEC-T4.25:YES", side: "buy" as const, quantity: 10, price: 0.45, orderType: "limit" as const };

describe("Kalshi fee terms", () => {
  it("unknown without the researched formula: says what to research, computes nothing, fills nothing", async () => {
    kalshiApi();
    const t = await kalshiTakerTerms("KXFED-26DEC-T4.25");
    expect("missing" in t && t.missing).toMatch(
      /no fee is known for kalshi\.feeFormula: no venue facts are stored for US .*ultrastock facts research venues --country US/,
    );
    await expect(simulatePredictionFill(order, new Date())).rejects.toThrow(/no paper fill on Kalshi: no fee is known/);
  });

  it("the researched coefficient × the series' live multiplier, by the formula the engine knows", async () => {
    installTestVenueFacts({ country: "US" });
    const asked = kalshiApi({ ticker: "KXFED", fee_type: "quadratic", fee_multiplier: 0.5 });
    const t = await kalshiTakerTerms("KXFED-26DEC-T4.25");
    if ("missing" in t) throw new Error(t.missing);
    expect(t).toMatchObject({ coefficient: 0.07, multiplier: 0.5, feeType: "quadratic", series: "KXFED" });
    expect(asked.some((u) => u.endsWith("/trade-api/v2/series/KXFED"))).toBe(true);
    const fill = await simulatePredictionFill(order, new Date());
    if (fill.kind !== "fill") throw new Error(fill.reason);
    // The YES ask is 1 − 0.59 = 0.41: ceil_to_cent(0.07 × 0.5 × 10 × 0.41 × 0.59) = ceil(8.4665) / 100 = 0.09
    expect(fill.fill.price).toBe(0.41);
    expect(fill.fill.fee).toBe(0.09);
    expect(fill.fill.method).toMatch(/fee_multiplier 0\.5 and fee_type quadratic of series KXFED/);
  });

  it("refuses a formula it does not compute, and a fee type it does not know", async () => {
    installTestVenueFacts({ country: "US", values: { ...TEST_VENUE_VALUES, "kalshi.feeFormula": "0.07 per contract, flat" } });
    kalshiApi();
    const a = await kalshiTakerTerms("KXFED-26DEC-T4.25");
    expect("missing" in a && a.missing).toMatch(/researched Kalshi fee formula is "0\.07 per contract, flat".*ultrastock computes only/);
    installTestVenueFacts({ country: "US" });
    setNetMode({ kind: "live" }); // a fresh read: the first answer is memoised
    kalshiApi({ ticker: "KXFED", fee_type: "flat", fee_multiplier: 1 });
    const b = await kalshiTakerTerms("KXFED-26DEC-T4.25");
    expect("missing" in b && b.missing).toMatch(/fee_type "flat"/);
  });
});

describe("predict-analysis says when the Kalshi fee is unknown", () => {
  const cmd = (positional: string[], values: Record<string, string>): CommandArgs => ({ command: "predict-analysis", positional, values, bools: new Set() });
  it("no researched fee and no --kalshi-fee: no fee modelled, said plainly", async () => {
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out += String(c);
      return true;
    });
    try {
      await withFixture("quant-predict-kalshi", () => predictAnalysisCommand(cmd(["kalshi", "KXFED"], { limit: "2" }), true));
    } finally {
      vi.restoreAllMocks();
    }
    expect(out).toMatch(/no Kalshi fee modelled — the fee is unknown: no fee is known for kalshi\.feeFormula/);
  });
});
