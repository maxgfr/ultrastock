# Data sources

Every figure carries its source, the URL read, when it was read (`fetchedAt`),
the date it is true at (`asOf`), the delay at the source, and whether the source
is **official** (an exchange, a regulator, a central bank, a statistics office,
the issuer) or not. When a source fails, the next one in its chain answers and
the figure says `fallback for <source>`; a definitive refusal ("no such
listing", a jurisdiction block) is reported, never routed around.

## Prices

| Symbol | Chain | Delay | Official |
|---|---|---|---|
| `MC.PA`, `ASML.AS`, `CW8.PA`, `ABI.BR`, `EDP.LS`, `ENEL.MI`, `EQNR.OL`, `A5G.IR`, an EU ISIN | Euronext → Yahoo | end of day; ~2 years of history at Euronext | Euronext yes |
| `SAP.DE`, `SHEL.L`, `NESN.SW`, `SAN.MC`, `VOLV-B.ST`, `NOKIA.HE`, `NOVO-B.CO`, `OMV.VI`, `PKN.WA` | Yahoo | delayed 15–20 min | no |
| `NVDA`, `QQQ`, `BRK.B` | Nasdaq API → Yahoo | delayed / last sale; 10 years | no |
| `BTCUSDT`, `ETH-EUR`, `SOL/USDC` | Binance → Kraken → Coinbase | real time, closed bars | yes |

- London prices from Yahoo are in pence (GBp): ultrastock converts to GBP and says so.
- A crypto `-USD` pair reads the USDT book on Binance; the answer must say USDT.
- Binance refuses some jurisdictions (HTTP 451): Kraken and Coinbase stand in.
- Long crypto histories (years of minute bars, futures mark/index/premium
  klines) go through maxgfr/binance-historical when installed (`doctor`).

## Everything else

| Area | Sources (official ✓) |
|---|---|
| Macro | BLS ✓, FRED ✓, ECB ✓, Eurostat ✓, INSEE ✓, World Bank ✓ |
| Rates, FX | US Treasury ✓, ECB ✓ (policy, €STR, AAA curve, reference rates), FRED ✓ (credit spreads), Frankfurter |
| Positioning, sentiment | CFTC COT ✓, CNN Fear & Greed, alternative.me, Cboe |
| Calendars | Nasdaq, ForexFactory (events); exchange holidays computed from the rules |
| News | Google News, GDELT, Yahoo (external text) |
| Options | CBOE ✓ (US, 15 min), Deribit ✓ (BTC, ETH) |
| Crypto | Binance futures ✓, CoinGecko, DefiLlama, CoinMetrics, mempool.space, DexScreener, Solana RPC |
| Prediction | Kalshi ✓, Manifold, Polymarket (where lawful) |
| Snapshot, screens | TradingView scanner (unofficial), maxgfr/crible (fundamentals, via uvx) |
| Universes | Wikipedia index pages (current members only — survivorship) |
| Regulation | ESMA MiCA registers ✓, regulator DNS blocks |

Optional keys: `ULTRASTOCK_FRED_API_KEY` (or `FRED_API_KEY`), `ULTRASTOCK_COINGECKO_API_KEY` (demo key), `ULTRASTOCK_SOLANA_RPC` (your own RPC endpoint).
