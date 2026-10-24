// Declarative strategies: the JSON format of maxgfr/ai-strategy-backtester,
// ported. A strategy names its indicators (with parameters, `_type` to alias
// one indicator twice), and four signal blocks — buy, sell, short, cover —
// each "all" / "any" of [left, op, right] conditions, or a "score": every
// `required` condition plus at least `threshold` of the `scored` ones.
// References: a number, a candle field (close, open, high, low, volume), an
// indicator alias ("rsi"), one of its fields ("adx.adx"), and a past bar
// ("adx.adx[-2]", "close[-1]"). A positive offset reads the future and is
// refused.
//
// What the port adds to the source format: a `risk` block (stops, target,
// trailing, ATR stop, time stop, risk-per-trade sizing, circuit breaker —
// the source kept these in config.json), an `execution` block (market or limit
// entries) and `baseInterval`. The source tuned every strategy for 4h bars and
// rescaled period parameters to the running interval by sqrt(240 / minutes)
// (min 2); a strategy that declares `baseInterval` keeps that behaviour, one
// that does not reads its periods as bars of the interval it runs on.
//
// Validation is hand-written (no zod) and names the path of every problem.
// Indicators come from the ultrastock registry (src/analytics/indicators):
// the source's catalog names map onto it through SOURCE_INDICATORS below, with
// parameter and field renames where they differ.
import { computeIndicator, type IndicatorInfo, type IndicatorParams, type IndicatorRow, listIndicators } from "../analytics/indicators/index.js";
import type { Bar, Interval } from "../providers/types.js";

export type Op = ">" | "<" | ">=" | "<=" | "==" | "!=";
export type ValueRef = number | string;
export type Condition = [ValueRef, Op, ValueRef];

export interface SimpleBlock {
  mode: "all" | "any";
  conditions: Condition[];
}
export interface ScoreBlock {
  mode: "score";
  threshold: number;
  required?: Condition[];
  scored: Condition[];
}
export type SignalBlock = SimpleBlock | ScoreBlock;

/** Risk rules; every percentage is a percent number (8 = 8 %). */
export interface RiskRules {
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  /** A stop `multiplier` × ATR(`period`) away from the entry, ATR read at the signal bar. */
  atrStop?: { period: number; multiplier: number };
  /** Exit at the next open once a position has been held this many bars. */
  timeStopBars?: number;
  /** Size each position so that hitting its stop loses this % of equity (needs a stop). */
  riskPerTradePct?: number;
  /** Circuit breaker: no new position once equity is this % under its peak (permanent). */
  maxDrawdownPct?: number;
}

export interface ExecutionRules {
  /** "market" entries fill at the next open and pay the taker fee; "limit" entries rest for one bar at an offset and pay the maker fee. */
  entry?: "market" | "limit";
  /** How far from the signal close the limit rests, in %. */
  limitOffsetPct?: number;
}

export interface StrategyDef {
  name: string;
  description: string;
  leverage?: number;
  baseInterval?: Interval;
  /** Intervals the author designed it for (documentation; the source config's "timeframes"). */
  intervals?: string[];
  indicators: Record<string, Record<string, number | string>>;
  buy: SignalBlock;
  sell: SignalBlock;
  short?: SignalBlock;
  cover?: SignalBlock;
  risk?: RiskRules;
  execution?: ExecutionRules;
}

