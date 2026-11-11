import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The marked book: a line the quote provider could not price (no valueBase), and a total that leaves it out.
const marked = vi.hoisted(() => ({ unpriced: true }));
vi.mock("../src/analyze/portfolio/book.js", async (original) => ({
  ...(await original<typeof import("../src/analyze/portfolio/book.js")>()),
  loadMarkedBook: async () => ({
    profile: (await import("../src/core/profile.js")).defaultProfile("FR", "EUR"),
    base: "EUR",
    txs: [],
    book: { positions: [], cash: [], transactions: [] },
    rates: { EUR: 1 },
    cash: [],
    cashBase: 5_000,
    totalBase: marked.unpriced ? 5_000 : 10_000,
    holdings: [
      {
        symbol: "AAA",
        assetClass: "equity",
        accounts: [{ account: "cto", quantity: 10 }],
        quantity: 10,
        currency: "EUR",
        averageCost: 500,
        ...(marked.unpriced ? {} : { price: 500, fx: 1, valueBase: 5_000, weightPct: 50 }),
      },
    ],
  }),
}));
const curves = vi.hoisted(() => [] as Array<Array<{ equity: number }>>);
vi.mock("../src/commands/trading.js", async (original) => ({
  ...(await original<typeof import("../src/commands/trading.js")>()),
  flowRates: async () => ({ rates: {}, notes: [] }),
  bookPerformance: (_txs: unknown, _book: unknown, _total: unknown, curve: Array<{ equity: number }>) => {
    curves.push(curve);
    return { breaker: { tripped: false } };
  },
}));

import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { portfolioView } from "../src/serve/views.js";

beforeEach(async () => {
  process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "serve-unpriced-"));
  saveProfile(defaultProfile("FR", "EUR"));
  await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 10_000, currency: "EUR", origin: "manual" }], "real");
  curves.length = 0;
});

describe("serve: today's point on the breaker's curve", () => {
  it("is left out when a position could not be priced, as `portfolio show` records none", async () => {
    marked.unpriced = true;
    const v = await portfolioView("real", new Date("2026-11-11T10:00:00Z"));
    expect("hint" in v).toBe(false);
    // 5 000 is the cash alone: reading it as the book's value would be a 50 % "loss".
    expect(curves.at(-1)!.map((p) => p.equity)).not.toContain(5_000);
  });

  it("is added when every position is priced", async () => {
    marked.unpriced = false;
    await portfolioView("real", new Date("2026-11-11T10:00:00Z"));
    expect(curves.at(-1)!.map((p) => p.equity)).toContain(10_000);
  });
});
