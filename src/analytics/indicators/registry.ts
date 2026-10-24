// The indicator registry: one name → function, parameter specs with defaults,
// and output fields, so strategy, screening and alert code can ask for
// "rsi(period=14)" by name and get rows it can index by bar. Every entry obeys
// the library contract: values[i] is known at the close of bar i (tested
// generically for every entry in tests/indicators-registry.test.ts).
import type { Bar } from "../../providers/types.js";
import { atr, bollinger, ema, macd, rsi, sma, trueRange } from "../indicators.js";
import { dema, hma, kama, MA_TYPES, type MaType, mcginleyDynamic, movingAverage, rma, tema, vwma, wma } from "./averages.js";
import { bollingerBandwidth, bollingerPercentB, donchian, keltner, movingAverageEnvelope, starcBands } from "./bands.js";
import { CANDLE_PATTERNS, heikinAshi } from "./candles.js";
import {
  awesomeOscillator,
  cci,
  coppockCurve,
  dpo,
  elderRay,
  fisherTransform,
  kdj,
  kst,
  momentum,
  pmo,
  pringSpecialK,
  roc,
  rvi,
  shinohara,
  stochastic,
  stochRsi,
  trix,
  ultimateOscillator,
  williamsR,
} from "./momentum.js";
import { type Series, chain } from "./shared.js";
import {
  highestHigh,
  linearRegressionSlope,
  lowestLow,
  mansfieldRs,
  percentRank,
  relativeStrength,
  rollingMax,
  rollingMin,
  rollingStdev,
  zScore,
} from "./stats.js";
import { adx, aroon, ichimoku, pmax, psar, ravi, supertrend, vortex } from "./trend.js";
import { atrTrailingStop, chandelierExit, choppinessIndex, massIndex, williamsVixFix } from "./volatility.js";
import { accumulationDistribution, chaikinOscillator, cmf, emv, forceIndex, mfi, obv, rollingVwap, twiggsMoneyFlow, volumeOscillator, vwap } from "./volume.js";

export type IndicatorGroup = "averages" | "trend" | "momentum" | "volatility" | "bands" | "volume" | "stats" | "candles";

export interface IndicatorParamSpec {
  name: string;
  kind: "number" | "string" | "bars";
  /** Absent for a required parameter (a benchmark series). */
  default?: number | string;
  description: string;
  integer?: boolean;
  min?: number;
  choices?: readonly string[];
}

export interface IndicatorInfo {
  name: string;
  group: IndicatorGroup;
  description: string;
  params: IndicatorParamSpec[];
  /** Field names of each row; single-output indicators have one field, `value`. */
  outputs: string[];
}

export type IndicatorParamValue = number | string | readonly Bar[];
export type IndicatorParams = Record<string, IndicatorParamValue>;
export type IndicatorRow = Record<string, number>;

export interface IndicatorResult {
  name: string;
  /** The parameters actually used, defaults filled in (a bars parameter shows as its length). */
  params: Record<string, number | string>;
  outputs: string[];
  /** Aligned with the input bars: undefined until the indicator is defined. */
  values: Array<IndicatorRow | undefined>;
}

type Resolved = Record<string, IndicatorParamValue>;
type Raw = ReadonlyArray<number | object | undefined>;

interface IndicatorDef extends IndicatorInfo {
  run: (bars: readonly Bar[], p: Resolved) => Raw;
}

export const PRICE_SOURCES = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "volume"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** The value series an indicator reads: a price field or a classic combination. */
export function priceSource(bars: readonly Bar[], source: PriceSource = "close"): number[] {
  switch (source) {
    case "open":
      return bars.map((b) => b.open);
    case "high":
      return bars.map((b) => b.high);
    case "low":
      return bars.map((b) => b.low);
    case "hl2":
      return bars.map((b) => (b.high + b.low) / 2);
    case "hlc3":
      return bars.map((b) => (b.high + b.low + b.close) / 3);
    case "ohlc4":
      return bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
    case "volume":
      return bars.map((b) => b.volume ?? 0);
    default:
      return bars.map((b) => b.close);
  }
}

