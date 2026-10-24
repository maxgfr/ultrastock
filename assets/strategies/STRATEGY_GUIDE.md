# Writing a strategy — from an idea in words to a JSON file ultrastock can backtest

Ported from maxgfr/ai-strategy-backtester's `STRATEGY_PROMPT.md` (same JSON semantics), adapted to ultrastock:
risk rules now live **in the strategy file**, indicators come from ultrastock's registry (the source's 51 names
still work, and 50-odd more are available), and the backtester fills at the next open.

Workflow: `ultrastock strategy new <name> [--like <built-in>]` → edit `<home>/strategies/<name>.json` →
`ultrastock strategy validate <name>` → `ultrastock backtest run <name> <symbol>` → `ultrastock backtest review <name> <symbol>`.

---

## The format

```json
{
  "name": "kebab-case-name",
  "description": "One sentence: the edge and why it should persist",
  "leverage": 1,
  "baseInterval": "4h",
  "indicators": {
    "alias": { "_type": "registryOrSourceName", "param": 14 }
  },
  "buy":   { "mode": "all" | "any", "conditions": [["ref", "op", "ref"], ...] },
  "sell":  { "mode": "score", "threshold": 2, "required": [[...]], "scored": [[...], [...], [...]] },
  "short": { ... },
  "cover": { ... },
  "risk": {
    "stopLossPct": 8,
    "takeProfitPct": 25,
    "trailingStopPct": 15,
    "atrStop": { "period": 14, "multiplier": 3 },
    "timeStopBars": 40,
    "riskPerTradePct": 2,
    "maxDrawdownPct": 30
  },
  "execution": { "entry": "market" | "limit", "limitOffsetPct": 0.5 }
}
```

Every key but `name`, `description`, `indicators`, `buy` and `sell` is optional. Unknown keys are refused.

- **name**: kebab-case, starting with a letter.
- **leverage**: 1–125. Above 1 the strategy runs as a USDT-M perpetual on crypto (funding from Binance's history,
  liquidation at the maintenance margin). Listed securities always run as a cash account (1×).
- **baseInterval** (optional): the interval the periods were tuned for. When set and the run uses another interval,
  every integer period is rescaled by `sqrt(baseMinutes / runMinutes)` (minimum 2) — the source's auto-scaling, which
  tuned everything for 4h. Without it, a period is a number of bars of the interval you run on.
- **intervals** (optional, documentation): the intervals the author designed it for.
- **short / cover**: both or neither. On crypto a strategy with a short block runs as a perpetual (funding applies).
  On listed securities shorts are taken only because the strategy says so (no borrow fee is modelled).

### Position logic

When long, only `sell` is evaluated; when short, only `cover`; when flat, `buy` first, then `short`. A signal is
decided on a bar's **close** and filled at the **next bar's open**.

### Signal blocks

- `"all"`: every condition holds. `"any"`: at least one holds. Both use `conditions`.
- `"score"`: every `required` condition holds **and** at least `threshold` of the `scored` ones (an integer from 1 to
  the number of scored conditions). Score mode uses `scored`, never `conditions`.

### Value references

| Kind | Example | Meaning |
|---|---|---|
| Number | `30`, `0.5` | A constant |
| Candle field | `"close"`, `"open"`, `"high"`, `"low"`, `"volume"` | The bar's value |
| Indicator | `"rsi"`, `"supertrend"` | The indicator's default field at this bar |
| Indicator field | `"macd.histogram"`, `"adx.adx"` | A named output |
| Past bar | `"rsi[-1]"`, `"donchian.upper[-1]"`, `"close[-2]"` | N bars ago |

Offsets must be ≤ 0: `"rsi[1]"` reads the future and is refused. A reference to an indicator that is not yet defined
(warm-up) makes its condition false.

Operators: `>`, `<`, `>=`, `<=`, `==`, `!=` (`==` compares exactly — use it between two fields of one indicator, like
`["pmax.pmax", "==", "pmax.pmaxLong"]`).

### Aliases (`_type`)

```json
"indicators": {
  "breakout": { "_type": "donchian", "period": 200 },
  "exit":     { "_type": "donchian", "period": 10 }
}
```