export const CANDLE_FIELDS = ["close", "open", "high", "low", "volume"] as const;
const OPS: readonly Op[] = [">", "<", ">=", "<=", "==", "!="];
const INTERVAL_MINUTES: Record<string, number> = { "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };
const REF = /^([a-zA-Z]+)(?:\.([a-zA-Z]+))?(?:\[(-?\d+)\])?$/;

// --- The source catalog → the ultrastock registry ------------------------------------

interface Adapter {
  /** Registry name. */
  registry: string;
  /** Source parameter name → registry name, where they differ. */
  params?: Record<string, string>;
  /** Source field name → registry field, where they differ. Registry field names are always accepted too. */
  fields?: Record<string, string>;
  /** The field a bare reference reads (the source catalog's defaultField). */
  defaultField?: string;
  /** Parameters fixed to reproduce the source's semantics (overridable). */
  fixed?: IndicatorParams;
  /** Fields the source had and the registry refuses, with why. */
  refused?: Record<string, string>;
}

/**
 * The 51 indicators of the source catalog. Names absent here are read straight
 * from the registry (sma, wma, kama, atr, zScore… — 107 entries in all).
 * `bollingerBands` is the one composite: the registry's bollinger bands plus
 * its %B as the source's `bbr`.
 */
export const SOURCE_INDICATORS: Record<string, Adapter> = {
  bollingerBands: { registry: "bollinger", defaultField: "bbr" },
  vwap: { registry: "vwap", fixed: { anchor: "start" } },
  pmax: { registry: "pmax", params: { emaPeriod: "maPeriod" }, fields: { pmaxLong: "longStop", pmaxShort: "shortStop" }, defaultField: "pmax" },
  adx: { registry: "adx", fields: { pdi: "plusDI", mdi: "minusDI" }, defaultField: "adx" },
  donchian: { registry: "donchian", defaultField: "middle" },
  aroon: { registry: "aroon", defaultField: "oscillator" },
  ichimoku: {
    registry: "ichimoku",
    fields: { conversion: "tenkan", base: "kijun" },
    defaultField: "tenkan",
    refused: {
      chikou:
        "the chikou span is today's close plotted 26 bars back: reading it at its plotted bar needs future closes — compare close with close[-26] instead",
    },
  },
  chandelier: { registry: "chandelierExit", defaultField: "exitLong" },
  keltner: { registry: "keltner", defaultField: "middle" },
  starcBands: { registry: "starcBands", defaultField: "middle" },
  movingAverageEnvelope: { registry: "movingAverageEnvelope", defaultField: "middle" },
  stochRsi: { registry: "stochRsi", defaultField: "k" },
  supertrend: { registry: "supertrend", defaultField: "supertrend" },
  psar: { registry: "psar", defaultField: "sar" },
  // Same name, same parameters, same fields in both:
  ...Object.fromEntries(
    [
      "rsi",
      "ema",
      "obv",
      "cmf",
      "williamsR",
      "cci",
      "roc",
      "ad",
      "mfi",
      "ao",
      "movingAverage",
      "trix",
      "volumeOscillator",
      "macd",
      "stochastic",
      "vortex",
      "atrTrailingStop",
      "pmo",
      "kdj",
      "volumeSma",
      "atrRatio",
      "elderRay",
      "ravi",
      "hma",
      "choppinessIndex",
      "ultimateOscillator",
      "chaikinOscillator",
      "linearRegressionSlope",
      "fisherTransform",
      "coppockCurve",
      "forceIndex",
      "dpo",
      "vwma",
      "rvi",
      "massIndex",
      "emv",
      "mcginleyDynamic",
    ].map((n) => [n, { registry: n }]),
  ),
};

let registryCache: Map<string, IndicatorInfo> | undefined;
const registry = () => (registryCache ??= new Map(listIndicators().map((i) => [i.name, i])));

interface ResolvedIndicator {
  alias: string;
  /** The name the strategy used (`_type` or the alias). */
  name: string;
  info: IndicatorInfo;
  adapter?: Adapter;
  params: IndicatorParams;
  /** Every field a reference may name → the registry field it reads. */
  fields: Map<string, string>;
  defaultField: string;
}

/** How a strategy's indicator entry maps onto the registry, or why it cannot. */
export function resolveIndicator(alias: string, raw: Record<string, number | string>): ResolvedIndicator | string {
  const name = typeof raw._type === "string" ? raw._type : alias;
  const adapter = SOURCE_INDICATORS[name];
  const info = registry().get(adapter?.registry ?? name);
  if (!info) return `unknown indicator "${name}" (alias "${alias}") — see \`ultrastock strategy list\` for the catalog`;
  const params: IndicatorParams = { ...(adapter?.fixed ?? {}) };
  for (const [k, v] of Object.entries(raw)) {
    if (k === "_type") continue;
    const target = adapter?.params?.[k] ?? k;
    const spec = info.params.find((p) => p.name === target);
    if (!spec || spec.kind === "bars")
      return `indicator "${alias}" (${name}): unknown parameter "${k}" (expected ${info.params
        .filter((p) => p.kind !== "bars")
        .map((p) => p.name)
        .join(", ")})`;
    if (spec.kind === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) return `indicator "${alias}": parameter "${k}" must be a number`;
      if (spec.integer && !Number.isInteger(v)) return `indicator "${alias}": parameter "${k}" must be an integer`;
      if (spec.min !== undefined && v < spec.min) return `indicator "${alias}": parameter "${k}" must be ≥ ${spec.min}`;
    } else {
      if (typeof v !== "string") return `indicator "${alias}": parameter "${k}" must be a string`;
      if (spec.choices && !spec.choices.includes(v)) return `indicator "${alias}": parameter "${k}" must be one of ${spec.choices.join(", ")}`;
    }
    params[target] = v;
  }
  if (info.params.some((p) => p.kind === "bars")) return `indicator "${name}" needs a benchmark series, which a strategy cannot supply`;
  const fields = new Map<string, string>(info.outputs.map((o) => [o, o]));
  for (const [s, r] of Object.entries(adapter?.fields ?? {})) fields.set(s, r);
  if (name === "bollingerBands") fields.set("bbr", "bbr");
  return { alias, name, info, adapter, params, fields, defaultField: adapter?.defaultField ?? info.outputs[0] ?? "value" };
}

