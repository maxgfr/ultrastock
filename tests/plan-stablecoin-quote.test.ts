// A live plan quoted in a dollar stablecoin says that whether the coin may be
// traded from the user's country is not checked yet (a jurisdiction rule).
import { describe, expect, it } from "vitest";
import { quoteAssetNote } from "../src/trading/plan.js";

describe("a live plan quoted in a dollar stablecoin", () => {
  it("says the coin's availability in the user's country is not checked; paper and fiat say nothing", () => {
    expect(quoteAssetNote("binance", "USDT")).toMatch(
      /quoted in USDT: whether USDT may be traded from your country of residence is a jurisdiction rule ultrastock does not check yet/,
    );
    expect(quoteAssetNote("paper", "USDT")).toBeUndefined();
    expect(quoteAssetNote("kraken", "EUR")).toBeUndefined();
  });
});