// ---- parameter spec builders -------------------------------------------------

const period = (name: string, def: number, description: string): IndicatorParamSpec => ({
  name,
  kind: "number",
  default: def,
  description,
  integer: true,
  min: 1,
});
const real = (name: string, def: number, description: string): IndicatorParamSpec => ({ name, kind: "number", default: def, description, min: 0 });
const SOURCE: IndicatorParamSpec = { name: "source", kind: "string", default: "close", description: "Price series read", choices: PRICE_SOURCES };
const BENCHMARK: IndicatorParamSpec = { name: "benchmark", kind: "bars", description: "Benchmark bars (as-of joined by date)" };

const num = (p: Resolved, k: string) => p[k] as number;
const str = (p: Resolved, k: string) => p[k] as string;
const src = (bars: readonly Bar[], p: Resolved) => priceSource(bars, str(p, "source") as PriceSource);

const defs: IndicatorDef[] = [];
function def(name: string, group: IndicatorGroup, description: string, params: IndicatorParamSpec[], outputs: string[], run: IndicatorDef["run"]) {
  defs.push({ name, group, description, params, outputs, run });
}
const V = ["value"];
const BAND = ["upper", "middle", "lower"];

// ---- averages -----------------------------------------------------------------
def("sma", "averages", "Simple moving average", [period("period", 20, "Window"), SOURCE], V, (b, p) => sma(src(b, p), num(p, "period")));
def("ema", "averages", "Exponential moving average, SMA-seeded", [period("period", 20, "Window"), SOURCE], V, (b, p) => ema(src(b, p), num(p, "period")));
def("wma", "averages", "Linearly weighted moving average", [period("period", 20, "Window"), SOURCE], V, (b, p) => wma(src(b, p), num(p, "period")));
def("rma", "averages", "Wilder's smoothing (RMA/SMMA)", [period("period", 14, "Window"), SOURCE], V, (b, p) => rma(src(b, p), num(p, "period")));
def("dema", "averages", "Mulloy's double EMA", [period("period", 20, "Window"), SOURCE], V, (b, p) => dema(src(b, p), num(p, "period")));
def("tema", "averages", "Mulloy's triple EMA", [period("period", 20, "Window"), SOURCE], V, (b, p) => tema(src(b, p), num(p, "period")));
def("hma", "averages", "Hull moving average", [period("period", 16, "Window"), SOURCE], V, (b, p) => hma(src(b, p), num(p, "period")));
def(
  "kama",
  "averages",
  "Kaufman adaptive moving average",
  [period("period", 10, "Efficiency-ratio window"), period("fast", 2, "Fast EMA period"), period("slow", 30, "Slow EMA period"), SOURCE],
  V,
  (b, p) => kama(src(b, p), num(p, "period"), num(p, "fast"), num(p, "slow")),
);
def(
  "mcginleyDynamic",
  "averages",
  "McGinley Dynamic",
  [period("period", 14, "Window"), { ...real("k", 1, "McGinley's constant (he suggested 0.6)"), min: 0.01 }, SOURCE],
  V,
  (b, p) => mcginleyDynamic(src(b, p), num(p, "period"), num(p, "k")),
);
def("vwma", "averages", "Volume-weighted moving average", [period("period", 20, "Window")], V, (b, p) => vwma(b, num(p, "period")));
def(
  "movingAverage",
  "averages",
  "Moving average of a chosen type",
  [period("period", 20, "Window"), { name: "type", kind: "string", default: "ema", description: "Average type", choices: MA_TYPES }, SOURCE],
  V,
  (b, p) => movingAverage(src(b, p), num(p, "period"), str(p, "type") as MaType),
);

