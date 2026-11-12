// A live plan quoted in a dollar stablecoin says what the research of the
// user's country concluded about the coin (jurisdiction `stablecoin.<coin>`),
// or that it was not researched and how to research it.
import { beforeEach, describe, expect, it } from "vitest";
import { stablecoinKey } from "../src/core/jurisdiction.js";
import { quoteAssetNote } from "../src/trading/plan.js";
import { clearJurisdictionFacts, installJurisdictionTestFacts } from "./helpers/jurisdiction-facts.js";

describe("a live plan quoted in a dollar stablecoin", () => {
  beforeEach(() => clearJurisdictionFacts());

  it("names the research to do when the coin is not researched; paper and fiat say nothing", () => {
    expect(quoteAssetNote("binance", "USDT", "DE")).toMatch(
      /quoted in USDT: USDT for residents of DE is unknown \(not researched for DE — research it: `ultrastock facts research jurisdiction --country DE --key stablecoin\.usdt --out <run>`/,
    );
    expect(quoteAssetNote("binance", "USDT", undefined)).toMatch(/no profile names the country .*profile init --jurisdiction <CC>/);
    expect(quoteAssetNote("paper", "USDT", "DE")).toBeUndefined();
    expect(quoteAssetNote("kraken", "EUR", "DE")).toBeUndefined();
  });

  it("says what the research concluded", () => {
    installJurisdictionTestFacts({ DE: { [stablecoinKey("USDT")]: "blocked", [stablecoinKey("USDC")]: "allowed" } });
    expect(quoteAssetNote("binance", "USDT", "DE")).toMatch(
      /USDT for residents of DE is blocked \(TEST conclusion for DE: blocked.*refused until the research says "allowed"/,
    );
    expect(quoteAssetNote("kraken", "USDC", "DE")).toMatch(/the DE research allows it \(TEST conclusion for DE: allowed/);
  });
});