// --- Validation -------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const TOP_KEYS = new Set(["name", "description", "leverage", "baseInterval", "intervals", "indicators", "buy", "sell", "short", "cover", "risk", "execution"]);
const RISK_KEYS: Record<string, [number, number]> = {
  stopLossPct: [0.01, 100],
  takeProfitPct: [0.01, 10_000],
  trailingStopPct: [0.01, 100],
  riskPerTradePct: [0.01, 100],
  maxDrawdownPct: [0.01, 100],
};

function checkCondition(c: unknown, path: string, aliases: Map<string, ResolvedIndicator>, errors: string[]): void {
  if (!Array.isArray(c) || c.length !== 3) {
    errors.push(`${path}: a condition is [left, op, right], like ["rsi", "<", 30]`);
    return;
  }
  const [l, op, r] = c as unknown[];
  if (!OPS.includes(op as Op)) errors.push(`${path}[1]: operator ${JSON.stringify(op)} is not one of ${OPS.join(" ")}`);
  for (const [ref, at] of [
    [l, 0],
    [r, 2],
  ] as const) {
    const msg = checkRef(ref, aliases);
    if (msg) errors.push(`${path}[${at}]: ${msg}`);
  }
}

/** Why a value reference is invalid, or undefined when it resolves. */
function checkRef(ref: unknown, aliases: Map<string, ResolvedIndicator>): string | undefined {
  if (typeof ref === "number") return Number.isFinite(ref) ? undefined : "a number literal must be finite";
  if (typeof ref !== "string") return `a reference is a number or a string, not ${JSON.stringify(ref)}`;
  const m = REF.exec(ref);
  if (!m) return `"${ref}" is not a reference (alias, alias.field, alias[-n] or alias.field[-n])`;
  const [, head, field, off] = m;
  if (off !== undefined && Number(off) > 0) return `"${ref}" reads ${off} bar(s) into the future — offsets must be ≤ 0`;
  if ((CANDLE_FIELDS as readonly string[]).includes(head!)) return field ? `"${ref}": a candle field has no sub-field` : undefined;
  const ind = aliases.get(head!);
  if (!ind) return `"${ref}" uses undeclared indicator "${head}" (declared: ${[...aliases.keys()].join(", ") || "none"})`;
  if (field) {
    const refused = ind.adapter?.refused?.[field];
    if (refused) return `"${ref}": ${refused}`;
    if (!ind.fields.has(field)) return `unknown field "${field}" for indicator "${ind.name}" (available: ${[...ind.fields.keys()].join(", ")})`;
  }
  return undefined;
}

function checkBlock(b: unknown, path: string, aliases: Map<string, ResolvedIndicator>, errors: string[]): void {
  if (!isObj(b)) {
    errors.push(`${path}: a signal block is an object with "mode"`);
    return;
  }
  if (b.mode === "all" || b.mode === "any") {
    if ("scored" in b || "required" in b || "threshold" in b) errors.push(`${path}: "scored", "required" and "threshold" belong to mode "score" only`);
    if (!Array.isArray(b.conditions) || !b.conditions.length) errors.push(`${path}.conditions: a non-empty array of conditions is required`);
    else b.conditions.forEach((c, i) => checkCondition(c, `${path}.conditions[${i}]`, aliases, errors));
  } else if (b.mode === "score") {
    if ("conditions" in b) errors.push(`${path}: score mode counts "scored" conditions — "conditions" is for modes "all"/"any"`);
    if (!Array.isArray(b.scored) || !b.scored.length) errors.push(`${path}.scored: a non-empty array of conditions is required`);
    else b.scored.forEach((c, i) => checkCondition(c, `${path}.scored[${i}]`, aliases, errors));
    if (b.required !== undefined) {
      if (!Array.isArray(b.required)) errors.push(`${path}.required: an array of conditions`);
      else b.required.forEach((c, i) => checkCondition(c, `${path}.required[${i}]`, aliases, errors));
    }
    const n = Array.isArray(b.scored) ? b.scored.length : 0;
    if (typeof b.threshold !== "number" || !Number.isInteger(b.threshold) || b.threshold < 1 || (n && b.threshold > n))
      errors.push(`${path}.threshold: an integer between 1 and the number of scored conditions (${n})`);
  } else errors.push(`${path}.mode: "all", "any" or "score", not ${JSON.stringify(b.mode)}`);
}