// ---- trend ------------------------------------------------------------------------
def("adx", "trend", "Wilder's ADX with +DI/−DI", [period("period", 14, "Window")], ["adx", "plusDI", "minusDI", "dx"], (b, p) => adx(b, num(p, "period")));
def("aroon", "trend", "Chande's Aroon up/down/oscillator", [period("period", 25, "Window")], ["up", "down", "oscillator"], (b, p) =>
  aroon(b, num(p, "period")),
);
def(
  "psar",
  "trend",
  "Wilder's parabolic stop-and-reverse",
  [real("step", 0.02, "Acceleration step"), real("max", 0.2, "Acceleration cap")],
  ["sar", "trend"],
  (b, p) => psar(b, num(p, "step"), num(p, "max")),
);
def(
  "supertrend",
  "trend",
  "Supertrend ATR bands",
  [period("atrPeriod", 10, "ATR window"), real("multiplier", 3, "ATR multiple")],
  ["supertrend", "direction", "upper", "lower"],
  (b, p) => supertrend(b, num(p, "atrPeriod"), num(p, "multiplier")),
);
def(
  "ichimoku",
  "trend",
  "Ichimoku cloud with the forward spans realigned to the bar where they are known (no chikou)",
  [
    period("conversionPeriod", 9, "Tenkan window"),
    period("basePeriod", 26, "Kijun window"),
    period("spanPeriod", 52, "Senkou B window"),
    period("displacement", 26, "Cloud displacement"),
  ],
  ["tenkan", "kijun", "spanA", "spanB", "cloudTop", "cloudBottom", "leadA", "leadB"],
  (b, p) => ichimoku(b, num(p, "conversionPeriod"), num(p, "basePeriod"), num(p, "spanPeriod"), num(p, "displacement")),
);
def("vortex", "trend", "Vortex indicator +VI/−VI", [period("period", 14, "Window")], ["plusVI", "minusVI"], (b, p) => vortex(b, num(p, "period")));
def(
  "pmax",
  "trend",
  "Profit Maximizer (ATR stops around a moving average of hl2)",
  [
    period("maPeriod", 10, "Moving-average window"),
    period("atrPeriod", 10, "ATR window"),
    real("multiplier", 3, "ATR multiple"),
    { name: "maType", kind: "string", default: "ema", description: "Average type", choices: MA_TYPES },
  ],
  ["pmax", "ma", "direction", "longStop", "shortStop"],
  (b, p) => pmax(b, num(p, "maPeriod"), num(p, "atrPeriod"), num(p, "multiplier"), str(p, "maType") as MaType),
);
def(
  "ravi",
  "trend",
  "Chande's Range Action Verification Index (%)",
  [period("shortPeriod", 7, "Short SMA"), period("longPeriod", 65, "Long SMA"), SOURCE],
  V,
  (b, p) => ravi(src(b, p), num(p, "shortPeriod"), num(p, "longPeriod")),
);
def("linearRegressionSlope", "trend", "Least-squares slope per bar", [period("period", 14, "Window"), SOURCE], V, (b, p) =>
  linearRegressionSlope(src(b, p), num(p, "period")),
);

