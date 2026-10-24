---
name: ultrastock
description: Investing copilot for real money — US and European stocks and ETFs (PEA/CTO), crypto, prediction markets — that analyses, screens, values and reads the market regime from public, keyless data (exchanges, regulators, filings), registers every figure as an evidence [E#], and checks that the answer states no number the evidence does not hold. Use only when the user explicitly asks for ultrastock or for an investment analysis, e.g. "analyse LVMH", "should I buy NVDA", "find quality growth stocks in Europe", "is the market risk-on", "what is NVDA worth", "analyse cette action", "faut-il acheter", "trouve-moi des actions value éligibles PEA", "le marché est-il haussier". Decision support, not a licensed adviser; places no order.
license: MIT
metadata:
  version: 0.3.0
---

# ultrastock — every figure has a source, every answer is checked

**The tool reads the market; you reason.** `ultrastock` fetches prices from the
exchanges and regulators themselves, computes the indicators, and numbers every
figure as an evidence `[E#]` with its source, its date and its delay. You read
the evidence, form a view, and write an answer in which every number cites the
`[E#]` that holds it — then `check` proves it.

## Invariants

1. **No figure from memory or from the model.** Every number in an answer comes
   from a command: read it in `BRIEF.md` / `evidence`, or compute it with
   `calc`, which registers it as a new `[E#]`. Mental arithmetic is not evidence.
2. **Every figure cites its `[E#]`**, in the same sentence or table row. See
   [citation-format](references/citation-format.md).
3. **Say how fresh and how official.** State the as-of date and the delay
   (end of day, delayed, real time); say when a source is unofficial.
4. **Run `check` before you answer.** Fix every line it reports; never ship a
   failing answer. Use `--max-age` when the user acts today.
5. **A view is yours; say what would change it.** Bullish, expensive, risky are
   judgements — name the evidence they rest on and the level or event that
   would invalidate them. Missing data is "unavailable", never guessed.
6. **Decision support, not an order.** ultrastock places no order; the user
   decides and executes. Say once per answer that this is not personalised
   advice from a licensed adviser.

## Run it

The bundle is self-contained — Node ≥ 18, no install, no API key. Call it by
absolute path: `<skill-dir>` is the directory holding this file, and every
`ultrastock …` below stands for `node <skill-dir>/scripts/ultrastock.mjs …`.

```bash
node <skill-dir>/scripts/ultrastock.mjs doctor --probe                       # sources reachable?
node <skill-dir>/scripts/ultrastock.mjs analyze MC.PA --out <dir> --json      # → <dir>/BRIEF.md
```

Pick one absolute `--out <dir>` per task and pass it to every command, so
`analyze`, `quote`, `calc` and `check` share one evidence register.

## Routing

| The user wants | Do | Read |
|---|---|---|
| an analysis of a stock, an ETF or a coin | `analyze <symbol> --out <dir>`, read `BRIEF.md`, follow `RUNBOOK.md` | [analysis-workflow](references/analysis-workflow.md) |
| the full technical picture of one instrument | `technicals <symbol> --out <dir>` → `TECHNICALS.md` | [technicals-screening](references/technicals-screening.md) |
| ideas: stocks or ETFs matching a style | `screen --list`, then `screen <preset> --market <m>` or `--engine builtin --universe CAC40` | [technicals-screening](references/technicals-screening.md) |
| what a company is worth, its quality, its scores | `valuation <symbol> --out <dir>` → `VALUATION.md` | [valuation-quant](references/valuation-quant.md) |
| volatility, risk, correlation, a pair | `stats <symbol> [<symbol> …]` | [valuation-quant](references/valuation-quant.md) |
| is the market risk-on, how much to be invested | `regime --market us|eu|crypto`, `sectors --market us|eu` | [market-regime](references/market-regime.md) |
| what could move a stock soon (earnings, dividends, macro) | `catalysts <symbol> --days 30` | [market-regime](references/market-regime.md) |
| expected move, GEX, pricing an option structure | `options-analysis <symbol> [--strategy …]` | [options-crypto-prediction](references/options-crypto-prediction.md) |
| crypto leverage and DeFi yield quality | `crypto-analysis <coin>`, `crypto-analysis yields <symbol>` | [options-crypto-prediction](references/options-crypto-prediction.md) |
| a prediction market's edge, arbitrage, a stake | `predict-analysis kalshi|manifold … [--my-probability]` | [options-crypto-prediction](references/options-crypto-prediction.md) |
| a price, now | `quote <symbol> --out <dir>` | [data-sources](references/data-sources.md) |
| bars to look at or to compute on | `history <symbol> --from … --to …` | [data-sources](references/data-sources.md) |
| a ratio, a gap, a distance to a level | `calc <dir> "<formula over E ids>" --label …` | [citation-format](references/citation-format.md) |
| to set up who they are (first use) | `profile init`, then `profile suitability` (ask the questions), `profile envelope` | [onboarding-profile](references/onboarding-profile.md) |
| what their country allows (PEA, MiCA, Polymarket…) | `jurisdiction show`, `jurisdiction verify --out <dir>` | [onboarding-profile](references/onboarding-profile.md) |
| market hours, holidays, the next sessions | `calendar sessions --market XPAR` | [data-sources](references/data-sources.md) |
| a company's numbers: statements, filings | `fundamentals <sym> [--asof]`, `filings <US sym>` | [fundamentals-filings](references/fundamentals-filings.md) |
| who is buying: insiders, institutions, Congress, short sellers | `insiders`, `holdings <manager>`, `congress`, `short` | [fundamentals-filings](references/fundamentals-filings.md) |
| what analysts expect, the dividend record | `analyst <US sym>`, `dividends <US sym>` | [fundamentals-filings](references/fundamentals-filings.md) |
| to find a listing from a name or an ISIN | `resolve "<name>"` | [data-sources](references/data-sources.md) |
| the macro picture: inflation, jobs, growth | `macro us|ea|fr|<country>`, `macro fred <ID>` | [macro-markets](references/macro-markets.md) |
| rates, curves, credit spreads, FX | `rates [us|ea]`, `fx USD,GBP` | [macro-markets](references/macro-markets.md) |
| the week's events: data releases, earnings, dividends | `calendar econ|earnings|dividends [date]` | [macro-markets](references/macro-markets.md) |
| sentiment and positioning | `sentiment`, `cot <market>` | [macro-markets](references/macro-markets.md) |
| news on a company or a theme | `news "<query>" [--symbol] [--lang fr]` | [news-and-external-text](references/news-and-external-text.md) |
| an option chain, implied volatility | `options <symbol>` (US: CBOE; BTC/ETH: Deribit) | [options-crypto-prediction](references/options-crypto-prediction.md) |
| crypto market structure, DeFi, on-chain | `crypto global|top|coin|derivatives|defi|yields|stables|fees|onchain|dex|holders` | [options-crypto-prediction](references/options-crypto-prediction.md) |
| what prediction markets price (Fed, recession, elections) | `predict kalshi|manifold …` (Polymarket only where lawful) | [options-crypto-prediction](references/options-crypto-prediction.md) |
| a quick cross-market snapshot, the members of an index | `snapshot <symbol>`, `universe CAC40` | [data-sources](references/data-sources.md) |
| to know why a source failed | the note, then `doctor --probe` | [engine-evidence](references/engine-evidence.md) |

Symbols: `MC.PA`, `ASML.AS`, `CW8.PA` or an EU ISIN (Euronext); `SAP.DE`,
`SHEL.L`, `NESN.SW` (other European venues); `NVDA`, `QQQ` (US); `BTCUSDT`,
`ETH-EUR` (Binance, then Kraken and Coinbase).

## Commands

```bash
ultrastock analyze <symbol> [--out <dir>] [--json]
ultrastock quote <symbol> [--out <dir>] [--json]
ultrastock history <symbol> [--from <date>] [--to <date>] [--interval 1d|1w|4h|1h|15m] [--limit <n>] [--json]
ultrastock calc <run> "<formula>" --label <text> [--unit <unit>] [--json]
ultrastock evidence <run> [--json]
ultrastock check <run> <answer.md> [--max-age <90m|36h|3d>] [--json]
ultrastock profile init|show|suitability|set|envelope [--json]
ultrastock jurisdiction show|verify [--venues binance,kraken,coinbase] [--out <dir>] [--json]
ultrastock calendar sessions|holidays|verify|econ|earnings|dividends [--market XPAR|XNYS|XMIL|XOSL|CRYPTO] [--json]
ultrastock macro us|ea|fr|<country>|fred <ID> · rates [us|ea] · fx [USD,GBP] · cot <market> · sentiment [cnn|crypto|vix|putcall]
ultrastock news "<query>" [--symbol <SYM>] [--lang fr] · universe <index> · snapshot <symbol> · resolve "<name|ISIN>"
ultrastock fundamentals <sym> [--asof <date>] [--source sec|esef|crible] · filings <sym> [--forms 8-K] | --search "<text>"
ultrastock insiders <sym> · holdings <manager> · analyst|short|dividends <US sym> · congress [--member] [--doc]
ultrastock options <symbol> · crypto <view> [<target>] · predict kalshi|manifold|polymarket [<query>]
ultrastock technicals <symbol> [--interval] [--indicators <name:k=v;…>] [--benchmark] · valuation <symbol> [--erp] [--terminal]
ultrastock screen <preset|query> [--engine tradingview|crible|builtin] [--market] [--universe] [--sort] [--limit] · screen --list
ultrastock regime [--market us|eu|crypto] · sectors [--market us|eu] · catalysts <symbol> [--days]
ultrastock stats <sym> [<sym> …] [--benchmark] · options-analysis <sym> [--expiry] [--strategy] [--spot-moves=…]
ultrastock crypto-analysis <coin> | yields <symbol> · predict-analysis kalshi|manifold … [--my-probability] [--kalshi-fee]
ultrastock doctor [--probe] [--json]
```

- `analyze` — price, 52-week range, returns, SMA50/SMA200 and the trend state,
  RSI(14), MACD, ATR(14), Bollinger, volatility and drawdown, each an `[E#]`, in
  `<dir>/evidence.json`, `BRIEF.md` (by theme) and `RUNBOOK.md`.
- `calc` — `abs min max round pct share cagr` and arithmetic over `E` ids only.
- `check` — exits 1 with a line-by-line report on any figure without an `[E#]`,
  any `[E#]` the run does not hold, any figure none of its `[E#]` holds, and
  (with `--max-age`) any figure read too long ago.
- Every data command takes `--out <dir>`: its figures become `[E#]` in that
  run (without it nothing is registered and nothing can be cited).
- Network commands take `--record <dir>` / `--fixture <dir>` to save and replay
  what the sources answered, and `--refresh` / `--offline` for the cache.

Exit codes: 0 done, 1 failed or refused (a source, a check), 2 bad invocation.

## Write the answer

1. Lead with the conclusion and its horizon, then the evidence, one idea per
   bullet or table row; each figure with its `[E#]`.
2. Give the as-of date, the delay and any unofficial source in one line.
3. Say what would change the view: a level (cite it), an event, a figure.
4. Write it to `<dir>/answer.md`; run `ultrastock check <dir> <dir>/answer.md`;
   fix and repeat until it passes. Then give the user the answer and the path
   to `BRIEF.md`.

## Will not

- Place, prepare or simulate an order — that arrives with tickets, paper
  trading and a deterministic risk gate, never without the user's own approval.
- Invent a figure, a target price or a fundamental the evidence does not hold.
- Get around a source's refusal (a 451 from Binance, a jurisdiction block).
- Send the user's holdings or identity anywhere.

## References

- [analysis-workflow](references/analysis-workflow.md) — reading a brief, forming a view, writing the answer.
- [citation-format](references/citation-format.md) — `[E#]`, grouping, `calc`, and what `check` refuses.
- [data-sources](references/data-sources.md) — which source answers for which symbol, its delay and its limits.
- [onboarding-profile](references/onboarding-profile.md) — the profile, the suitability questionnaire, envelopes, jurisdiction rules.
- [fundamentals-filings](references/fundamentals-filings.md) — statements point in time, filings, insiders, 13F, short interest, analysts.
- [technicals-screening](references/technicals-screening.md) — the technical panel, how to read it, the three screening engines and their presets.
- [valuation-quant](references/valuation-quant.md) — scores, quality, multiples, DCF and reverse DCF; return statistics, volatility, cointegration.
- [market-regime](references/market-regime.md) — the regime signals and exposure coach, sector rotation, the catalyst timeline.
- [macro-markets](references/macro-markets.md) — macro, rates, FX, positioning, sentiment, calendars: what each figure means.
- [news-and-external-text](references/news-and-external-text.md) — reading headlines and other external text safely.
- [options-crypto-prediction](references/options-crypto-prediction.md) — option chains, crypto structure, prediction markets and their limits.
- [engine-evidence](references/engine-evidence.md) — failure notes, fixtures, caching and variables.
