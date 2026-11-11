// A held prediction-market contract is priced from its own book by loadMarkedBook. The morning brief must not then
// look it up as a listed symbol (a Nasdaq lookup that can only fail) and report an error for a line it already priced.
// The contract's book and the FX are stubbed; everything else replays the morning fixture (no network).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withFixture } from "./helpers/fixtures.js";

const fetchedAt = "2026-10-24T10:00:00.000Z";
const CONTRACT = "KALSHI:FED-26DEC-T4.25:YES";
const looked = vi.hoisted(() => [] as string[]);

vi.mock("../src/providers/router.js", async (original) => {
  const actual = await original<typeof import("../src/providers/router.js")>();
  return {
    ...actual,
    resolveSymbol: async (s: string, ...rest: unknown[]) => {
      looked.push(s);
      if (s.startsWith("KALSHI:")) throw new Error(`${s} looked up as a listed symbol`);
      return (actual.resolveSymbol as (...a: unknown[]) => ReturnType<typeof actual.resolveSymbol>)(s, ...rest);
    },
  };
});
vi.mock("../src/providers/prediction/kalshi.js", () => ({
  kalshiOrderbook: vi.fn(async () => ({
    book: { bids: [{ price: 0.38, size: 50 }], asks: [{ price: 0.42, size: 20 }] },
    dataset: { provenance: { source: "kalshi", url: "https://kalshi.example/book", fetchedAt, official: true } },
  })),
}));
vi.mock("../src/providers/macro/ecb.js", () => ({
  ecbFx: vi.fn(async () => ({
    title: "ECB reference rates",
    points: [{ key: "EUR.fx.USD", label: "USD per EUR", value: 1.25, unit: "USD" }],
    provenance: { source: "ecb", fetchedAt, official: true, asOf: "2026-10-23" },
    notes: [],
  })),
}));

const { morningRun } = await import("../src/analyze/morning/run.js");
const { defaultProfile, saveProfile } = await import("../src/core/profile.js");
const { appendTransactions } = await import("../src/portfolio/ledger.js");

describe("a held prediction-market contract in the morning brief", () => {
  it("is not looked up as a listed symbol, so no error is reported for a line already priced", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "morning-contract-home-"));
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions(
      [
        { date: "2026-10-01", type: "deposit", account: "kalshi", amount: 100, currency: "USD", origin: "manual" },
        { date: "2026-10-02", type: "buy", account: "kalshi", symbol: CONTRACT, quantity: 50, price: 0.3, currency: "USD", origin: "manual" },
      ],
      "real",
    );
    await withFixture("morning-alo", async () => {
      const r = await morningRun(mkdtempSync(join(tmpdir(), "morning-contract-run-")), { markets: ["eu"], now: new Date(fetchedAt) });
      expect(r.universe.map((u) => u.symbol)).toContain(CONTRACT);
      expect(looked).not.toContain(CONTRACT);
      expect(r.notes.filter((n) => n.includes(CONTRACT))).toEqual([]);
    });
  });
});
