import { describe, expect, it } from "vitest";
import { BUILTIN_STRATEGIES, findStrategy, listStrategies, loadStrategy, strategyTemplate } from "../src/backtest/catalog.js";
import { simulate } from "../src/backtest/simulate.js";
import {
  compileStrategy,
  paramValue,
  resolveIndicator,
  SOURCE_INDICATORS,
  type StrategyDef,
  scaleParams,
  tunableParams,
  validateStrategy,
  withParam,
} from "../src/backtest/strategy.js";
import { computeIndicator, listIndicators } from "../src/analytics/indicators/index.js";
import { bar, day, ramp, randomWalk } from "./helpers/series.js";

const base = (over: Record<string, unknown> = {}) => ({
  name: "t",
  description: "test",
  indicators: { rsi: { period: 14 } },
  buy: { mode: "all", conditions: [["rsi", "<", 30]] },
  sell: { mode: "all", conditions: [["rsi", ">", 70]] },
  ...over,
});

describe("the source catalog maps onto the registry", () => {
  it("maps all 51 source indicators, each computing and exposing its default field", () => {
    expect(Object.keys(SOURCE_INDICATORS)).toHaveLength(51);
    const bars = randomWalk(300, 3);
    for (const [name, a] of Object.entries(SOURCE_INDICATORS)) {
      const r = resolveIndicator(name, {});
      if (typeof r === "string") throw new Error(r);
      expect(r.info.name).toBe(a.registry);
      expect(r.fields.has(r.defaultField)).toBe(true);
      const values = computeIndicator(r.info.name, bars, r.params).values;
      expect(values.some((v) => v !== undefined)).toBe(true);
    }
  });

  it("renames the parameters and fields that differ", () => {
    const p = resolveIndicator("pmax", { emaPeriod: 12, atrPeriod: 9, multiplier: 2 });
    if (typeof p === "string") throw new Error(p);
    expect(p.params).toEqual({ maPeriod: 12, atrPeriod: 9, multiplier: 2 });
    expect(p.fields.get("pmaxLong")).toBe("longStop");
    const adx = resolveIndicator("adx", {}) as Exclude<ReturnType<typeof resolveIndicator>, string>;
    expect(adx.fields.get("pdi")).toBe("plusDI");
    expect((resolveIndicator("vwap", {}) as { params: object }).params).toEqual({ anchor: "start" });
    expect((resolveIndicator("x", { _type: "kama", period: 10 }) as { info: { name: string } }).info.name).toBe("kama");
  });

  it("reads the registry directly for names the source did not have", () => {
    const listed = new Set(listIndicators().map((i) => i.name));
    expect(listed.has("zScore")).toBe(true);
    expect(typeof resolveIndicator("z", { _type: "zScore", period: 20 })).toBe("object");
  });
});

describe("validation", () => {
  it("accepts every built-in strategy", () => {
    expect(BUILTIN_STRATEGIES).toHaveLength(27);
    for (const s of BUILTIN_STRATEGIES) {
      const v = validateStrategy(s);
      expect(v.errors, (s as { name: string }).name).toEqual([]);
    }
    expect(listStrategies().every((s) => s.valid)).toBe(true);
    expect(validateStrategy(strategyTemplate("my-idea")).valid).toBe(true);
  });

  it("names the path and the problem", () => {
    const errs = (x: unknown) => validateStrategy(x).errors.join("\n");
    expect(errs(base({ name: "Bad Name" }))).toMatch(/^name: kebab-case/);
    expect(errs(base({ indicators: { rsi14: { period: 14 } } }))).toMatch(/indicators\.rsi14: an alias is letters only/);
    expect(errs(base({ indicators: { foo: {} } }))).toMatch(/indicators\.foo: unknown indicator "foo"/);
    expect(errs(base({ indicators: { rsi: { length: 14 } } }))).toMatch(/unknown parameter "length" \(expected period, source\)/);
    expect(errs(base({ indicators: { rsi: { period: 1.5 } } }))).toMatch(/must be an integer/);
    expect(errs(base({ buy: { mode: "all", conditions: [["rsi[1]", "<", 30]] } }))).toMatch(
      /buy\.conditions\[0\]\[0\]: "rsi\[1\]" reads 1 bar\(s\) into the future/,
    );
    expect(errs(base({ buy: { mode: "all", conditions: [["macd.histogram", ">", 0]] } }))).toMatch(/undeclared indicator "macd"/);
    expect(errs(base({ buy: { mode: "all", conditions: [["rsi", "=>", 30]] } }))).toMatch(/buy\.conditions\[0\]\[1\]: operator "=>"/);
    expect(errs(base({ buy: { mode: "score", threshold: 2, conditions: [["rsi", "<", 30]] } }))).toMatch(/score mode counts "scored"/);
    expect(errs(base({ buy: { mode: "score", threshold: 3, scored: [["rsi", "<", 30]] } }))).toMatch(
      /buy\.threshold: an integer between 1 and the number of scored conditions \(1\)/,
    );
    expect(errs(base({ short: { mode: "all", conditions: [["rsi", ">", 80]] } }))).toMatch(/short and cover: define both or neither/);
    expect(errs(base({ risk: { stopLossPct: 0 } }))).toMatch(/risk\.stopLossPct: a percent number/);
    expect(errs(base({ risk: { riskPerTradePct: 2 } }))).toMatch(/riskPerTradePct: needs a stop/);
    expect(errs(base({ risk: { atrStop: { period: 14 } } }))).toMatch(/risk\.atrStop/);
    expect(errs(base({ extra: 1 }))).toMatch(/^extra: unknown key/);
    expect(errs(base({ indicators: { ichimoku: {} }, buy: { mode: "all", conditions: [["close", ">", "ichimoku.chikou"]] } }))).toMatch(
      /chikou span .* future/,
    );
    expect(errs(base({ buy: { mode: "all", conditions: [["rsi.nope", ">", 1]] } }))).toMatch(/unknown field "nope" for indicator "rsi" \(available: value\)/);
    expect(validateStrategy(base({ risk: { stopLossPct: 0.08 } })).warnings.join()).toMatch(/means 0\.08 %/);
  });
});

