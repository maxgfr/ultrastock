# Technicals and screening

## `technicals <symbol>`

One run gives the whole technical picture, each reading an `[E#]`, and writes
`TECHNICALS.md` in the run:

- **Trend**: SMA 20/50/200, EMA 21, ADX(14) with +DI/−DI, Supertrend,
  Parabolic SAR, the Ichimoku cloud, Aroon.
- **Momentum**: RSI(14), MACD, stochastic, Williams %R, CCI, ROC.
- **Volatility**: ATR(14), Bollinger %B and bandwidth, Keltner, Donchian,
  the chandelier exit.
- **Volume**: MFI and Chaikin money flow.
- **Relative strength** against a benchmark (`--benchmark`): the 6-month
  relative return and Mansfield RS. The default is SPY for US listings, the
  CAC 40 for Paris and CW8 (MSCI World) elsewhere in Europe; coins have no
  default.
- **Structure**: the 52-week range, Minervini's trend template (eight
  conditions, each one an `[E#]`), the VCP (contractions and the pivot),
  support and resistance from pivots, recent gaps, candlesticks.
- **Bullish score**: points with a reason each. Quote the reasons, never the
  score alone.

`--indicators "rsi:period=7,keltner:period=20;mult=1.5"` adds any of the 107
registry indicators by name. `--interval 1w` reads weekly bars, and `4h`/`1h`
work for crypto. No indicator looks at a bar after the one it is computed on
(tested).

How to read it:
- A trend call needs **two** confirmations: a moving-average order and ADX
  above 20–25, or a Supertrend flip with volume.
- RSI above 70 in a strong trend is strength, not a sell signal. Overbought
  calls only work in a range (ADX below 20).
- A support or resistance level is a zone, about ±1 ATR wide. Cite the level
  and the ATR.
- Candlesticks alone are noise. Use one only at a level, with volume.
- Always say what invalidates the read: a close below the stop level, or the
  loss of the 50-day average. Cite the level.

## `screen <preset|query>`

Three engines:

| Engine | Universe | Presets |
|---|---|---|
| `tradingview` (default) | a whole `--market` (america, france, germany, uk, italy, spain, netherlands…; `europe` merges 14 markets; `crypto`) | value, quality-growth, momentum, breakout-52w, dividend-growth, oversold-quality, small-cap-value, magic-formula, garp, etf, pea-candidates |
| `builtin` | daily bars of `--universe SPX\|NDX\|CAC40\|SBF120\|DAX\|SX5E\|AEX\|UKX` or a list (≤ 120 symbols) | minervini, vcp, canslim-technical, momentum-burst, exhaustion-hammer, pullback-to-50, golden-cross, rs-leaders |
| `crible` | crible's global fundamentals dataset | crible presets, or any DSL: `"piotroski_f >= 7 AND country IN ('FR','DE')"` |

- `screen --list [--engine …]` prints every preset with its rules and source.
  Read the rules before you present the results.
- `--sort -market_cap` sorts, `--limit` caps.
- `--bootstrap` (crible) downloads its dataset once, which takes about a minute.
- crible holds one row per listing. A crible screen keeps **primary listings**
  and drops the ADR / OTC line of an issuer whose home listing is in the
  results, so a count is a count of issuers. Share classes (A/B, preferred)
  stay. `--all-listings` keeps every line (German regional exchanges, the LSE
  order book, OTC).
- TradingView is unofficial and its fundamentals lag. A screen finds
  **candidates**: run `analyze`, `technicals` and `valuation` on each one
  before you call any of them a buy.
- Index universes are today's members. Name the survivorship bias whenever you
  test anything historical on them.
- `pea-candidates` filters on European listings. PEA eligibility depends on the
  issuer's seat, and on the fund for ETFs, so check it per security. The
  [onboarding-profile](onboarding-profile.md) page explains the envelope rules.
