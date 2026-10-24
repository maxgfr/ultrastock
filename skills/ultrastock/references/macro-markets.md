# Macro, rates, sentiment and calendars

All commands take `--out <dir>`; every figure becomes an `[E#]`.

## Macro

| Command | Reads | Note |
|---|---|---|
| `macro us` | BLS (CPI, core CPI, unemployment, payrolls), FRED (claims, fed funds) | BLS is often down; FRED stands in (index levels — compute y/y with `calc`) |
| `macro ea` | ECB HICP and core, Eurostat unemployment and GDP (euro area) | official |
| `macro fr` | INSEE CPI and unemployment, Eurostat GDP and HICP (France) | official |
| `macro <ISO>` | World Bank growth, inflation, debt | annual, lagged |
| `macro fred <ID>` | any FRED series (`T10Y2Y`, `BAMLH0A0HYM2`, `M2SL`, `WALCL`…) | `--days` for history |

## Rates, credit, FX

`rates` reads the US Treasury par curve (1M–30Y, with the 2s10s and 3m10y
spreads), the ECB's policy rates, €STR and the euro AAA curve, and the US
high-yield and investment-grade option-adjusted spreads. An inverted curve
(2s10s < 0) has preceded most US recessions, with long and variable lags; a
widening high-yield spread is stress spreading. `fx` gives the ECB's reference
rates (euro per currency), the rates to use for a portfolio in EUR.

## Positioning and sentiment

- `cot <market>`: CFTC Commitments of Traders — speculators' (or, with
  `--report tff`, leveraged funds' and asset managers') net position, its
  weekly change, and a COT index 0–100 over 26 and 156 weeks. Above 90 is a
  crowded long, below 10 a crowded short: contrarian at the extremes only.
  Tuesday positions, published Friday.
- `sentiment`: CNN Fear & Greed (0–100 with its seven parts), the crypto Fear &
  Greed index, the VIX term structure (VIX9D/VIX/VIX3M/VIX6M; VIX above VIX3M
  is an inverted, stressed curve) and Cboe put/call ratios. Sentiment is a
  contrarian input at extremes and noise in between — never a signal alone.

## Calendars

`calendar econ [date]` (Nasdaq and ForexFactory: country, impact, forecast,
previous, actual), `calendar earnings [date]`, `calendar dividends [date]`.
Event names are external text. Check the calendar before any trade: an earnings
release or a central-bank decision inside the holding period changes the risk.