describe("compilation", () => {
  it("evaluates all / any / score blocks, offsets and candle fields on known bars", () => {
    const bars = ramp(40);
    const def = validateStrategy({
      name: "x",
      description: "x",
      indicators: { fast: { _type: "sma", period: 3 }, slow: { _type: "sma", period: 10 } },
      buy: {
        mode: "score",
        threshold: 2,
        required: [["fast", ">", "slow"]],
        scored: [
          ["close", ">", "close[-1]"],
          ["fast", ">", "fast[-1]"],
          ["close", "<", 0],
        ],
      },
      sell: {
        mode: "any",
        conditions: [
          ["close", "<", "slow"],
          ["volume", "<", 0],
        ],
      },
    }).def!;
    const s = compileStrategy(def, bars);
    expect(s.buy.slice(0, 9).every((x) => !x)).toBe(true); // slow undefined until bar 9
    expect(s.buy[9]).toBe(true);
    expect(s.sell.every((x) => !x)).toBe(true);
  });

  it("rescales period parameters from the base interval like the source (sqrt, min 2)", () => {
    const info = listIndicators().find((i) => i.name === "rsi")!;
    expect(scaleParams(info, { period: 14 }, "4h", "1d")).toEqual({ period: 6 });
    expect(scaleParams(info, { period: 14 }, "4h", "1h")).toEqual({ period: 28 });
    expect(scaleParams(info, { period: 3 }, "4h", "1w")).toEqual({ period: 2 });
    expect(scaleParams(info, { period: 14 }, undefined, "1d")).toEqual({ period: 14 });
    const turtle = loadStrategy("turtle").def;
    expect(compileStrategy(turtle, randomWalk(300), "1d").params.breakout).toEqual({ period: 82 });
  });

  it("reads and rewrites parameters for sweeps", () => {
    const def = loadStrategy("confluence").def;
    expect(paramValue(def, "pmax.emaPeriod")).toBe(10);
    expect(paramValue(def, "rsi.period")).toBe(14);
    expect(paramValue(withParam(def, "rsi.period", 21), "rsi.period")).toBe(21);
    expect(withParam(def, "risk.stopLossPct", 5).risk?.stopLossPct).toBe(5);
    expect(() => withParam(def, "nope.period", 3)).toThrow(/no indicator "nope"/);
    expect(
      tunableParams(def)
        .slice(0, 3)
        .map((p) => p.path),
    ).toEqual(["pmax.emaPeriod", "pmax.atrPeriod", "supertrend.atrPeriod"]);
    expect(tunableParams(def).find((p) => p.path === "pmax.multiplier")?.integer).toBe(false);
  });

  it("finds strategies by name and by path, refuses unknown ones", () => {
    expect(findStrategy("turtle")?.origin).toBe("builtin");
    expect(findStrategy("no-such")).toBeUndefined();
    expect(() => loadStrategy("no-such")).toThrow(/no strategy "no-such"/);
  });

  it("every built-in compiles and trades on a random walk", () => {
    const bars = randomWalk(1200, 11);
    let total = 0;
    for (const s of BUILTIN_STRATEGIES as StrategyDef[]) {
      const sig = compileStrategy(s, bars, "1d");
      const r = simulate(bars, sig, {
        capital: 10_000,
        costs: { makerPct: 0.1, takerPct: 0.1, slippagePct: 0.05 },
        allowShort: !!s.short,
        leverage: s.leverage,
        risk: s.risk,
      });
      total += r.trades.length;
      expect(r.equity).toHaveLength(bars.length);
    }
    expect(total).toBeGreaterThan(100);
  });

  it("a strategy with an all-false block never trades", () => {
    const bars = [bar(day(0), 1, 1, 1, 1), ...ramp(60).slice(1)];
    const def = validateStrategy(base({ buy: { mode: "all", conditions: [["close", "<", 0]] } })).def!;
    expect(simulate(bars, compileStrategy(def, bars), { capital: 1000, costs: { makerPct: 0, takerPct: 0, slippagePct: 0 } }).trades).toHaveLength(0);
  });
});
