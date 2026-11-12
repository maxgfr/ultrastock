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
| `PETR4.SA`, `WALMEX.MX`, `RY.TO`, `TOI.V`, `GGAL.BA`, `SQM-B.SN`, `ECOPETROL.CL` (Americas); `7203.T`, `0700.HK`, `005930.KS`, `247540.KQ`, `600519.SS`, `000858.SZ`, `2330.TW`, `6488.TWO`, `D05.SI`, `1155.KL`, `BBCA.JK`, `PTT.BK`, `RELIANCE.NS`, `TCS.BO` (Asia); `BHP.AX`, `FPH.NZ` (Oceania); `NPN.JO`, `TEVA.TA`, `THYAO.IS`, `2222.SR`, `QNBK.QA` (Middle East, Africa) | Yahoo | delayed (venue-dependent); ~2 years of daily bars | no |
| `AAPL.NE` (Cboe Canada) | Yahoo | quote only: Yahoo keeps no daily history there — use the `.TO` or US line | no |
| `NVDA`, `QQQ`, `BRK.B` | Nasdaq API → Yahoo | delayed / last sale; 10 years | no |
| `BTCUSDT`, `ETH-EUR`, `SOL/USDC` | Binance → Kraken → Coinbase | real time, closed bars | yes |
| an ISIN Euronext does not list (`LU0161305163`, `FR0000989626`): a mutual fund (OPCVM, SICAV, FCP) of an assurance-vie or a bank | FT fund pages | one NAV a day, published the next day; several years of history | no |

- **Funds that trade on no exchange.** An ISIN with no Euronext listing is
  priced at its net asset value from the FT's fund pages, so `quote`,
  `history`, `stats` and `portfolio` (show, risk, stress, optimize) work on an
  assurance-vie's unit-linked funds. A bar's open, high, low and close are the
  same NAV. `fund <ISIN> --wrapper-fee <pct>` prints the share class's charges
  (ongoing, max annual, entry, exit), its category, style, domicile and size,
  and the yearly cost inside the contract (ongoing charge + the insurer's fee
  on unit-linked funds). The fonds euros has no NAV: book it as cash. The FT is
  unofficial; the KID (DIC) is the reference for the charges.

- Sub-units are converted and said so: London in pence (GBp → GBP), Johannesburg
  in cents (ZAc → ZAR), Tel Aviv in agorot (ILA → ILS).
- Every Yahoo venue carries its MIC (BVMF, XTKS, XHKG, XKRX, XSHG, XASX, XJSE…),
  its currency and its time zone; session dates are the exchange's own. Each
  suffix was checked live (a quote and a year of bars) before it was listed.
- **Lima (`.LM`) is refused**: Yahoo serves it with no currency and no last price,
  and Lima lists both PEN and USD lines — use the issuer's US line (BAP, SCCO, BVN).
- **No exchange calendar** outside NYSE/Nasdaq and Euronext: for Xetra, London,
  Tokyo, São Paulo… sessions are counted as Monday–Friday weekdays and no holiday
  is guessed (the catalysts say so). Riyadh and Doha trade Sunday–Thursday: a
  session count there is approximate.
- **Calendars**: the holiday rules are computed; trading hours and one-off
  closures (a day of mourning, an outage) are researched facts per year
  (`ultrastock facts research calendar --country US|FR|IT|NO --year <Y> --out <run>`, keys
  `<MIC>.open`, `<MIC>.close`, `<MIC>.specialClosures`). Without them the hours
  are the built-in ones (`calendar sessions` says so) and a session count past
  the closures last checked carries a note that it may be off by a day — say so
  when a horizon or a settlement date depends on it.
- A company that reports in another currency than it trades in (a Hong Kong line
  reporting in CNY, a London line reporting in USD) is valued in its statements'
  currency: the price is converted at the ECB cross rate as a derived [E#]. Outside
  USD and EUR the DCF discounts at the euro AAA 10-year — indicative, and said so.
- **FX for the book**: ECB reference rates cover USD, GBP, CHF, JPY, CNY, HKD, KRW,
  INR, AUD, NZD, CAD, BRL, MXN, ZAR, ILS, TRY, SGD, MYR, IDR, THB, the Nordic and
  CEE currencies. TWD, SAR, QAR, ARS, CLP and COP have no ECB rate: Yahoo's EUR
  cross rate (`EURTWD=X`, unofficial) stands in, said so.
- TradingView tickers follow the venue (`0700.HK` → `HKEX:700`, `PETR4.SA` →
  `BMFBOVESPA:PETR4`); Bursa Malaysia has none (TradingView keys it by name).
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
| Snapshot, screens | TradingView scanner (unofficial), maxgfr/crible (fundamentals, at a pinned tag: a Homebrew crible of that version, else uvx; its local dataset is dated — see below) |
| Universes | Wikipedia index pages (current members only — survivorship) |
| Regulation | ESMA MiCA registers ✓, regulator DNS blocks |

Optional keys: `ULTRASTOCK_FRED_API_KEY` (or `FRED_API_KEY`), `ULTRASTOCK_COINGECKO_API_KEY` (demo key), `ULTRASTOCK_SOLANA_RPC` (your own RPC endpoint).

## How crible runs

ultrastock pins one crible tag. It runs, in order: `ULTRASTOCK_CRIBLE_CMD` when set;
the `crible` on PATH when it is a Homebrew keg (`brew install maxgfr/tap/crible`)
of the pinned minor, at least the pinned patch: it starts faster and needs no git
lookup; else `uvx --from git+https://github.com/maxgfr/crible@<tag>`. `doctor`
says which one runs, and why a Homebrew crible was passed over.

## crible's dataset

crible screens a local copy of its published dataset (`screen --engine crible
--bootstrap` downloads it once; the `data-latest` release is rebuilt daily). The
copy only moves when you refresh it. `doctor` and every crible-backed command —
`screen --engine crible`, `value`, the peers of `analyze --depth full`, the
crible cross-check of `research` — compare its build date (the restored
manifest's `generated_at`) with the latest published one (read through the
network layer, cached six hours) and warn when it is over 7 days old
(`ULTRASTOCK_CRIBLE_MAX_AGE_DAYS`) and a newer one exists. The warning lands in
the command's notes (VALUE.md, DOSSIER.md, the peers dataset). Refresh with
`ultrastock screen --engine crible --bootstrap` (replaces the local copy with the
published one, about a minute). Nothing is ever downloaded unasked; a recorded or
replayed run skips the check.
