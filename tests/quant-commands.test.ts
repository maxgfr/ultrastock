// The quant commands end to end, on recorded fixtures (record once with
// ULTRASTOCK_RECORD=1). The commands are called directly with a CommandArgs:
// the CLI wiring is the lead's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cryptoAnalysisCommand, optionsAnalysisCommand, predictAnalysisCommand, statsCommand } from "../src/commands/quant.js";
import type { CommandArgs } from "../src/engine.js";
import { withFixture } from "./helpers/fixtures.js";

afterEach(() => vi.restoreAllMocks());

// Recording reads the live sources (paced APIs): give it time. A replay takes milliseconds.
const SLOW = 120_000;

interface JsonOut {
  datasets: Array<{ title: string; notes: string[]; provenance: { source: string }; points: Array<{ key: string; value: unknown; formula?: string }> }>;
}

async function run(fn: (a: CommandArgs, j: boolean) => Promise<void>, positional: string[], values: Record<string, string> = {}): Promise<JsonOut> {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  try {
    await fn({ command: "test", positional, values, bools: new Set() }, true);
  } finally {
    vi.restoreAllMocks();
  }
  return JSON.parse(out) as JsonOut;
}

const all = (r: JsonOut) => r.datasets.flatMap((d) => d.points);
const find = (r: JsonOut, re: RegExp) => all(r).filter((p) => re.test(p.key));

describe("options-analysis (CBOE fixture)", () => {
  it(
    "reads three expiries, the term structure, and prices a straddle",
    async () => {
      await withFixture("quant-options-gpro", async () => {
        const r = await run(optionsAnalysisCommand, ["GPRO"]);
        expect(r.datasets[0]!.provenance.source).toBe("cboe");
        const dtes = find(r, /^GPRO\.quant\.opt\.[\d-]+\.dte$/);
        expect(dtes.length).toBeGreaterThanOrEqual(1);
        expect(dtes.every((p) => (p.value as number) >= 7)).toBe(true);
        expect(find(r, /\.maxPain$/).length).toBe(dtes.length);
        expect(find(r, /^GPRO\.quant\.term\./).length).toBeGreaterThan(1);
        expect(find(r, /^GPRO\.quant\.(ivRank\.status|ivRank)$/).length).toBe(1);
        const atm = find(r, /\.atmStrike$/)[0]!;
        const expiry = atm.key.split(".")[3]!;
        const s = await run(optionsAnalysisCommand, ["GPRO"], { expiry, strategy: `straddle:${atm.value}` });
        const strat = s.datasets.find((d) => /straddle/.test(d.title))!;
        expect(strat.points.find((p) => p.key === "GPRO.quant.strategy.maxProfit")!.value).toBe("unlimited");
        expect(strat.points.filter((p) => p.key.includes(".pnl.")).length).toBe(90);
      });
    },
    SLOW,
  );
  it("refuses an unknown expiry and a malformed strategy before any analysis", async () => {
    await withFixture("quant-options-gpro", async () => {
      await expect(run(optionsAnalysisCommand, ["GPRO"], { expiry: "2099-01-01" })).rejects.toThrow(/no 2099-01-01 expiry/);
    });
    await expect(run(optionsAnalysisCommand, ["GPRO"], { strategy: "condor:1" })).rejects.toThrow(/unknown strategy/);
  });
});

describe("stats (Nasdaq fixtures)", () => {
  it(
    "portrays one symbol against SPY",
    async () => {
      const r = await withFixture("quant-stats-single", () => run(statsCommand, ["NVDA"], { days: "250" }));
      for (const k of ["vol.yangZhang", "garch.forecast10d", "hurst", "adf.stat", "hmm.turbulent", "var99", "cfVar95", "ulcer"])
        expect(typeof all(r).find((p) => p.key === `NVDA.stats.${k}`)?.value, k).toBe("number");
      expect(typeof all(r).find((p) => p.key === "NVDA.stats.vs.SPY.beta")?.value).toBe("number");
    },
    SLOW,
  );
  it(
    "compares several symbols: correlations, tail dependence, cointegration",
    async () => {
      const r = await withFixture("quant-stats-multi", () => run(statsCommand, ["NVDA", "AMD", "SPY"], { days: "250" }));
      expect(find(r, /~.*\.stats\.pearson$/).length).toBe(3);
      expect(find(r, /~.*\.stats\.spearman$/).length).toBe(3);
      expect(find(r, /~.*\.stats\.coint\.verdict$/).length).toBe(3);
    },
    SLOW,
  );
  it("caps the number of symbols", async () => {
    await expect(
      run(
        statsCommand,
        Array.from({ length: 11 }, (_, i) => `S${i}`),
      ),
    ).rejects.toThrow(/at most 10/);
  });
});

describe("crypto-analysis (fixture)", () => {
  it(
    "reads BTC positioning, volatility and leverage heat",
    async () => {
      const r = await withFixture("quant-crypto-btc", () => run(cryptoAnalysisCommand, ["BTC"], { days: "60" }));
      const heat = all(r).find((p) => p.key === "BTC.quant.leverageHeat");
      expect(["crowded", "warm", "neutral", "short-crowded", "unknown"]).toContain(heat?.value);
      expect(heat?.formula).toMatch(/20 %\/yr/);
      expect(typeof all(r).find((p) => p.key === "BTC.quant.realised.vol30d")?.value).toBe("number");
      expect(typeof all(r).find((p) => p.key === "BTC.quant.funding.mean30d.annualized")?.value).toBe("number");
    },
    SLOW,
  );
});

describe("predict-analysis (fixtures)", () => {
  it(
    "reads Kalshi markets with books, arbitrage and half-Kelly",
    async () => {
      const r = await withFixture("quant-predict-kalshi", () =>
        run(predictAnalysisCommand, ["kalshi", "KXFED"], { limit: "2", "my-probability": "0.62", "kalshi-fee": "0.07" }),
      );
      const readings = r.datasets.find((d) => /readings/.test(d.title))!;
      expect(readings.notes.join(" ")).toMatch(/paper trading only for French residents/);
      expect(readings.points.some((p) => p.key.endsWith(".quant.daysToClose"))).toBe(true);
    },
    SLOW,
  );
  it("never reads Polymarket", async () => {
    await expect(run(predictAnalysisCommand, ["polymarket", "election"])).rejects.toThrow(/does not read Polymarket/);
  });
});
