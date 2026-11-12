// Years to expiry of a US option in catalysts (`toChainOptions`) run to the New York close, daylight saving included
// — the same instant as `settlementAt` in analyze/quant/options.ts, not a fixed 21:00 UTC (an hour late from March
// to November). Latent while `expectedMove`, its one consumer, does not read `t`.
import { describe, expect, it } from "vitest";
import { settlementAt } from "../src/analyze/quant/options.js";
import { toChainOptions } from "../src/analyze/regime/catalysts.js";
import type { OptionContract } from "../src/providers/options/chain.js";

const HOUR = 3_600_000;
const contract = (expiry: string) => ({ right: "call", strike: 100, expiry, openInterest: 1, volume: 1 }) as unknown as OptionContract;
const hoursLeft = (expiry: string, now: Date) => toChainOptions([contract(expiry)], now)[0]!.t * 365 * 24;

describe("years to expiry of a US option in catalysts", () => {
  it("control: in winter both readings agree (16:00 EST = 21:00 UTC)", () => {
    const now = new Date("2026-12-18T19:00:00Z");
    expect(hoursLeft("2026-12-18", now)).toBeCloseTo((settlementAt("cboe", "2026-12-18").getTime() - now.getTime()) / HOUR, 6);
  });

  it("in summer too (16:00 EDT = 20:00 UTC)", () => {
    const now = new Date("2026-07-17T19:00:00Z"); // 15:00 in New York: one hour to the close
    const expected = (settlementAt("cboe", "2026-07-17").getTime() - now.getTime()) / HOUR;
    expect(expected).toBeCloseTo(1, 6);
    // Before the fix: 2 hours.
    expect(hoursLeft("2026-07-17", now)).toBeCloseTo(expected, 6);
  });
});
