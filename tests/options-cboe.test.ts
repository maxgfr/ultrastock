import { describe, expect, it } from "vitest";
import { cboeOptions, cboeSymbol, parseCboeOptions, parseOccSymbol } from "../src/providers/options/cboe.js";
import { summarizeChain } from "../src/providers/options/chain.js";
import { withFixture } from "./helpers/fixtures.js";

describe("cboe parsers", () => {
  it("parses OCC symbols and names index files", () => {
    expect(parseOccSymbol("AAPL261023C00110000")).toEqual({ root: "AAPL", expiry: "2026-10-23", right: "call", strike: 110 });
    expect(parseOccSymbol("SPXW261030P05525500")).toEqual({ root: "SPXW", expiry: "2026-10-30", right: "put", strike: 5525.5 });
    expect(parseOccSymbol("not-an-option")).toBeUndefined();
    expect(cboeSymbol("^spx")).toBe("_SPX");
    expect(cboeSymbol("AAPL")).toBe("AAPL");
  });
  it("reads contracts (IV in percent, a zero IV is unknown) and summarises per expiry", () => {
    const cs = parseCboeOptions([
      { option: "XYZ261120C00010000", bid: 1, ask: 1.2, iv: 0.5, open_interest: 100, volume: 10, delta: 0.5 },
      { option: "XYZ261120P00010000", bid: 0.9, ask: 1.1, iv: 0.6, open_interest: 300, volume: 30, delta: -0.5 },
      { option: "XYZ261120C00005000", bid: 5, ask: 5.2, iv: 0, open_interest: 50, volume: 0 },
      { option: "XYZ261218C00010000", bid: 2, ask: 2.2, iv: 0.45, open_interest: 10, volume: 0 },
    ]);
    expect(cs[0]).toMatchObject({ right: "call", strike: 10, iv: 50, openInterest: 100 });
    expect(cs[2]!.iv).toBeUndefined();
    const s = summarizeChain({ contracts: cs, underlyingPrice: 10.2 }, new Date("2026-10-24T00:00:00Z"));
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ expiry: "2026-11-20", daysToExpiry: 27, atmStrike: 10, atmIv: 55, putCallOi: 2, putCallVolume: 3, totalOi: 450 });
    expect(s[1]!.putCallVolume).toBeUndefined();
    expect(s[1]).toMatchObject({ callOi: 10, putOi: 0, atmIv: 45 });
  });
});

describe("cboe fixture", () => {
  it("replays a small US chain (GPRO)", async () => {
    const { dataset, chain } = await withFixture("options-cboe-gpro", () => cboeOptions("GPRO"));
    expect(chain.contracts.length).toBeGreaterThan(50);
    expect(dataset.provenance).toMatchObject({ source: "cboe", official: true, delay: "15min" });
    expect(dataset.points.find((p) => p.key === "GPRO.opt.oi.total")!.value as number).toBeGreaterThan(0);
    expect(dataset.points.some((p) => /^GPRO\.opt\.\d{4}-\d{2}-\d{2}\.atm_iv$/.test(p.key))).toBe(true);
  });
});