export interface Validation {
  valid: boolean;
  errors: string[];
  /** Advice that does not invalidate the strategy. */
  warnings: string[];
  def?: StrategyDef;
}

/** Check a parsed JSON value against the strategy format; every error names its path. */
export function validateStrategy(x: unknown): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(x)) return { valid: false, errors: ["a strategy is a JSON object"], warnings };
  for (const k of Object.keys(x)) if (!TOP_KEYS.has(k)) errors.push(`${k}: unknown key (known: ${[...TOP_KEYS].join(", ")})`);
  if (typeof x.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(x.name))
    errors.push("name: kebab-case (lowercase letters, digits, hyphens), starting with a letter");
  if (typeof x.description !== "string" || !x.description.trim()) errors.push("description: a non-empty string");
  if (x.leverage !== undefined && (typeof x.leverage !== "number" || x.leverage < 1 || x.leverage > 125)) errors.push("leverage: a number from 1 to 125");
  if (x.baseInterval !== undefined && !(typeof x.baseInterval === "string" && x.baseInterval in INTERVAL_MINUTES))
    errors.push(`baseInterval: one of ${Object.keys(INTERVAL_MINUTES).join(", ")}`);
  if (x.intervals !== undefined && !(Array.isArray(x.intervals) && x.intervals.every((s) => typeof s === "string")))
    errors.push("intervals: an array of interval names");
  const aliases = new Map<string, ResolvedIndicator>();
  if (!isObj(x.indicators)) errors.push("indicators: an object of alias → parameters");
  else
    for (const [alias, params] of Object.entries(x.indicators)) {
      if (!/^[a-zA-Z]+$/.test(alias)) {
        errors.push(`indicators.${alias}: an alias is letters only (emaSlow, not ema50)`);
        continue;
      }
      if ((CANDLE_FIELDS as readonly string[]).includes(alias)) {
        errors.push(`indicators.${alias}: "${alias}" is a candle field and cannot be an alias`);
        continue;
      }
      if (!isObj(params)) {
        errors.push(`indicators.${alias}: an object of parameters ({} for the defaults)`);
        continue;
      }
      const r = resolveIndicator(alias, params as Record<string, number | string>);
      if (typeof r === "string") errors.push(`indicators.${alias}: ${r}`);
      else aliases.set(alias, r);
    }
  for (const k of ["buy", "sell"] as const) {
    if (x[k] === undefined) errors.push(`${k}: required`);
    else checkBlock(x[k], k, aliases, errors);
  }
  if ((x.short === undefined) !== (x.cover === undefined)) errors.push("short and cover: define both or neither");
  for (const k of ["short", "cover"] as const) if (x[k] !== undefined) checkBlock(x[k], k, aliases, errors);
  if (x.risk !== undefined) {
    if (!isObj(x.risk)) errors.push("risk: an object");
    else
      for (const [k, v] of Object.entries(x.risk)) {
        if (k === "atrStop") {
          if (!isObj(v) || typeof v.period !== "number" || !Number.isInteger(v.period) || v.period < 1 || typeof v.multiplier !== "number" || v.multiplier <= 0)
            errors.push('risk.atrStop: { "period": integer ≥ 1, "multiplier": number > 0 }');
        } else if (k === "timeStopBars") {
          if (typeof v !== "number" || !Number.isInteger(v) || v < 1) errors.push("risk.timeStopBars: an integer ≥ 1");
        } else if (RISK_KEYS[k]) {
          const [lo, hi] = RISK_KEYS[k]!;
          if (typeof v !== "number" || v < lo || v > hi) errors.push(`risk.${k}: a percent number between ${lo} and ${hi} (8 means 8 %)`);
          else if (v < 1 && k !== "riskPerTradePct") warnings.push(`risk.${k} = ${v} means ${v} %, not ${v * 100} % — percents are percent numbers`);
        } else errors.push(`risk.${k}: unknown key (stopLossPct, takeProfitPct, trailingStopPct, atrStop, timeStopBars, riskPerTradePct, maxDrawdownPct)`);
      }
    if (isObj(x.risk) && x.risk.riskPerTradePct !== undefined && x.risk.stopLossPct === undefined && x.risk.atrStop === undefined)
      errors.push("risk.riskPerTradePct: needs a stop (stopLossPct or atrStop) to size against");
  }
  if (x.execution !== undefined) {
    if (!isObj(x.execution)) errors.push("execution: an object");
    else {
      for (const k of Object.keys(x.execution)) if (k !== "entry" && k !== "limitOffsetPct") errors.push(`execution.${k}: unknown key (entry, limitOffsetPct)`);
      if (x.execution.entry !== undefined && x.execution.entry !== "market" && x.execution.entry !== "limit")
        errors.push('execution.entry: "market" or "limit"');
      const off = x.execution.limitOffsetPct;
      if (off !== undefined && (typeof off !== "number" || off < 0 || off > 50)) errors.push("execution.limitOffsetPct: a percent number from 0 to 50");
    }
  }
  // Advice from the source's guide (anti-patterns), not errors.
  for (const k of ["buy", "short"] as const) {
    const b = x[k];
    if (isObj(b) && b.mode === "all" && Array.isArray(b.conditions) && b.conditions.length >= 5)
      warnings.push(`${k}: ${b.conditions.length} conditions joined by "all" rarely all hold — expect few trades`);
    if (isObj(b) && b.mode === "score" && Array.isArray(b.scored) && typeof b.threshold === "number" && b.threshold < b.scored.length / 2)
      warnings.push(`${k}: threshold ${b.threshold} of ${b.scored.length} scored conditions is permissive — expect noisy signals`);
  }
  return { valid: errors.length === 0, errors, warnings, def: errors.length ? undefined : (x as unknown as StrategyDef) };
}

