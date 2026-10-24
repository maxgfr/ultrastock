import { describe, expect, it } from "vitest";
import { BUILTIN_STRATEGIES } from "../src/backtest/catalog.js";
import { type Costs, simulate } from "../src/backtest/simulate.js";
import { compileStrategy, type Signals, type StrategyDef } from "../src/backtest/strategy.js";
import type { Bar } from "../src/providers/types.js";
import { bar, day, randomWalk } from "./helpers/series.js";

const NO_COST: Costs = { makerPct: 0, takerPct: 0, slippagePct: 0 };
const flatBars = (n: number, p = 100): Bar[] => Array.from({ length: n }, (_, i) => bar(day(i), p, p + 1, p - 1, p));

/** Signals with buy/sell/short/cover true at the given bar indexes. */
function sig(n: number, at: { buy?: number[]; sell?: number[]; short?: number[]; cover?: number[] }): Signals {
  const arr = (xs: number[] = []) => Array.from({ length: n }, (_, i) => xs.includes(i));
  return { buy: arr(at.buy), sell: arr(at.sell), short: arr(at.short), cover: arr(at.cover), params: {} };
}

describe("fills: the source's biases, fixed", () => {
  it("fills a signal at the NEXT bar's open, not the signal bar's close", () => {
    const bars = flatBars(12);
    bars[5] = bar(day(5), 100, 101, 99, 100);
    bars[6] = bar(day(6), 110, 125, 109, 120);
    const r = simulate(bars, sig(12, { buy: [5], sell: [8] }), { capital: 10_000, costs: { makerPct: 0, takerPct: 0, slippagePct: 0.1 } });
    const t = r.trades[0]!;
    expect(t.signalIndex).toBe(5);
    expect(t.entryIndex).toBe(6);
    // The source filled at bars[5].close (100); the order can only fill at bars[6].open plus slippage.
    expect(t.entryPrice).toBeCloseTo(110 * 1.001, 9);
    expect(t.entryPrice).not.toBeCloseTo(100, 3);
    expect(t.exitIndex).toBe(9);
  });

  it("fills a stop the bar gaps through at the open (the worse price), not at the stop", () => {
    const bars = flatBars(12);
    bars[8] = bar(day(8), 80, 82, 75, 78); // opens 20 % under a 100 entry: through a 10 % stop
    const r = simulate(bars, sig(12, { buy: [2] }), { capital: 10_000, costs: { makerPct: 0, takerPct: 0, slippagePct: 0.1 }, risk: { stopLossPct: 10 } });
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("stop");
    expect(t.exitIndex).toBe(8);
    // The source would book 90 (the stop) less slippage; the market only offered 80.
    expect(t.exitPrice).toBeCloseTo(80 * 0.999, 9);
    expect(t.exitPrice).toBeLessThan(90 * 0.999);
  });

  it("fills an intrabar stop at the stop less slippage, a short's gap at the open", () => {
    const bars = flatBars(12);
    bars[7] = bar(day(7), 99, 100, 88, 95);
    const r = simulate(bars, sig(12, { buy: [2] }), { capital: 10_000, costs: { makerPct: 0, takerPct: 0, slippagePct: 0.1 }, risk: { stopLossPct: 10 } });
    expect(r.trades[0]!.exitPrice).toBeCloseTo(r.trades[0]!.entryPrice * 0.9 * 0.999, 9);
    const sb = flatBars(12);
    sb[8] = bar(day(8), 120, 125, 119, 121);
    const s = simulate(sb, sig(12, { short: [2] }), { capital: 10_000, costs: NO_COST, allowShort: true, risk: { stopLossPct: 10 } });
    expect(s.trades[0]!.side).toBe("short");
    expect(s.trades[0]!.exitPrice).toBe(120);
    expect(s.trades[0]!.pnl).toBeLessThan(0);
  });

  it("charges market orders the taker fee and limit orders the maker fee", () => {
    const bars = flatBars(12);
    const costs = { makerPct: 0.02, takerPct: 0.1, slippagePct: 0 };
    const m = simulate(bars, sig(12, { buy: [2], sell: [6] }), { capital: 10_000, costs });
    const t = m.trades[0]!;
    // Entry and exit are market orders: taker on both sides (the source charged the entry the maker fee).
    expect(t.entryOrder).toBe("market");
    expect(t.fees).toBeCloseTo(t.notional * 0.001 + t.qty * t.exitPrice * 0.001, 9);
    expect(t.fees).not.toBeCloseTo(t.notional * 0.0002 + t.qty * t.exitPrice * 0.001, 6);
    const lb = flatBars(12);
    lb[3] = bar(day(3), 100, 101, 99, 100); // trades through a limit 0.5 % under the signal close
    const l = simulate(lb, sig(12, { buy: [2], sell: [6] }), { capital: 10_000, costs, execution: { entry: "limit", limitOffsetPct: 0.5 } });
    const lt = l.trades[0]!;
    expect(lt.entryOrder).toBe("limit");
    expect(lt.entryPrice).toBeCloseTo(99.5, 9);
    expect(lt.fees).toBeCloseTo(lt.notional * 0.0002 + lt.qty * lt.exitPrice * 0.001, 9);
  });

  it("cancels a limit the next bar never reaches", () => {
    const bars = flatBars(12).map((b) => ({ ...b, low: 99.8 }));
    const r = simulate(bars, sig(12, { buy: [2] }), { capital: 10_000, costs: NO_COST, execution: { entry: "limit", limitOffsetPct: 1 } });
    expect(r.trades).toHaveLength(0);
    expect(r.unfilledLimits).toBe(1);
  });

  it("assumes the stop hit first when stop and target are both inside one bar", () => {
    const bars = flatBars(12);
    bars[5] = bar(day(5), 100, 125, 85, 100);
    const r = simulate(bars, sig(12, { buy: [2] }), { capital: 10_000, costs: NO_COST, risk: { stopLossPct: 10, takeProfitPct: 20 } });
    expect(r.trades[0]!.exitReason).toBe("stop");
    expect(r.trades[0]!.exitPrice).toBe(90);
    const up = flatBars(12);
    up[5] = bar(day(5), 100, 125, 95, 120);
    expect(simulate(up, sig(12, { buy: [2] }), { capital: 10_000, costs: NO_COST, risk: { stopLossPct: 10, takeProfitPct: 20 } }).trades[0]).toMatchObject({
      exitReason: "target",
      exitPrice: 120,
    });
  });

  it("trails the extreme of the PREVIOUS bars, not the current bar's own high", () => {
    const bars = flatBars(12);
    // A wide bar: its high would put a 10 % trail at 117, its low (110) under it — but the high may come after the low.
    bars[5] = bar(day(5), 100, 130, 100, 125);
    const r = simulate(bars.slice(0, 7), sig(7, { buy: [2] }), { capital: 10_000, costs: NO_COST, risk: { trailingStopPct: 10 } });
    expect(r.trades[0]!.exitIndex).toBe(6); // the trail from 130 (117) only binds from bar 6
    expect(r.trades[0]!.exitReason).toBe("trail");
  });
});

