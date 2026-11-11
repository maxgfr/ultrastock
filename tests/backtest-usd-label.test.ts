// A backtest — or a rebalance target — on BTC-USD answered by Kraken's dollar book (Binance refuses, HTTP 451) labels
// its figures with that book, as analyze, technicals and quant stats do. The venues are stubbed.
import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Instrument, PriceSeries, QuoteResult } from "../src/providers/types.js";
import { randomWalk } from "./helpers/series.js";

const fetchedAt = "2026-11-09T09:00:00.000Z";

vi.mock("../src/providers/binance.js", async (original) => {
  const { ProviderError } = await import("../src/providers/types.js");
  const refuse = async () => {
    throw new ProviderError("binance", "Binance refuses requests from this location (HTTP 451)", 451);
  };
  return { ...(await original<typeof import("../src/providers/binance.js")>()), binanceQuote: refuse, binanceHistory: refuse };
});

vi.mock("../src/providers/markets/kraken.js", () => {
  const instrumentOf = (symbol: string): Instrument => {
    const [base, quote] = symbol.includes("-") ? symbol.split("-") : [symbol.slice(0, 3), symbol.slice(3)];
    return { symbol: `${base}-${quote}`, market: "crypto", kind: "crypto", name: `${base}/${quote}`, currency: quote!, venueId: `X${base}Z${quote}` };
  };
  return {
    resolveKraken: async (symbol: string) => instrumentOf(symbol),
    krakenQuote: async (instrument: Instrument, notes: string[]): Promise<QuoteResult> => ({
      instrument,
      price: 100_000,
      at: fetchedAt,
      provenance: { source: "kraken", fetchedAt, official: true },
      notes: [...notes],
    }),
    krakenHistory: async (instrument: Instrument, _i: string, _f: Date, _t: Date, notes: string[]): Promise<PriceSeries> => ({
      instrument,
      interval: "1d",
      bars: randomWalk(400, 7, 100_000),
      adjusted: false,
      provenance: { source: "kraken", fetchedAt, official: true },
      notes: [...notes],
    }),
  };
});

const { loadMarket, strategyBacktest } = await import("../src/backtest/run.js");
const { loadStrategy } = await import("../src/backtest/catalog.js");
const { loadMarkedBook } = await import("../src/analyze/portfolio/book.js");
const { Findings } = await import("../src/analyze/portfolio/findings.js");
const { rebalanceAnalysis } = await import("../src/analyze/portfolio/run-book.js");
const { homeDir } = await import("../src/core/paths.js");
const { defaultProfile, saveProfile } = await import("../src/core/profile.js");
const { appendTransactions } = await import("../src/portfolio/ledger.js");

describe("a backtest on Kraken's BTC-USD book", () => {
  it("labels its money figures in USD on BTC-USD, not in USDT on BTCUSDT", async () => {
    const to = new Date("2026-11-09T09:00:00Z");
    const m = await loadMarket("BTC-USD", { from: new Date(to.getTime() - 400 * 86_400_000), to, interval: "1d", capital: 10_000 });
    // The bars are Kraken's dollar book …
    expect(m.series.provenance.source).toBe("kraken");
    expect([m.series.instrument.symbol, m.series.instrument.currency]).toEqual(["BTC-USD", "USD"]);
    const rep = strategyBacktest(m, loadStrategy("sma-cross").def);
    const equity = rep.datasets[0]!.points.find((p) => /\.finalEquity$/.test(p.key))!;
    // … so the final equity is dollars of the BTC-USD book.
    expect(equity.unit).toBe("USD");
    expect(equity.key.startsWith("BTC-USD.")).toBe(true);
  });
});

describe("a rebalance target quoted by Kraken's BTC-USD book", () => {
  it("registers the dollar quote under BTC-USD, not under the BTCUSDT pair", async () => {
    rmSync(homeDir(), { recursive: true, force: true });
    saveProfile(defaultProfile("US", "USD"));
    await appendTransactions([{ date: "2026-11-01", type: "deposit", account: "broker", amount: 1000, currency: "USD", origin: "manual" }], "paper");
    const f = new Findings();
    const m = await loadMarkedBook("paper", f, new Date(fetchedAt));
    await rebalanceAnalysis(m, f, { targets: { "BTC-USD": 50, CASH: 50 } });
    const quote = f.inputs.flatMap((d) => d.points).find((p) => /\.quote\.price$/.test(p.key))!;
    expect([quote.key, quote.value, quote.unit]).toEqual(["BTC-USD.quote.price", 100_000, "USD"]);
  });
});