// --- Compilation: indicators once, then a boolean per bar per block --------------------------

/** Rescale period parameters from `base` to `run` the way the source did: × sqrt(base / run minutes), at least 2. */
export function scaleParams(info: IndicatorInfo, params: IndicatorParams, base: Interval | undefined, run: Interval): IndicatorParams {
  if (!base || base === run) return params;
  const b = INTERVAL_MINUTES[base];
  const r = INTERVAL_MINUTES[run];
  if (!b || !r) return params;
  const scale = Math.sqrt(b / r);
  const out: IndicatorParams = { ...params };
  for (const spec of info.params) {
    if (spec.kind !== "number" || !spec.integer) continue;
    const v = (params[spec.name] ?? spec.default) as number;
    out[spec.name] = Math.max(2, Math.round(v * scale));
  }
  return out;
}

export interface Signals {
  buy: boolean[];
  sell: boolean[];
  short: boolean[];
  cover: boolean[];
  /** The effective parameters of each alias after scaling, for the report. */
  params: Record<string, Record<string, number | string>>;
}

type Getter = (i: number) => number | undefined;

/**
 * Evaluate a strategy on every bar. signals.buy[i] is decided from bars 0..i
 * only (the registry's contract: an indicator value at i is known at bar i's
 * close), so the simulator may act on it at bar i + 1 and never earlier.
 */