// ---- momentum ---------------------------------------------------------------------
def("rsi", "momentum", "Wilder's RSI", [period("period", 14, "Window"), SOURCE], V, (b, p) => rsi(src(b, p), num(p, "period")));
def(
  "macd",
  "momentum",
  "Appel's MACD",
  [period("fast", 12, "Fast EMA"), period("slow", 26, "Slow EMA"), period("signal", 9, "Signal EMA"), SOURCE],
  ["macd", "signal", "histogram"],
  (b, p) => macd(src(b, p), num(p, "fast"), num(p, "slow"), num(p, "signal")),
);
def("roc", "momentum", "Rate of change (%)", [period("period", 12, "Lookback"), SOURCE], V, (b, p) => roc(src(b, p), num(p, "period")));
def("momentum", "momentum", "Momentum (price difference)", [period("period", 10, "Lookback"), SOURCE], V, (b, p) => momentum(src(b, p), num(p, "period")));
def(
  "stochastic",
  "momentum",
  "Lane's stochastic (smooth 1 = fast, 3 = slow)",
  [period("period", 14, "%K window"), period("signalPeriod", 3, "%D window"), period("smooth", 1, "%K smoothing")],
  ["k", "d"],
  (b, p) => stochastic(b, num(p, "period"), num(p, "signalPeriod"), num(p, "smooth")),
);
def(
  "stochasticSlow",
  "momentum",
  "Lane's slow stochastic",
  [period("period", 14, "%K window"), period("signalPeriod", 3, "%D window"), period("smooth", 3, "%K smoothing")],
  ["k", "d"],
  (b, p) => stochastic(b, num(p, "period"), num(p, "signalPeriod"), num(p, "smooth")),
);
def("williamsR", "momentum", "Williams %R", [period("period", 14, "Window")], V, (b, p) => williamsR(b, num(p, "period")));
def(
  "cci",
  "momentum",
  "Lambert's Commodity Channel Index",
  [period("period", 20, "Window"), { ...real("constant", 0.015, "Lambert's constant"), min: 0.0001 }],
  V,
  (b, p) => cci(b, num(p, "period"), num(p, "constant")),
);
def(
  "stochRsi",
  "momentum",
  "Chande & Kroll StochRSI (0–100)",
  [
    period("rsiPeriod", 14, "RSI window"),
    period("stochasticPeriod", 14, "Stochastic window"),
    period("kPeriod", 3, "%K smoothing"),
    period("dPeriod", 3, "%D smoothing"),
    SOURCE,
  ],
  ["stochRsi", "k", "d"],
  (b, p) => stochRsi(src(b, p), num(p, "rsiPeriod"), num(p, "stochasticPeriod"), num(p, "kPeriod"), num(p, "dPeriod")),
);
def(
  "kdj",
  "momentum",
  "KDJ stochastic",
  [period("rsvPeriod", 9, "RSV window"), period("kPeriod", 3, "K smoothing"), period("dPeriod", 3, "D smoothing")],
  ["k", "d", "j"],
  (b, p) => kdj(b, num(p, "rsvPeriod"), num(p, "kPeriod"), num(p, "dPeriod")),
);
def(
  "ultimateOscillator",
  "momentum",
  "Williams' Ultimate Oscillator",
  [period("period1", 7, "Short window"), period("period2", 14, "Medium window"), period("period3", 28, "Long window")],
  V,
  (b, p) => ultimateOscillator(b, num(p, "period1"), num(p, "period2"), num(p, "period3")),
);
def("ao", "momentum", "Bill Williams' Awesome Oscillator", [period("fastPeriod", 5, "Fast SMA"), period("slowPeriod", 34, "Slow SMA")], V, (b, p) =>
  awesomeOscillator(b, num(p, "fastPeriod"), num(p, "slowPeriod")),
);
def("trix", "momentum", "Hutson's TRIX (%)", [period("period", 14, "EMA window"), SOURCE], V, (b, p) => trix(src(b, p), num(p, "period")));
def(
  "pmo",
  "momentum",
  "DecisionPoint Price Momentum Oscillator",
  [period("smooth1Period", 35, "First smoothing"), period("smooth2Period", 20, "Second smoothing"), period("signalPeriod", 10, "Signal EMA"), SOURCE],
  ["pmo", "signal"],
  (b, p) => pmo(src(b, p), num(p, "smooth1Period"), num(p, "smooth2Period"), num(p, "signalPeriod")),
);
def("kst", "momentum", "Pring's Know Sure Thing (daily)", [period("signalPeriod", 9, "Signal SMA"), SOURCE], ["kst", "signal"], (b, p) =>
  kst(src(b, p), num(p, "signalPeriod")),
);
def("pringSpecialK", "momentum", "Pring's Special K (daily)", [period("signalPeriod", 10, "Signal SMA"), SOURCE], ["specialK", "signal"], (b, p) =>
  pringSpecialK(src(b, p), num(p, "signalPeriod")),
);
def(
  "coppockCurve",
  "momentum",
  "Coppock curve",
  [period("rocPeriod1", 14, "Long ROC"), period("rocPeriod2", 11, "Short ROC"), period("wmaPeriod", 10, "WMA window"), SOURCE],
  V,
  (b, p) => coppockCurve(src(b, p), num(p, "rocPeriod1"), num(p, "rocPeriod2"), num(p, "wmaPeriod")),
);
def("dpo", "momentum", "Detrended Price Oscillator (not displaced)", [period("period", 20, "SMA window"), SOURCE], V, (b, p) =>
  dpo(src(b, p), num(p, "period")),
);
def("fisherTransform", "momentum", "Ehlers' Fisher transform", [period("period", 10, "Window")], ["fisher", "signal"], (b, p) =>
  fisherTransform(b, num(p, "period")),
);
def("rvi", "momentum", "Relative Vigor Index", [period("period", 10, "Window")], ["rvi", "signal"], (b, p) => rvi(b, num(p, "period")));
def("elderRay", "momentum", "Elder ray bull/bear power", [period("period", 13, "EMA window")], ["bullPower", "bearPower"], (b, p) =>
  elderRay(b, num(p, "period")),
);
def("shinohara", "momentum", "Shinohara intensity ratios (A and B)", [period("period", 26, "Window")], ["aRatio", "bRatio"], (b, p) =>
  shinohara(b, num(p, "period")),
);

