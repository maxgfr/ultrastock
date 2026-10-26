---
name: ultrastock
description: Investing copilot for real money — US and European stocks and ETFs (PEA/CTO), crypto, prediction markets — that analyses, screens, values and reads the market regime from public, keyless data (exchanges, regulators, filings), registers every figure as an evidence [E#], and checks that the answer states no number the evidence does not hold. Use only when the user explicitly asks for ultrastock or for an investment analysis, e.g. "analyse LVMH", "should I buy NVDA", "find quality growth stocks in Europe", "is the market risk-on", "what is NVDA worth", "analyse cette action", "faut-il acheter", "trouve-moi des actions value éligibles PEA", "cherche des values", "compare ces ETF", "analyse le dernier rapport d'Anthropic", "le marché est-il haussier". Decision support, not a licensed adviser; places no order.
license: MIT
metadata:
  version: 1.3.0
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
5. **Tax figures need this year's rules.** Run `tax verify` and check the
   parameters the answer uses by web search before stating a tax amount.
6. **A view is yours; say what would change it.** Bullish, expensive, risky are
   judgements — name the evidence they rest on and the level or event that
   would invalidate them. Missing data is "unavailable", never guessed.
7. **Decision support, not an order.** ultrastock places no real order; the
   user decides and executes. Say once per answer that this is not personalised
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
| an analysis of a stock, an ETF or a coin ("should I buy…") | `analyze <symbol> --out <dir>` (`--depth quick|standard|deep`), read `BRIEF.md`, run the debate in `RUNBOOK.md`, `decide`, `check`, `report` | [analysis-workflow](references/analysis-workflow.md) |
| a complete analysis ("analyse complète", everything on it) | `analyze <symbol> --depth full --out <dir>`, then step 0 of `RUNBOOK.md`: your web search on `RESEARCH.todo.json`, `research --out <dir> --web-results <file>`, then the debate | [analysis-workflow](references/analysis-workflow.md), [research](references/research.md) |
| undervalued stocks ("cherche des values", deep value, dividend, GARP, magic formula) | `value [--style …] [--region world|europe|pea|us|FR,DE] --out <dir>` → `VALUE.md`, then its runbook (`research --ask` on the first names) | [value-search](references/value-search.md) |
| an ETF: what it holds, costs, whether it is PEA-eligible; which of several to pick | `analyze <ETF> --out <dir>` → `ETF.md`; `etf compare A,B,C`, `etf overlap A,B`, `etf find "MSCI World" --pea` | [etf](references/etf.md) |
| ETFs to buy for a goal ("propose-moi des ETF pour mon PEA", "quels ETF pour débuter"), or the catalogue ("des ETF obligataires en EUR") | `etf propose [--goal core|growth|income|defensive] [--envelope pea|cto|av] [--risk 1-7] [--amount <EUR>] --out <dir>` → `PROPOSAL.md` + `TARGETS.json`, then its runbook; `etf find --asset bond --currency EUR` | [etf](references/etf.md) |
| what changed since the last analysis | `analyze <symbol> --since <old run> --out <dir>` → `DELTA.md` | [analysis-workflow](references/analysis-workflow.md) |
| to record or import what they hold | `portfolio add|deposit|withdraw`, `portfolio import <file> --format … --account … --dry-run` | [portfolio-risk](references/portfolio-risk.md) |
| their portfolio: value, performance, risk, stress, income | `portfolio show|perf|risk|stress|income|lookthrough --out <dir>` | [portfolio-risk](references/portfolio-risk.md) |
| how to allocate or rebalance, which envelope, a savings goal | `portfolio optimize|rebalance --targets …|location|goals --target … --years …` | [portfolio-risk](references/portfolio-risk.md) |
| to turn a view into an order, sized within their limits | `plan <symbol> --account <id> [--entry] [--stop] [--target]`, then `ticket` | [trading-paper](references/trading-paper.md) |
| to record the call an analysis ended on | `decide <run> <run>/decision.json` | [journal-alerts](references/journal-alerts.md) |
| how good past calls were, what the trades teach | `journal settle`, `journal hits`, `journal review`, `journal digest`, `journal lesson "…"` | [journal-alerts](references/journal-alerts.md) |
| to track an idea until it is acted on or dropped | `journal thesis add|move|list|show` | [journal-alerts](references/journal-alerts.md) |
| to be told when a level breaks, a stop is hit or an 8-K lands | `watch add <SYM> "<condition>"`, `watch add stops|8k <SYM>`, `watch run --notify` | [journal-alerts](references/journal-alerts.md) |
| to send a real (or testnet) order | `broker status`, `broker preview <ticket>`, `broker code <ticket>` — the USER submits with the code | [live-execution](references/live-execution.md) |
| to stop everything now | `broker panic` (kill switch + cancel ultrastock's working orders) | [live-execution](references/live-execution.md) |
| to practise a prediction-market view | `predict order kalshi <TICKER> yes|no --contracts N --price P`, then `paper submit` | [options-crypto-prediction](references/options-crypto-prediction.md) |
| would a rule have worked, is it overfit | `strategy list`, `backtest review <strategy> <symbol>` (then `walkforward`, `sweep`, `montecarlo`) | [backtesting](references/backtesting.md) |
| a portfolio rule over history (60/40, dual momentum…) | `backtest run 60-40 CW8.PA,IEAC.AS --rebalance quarterly` | [backtesting](references/backtesting.md) |
| to write or check their own strategy | `strategy new <name> --like sma-cross`, `strategy validate <file>` | [backtesting](references/backtesting.md) |
| what they owe on last year's gains, dividends, crypto; which boxes to fill | `tax verify` (then web-search the parameters), `tax report --year <y> [--tmi 30]`, `tax lots`, `tax export --format 2074|2086|8949|koinly` | [tax](references/tax.md) |
| which losses to harvest before year end | `tax harvest` | [tax](references/tax.md) |
| the tax rules of their envelopes (PEA, AV, CTO, crypto, IRA) | `tax rules [--regime fr|us]` | [tax](references/tax.md) |
| to keep a document (an article, a report) for the analysis | `knowledge import <file> --title …` | [journal-alerts](references/journal-alerts.md) |
| to practise without money, and know when they are ready | `paper submit <ticket>|sweep|book|readiness` | [trading-paper](references/trading-paper.md) |
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
| web sources compiled and checked: business model, controversies, short-sellers, the latest report ("analyse le dernier rapport de X"), one precise question | `research <subject> [--focus results] [--ask "…"] --out <run>`, your web search, then `research --out <run> --web-results <file>` — no search of your own: `--search-with claude|codex` | [research](references/research.md) |
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
ultrastock analyze <symbol> [--depth quick|standard|deep|full] [--since <run>] [--out <dir>] [--json]
ultrastock quote <symbol> [--out <dir>] [--json]
ultrastock history <symbol> [--from <date>] [--to <date>] [--interval 1d|1w|4h|1h|15m] [--limit <n>] [--json]
ultrastock calc <run> "<formula>" --label <text> [--unit <unit>] [--json]
ultrastock calc <run> --from <E#> "<figure as the document writes it>" --label <text> [--json]
ultrastock research <subject> [--kind equity|etf|crypto|company] [--focus results] [--ask "<question>"] [--search-with claude|codex] --out <run>
ultrastock research --out <run> --web-results <file|-> | --urls <a,b> | --search-with claude|codex | --engine-search [--browser] [--no-wayback]
ultrastock searxng|firecrawl|stack up|down|status   (optional local search stack, Docker)
ultrastock evidence <run> [--json]
ultrastock check <run> <answer.md> [--max-age <90m|36h|3d>] [--json]
ultrastock report <run> [--answer <answer.md>] [--json]
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
ultrastock etf compare <A,B,C> · etf overlap <A,B> · etf find "<index|theme>" [--pea] [--acc|--dist] [--ucits] [--currency EUR]
ultrastock etf find [--asset equity|bond|commodity|money-market|multi-asset|real-estate] [--focus] [--exposure] [--sort aum|ter|perf] [--leveraged]
ultrastock etf propose [--goal core|growth|income|defensive] [--envelope pea|cto|av] [--risk 1-7] [--amount] [--max-funds 4] [--acc|--dist] [--hedged]
ultrastock value [--style quality-value|deep-value|dividend|garp|magic-formula|all] [--region world|europe|pea|us|<ISO,…>] [--top] [--watch]
ultrastock regime [--market us|eu|crypto] · sectors [--market us|eu] · catalysts <symbol> [--days]
ultrastock stats <sym> [<sym> …] [--benchmark] · options-analysis <sym> [--expiry] [--strategy] [--spot-moves=…]
ultrastock crypto-analysis <coin> | yields <symbol> · predict-analysis kalshi|manifold … [--my-probability] [--kalshi-fee]
ultrastock portfolio show|perf|risk|stress|optimize|rebalance|location|lookthrough|income|goals [--book real|paper] [--out <dir>]
ultrastock portfolio import <file> --format ibkr-flex|binance|kraken|coinbase|generic --account <id> [--map] [--dry-run]
ultrastock portfolio deposit|withdraw <account> <amount> · portfolio add buy|sell|dividend|… --account <id> […]
ultrastock plan <symbol> --account <id> [--entry] [--stop] [--target a,b] [--ticket] · ticket list|show|check|cancel [<id>]
ultrastock paper book|submit <ticket-id>|sweep|readiness
ultrastock decide <run> <decision.json> · journal settle|hits|review|digest [--book] · journal lesson "<text>" | lessons
ultrastock journal thesis list|add|show|move [<id>] [<state>] [--symbol] [--thesis] [--invalidation] [--review-by]
ultrastock watch list|add <SYM> "<condition>"|add 8k <SYM>|add stops|rm <id>|run [--notify] · knowledge import <file>
ultrastock broker status|setup <venue>|balances|open|limits [set]|panic · broker preview|code|submit|reconcile|cancel <ticket> [--venue] [--env test|live] [--code]
ultrastock predict order kalshi <TICKER> yes|no [buy|sell] --contracts <n> --price <0-1>
ultrastock backtest run|walkforward|sweep|montecarlo|compare|review <strategy> <symbol> [--years] [--grid] … · backtest decisions
ultrastock strategy list|show|validate|new [<name>] [--like <strategy>]
ultrastock tax report|lots|harvest|rules|verify|export [--regime fr|us] [--year] [--tmi] [--income] [--filing] [--carryforward] [--envelope-value] [--format]
ultrastock mcp [--transport stdio|http --token <t>]   # the same commands as MCP tools (read-only + ticket creation)
ultrastock doctor [--probe] [--json]                  # sources, keys, and each command's maturity (stable / beta / experimental)
```

- `analyze` — `quick`: price, range, returns, averages and trend state, RSI,
  MACD, ATR, Bollinger, volatility, drawdown. `standard` (default) adds the
  technical panel, valuation (companies), catalysts, the market regime, news,
  insiders, analysts (US), the portfolio context (holding / flat / not
  provided), the profile's limits and the jurisdiction's rules; `deep` debates
  three rounds. `BRIEF.md` indexes the slices; `RUNBOOK.md` is the debate —
  analysts → bull / bear → judge → trader → risk trio → portfolio manager.
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
   fix and repeat until it passes.
5. `ultrastock report <dir>` writes `<dir>/report.html`: the answer, the
   recorded decision, the debate's notes, a price chart and every cited `[E#]`
   linked to its source. It refuses an answer that fails `check`. Give the
   user the answer and the report's path.

## Will not

- Approve a real order. A live order needs a 6-digit code that only the user
  can read (never in your output), on top of the risk gate, the limits and the
  jurisdiction; you never type a code you did not receive from the user, never
  retry a submission, never argue past a refusal.
- Ask for an API key or a secret in the conversation: the user stores keys in
  their keychain (`broker setup`).
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
- [portfolio-risk](references/portfolio-risk.md) — the ledger, statement imports, risk, stress, optimisation, rebalancing, location, income, goals.
- [trading-paper](references/trading-paper.md) — plan, the risk gate's codes, tickets, paper trading and readiness.
- [journal-alerts](references/journal-alerts.md) — decisions settled against the market, hit rates, theses, trade reviews, lessons, alerts.
- [backtesting](references/backtesting.md) — the strategy format, honest fills, walk-forward, sweeps with deflated Sharpe and PBO, Monte Carlo, the review verdict.
- [tax](references/tax.md) — verify the year's rules first; France (PMP, PFU vs scale, PEA, AV, crypto 150 VH bis, 2778-DIV, 3916) and the US (lots, wash sales, brackets, NIIT).
- [live-execution](references/live-execution.md) — environments, key setup, the harness approval rule, the order chain, every refusal code.
- [macro-markets](references/macro-markets.md) — macro, rates, FX, positioning, sentiment, calendars: what each figure means.
- [news-and-external-text](references/news-and-external-text.md) — reading headlines and other external text safely.
- [research](references/research.md) — web sources compiled into document evidence: the worklist, your search, ingestion, `check` against the page.
- [value-search](references/value-search.md) — the `value` styles, the anti value-trap gates, the sector percentiles, reading VALUE.md.
- [etf](references/etf.md) — an ETF as a fund: costs, replication, PEA, domicile and PRIIPs, tracking, overlap, comparing funds on one index; browsing the catalogue; `etf propose` and its allocation convention.
- [options-crypto-prediction](references/options-crypto-prediction.md) — option chains, crypto structure, prediction markets and their limits.
- [engine-evidence](references/engine-evidence.md) — failure notes, fixtures, caching and variables.