An alias is letters only (`emaSlow`, not `ema50`) and cannot be a candle field name. Without `_type` the alias is the
indicator name.

### Risk rules (all percentages are percent numbers: 8 means 8 %)

| Key | Meaning |
|---|---|
| `stopLossPct` | Exit when price moves this far against the entry. A bar that gaps through it fills at the open. |
| `takeProfitPct` | A resting limit this far in favour; fills at the target, or at the open if the bar opens beyond it. |
| `trailingStopPct` | Exit on this retrace from the best price **of the previous bars** (peak for a long, trough for a short). |
| `atrStop` | A stop `multiplier × ATR(period)` from the entry, ATR read at the signal bar. |
| `timeStopBars` | Exit at the next open once the position has been held this many bars. |
| `riskPerTradePct` | Size so that the nearest stop loses this % of equity (`notional = equity × risk / stop distance`, capped by equity × leverage). Needs a stop. The rest stays in cash. |
| `maxDrawdownPct` | Circuit breaker: once equity is this far under its peak, no new position — for good. Open positions are not closed. |

When several stops apply, the tightest binds. A stop and the target both inside one bar: the stop is assumed hit first.

### Execution

`"entry": "market"` (default) fills at the next open plus slippage and pays the **taker** fee. `"limit"` rests one bar
at `limitOffsetPct` (default 0.5 %) below the signal close for a long (above for a short), fills when the next bar
trades through it (at the open if it opens beyond), pays the **maker** fee and no slippage, and is cancelled if
untouched. Signal and stop exits are market orders (taker); targets are limits (maker).

Default costs per side: crypto spot 0.1 % maker / 0.1 % taker; perpetuals 0.02 % / 0.05 %; listed securities 0.1 % /
0.1 %; slippage 0.05 % on market orders. Override with `--fee`, `--maker`, `--taker`, `--slippage`.

---

## Indicators

Any of the registry's indicators can be used by name (`ultrastock technicals --indicators` uses the same registry:
sma, wma, rma, dema, tema, kama, atr, stdev, zScore, percentRank, rollingMax/Min, highestHigh, lowestLow, keltner,
bollinger, williamsVixFix, kst, pringSpecialK, shinohara, heikinAshi, the candlestick patterns, …). The source's 51
names keep their meaning through this mapping:

