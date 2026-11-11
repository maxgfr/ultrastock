import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMarkedBook } from "../src/analyze/portfolio/book.js";
import { Findings } from "../src/analyze/portfolio/findings.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";

const fetchedAt = "2026-10-24T10:00:00.000Z";

// Offline: Kalshi's book and the ECB rate are answered here; a listed symbol must never be looked up for a contract.
vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: vi.fn(async (s: string) => {
    throw new Error(`${s} looked up as a listed symbol`);
  }),
  getQuote: vi.fn(),
}));
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
  })),
}));

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
});

describe("a book holding prediction-market contracts", () => {
  it("prices them from the contract's book, as `portfolio show` does", async () => {
    await appendTransactions(
      [
        { date: "2026-10-01", type: "deposit", account: "kalshi", amount: 100, currency: "USD", origin: "manual" },
        {
          date: "2026-10-02",
          type: "buy",
          account: "kalshi",
          symbol: "KALSHI:FED-26DEC-T4.25:YES",
          quantity: 50,
          price: 0.3,
          currency: "USD",
          origin: "manual",
        },
      ],
      "paper",
    );
    const f = new Findings();
    const m = await loadMarkedBook("paper", f, new Date(fetchedAt));
    const h = m.holdings.find((x) => x.symbol === "KALSHI:FED-26DEC-T4.25:YES")!;
    expect(h.price).toBeCloseTo(0.4, 10);
    // 50 × 0.40 USD at 1.25 USD per EUR.
    expect(h.valueBase).toBeCloseTo(16, 10);
    expect(h.weightPct).toBeGreaterThan(0);
    // Cash: 100 − 15 = 85 USD = 68 EUR.
    expect(m.totalBase).toBeCloseTo(84, 10);
  });
});
