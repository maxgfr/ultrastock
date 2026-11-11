// A prediction-market contract is priced from its own book (loadMarkedBook) and has no instrument or history: the
// stress replay must not move it like a world equity tracker through the equity proxy chain, and `portfolio risk`
// must not file it under "funds" in the country exposure. Everything is stubbed (no network).
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, PriceSeries } from "../src/providers/types.js";

const fetchedAt = "2026-10-24T10:00:00.000Z";
const CONTRACT = "KALSHI:FED-26DEC-T4.25:YES";

vi.mock("../src/providers/router.js", () => ({
  // The contract is no listed symbol; the proxies of the stress replay resolve.
  resolveSymbol: vi.fn(async (s: string) => {
    if (s.startsWith("KALSHI:")) throw new Error(`${s} looked up as a listed symbol`);
    const instrument: Instrument = { symbol: s, market: "euronext", kind: "etf", name: `${s} tracker`, currency: "EUR", venueId: s };
    return { instrument, notes: [] };
  }),
  getQuote: vi.fn(),
  getHistory: vi.fn(),
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
// The proxy halves over every window: a daily series from the day asked to the day asked.
vi.mock("../src/analyze/portfolio/history.js", async (original) => ({
  ...(await original<typeof import("../src/analyze/portfolio/history.js")>()),
  dailyHistory: vi.fn(async (r: { instrument: Instrument }, from: Date, to: Date): Promise<PriceSeries> => {
    const bars = [];
    const n = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    for (let i = 0; i <= n; i++) {
      const close = 100 - (50 * i) / n;
      bars.push({ date: new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10), open: close, high: close, low: close, close });
    }
    return { instrument: r.instrument, interval: "1d", bars, adjusted: true, provenance: { source: "stub", fetchedAt, official: false }, notes: [] };
  }),
}));

const { loadMarkedBook } = await import("../src/analyze/portfolio/book.js");
const { Findings } = await import("../src/analyze/portfolio/findings.js");
const { riskAnalysis, stressAnalysis } = await import("../src/analyze/portfolio/run-risk.js");
const { homeDir } = await import("../src/core/paths.js");
const { defaultProfile, saveProfile } = await import("../src/core/profile.js");
const { appendTransactions } = await import("../src/portfolio/ledger.js");

async function book() {
  await appendTransactions(
    [
      { date: "2026-10-01", type: "deposit", account: "kalshi", amount: 100, currency: "USD", origin: "manual" },
      { date: "2026-10-02", type: "buy", account: "kalshi", symbol: CONTRACT, quantity: 50, price: 0.3, currency: "USD", origin: "manual" },
    ],
    "paper",
  );
  const f = new Findings();
  const m = await loadMarkedBook("paper", f, new Date(fetchedAt));
  return { f, m };
}

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
});

describe("a prediction-market contract in the portfolio analyses", () => {
  it("is not replayed through a historical crash as if it were a world equity tracker", async () => {
    const { f, m } = await book();
    expect(m.holdings.find((h) => h.symbol === CONTRACT)!.weightPct).toBeGreaterThan(0);
    const res = await stressAnalysis(m, f);
    const gfc = res.scenarios.find((s) => s.id === "gfc");
    const line = gfc?.lines.find((l) => l.symbol === CONTRACT);
    // A contract that did not exist in 2008 and is no equity has no move in that window: left out, not proxied.
    expect(line?.proxy).toBeUndefined();
    expect(line?.basis ?? "none").toBe("none");
  });

  it("is not counted among the funds in the exposure by country", async () => {
    const { f, m } = await book();
    const res = await riskAnalysis(m, f);
    expect(res.byCountry.find((c) => c.label === "funds")).toBeUndefined();
    expect(res.byCountry.find((c) => c.label === "prediction markets")?.weight).toBeGreaterThan(0);
  });
});
