# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

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
