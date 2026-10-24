import { describe, expect, it } from "vitest";
import { concentrationPoints, holderConcentration, rpcResult, solanaTokenConcentration, tokenUnits } from "../src/providers/crypto/solana.js";
import { ProviderError } from "../src/providers/types.js";

const amt = (ui: number, decimals = 5) => ({ amount: String(Math.round(ui * 10 ** decimals)), decimals, uiAmount: ui });

describe("Solana holder concentration", () => {
  it("sums the ten largest accounts over supply", () => {
    const largest = [50, 10, 5, 5, 5, 5, 5, 5, 5, 3, 1, 1].map((v) => amt(v));
    const c = holderConcentration(largest, amt(200))!;
    expect(c.topN).toBe(10);
    expect(c.topShare).toBeCloseTo(((50 + 10 + 5 * 7 + 3) / 200) * 100);
    expect(c.top1Share).toBe(25);
    expect(holderConcentration(largest, amt(0))).toBeUndefined();
    expect(tokenUnits({ amount: "12345", decimals: 2, uiAmount: null })).toBe(123.45);
    const pts = concentrationPoints("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", c, "2026-10-24");
    expect(pts[0]).toMatchObject({ key: "SOL.DezXAZ8z7P.holders.top10Share", unit: "%" });
    expect(pts[0]!.formula).toMatch(/supply/);
  });
  it("maps JSON-RPC errors carried in an HTTP 200", () => {
    expect(rpcResult("getTokenSupply", 200, { result: { value: 1 } })).toEqual({ value: 1 });
    const throttled = (() => {
      try {
        rpcResult("getTokenLargestAccounts", 429, { error: { code: 429, message: "Too many requests" } });
      } catch (e) {
        return e as ProviderError;
      }
    })()!;
    expect(throttled.transient).toBe(true);
    const bad = (() => {
      try {
        rpcResult("getTokenSupply", 200, { error: { code: -32602, message: "Invalid param: WrongSize" } });
      } catch (e) {
        return e as ProviderError;
      }
    })()!;
    expect(bad.transient).toBe(false);
    expect(() => rpcResult("x", 200, { error: { code: -32005 } })).toThrow(ProviderError);
  });
  it("rejects a malformed mint before any call", async () => {
    await expect(solanaTokenConcentration("not-a-mint")).rejects.toBeInstanceOf(ProviderError);
  });
});