// ---- volatility -------------------------------------------------------------------
def("atr", "volatility", "Wilder's Average True Range", [period("period", 14, "Window")], V, (b, p) => atr(b, num(p, "period")));
def("trueRange", "volatility", "True range", [], V, (b) => trueRange(b));
def(
  "atrRatio",
  "volatility",
  "ATR relative to its own SMA (volatility expansion > 1)",
  [period("atrPeriod", 14, "ATR window"), period("smaPeriod", 50, "SMA of ATR")],
  V,
  (b, p) => {
    const a = atr(b, num(p, "atrPeriod"));
    const m = chain(a, (xs) => sma(xs, num(p, "smaPeriod")));
    return a.map((x, i) => (x === undefined || m[i] === undefined || m[i] === 0 ? undefined : x / m[i]!));
  },
);
def("stdev", "volatility", "Rolling standard deviation", [period("period", 20, "Window"), SOURCE], V, (b, p) => rollingStdev(src(b, p), num(p, "period")));
def("choppinessIndex", "volatility", "Dreiss' Choppiness Index", [period("period", 14, "Window")], V, (b, p) => choppinessIndex(b, num(p, "period")));
def("massIndex", "volatility", "Dorsey's Mass Index", [period("emaPeriod", 9, "EMA window"), period("sumPeriod", 25, "Sum window")], V, (b, p) =>
  massIndex(b, num(p, "emaPeriod"), num(p, "sumPeriod")),
);
def(
  "atrTrailingStop",
  "volatility",
  "ATR trailing stop on closes",
  [period("period", 14, "ATR window"), real("multiplier", 3, "ATR multiple")],
  ["stop", "trend"],
  (b, p) => atrTrailingStop(b, num(p, "period"), num(p, "multiplier")),
);
def(
  "chandelierExit",
  "volatility",
  "LeBeau's Chandelier exit",
  [period("period", 22, "Window"), real("multiplier", 3, "ATR multiple")],
  ["exitLong", "exitShort"],
  (b, p) => chandelierExit(b, num(p, "period"), num(p, "multiplier")),
);
def(
  "williamsVixFix",
  "volatility",
  "Williams VIX Fix with band and percentile thresholds",
  [
    period("lookback", 22, "Highest-close window"),
    period("bbLength", 20, "Band window"),
    real("bbMultiplier", 2, "Band deviations"),
    period("percentileLookback", 50, "Range window"),
    real("highPercentile", 0.85, "Range-high factor"),
    real("lowPercentile", 1.01, "Range-low factor"),
  ],
  ["wvf", "upperBand", "rangeHigh", "rangeLow", "buyZone"],
  (b, p) =>
    williamsVixFix(
      b,
      num(p, "lookback"),
      num(p, "bbLength"),
      num(p, "bbMultiplier"),
      num(p, "percentileLookback"),
      num(p, "highPercentile"),
      num(p, "lowPercentile"),
    ),
);