describe("sizing, leverage, funding, breaker, time stop", () => {
  it("sizes a position so the stop loses riskPerTradePct of equity", () => {
    const r = simulate(flatBars(12), sig(12, { buy: [2] }), { capital: 10_000, costs: NO_COST, risk: { stopLossPct: 8, riskPerTradePct: 2 } });
    expect(r.trades[0]!.notional).toBeCloseTo(2500, 6); // 2 % / 8 % of 10 000
    expect(r.trades[0]!.r).toBeCloseTo(0, 9);
  });

  it("liquidates a 10× long at the maintenance margin and loses the margin", () => {
    const bars = flatBars(12);
    bars[6] = bar(day(6), 99, 100, 88, 92);
    const r = simulate(bars, sig(12, { buy: [2] }), { capital: 10_000, costs: NO_COST, leverage: 10, liquidation: true });
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("liquidation");
    expect(t.pnl).toBeCloseTo(-10_000, 6);
    expect(r.liquidations).toBe(1);
  });

  it("takes the stop before the liquidation price when the stop is nearer", () => {
    const bars = flatBars(12);
    bars[6] = bar(day(6), 99, 100, 88, 92);
    const r = simulate(bars, sig(12, { buy: [2] }), { capital: 10_000, costs: NO_COST, leverage: 5, liquidation: true, risk: { stopLossPct: 5 } });
    expect(r.trades[0]!.exitReason).toBe("stop");
  });

  it("charges funding at each settlement inside a held bar (long pays, short receives)", () => {
    const bars = flatBars(6);
    const t0 = Date.parse(`${bars[3]!.date}T00:00:00Z`);
    const funding = [0, 8, 16].map((h) => ({ time: t0 + h * 3_600_000, rate: 0.0001 }));
    const long = simulate(bars, sig(6, { buy: [1] }), { capital: 10_000, costs: NO_COST, funding });
    expect(long.trades[0]!.funding).toBeCloseTo(3 * 0.0001 * 10_000, 6);
    const short = simulate(bars, sig(6, { short: [1] }), { capital: 10_000, costs: NO_COST, funding, allowShort: true });
    expect(short.trades[0]!.funding).toBeCloseTo(-3, 6);
  });

  it("stops opening positions once the breaker trips, and exits on a time stop", () => {
    const bars = flatBars(30);
    bars[4] = bar(day(4), 70, 71, 69, 70);
    const r = simulate(bars, sig(30, { buy: [2, 10, 20], sell: [5] }), { capital: 10_000, costs: NO_COST, risk: { maxDrawdownPct: 20 } });
    expect(r.trades).toHaveLength(1);
    expect(r.breakerTrippedAt).toBe(bars[4]!.date);
    const t = simulate(flatBars(30), sig(30, { buy: [2] }), { capital: 10_000, costs: NO_COST, risk: { timeStopBars: 4 } });
    expect(t.trades[0]).toMatchObject({ exitReason: "time", entryIndex: 3, exitIndex: 7, bars: 4 });
  });
});

