# Options, crypto structure, prediction markets

## Options — `options <symbol>`

US listings come from CBOE's delayed quotes (15 minutes), BTC and ETH from
Deribit (with the DVOL volatility index). The summary gives, per expiry, the
at-the-money implied volatility, put/call open-interest and volume ratios and
the open interest, plus CBOE's 30-day IV. Read IV against its own history, not
in isolation: high IV makes options expensive to buy and pays to sell — with
the risk that comes with it. ultrastock places no option order.

## Crypto — `crypto <view>`

| View | Reads |
|---|---|
| `global`, `top`, `coin <id>` | CoinGecko: capitalisation, dominance, prices, supply, FDV |
| `derivatives <coin>` | Binance futures: mark/index, funding (and annualised), open interest, long/short ratios, taker flow |
| `defi [protocol]`, `yields [symbol]`, `stables`, `fees [chain]` | DefiLlama: TVL, pool APYs (base vs reward — a reward-heavy yield is emissions, not income), stablecoin supply, fees |
| `onchain [btc|eth]` | CoinMetrics community (MVRV, active addresses, hash rate) and mempool.space (fees, hash rate, difficulty) |
| `dex <query>` | DexScreener pairs, with low-liquidity and young-pair warnings |
| `holders <mint>` | Solana top-10 holder concentration (often rate-limited on the public RPC) |

Funding above ~20 % a year annualised is crowded leverage; deeply negative is
capitulation. MVRV far above 1 is unrealised profit; NVT is not available on
the free tier.

## Prediction markets — `predict`

- `predict kalshi [SERIES|events|market:<ticker>|book:<ticker>]` — Kalshi, a
  CFTC-regulated exchange.
- `predict manifold <terms>` — play money: a signal of opinion, not a market.
- `predict polymarket <slug>` — refused where the profile's jurisdiction blocks
  it. **France: blocked (ANJ)** — not read, not paper-traded, never worked
  around.

Odds are probabilities priced by participants, with fees, thin books and
resolution rules that matter: read the rules (external text) before treating
a price as a probability.
