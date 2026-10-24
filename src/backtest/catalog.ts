// Where strategies come from: a path to a JSON file, the user's own
// (<home>/strategies/<name>.json, written by `strategy new`), or the built-ins
// bundled from assets/strategies — the 26 strategies of
// maxgfr/ai-strategy-backtester with their config.json risk rules folded in
// (stop, trailing stop, breaker, risk per trade; tuned for 4h crypto bars, so
// they declare baseInterval "4h"), plus sma-cross. They are imported, not read
// from disk, so the bundled CLI carries them.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import adaptiveMomentumReversal from "../../assets/strategies/adaptive-momentum-reversal.json";
import aroonTrendRider from "../../assets/strategies/aroon-trend-rider.json";
import bollingerSqueeze from "../../assets/strategies/bollinger-squeeze.json";
import breakoutMomentumRider from "../../assets/strategies/breakout-momentum-rider.json";
import breakoutVolume from "../../assets/strategies/breakout-volume.json";
import cciWilliamsMomentum from "../../assets/strategies/cci-williams-momentum.json";
import confluence from "../../assets/strategies/confluence.json";
import coppockBottom from "../../assets/strategies/coppock-bottom.json";
import dpoRsiPullback from "../../assets/strategies/dpo-rsi-pullback.json";
import elderImpulse from "../../assets/strategies/elder-impulse.json";
import fastSupertrend from "../../assets/strategies/fast-supertrend.json";
import hullChopMomentum from "../../assets/strategies/hull-chop-momentum.json";
import ichimokuCloud from "../../assets/strategies/ichimoku-cloud.json";
import kdjExtremeRecovery from "../../assets/strategies/kdj-extreme-recovery.json";
import keltnerBreakout from "../../assets/strategies/keltner-breakout.json";
import pmaxStrategy from "../../assets/strategies/pmax.json";
import psarMomentum from "../../assets/strategies/psar-momentum.json";
import rsiMacdTrendRide from "../../assets/strategies/rsi-macd-trend-ride.json";
import smaCross from "../../assets/strategies/sma-cross.json";
import stochrsiTrendFilter from "../../assets/strategies/stochrsi-trend-filter.json";
import supertrendPullbackMomentum from "../../assets/strategies/supertrend-pullback-momentum.json";
import supertrendStrategy from "../../assets/strategies/supertrend.json";
import trendMomentumRider from "../../assets/strategies/trend-momentum-rider.json";
import turtleSupertrendExit from "../../assets/strategies/turtle-supertrend-exit.json";
import turtle from "../../assets/strategies/turtle.json";
import vwapMomentum from "../../assets/strategies/vwap-momentum.json";
import vwmaChopBreakout from "../../assets/strategies/vwma-chop-breakout.json";
import { homeDir } from "../core/paths.js";
import { type StrategyDef, validateStrategy } from "./strategy.js";

export const BUILTIN_STRATEGIES: readonly unknown[] = [
  adaptiveMomentumReversal,
  aroonTrendRider,
  bollingerSqueeze,
  breakoutMomentumRider,
  breakoutVolume,
  cciWilliamsMomentum,
  confluence,
  coppockBottom,
  dpoRsiPullback,
  elderImpulse,
  fastSupertrend,
  hullChopMomentum,
  ichimokuCloud,
  kdjExtremeRecovery,
  keltnerBreakout,
  pmaxStrategy,
  psarMomentum,
  rsiMacdTrendRide,
  smaCross,
  stochrsiTrendFilter,
  supertrendPullbackMomentum,
  supertrendStrategy,
  trendMomentumRider,
  turtleSupertrendExit,
  turtle,
  vwapMomentum,
  vwmaChopBreakout,
];

/** The user's strategy directory. */
export function userStrategyDir(): string {
  return join(homeDir(), "strategies");
}

export interface StrategyEntry {
  name: string;
  description: string;
  origin: "builtin" | "user";
  path?: string;
  valid: boolean;
  errors: string[];
}

/** Built-ins and the user's strategies (a user file shadows a built-in of the same name). */
export function listStrategies(): StrategyEntry[] {
  const out = new Map<string, StrategyEntry>();
  for (const s of BUILTIN_STRATEGIES) {
    const v = validateStrategy(s);
    const o = s as { name: string; description: string };
    out.set(o.name, { name: o.name, description: o.description, origin: "builtin", valid: v.valid, errors: v.errors });
  }
  const dir = userStrategyDir();
  if (existsSync(dir))
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const path = join(dir, f);
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const v = validateStrategy(raw);
        out.set(raw?.name ?? f, { name: raw?.name ?? f, description: String(raw?.description ?? ""), origin: "user", path, valid: v.valid, errors: v.errors });
      } catch (e) {
        out.set(f, { name: f, description: "", origin: "user", path, valid: false, errors: [`not JSON: ${(e as Error).message}`] });
      }
    }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The raw JSON of a strategy: a file path, then the user's directory, then the built-ins. */
export function findStrategy(ref: string): { raw: unknown; origin: string } | undefined {
  if (ref.endsWith(".json") || ref.includes("/")) {
    if (!existsSync(ref)) return undefined;
    return { raw: JSON.parse(readFileSync(ref, "utf8")), origin: ref };
  }
  const user = join(userStrategyDir(), `${ref}.json`);
  if (existsSync(user)) return { raw: JSON.parse(readFileSync(user, "utf8")), origin: user };
  const b = BUILTIN_STRATEGIES.find((s) => (s as { name?: string }).name === ref);
  return b ? { raw: structuredClone(b), origin: "builtin" } : undefined;
}

/** Load and validate, throwing every validation error at once. */
export function loadStrategy(ref: string): { def: StrategyDef; origin: string; warnings: string[] } {
  const found = findStrategy(ref);
  if (!found) throw new Error(`no strategy "${ref}" — \`ultrastock strategy list\` shows the built-ins and yours`);
  const v = validateStrategy(found.raw);
  if (!v.valid) throw new Error(`strategy ${ref} is invalid:\n  - ${v.errors.join("\n  - ")}`);
  return { def: v.def!, origin: found.origin, warnings: v.warnings };
}

/** A starting point for `strategy new`: a trend filter, an entry, an exit and risk rules. */
export function strategyTemplate(name: string): StrategyDef {
  return {
    name,
    description: "Describe the idea in one sentence: what the edge is and why it should persist",
    indicators: {
      trend: { _type: "ema", period: 100 },
      rsi: { period: 14 },
    },
    buy: {
      mode: "all",
      conditions: [
        ["close", ">", "trend"],
        ["rsi", "<", 35],
      ],
    },
    sell: {
      mode: "any",
      conditions: [
        ["rsi", ">", 70],
        ["close", "<", "trend"],
      ],
    },
    risk: { stopLossPct: 8, trailingStopPct: 15, maxDrawdownPct: 30 },
    execution: { entry: "market" },
  };
}