describe("no look-ahead: a run on bars[0..k] matches the full run up to k", () => {
  const bars = randomWalk(900, 7);
  const defs = BUILTIN_STRATEGIES as StrategyDef[];
  for (const name of ["adaptive-momentum-reversal", "confluence", "turtle", "ichimoku-cloud", "bollinger-squeeze", "vwap-momentum", "pmax"]) {
    it(name, () => {
      const def = defs.find((d) => d.name === name)!;
      const full = compileStrategy(def, bars, "1d");
      const fullSim = simulate(bars, full, {
        capital: 10_000,
        costs: { makerPct: 0.02, takerPct: 0.05, slippagePct: 0.05 },
        leverage: def.leverage ?? 1,
        allowShort: !!def.short,
        liquidation: true,
        risk: def.risk,
      });
      expect(fullSim.trades.length).toBeGreaterThan(0);
      for (const k of [400, 650]) {
        const cut = bars.slice(0, k);
        const part = compileStrategy(def, cut, "1d");
        for (const key of ["buy", "sell", "short", "cover"] as const) expect(part[key]).toEqual(full[key].slice(0, k));
        const sim = simulate(cut, part, {
          capital: 10_000,
          costs: { makerPct: 0.02, takerPct: 0.05, slippagePct: 0.05 },
          leverage: def.leverage ?? 1,
          allowShort: !!def.short,
          liquidation: true,
          risk: def.risk,
        });
        expect(sim.trades.filter((t) => t.exitIndex < k - 1)).toEqual(fullSim.trades.filter((t) => t.exitIndex < k - 1));
        expect(sim.equity.slice(0, k - 1)).toEqual(fullSim.equity.slice(0, k - 1));
      }
    });
  }
});
