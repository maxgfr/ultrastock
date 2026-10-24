# Data sources

Every figure carries its source, the URL read, when it was read (`fetchedAt`),
the date it is true at (`asOf`), the delay at the source, and whether the source
is **official** (an exchange, a regulator, the issuer) or not.

| Symbol | Source | Prices | Delay | Official |
|---|---|---|---|---|
| `MC.PA`, `ASML.AS`, `CW8.PA`, `ABI.BR`, `EDP.LS`, `ENEL.MI`, `EQNR.OL`, `A5G.IR`, an EU ISIN | Euronext (live.euronext.com) | daily, adjusted, about the last 2 years | end of day | yes |
| `NVDA`, `QQQ`, `BRK.B` | api.nasdaq.com | quote + 10 years of split-adjusted daily bars | Nasdaq Last Sale or delayed | no |
| `BTCUSDT`, `ETH-EUR`, `SOL/USDC` | Binance spot (api.binance.com) | closed bars, 15m to 1w | real time | yes |

- **Euronext suffixes**: `.PA` Paris, `.AS` Amsterdam, `.BR` Brussels, `.LS`
  Lisbon, `.MI` Milan, `.OL` Oslo, `.IR` Dublin — the main market first, then
  the growth segment. The quote of a Euronext listing is the official close of
  the last session, not an intraday price.
- **Crypto**: `-USD` reads the USDT book (Binance spot has no USD book), and the
  answer must say USDT. A bar still forming is never used. Binance refuses some
  locations (HTTP 451): the refusal is reported, never routed around.
- **Not covered yet**: other European venues (`.DE`, `.L`, `.SW`) and US ISINs
  are refused with a note rather than guessed.