| Source name | Registry | Parameters | Fields (default in **bold**) | Note |
|---|---|---|---|---|
| `rsi` | rsi | period=14 | **value** | |
| `ema` | ema | period=20 | **value** | |
| `movingAverage` | movingAverage | period=20, type=ema | **value** | |
| `supertrend` | supertrend | atrPeriod=10, multiplier=3 | **supertrend**, direction, upper, lower | |
| `bollingerBands` | bollinger + bollingerPercentB | period=20, stdDev=2 | upper, middle, lower, **bbr** | bbr = %B |
| `obv` | obv | — | **value** | |
| `vwap` | vwap | anchor=start | **value** | cumulative from the first bar, as the source |
| `cmf` | cmf | period=20 | **value** | |
| `williamsR` | williamsR | period=14 | **value** | |
| `cci` | cci | period=20 | **value** | |
| `roc` | roc | period=12 | **value** | |
| `ad` | ad | — | **value** | |
| `mfi` | mfi | period=14 | **value** | |
| `psar` | psar | step=0.02, max=0.2 | **sar**, trend | |
| `ao` | ao | fastPeriod=5, slowPeriod=34 | **value** | |
| `trix` | trix | period=14 | **value** | |
| `volumeOscillator` | volumeOscillator | fastPeriod=14, slowPeriod=28 | **value** | |
| `volumeSma` | volumeSma | period=20 | **value** | SMA of volume |
| `atrRatio` | atrRatio | atrPeriod=14, smaPeriod=50 | **value** | ATR / SMA(ATR) |
| `macd` | macd | fast=12, slow=26, signal=9 | **macd**, signal, histogram | |
| `pmax` | pmax | emaPeriod→maPeriod=10, atrPeriod=10, multiplier=3 | **pmax**, pmaxLong→longStop, pmaxShort→shortStop, ma, direction | |
| `adx` | adx | period=14 | **adx**, pdi→plusDI, mdi→minusDI, dx | |
| `donchian` | donchian | period=20 | upper, **middle**, lower | |
| `stochastic` | stochastic | period=14, signalPeriod=3 | **k**, d | |
| `aroon` | aroon | period=25 | up, down, **oscillator** | |
| `ichimoku` | ichimoku | conversionPeriod=9, basePeriod=26, spanPeriod=52 | conversion→tenkan (**default**), base→kijun, spanA, spanB, cloudTop, cloudBottom, leadA, leadB | see below |
| `vortex` | vortex | period=14 | **plusVI**, minusVI | |
| `chandelier` | chandelierExit | period=22, multiplier=3 | **exitLong**, exitShort | |
| `keltner` | keltner | maPeriod=20, atrPeriod=10, multiplier=1.5 | upper, **middle**, lower | |
| `starcBands` | starcBands | smaPeriod=6, atrPeriod=15, multiplier=1.33 | upper, **middle**, lower | |
| `movingAverageEnvelope` | movingAverageEnvelope | period=20, percentage=2.5 | upper, **middle**, lower | |
| `atrTrailingStop` | atrTrailingStop | period=14, multiplier=3 | **stop**, trend (+1 / −1) | |
| `pmo` | pmo | smooth1Period=35, smooth2Period=20, signalPeriod=10 | **pmo**, signal | |
| `kdj` | kdj | rsvPeriod=9, kPeriod=3, dPeriod=3 | **k**, d, j | |
| `stochRsi` | stochRsi | rsiPeriod=14, stochasticPeriod=14, kPeriod=3, dPeriod=3 | stochRsi, **k**, d | |
| `elderRay` | elderRay | period=13 | **bullPower**, bearPower | |
| `ravi` | ravi | shortPeriod=7, longPeriod=65 | **value** | |
| `hma` | hma | period=16 | **value** | |
| `choppinessIndex` | choppinessIndex | period=14 | **value** | |
| `ultimateOscillator` | ultimateOscillator | period1=7, period2=14, period3=28 | **value** | |
| `chaikinOscillator` | chaikinOscillator | fastPeriod=3, slowPeriod=10 | **value** | |
| `linearRegressionSlope` | linearRegressionSlope | period=14 | **value** | |
| `fisherTransform` | fisherTransform | period=10 | **fisher**, signal | |
| `coppockCurve` | coppockCurve | rocPeriod1=14, rocPeriod2=11, wmaPeriod=10 | **value** | |
| `forceIndex` | forceIndex | period=13 | **value** | |
| `dpo` | dpo | period=20 | **value** | |
| `vwma` | vwma | period=20 | **value** | |
| `rvi` | rvi | period=10 | **rvi**, signal | |
| `massIndex` | massIndex | emaPeriod=9, sumPeriod=25 | **value** | |
| `emv` | emv | period=14 | **value** | |
| `mcginleyDynamic` | mcginleyDynamic | period=14 | **value** | |

**Ichimoku:** `cloudTop`/`cloudBottom`/`spanA`/`spanB` are the standard cloud *at the current bar* (the spans computed
26 bars earlier); `leadA`/`leadB` are the spans computed now (plotted 26 bars ahead). The source compared price with
the current, undisplaced spans — use `leadA`/`leadB` to reproduce it. `chikou` is refused: it is today's close plotted
26 bars back, so reading it at its plotted bar needs future closes — compare `close` with `close[-26]` instead.

**Warm-up:** indicators are computed once on the whole series (each value uses bars up to its own only); the source
recomputed them on a sliding window, so recursive indicators (EMA seeds, cumulative VWAP/OBV/AD) differ during the
warm-up, never after.

---

## Anti-patterns (the source's lessons)

1. **Too many conditions** — 5+ `all` conditions on entry almost never fire. Keep 2–4.
2. **Overlapping entry/exit ranges** — buy at RSI < 50 and sell at RSI > 45 whipsaws: when long only `sell` is
   checked, and it fires at once.
