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

## Analysis on top of the data

### `options-analysis <symbol>`

For each expiry (or one `--expiry`):
- the expected move, from the straddle and from one standard deviation;
- max pain;
- dealer gamma exposure: the total, the flip level, the call and put walls;
- put/call ratios and the 25-delta skew.

Across expiries it adds the ATM-IV term structure and unusual activity. Once
20 days of IV are stored, it also gives the IV rank.

`--strategy` prices a structure at mid: `long-call:K`, `bull-call:K1/K2`,
`bear-put:K1/K2`, `iron-condor:Kp1/Kp2/Kc1/Kc2`, `straddle:K`,
`strangle:Kp/Kc`, `covered-call:K`, `cash-secured-put:K` or `collar:Kp/Kc`.
The output gives the max profit and loss, the breakevens, and a P&L matrix by
spot move, date and volatility. Pass the moves with an equals sign:
`--spot-moves=-30,0,30`. `--rate` sets the risk-free rate.

- GEX assumes dealers are long calls and short puts. This is a convention,
  not a measurement, so say so.
- Mid prices flatter. A real fill pays part of the spread on every leg.

### `crypto-analysis <coin>`

Covers funding (annualised, plus the 30-day mean), basis, open interest,
long/short ratios, DVOL, MVRV, realised volatility and drawdown from the
all-time high. These combine into a **leverage heat** reading.
`crypto-analysis yields <symbol>` judges DeFi pools by how much of their APY is
rewards (emissions) and by their TVL.

### `predict-analysis kalshi <SERIES|market:TICKER> | manifold <terms>`

Reads, for each market:
- the implied probability, the spread and the time to close;
- the order-book imbalance;
- YES + NO arbitrage, net of fees. Kalshi's taker fee is modelled as
  0.07 × C × P × (1 − P) by default; `--kalshi-fee` changes the coefficient.

With `--my-probability` it adds a half-Kelly stake. The edge behind it is
discounted by half the spread and the fee, and `--contracts` prices a size.

- For French residents this is paper only, and Polymarket is never used here.
- An edge is only as good as your probability. Write down where it comes from
  before you size anything.