// ---- bands --------------------------------------------------------------------------
def("bollinger", "bands", "Bollinger bands", [period("period", 20, "Window"), real("stdDev", 2, "Deviations"), SOURCE], BAND, (b, p) =>
  bollinger(src(b, p), num(p, "period"), num(p, "stdDev")),
);
def("bollingerPercentB", "bands", "Bollinger %B", [period("period", 20, "Window"), real("stdDev", 2, "Deviations"), SOURCE], V, (b, p) =>
  bollingerPercentB(src(b, p), num(p, "period"), num(p, "stdDev")),
);
def("bollingerBandwidth", "bands", "Bollinger bandwidth", [period("period", 20, "Window"), real("stdDev", 2, "Deviations"), SOURCE], V, (b, p) =>
  bollingerBandwidth(src(b, p), num(p, "period"), num(p, "stdDev")),
);
def(
  "keltner",
  "bands",
  "Keltner channels (EMA ± k·ATR)",
  [period("maPeriod", 20, "EMA window"), period("atrPeriod", 10, "ATR window"), real("multiplier", 1.5, "ATR multiple")],
  BAND,
  (b, p) => keltner(b, num(p, "maPeriod"), num(p, "atrPeriod"), num(p, "multiplier")),
);
def("donchian", "bands", "Donchian channel", [period("period", 20, "Window")], BAND, (b, p) => donchian(b, num(p, "period")));
def(
  "starcBands",
  "bands",
  "Stoller's STARC bands",
  [period("smaPeriod", 6, "SMA window"), period("atrPeriod", 15, "ATR window"), real("multiplier", 1.33, "ATR multiple")],
  BAND,
  (b, p) => starcBands(b, num(p, "smaPeriod"), num(p, "atrPeriod"), num(p, "multiplier")),
);
def(
  "movingAverageEnvelope",
  "bands",
  "Moving-average envelope",
  [
    period("period", 20, "Window"),
    real("percentage", 2.5, "Envelope %"),
    { name: "type", kind: "string", default: "sma", description: "Average type", choices: ["sma", "ema"] },
    SOURCE,
  ],
  BAND,
  (b, p) => movingAverageEnvelope(src(b, p), num(p, "period"), num(p, "percentage"), str(p, "type") as "sma" | "ema"),
);