3. **Exits too eager** — selling at RSI > 60 cuts winners; prefer 70–75.
4. **Score threshold too low** — 3 of 10 scored conditions is noise; use ≥ half (`validate` warns below half).
5. **Score threshold too high** — 4 of 5 rarely fires.
6. **No trend filter** — oversold entries without a trend gate (Supertrend, EMA, ADX) die in bear markets.
7. **No volume confirmation** — breakouts without `volumeSma` or `cmf` produce false breaks.
8. **Chandelier exit as the trailing stop** — it often cuts winners early; prefer `atrTrailingStop` or Supertrend.
9. **Same threshold both ways** — buy < 30 / sell > 30 churns; use asymmetric thresholds.

## Design principles (from the source's backtests of 20+ strategies on ETHUSDT 2022–2026)

These were measured by a backtester that filled at the signal bar's close and booked gapped stops at the stop price;
treat them as hypotheses to re-test here, not results.

1. Trend following dominated; the best performers were trend followers, not bottom pickers.
2. Simple beat complex: two entry conditions and one exit.
3. Slower intervals (6h, 12h) beat 4h.
4. Shorts mostly lost money.
5. `["adx.adx", ">", 20]` removed choppy-market signals.
6. Buying the dip inside an uptrend (Supertrend up + RSI under 50 + MACD positive) worked.
7. Exits mattered more than entries; patient exits (one Supertrend break, the cloud bottom) won.

## Typical thresholds

| Reference | Oversold / bearish | Overbought / bullish | Other |
|---|---|---|---|
| `rsi` | < 30 (aggressive < 35) | > 70 (aggressive > 75) | 40–60 neutral |
| `stochRsi.k` | < 20 | > 80 | |
| `williamsR` | < −80 | > −20 | |
| `mfi` | < 20 (accumulation < 40) | > 80 | |
| `adx.adx` | | | > 20 trending, > 25 strong, < 20 ranging |
| `cmf` | < −0.1 | > 0.05 | |
| `kdj.j` | < 0 (extreme < 20) | > 80 (extreme > 100) | |
| `roc` | < −2 | > 2 | ≈ 0 flat |
| `cci` | < −100 | > 100 | |
| `macd.histogram` | < 0 | > 0 | |
| `atrRatio` | < 0.5 (calm) | > 1.5 (volatile) | ≈ 1 normal |
| `ravi` | < 3 ranging | > 3 trending | |
| `elderRay.bullPower` | < 0 | > 0 | |
| `choppinessIndex` | < 38.2 trending | > 61.8 choppy | |
| `ultimateOscillator` | < 30 | > 70 | 50 neutral |
| `chaikinOscillator` | < 0 | > 0 | |
| `linearRegressionSlope` | < 0 | > 0 | magnitude = strength |
| `fisherTransform.fisher` | < −1 | > 1 | signal cross = entry |
| `rvi.rvi` | < 0 | > 0 | signal cross = entry |
| `coppockCurve` | < 0 | > 0 | zero cross from below = buy |
| `forceIndex` | < 0 | > 0 | |
| `dpo` | < 0 | > 0 | cycles around 0 |
| `massIndex` | | > 27 bulge | then < 26.5 = reversal |
| `emv` | < 0 | > 0 | |
| `bollingerBands.bbr` | < 0 (under the lower band) | > 1 (over the upper band) | 0.5 = middle |

## Ideas to try

Long only: Mass Index bulge (> 27 then < 26.5) + RSI oversold + trend filter; RVI signal cross + Supertrend gate;
EMV positive + ADX trending + volume; stochastic K/D cross in the lower Keltner zone; CMF accumulation + Aroon
confirmation; PMO zero cross + EMA filter.

Long/short (2×, crypto): Aroon up/down cross; Fisher transform extremes; TRIX zero cross with ADX.

## Before trusting a result

`ultrastock backtest review <strategy> <symbol>` runs the battery and answers PASS / REVISE / REJECT: at least 30
trades over ≥ 3 years (or a full cycle), walk-forward out-of-sample Sharpe ≥ 50 % of in-sample, deflated Sharpe ≥ 0.95
(deflated by the variants swept plus `--trials` you declare — count every idea you tried), probability of backtest
overfitting < 0.5, profitable at ×2 costs, no trade above 25 % of the net profit, no survivorship (a symbol picked from
today's index members — say so with `--universe`), and the look-ahead check re-run on this run's own data.
