import { describe, expect, it, vi } from "vitest";
import { builtinScreen } from "../src/analyze/screen/builtin.js";
import type { Bar } from "../src/providers/types.js";
import { randomWalk } from "./helpers/series.js";

// 300 daily bars for a US share, the last dated Tuesday 10 November 2026.
const bars: Bar[] = randomWalk(300, 7).map((b, i, all) => ({
  ...b,
  date: new Date(Date.parse("2026-11-10T00:00:00Z") - (all.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
}));
vi.mock("../src/providers/router.js", async (importActual) => {
  const instrument = { symbol: "AAPL", market: "us", currency: "USD" };
  return {
    ...(await importActual<typeof import("../src/providers/router.js")>()),
    resolveSymbol: async () => ({ instrument, notes: [] }),
    getHistory: async () => ({ instrument, bars, provenance: { source: "test", official: false, fetchedAt: "2026-11-10T22:00:00.000Z" } }),
  };
});

describe("a builtin screen's closed bars", () => {
  it("reads today's bar once the market's session is final, as every other analysis does", async () => {
    const asOf = async (now: string) => (await builtinScreen("golden-cross", { symbols: ["AAPL"], now: new Date(now) }))[0]!.provenance.asOf;
    // During the session, today's bar is still forming.
    expect(await asOf("2026-11-10T15:00:00Z")).toBe("2026-11-09");
    // After the US close (21:15 UTC), it is the session's close.
    expect(await asOf("2026-11-10T22:00:00Z")).toBe("2026-11-10");
  });
});