export function compileStrategy(def: StrategyDef, bars: readonly Bar[], interval: Interval = "1d"): Signals {
  const v = validateStrategy(def);
  if (!v.valid) throw new Error(`strategy ${def.name}: ${v.errors.join("; ")}`);
  const columns = new Map<string, { rows: Array<IndicatorRow | undefined>; ind: ResolvedIndicator }>();
  const params: Signals["params"] = {};
  for (const [alias, raw] of Object.entries(def.indicators)) {
    const ind = resolveIndicator(alias, raw) as ResolvedIndicator;
    const p = scaleParams(ind.info, ind.params, def.baseInterval, interval);
    let rows = computeIndicator(ind.info.name, bars, p).values;
    if (ind.name === "bollingerBands") {
      const pb = computeIndicator("bollingerPercentB", bars, p).values;
      rows = rows.map((r, i) => (r && pb[i] ? { ...r, bbr: pb[i]!.value! } : undefined));
    }
    columns.set(alias, { rows, ind });
    params[alias] = Object.fromEntries(Object.entries(p).map(([k, x]) => [k, x as number | string]));
  }
  const getter = (ref: ValueRef): Getter => {
    if (typeof ref === "number") return () => ref;
    const [, head, field, off] = REF.exec(ref)!;
    const o = off ? Number(off) : 0;
    if ((CANDLE_FIELDS as readonly string[]).includes(head!)) {
      const f = head as (typeof CANDLE_FIELDS)[number];
      return (i) => {
        const b = bars[i + o];
        return b ? (f === "volume" ? (b.volume ?? 0) : b[f]) : undefined;
      };
    }
    const col = columns.get(head!)!;
    const key = col.ind.fields.get(field ?? col.ind.defaultField) ?? field ?? col.ind.defaultField;
    return (i) => {
      const v = i + o >= 0 ? col.rows[i + o]?.[key] : undefined;
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    };
  };
  const cond = (c: Condition) => {
    const l = getter(c[0]);
    const r = getter(c[2]);
    const op = c[1];
    return (i: number) => {
      const a = l(i);
      const b = r(i);
      if (a === undefined || b === undefined) return false;
      switch (op) {
        case ">":
          return a > b;
        case "<":
          return a < b;
        case ">=":
          return a >= b;
        case "<=":
          return a <= b;
        case "==":
          return a === b;
        default:
          return a !== b;
      }
    };
  };
  const block = (b: SignalBlock | undefined): boolean[] => {
    if (!b) return bars.map(() => false);
    if (b.mode === "score") {
      const req = (b.required ?? []).map(cond);
      const sc = b.scored.map(cond);
      return bars.map((_, i) => req.every((f) => f(i)) && sc.reduce((n, f) => n + (f(i) ? 1 : 0), 0) >= b.threshold);
    }
    const cs = b.conditions.map(cond);
    return bars.map((_, i) => (b.mode === "all" ? cs.every((f) => f(i)) : cs.some((f) => f(i))));
  };
  return { buy: block(def.buy), sell: block(def.sell), short: block(def.short), cover: block(def.cover), params };
}

/** A copy of the strategy with one parameter changed: "alias.param" for an indicator, "risk.key" for a risk rule. */
export function withParam(def: StrategyDef, path: string, value: number): StrategyDef {
  const [head, key] = path.split(".");
  if (!head || !key) throw new Error(`parameter "${path}" is alias.param or risk.key`);
  if (head === "risk") return { ...def, risk: { ...(def.risk ?? {}), [key]: value } };
  if (head === "atrStop") return { ...def, risk: { ...(def.risk ?? {}), atrStop: { ...(def.risk?.atrStop ?? { period: 14, multiplier: 3 }), [key]: value } } };
  const ind = def.indicators[head];
  if (!ind) throw new Error(`parameter "${path}": no indicator "${head}" (declared: ${Object.keys(def.indicators).join(", ")})`);
  return { ...def, indicators: { ...def.indicators, [head]: { ...ind, [key]: value } } };
}

/** The current value of "alias.param" (the registry default when the strategy omits it) or "risk.key". */
export function paramValue(def: StrategyDef, path: string): number | undefined {
  const [head, key] = path.split(".");
  if (!head || !key) return undefined;
  if (head === "risk") return (def.risk as Record<string, number> | undefined)?.[key];
  const raw = def.indicators[head];
  if (!raw) return undefined;
  if (typeof raw[key] === "number") return raw[key] as number;
  const r = resolveIndicator(head, raw);
  if (typeof r === "string") return undefined;
  const target = r.adapter?.params?.[key] ?? key;
  const d = (r.params[target] ?? r.info.params.find((p) => p.name === target)?.default) as number | undefined;
  return typeof d === "number" ? d : undefined;
}

/**
 * The numeric parameters of a strategy's indicators, "alias.param" → value
 * (integer periods first, then real ones like multipliers) — the default sweep
 * dimensions.
 */
export function tunableParams(def: StrategyDef): Array<{ path: string; value: number; integer: boolean }> {
  const ints: Array<{ path: string; value: number; integer: boolean }> = [];
  const reals: Array<{ path: string; value: number; integer: boolean }> = [];
  for (const [alias, raw] of Object.entries(def.indicators)) {
    const r = resolveIndicator(alias, raw);
    if (typeof r === "string") continue;
    const reverse = Object.fromEntries(Object.entries(r.adapter?.params ?? {}).map(([s, t]) => [t, s]));
    for (const spec of r.info.params) {
      if (spec.kind !== "number") continue;
      const v = (r.params[spec.name] ?? spec.default) as number;
      (spec.integer ? ints : reals).push({ path: `${alias}.${reverse[spec.name] ?? spec.name}`, value: v, integer: !!spec.integer });
    }
  }
  return [...ints, ...reals];
}