// ---- volume -------------------------------------------------------------------------
def("obv", "volume", "Granville's On-Balance Volume", [], V, (b) => obv(b));
def("ad", "volume", "Chaikin's Accumulation/Distribution line", [], V, (b) => accumulationDistribution(b));
def("chaikinOscillator", "volume", "Chaikin oscillator", [period("fastPeriod", 3, "Fast EMA"), period("slowPeriod", 10, "Slow EMA")], V, (b, p) =>
  chaikinOscillator(b, num(p, "fastPeriod"), num(p, "slowPeriod")),
);
def("cmf", "volume", "Chaikin Money Flow", [period("period", 20, "Window")], V, (b, p) => cmf(b, num(p, "period")));
def("mfi", "volume", "Money Flow Index", [period("period", 14, "Window")], V, (b, p) => mfi(b, num(p, "period")));
def("forceIndex", "volume", "Elder's Force Index", [period("period", 13, "EMA window")], V, (b, p) => forceIndex(b, num(p, "period")));
def(
  "emv",
  "volume",
  "Arms' Ease of Movement",
  [period("period", 14, "SMA window"), { ...real("volumeScale", 100_000_000, "Volume divisor"), min: 1 }],
  V,
  (b, p) => emv(b, num(p, "period"), num(p, "volumeScale")),
);
def("twiggsMoneyFlow", "volume", "Twiggs Money Flow", [period("period", 21, "Wilder window")], V, (b, p) => twiggsMoneyFlow(b, num(p, "period")));
def("volumeOscillator", "volume", "Volume oscillator (%)", [period("fastPeriod", 14, "Fast EMA"), period("slowPeriod", 28, "Slow EMA")], V, (b, p) =>
  volumeOscillator(b, num(p, "fastPeriod"), num(p, "slowPeriod")),
);
def(
  "vwap",
  "volume",
  "VWAP anchored at each session, the first bar, or a date",
  [{ name: "anchor", kind: "string", default: "session", description: '"session", "start", or an anchor date (YYYY-MM-DD…)' }],
  V,
  (b, p) => vwap(b, str(p, "anchor")),
);
def("rollingVwap", "volume", "Rolling VWAP", [period("period", 20, "Window")], V, (b, p) => rollingVwap(b, num(p, "period")));
def("volumeSma", "volume", "SMA of volume", [period("period", 20, "Window")], V, (b, p) => sma(priceSource(b, "volume"), num(p, "period")));

// ---- statistics ---------------------------------------------------------------------
def("rollingMax", "stats", "Rolling maximum", [period("period", 20, "Window"), SOURCE], V, (b, p) => rollingMax(src(b, p), num(p, "period")));
def("rollingMin", "stats", "Rolling minimum", [period("period", 20, "Window"), SOURCE], V, (b, p) => rollingMin(src(b, p), num(p, "period")));
def("highestHigh", "stats", "Highest high", [period("period", 14, "Window")], V, (b, p) => highestHigh(b, num(p, "period")));
def("lowestLow", "stats", "Lowest low", [period("period", 14, "Window")], V, (b, p) => lowestLow(b, num(p, "period")));
def("zScore", "stats", "Z-score against the rolling mean/stdev", [period("period", 20, "Window"), SOURCE], V, (b, p) => zScore(src(b, p), num(p, "period")));
def("percentRank", "stats", "Percent of the previous n values ≤ the current one", [period("period", 252, "Window"), SOURCE], V, (b, p) =>
  percentRank(src(b, p), num(p, "period")),
);
def("relativeStrength", "stats", "Ratio line close / benchmark close", [BENCHMARK], V, (b, p) => relativeStrength(b, p.benchmark as readonly Bar[]));
def("mansfieldRs", "stats", "Mansfield relative strength (%)", [BENCHMARK, period("period", 252, "Ratio SMA window (52 on weekly bars)")], V, (b, p) =>
  mansfieldRs(b, p.benchmark as readonly Bar[], num(p, "period")),
);

// ---- candles ------------------------------------------------------------------------
def("heikinAshi", "candles", "Heikin-Ashi candles", [], ["open", "high", "low", "close"], (b) => heikinAshi(b));
const PATTERN_TEXT: Record<keyof typeof CANDLE_PATTERNS, string> = {
  doji: "Doji (+1 present)",
  spinningTop: "Spinning top (+1 present)",
  marubozu: "Marubozu (+1 white, −1 black)",
  hammer: "Hammer after a decline (+1)",
  hangingMan: "Hanging man after an advance (−1)",
  invertedHammer: "Inverted hammer after a decline (+1)",
  shootingStar: "Shooting star after an advance (−1)",
  engulfing: "Engulfing (+1 bullish, −1 bearish)",
  harami: "Harami (+1 bullish, −1 bearish)",
  piercingLine: "Piercing line (+1)",
  darkCloudCover: "Dark cloud cover (−1)",
  morningStar: "Morning star (+1)",
  eveningStar: "Evening star (−1)",
  threeSoldiersCrows: "Three white soldiers (+1) / black crows (−1)",
  tweezer: "Tweezer bottom (+1) / top (−1)",
};
const TREND_PATTERNS = new Set(["hammer", "hangingMan", "invertedHammer", "shootingStar", "tweezer"]);
for (const [name, fn] of Object.entries(CANDLE_PATTERNS) as Array<[keyof typeof CANDLE_PATTERNS, (b: readonly Bar[], lookback?: number) => number[]]>) {
  const withTrend = TREND_PATTERNS.has(name);
  const params = withTrend ? [period("trendLookback", 5, "Bars of the prior-trend test")] : [];
  def(name, "candles", PATTERN_TEXT[name], params, V, (b, p) => (withTrend ? fn(b, num(p, "trendLookback")) : fn(b)));
}

