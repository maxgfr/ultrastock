# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

# [0.7.0](https://github.com/maxgfr/ultrastock/compare/v0.6.0...v0.7.0) (2026-10-24)


### Features

* **backtest:** declarative strategies ported from ai-strategy-backtester with next-open fills, gapped stops and taker/maker fees; walk-forward, CPCV, PBO, Monte Carlo, sweeps, cost stress and a PASS/REVISE/REJECT review; allocation backtests; decision-quality replay; backtest and strategy commands ([29ce69c](https://github.com/maxgfr/ultrastock/commit/29ce69c88b9cbdb60d047a90af437291990de18b))
* **backtest:** wire backtest and strategy into the CLI; skill routing and the backtesting reference ([cc08ba1](https://github.com/maxgfr/ultrastock/commit/cc08ba1da17d0e89e6088e1e3599a9d6ded949c2))

# [0.6.0](https://github.com/maxgfr/ultrastock/compare/v0.5.0...v0.6.0) (2026-10-24)


### Features

* **journal:** decisions settled at +5/+20/+60 sessions with alpha and hit rates, theses with a life cycle and review dates, post-trade reviews in R (plan first, then outcome), digest, lessons and source imports; edge-triggered alerts (expressions, 8-Ks, stops) with safe notification channels; decide, journal, knowledge and watch commands ([5e4ef82](https://github.com/maxgfr/ultrastock/commit/5e4ef82caddbbabc908216340683318f336869e2)), closes [#6](https://github.com/maxgfr/ultrastock/issues/6)
* **journal:** lessons and open theses in the analysis brief; skill docs for decide, journal, theses, knowledge and alerts ([dce9e87](https://github.com/maxgfr/ultrastock/commit/dce9e87230a0c44d4498cae50e67f156edce6efd))

# [0.5.0](https://github.com/maxgfr/ultrastock/compare/v0.4.0...v0.5.0) (2026-10-24)


### Features

* **analyze:** multi-perspective analyze — slices, portfolio context, profile and jurisdiction, past decisions, delta and the debate runbook; ESEF issuer-extension capex and weighted share counts; skill docs for portfolio, plan, tickets and paper ([322f29c](https://github.com/maxgfr/ultrastock/commit/322f29c29dd6bc2c257212d3ddcb1af6afd39e58))
* **portfolio:** import broker statements into the ledger — IBKR Flex (XML, CSV, header/trailer, Activity Statement), Binance, Kraken, Coinbase and a column-mapped generic CSV with FR/EN formats; dry run, dedupe by content id, replay check ([2b9ba79](https://github.com/maxgfr/ultrastock/commit/2b9ba79932a188fedaef1fa02e652df9295e8040))
* **portfolio:** risk, stress, optimize, rebalance, location, look-through, income and goals analytics on the ledger's books ([0697809](https://github.com/maxgfr/ultrastock/commit/0697809800ae74cc8386352c2739f8bf501c77f5))
* **portfolio:** wire portfolio import into the CLI ([edb83a0](https://github.com/maxgfr/ultrastock/commit/edb83a0e842cc18765c9efdc86bf096ff9b8eb87))
* **portfolio:** wire risk, stress, optimize, rebalance, location, lookthrough, income and goals ([3a29b15](https://github.com/maxgfr/ultrastock/commit/3a29b1533bcc80f30b1a4afb13d0f09a3aa0eb29))
* **trading:** append-only ledger (PMP and FIFO cost bases, splits, dividends, cash, valuation, XIRR), deterministic risk gate with codes and fingerprints, circuit breaker with graduated drawdown sizing and cooling-off ([273c6f1](https://github.com/maxgfr/ultrastock/commit/273c6f1da7e4cab474d757f9422084ece4de507e)), closes [#5](https://github.com/maxgfr/ultrastock/issues/5)
* **trading:** tickets with fingerprints and an fsync'd audit trail, paper engine (order-book walk for crypto, slippage and fees, working limits swept against later bars), gate context from ledger, quotes and ECB rates, plan → trade context, readiness; portfolio, plan, ticket and paper commands ([1d0bbd8](https://github.com/maxgfr/ultrastock/commit/1d0bbd89bac1a64ab26e0c2c1b3bedd5b6b1a1db)), closes [#5](https://github.com/maxgfr/ultrastock/issues/5)

# [0.4.0](https://github.com/maxgfr/ultrastock/compare/v0.3.0...v0.4.0) (2026-10-24)


### Features

* **analyze:** typed decision schema with validation and journal entry, run-to-run delta, self-contained HTML report with linked evidence and an SVG price chart ([686bceb](https://github.com/maxgfr/ultrastock/commit/686bcebec69fda0ffee992ee322bbc675d37a421)), closes [#4](https://github.com/maxgfr/ultrastock/issues/4)
* **report:** report command — the checked answer, the decision, the debate notes and a price chart as one page; analyze keeps the year of bars for it ([4201f8d](https://github.com/maxgfr/ultrastock/commit/4201f8d8eac08f578b01143afd35ad624189b1c5))

# [0.3.0](https://github.com/maxgfr/ultrastock/compare/v0.2.0...v0.3.0) (2026-10-24)


### Features

* **analytics:** chart patterns — pivots, support/resistance, trend template, VCP, Darvas, gaps, breakouts ([bd2db3e](https://github.com/maxgfr/ultrastock/commit/bd2db3e04c635082f1af5fc54f309503e6ae0f6a))
* **analytics:** fundamental scores and valuation — Piotroski, Altman Z/Z'', Beneish M with reasons; quality metrics (ROIC, FCF after SBC, accruals, dividend cover); multiples (Graham, magic formula, PEG); DCF, reverse DCF, Gordon, residual income, CAPM, WACC, scenarios ([cec3424](https://github.com/maxgfr/ultrastock/commit/cec34248b5c88991c6a65ddb922ccfa2fbaef96b)), closes [#3](https://github.com/maxgfr/ultrastock/issues/3)
* **analytics:** indicator library with a by-name registry ([7c21c76](https://github.com/maxgfr/ultrastock/commit/7c21c7639f233a3629cd728203587765f2acb66a))
* **analytics:** market regime — intermarket ratio and trend signals, O'Neil distribution days and follow-through state machine, VIX term structure, contrarian sentiment, exposure coach and crypto regime scores with open weights ([9a6e911](https://github.com/maxgfr/ultrastock/commit/9a6e911794baa1971ebd3a00ff0e1887b0e12ec2)), closes [#3](https://github.com/maxgfr/ultrastock/issues/3)
* **analytics:** market regime, sector rotation and catalyst timeline commands ([99c8c70](https://github.com/maxgfr/ultrastock/commit/99c8c70594cd8d643a431808b8a9a27c6980846a)), closes [hi#impact](https://github.com/hi/issues/impact)
* **analytics:** option mathematics — Black-Scholes-Merton Greeks, implied volatility, American binomial, multi-leg payoffs and P&L matrix, expected move, max pain, gamma exposure, skew, IV rank, unusual activity ([1ae35b8](https://github.com/maxgfr/ultrastock/commit/1ae35b8e70275acba3e9460b4737038f7f5f4b72)), closes [#3](https://github.com/maxgfr/ultrastock/issues/3)
* **analytics:** portfolio construction (sample and Ledoit-Wolf covariance, minimum variance, max Sharpe, risk parity, HRP, Black-Litterman, band rebalancing with cash-flow steering) and position sizing (risk-based with caps, liquidity, lots; Kelly and binary Kelly, vol targeting, expectancy) ([be635da](https://github.com/maxgfr/ultrastock/commit/be635da5a57e65c8a52dd56a4c1cbf6950048c82)), closes [#3](https://github.com/maxgfr/ultrastock/issues/3)
* **analytics:** quant commands — options-analysis, stats, crypto-analysis, predict-analysis ([d463a80](https://github.com/maxgfr/ultrastock/commit/d463a80b3dc35e0fc4d07709763cab91f6acf069))
* **analytics:** screen — TradingView presets over one market or merged Europe, crible presets and DSL, builtin technical screens on index universes ([ae07182](https://github.com/maxgfr/ultrastock/commit/ae07182f9e884fde048dc782b02972b560327a3c))
* **analytics:** statistics and performance library — moments, OLS with Newey-West, GARCH(1,1), range volatility, ADF, Hurst, half-life, Engle-Granger, two-state HMM, CUSUM, VaR/CVaR/Cornish-Fisher, probabilistic and deflated Sharpe ([7ddd624](https://github.com/maxgfr/ultrastock/commit/7ddd6247a99375f8ff7e43956a65256786f93313)), closes [#3](https://github.com/maxgfr/ultrastock/issues/3)
* **analytics:** valuation — scores with components, quality, multiples, CAPM cost of equity, three-scenario DCF, reverse DCF, margin of safety; statements from filings with crible gap-filling ([5623a83](https://github.com/maxgfr/ultrastock/commit/5623a839d84386fa24e3eae92da2b6624ef3aa39)), closes [#3](https://github.com/maxgfr/ultrastock/issues/3)
* options-analysis, stats, crypto-analysis and predict-analysis commands; Kalshi taker fee modelled by default ([d17f0ae](https://github.com/maxgfr/ultrastock/commit/d17f0ae674dd987233a76fbd2655b77a471bc02d)), closes [#3](https://github.com/maxgfr/ultrastock/issues/3)
* **regime:** wire regime, sectors and catalysts; read Nasdaq economic times as New York time ([ef1383c](https://github.com/maxgfr/ultrastock/commit/ef1383c75d9c587407618ec6b586090dcb220212))
* **screen:** wire the screen command into the CLI ([f3155f7](https://github.com/maxgfr/ultrastock/commit/f3155f7bbc1edb31f7bf70076faaf645ff63ba36))
* technicals command — full indicator panel, relative strength, Minervini trend template, VCP, support/resistance, gaps, breakouts, candlesticks and a reasoned bullish score ([3d76186](https://github.com/maxgfr/ultrastock/commit/3d761863f849932fb86755cd02a70b73fd211f02)), closes [#3](https://github.com/maxgfr/ultrastock/issues/3)

# [0.2.0](https://github.com/maxgfr/ultrastock/compare/v0.1.0...v0.2.0) (2026-10-24)


### Features

* company data commands — resolve, fundamentals (SEC point-in-time, ESEF, crible), filings, insiders (Form 4, AMF), 13F holdings, analyst, short, dividends, congress; doctor checks the SEC contact ([fe09dd7](https://github.com/maxgfr/ultrastock/commit/fe09dd7a9ef1c6f82d975f2312b60cc25916a6f0)), closes [#2](https://github.com/maxgfr/ultrastock/issues/2)
* crible (uvx, MCP company) and binance-historical adapters; doctor reports profile, crible dataset and regulator DNS blocks ([56de407](https://github.com/maxgfr/ultrastock/commit/56de40746793c0307da3e3d5c2d5eef36d17e83e)), closes [#2](https://github.com/maxgfr/ultrastock/issues/2)
* data-layer framework — datasets, fallback chains, profile, suitability, jurisdiction, calendars ([db2af65](https://github.com/maxgfr/ultrastock/commit/db2af653787bbd9fc0eb515bd2c0bf0705db2178)), closes [#2](https://github.com/maxgfr/ultrastock/issues/2)
* macro, rates, fx, cot, sentiment, news and universe commands; calendar econ/earnings/dividends ([228810f](https://github.com/maxgfr/ultrastock/commit/228810f6e62f35bf7b5db963e8742442e7555780)), closes [#2](https://github.com/maxgfr/ultrastock/issues/2)
* price fallback chains (Euronext/Nasdaq → Yahoo, Binance → Kraken → Coinbase), European venues via Yahoo, and options, crypto, predict (jurisdiction-gated) and snapshot commands ([b9b60bb](https://github.com/maxgfr/ultrastock/commit/b9b60bb3c69eacba0a63387c1f9d8485e4813ba9)), closes [#2](https://github.com/maxgfr/ultrastock/issues/2)
* profile, suitability questionnaire, jurisdiction verify (MiCA register, ANJ DNS block) and exchange calendars commands ([efcac81](https://github.com/maxgfr/ultrastock/commit/efcac811b068ea354578ad0f2ca5d2c695e7a917)), closes [#2](https://github.com/maxgfr/ultrastock/issues/2)
* **providers:** CBOE and Deribit option chains ([d028fb2](https://github.com/maxgfr/ultrastock/commit/d028fb2cc46d70725927b333e69c6d1e9c6c0630))
* **providers:** crypto derivatives, market, DeFi and on-chain data ([1a9245b](https://github.com/maxgfr/ultrastock/commit/1a9245bfe5912a021dbd2509b1b085f9d9a8c300))
* **providers:** fundamentals data batch — SEC EDGAR, ESEF/GLEIF, AMF, OpenFIGI, Nasdaq analyst, FINRA, House PTRs ([2e3ff01](https://github.com/maxgfr/ultrastock/commit/2e3ff0147c9679cf09f0aab6c20fe088f8bfdc73))
* **providers:** Kalshi, Manifold and Polymarket prediction markets ([5a95802](https://github.com/maxgfr/ultrastock/commit/5a95802a4e5eff919ac1f35fd9e959c24f9ea12e))
* **providers:** macro, rates, positioning, calendars, sentiment, news and index-universe providers ([540808f](https://github.com/maxgfr/ultrastock/commit/540808f7f243467a1dcb9633f0bb4708f143edd4))
* **providers:** Yahoo, TradingView, Coinbase and Kraken price fallbacks ([076260f](https://github.com/maxgfr/ultrastock/commit/076260f518601edf186e141eb332ec560388b691))

# [0.1.0](https://github.com/maxgfr/ultrastock/compare/v0.0.0...v0.1.0) (2026-10-24)


### Features

* scaffold and vertical slice — cited evidence for Euronext, US and crypto ([#13](https://github.com/maxgfr/ultrastock/issues/13)) ([0b6d517](https://github.com/maxgfr/ultrastock/commit/0b6d517f54d0cebbd65e0ce23c78e7f7826ed1d2)), closes [#1](https://github.com/maxgfr/ultrastock/issues/1)