const BY_NAME = new Map(defs.map((d) => [d.name, d]));

/** Metadata for every registered indicator: name, group, params with defaults, outputs, description. */
export function listIndicators(): IndicatorInfo[] {
  return defs.map(({ name, group, description, params, outputs }) => ({
    name,
    group,
    description,
    params: params.map((p) => ({ ...p })),
    outputs: [...outputs],
  }));
}

function resolveParams(d: IndicatorDef, given: IndicatorParams): { resolved: Resolved; shown: Record<string, number | string> } {
  const known = new Set(d.params.map((p) => p.name));
  for (const k of Object.keys(given)) {
    if (!known.has(k)) throw new Error(`${d.name}: unknown parameter "${k}" (expected ${[...known].join(", ") || "none"})`);
  }
  const resolved: Resolved = {};
  const shown: Record<string, number | string> = {};
  for (const spec of d.params) {
    let v = given[spec.name] ?? spec.default;
    if (v === undefined) throw new Error(`${d.name}: parameter "${spec.name}" is required`);
    if (spec.kind === "bars") {
      if (!Array.isArray(v)) throw new Error(`${d.name}: parameter "${spec.name}" must be an array of bars`);
      resolved[spec.name] = v;
      shown[spec.name] = v.length;
      continue;
    }
    if (spec.kind === "number") {
      if (typeof v === "string" && v.trim() !== "") v = Number(v);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${d.name}: parameter "${spec.name}" must be a finite number`);
      if (spec.integer && !Number.isInteger(v)) throw new Error(`${d.name}: parameter "${spec.name}" must be an integer`);
      if (spec.min !== undefined && v < spec.min) throw new Error(`${d.name}: parameter "${spec.name}" must be ≥ ${spec.min}`);
    } else {
      if (typeof v !== "string") throw new Error(`${d.name}: parameter "${spec.name}" must be a string`);
      if (spec.choices && !spec.choices.includes(v)) throw new Error(`${d.name}: parameter "${spec.name}" must be one of ${spec.choices.join(", ")}`);
    }
    resolved[spec.name] = v;
    shown[spec.name] = v;
  }
  return { resolved, shown };
}

/** Run a registered indicator by name. Throws on an unknown name or an invalid parameter. */
export function computeIndicator(name: string, bars: readonly Bar[], params: IndicatorParams = {}): IndicatorResult {
  const d = BY_NAME.get(name);
  if (!d) throw new Error(`Unknown indicator "${name}". Known: ${[...BY_NAME.keys()].join(", ")}`);
  const { resolved, shown } = resolveParams(d, params);
  const raw = d.run(bars, resolved);
  const values = raw.map((x): IndicatorRow | undefined => {
    if (x === undefined) return undefined;
    if (typeof x === "number") return Number.isFinite(x) ? { value: x } : undefined;
    return { ...(x as IndicatorRow) };
  });
  return { name, params: shown, outputs: [...d.outputs], values };
}

/** One output field of a computed indicator as an aligned series (the first output by default). */
export function indicatorField(result: IndicatorResult, field: string = result.outputs[0] ?? "value"): Series {
  if (!result.outputs.includes(field)) throw new Error(`${result.name}: no output "${field}" (outputs: ${result.outputs.join(", ")})`);
  return result.values.map((row) => row?.[field]);
}
