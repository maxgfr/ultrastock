# Portfolio: the ledger, imports and portfolio analytics

## The ledger

Every movement of money and securities is one line of
`<home>/ledger/<book>.jsonl`. The `real` book is what the user holds; the
`paper` book is simulation. After `portfolio db init` the same transactions
live in the local SQLite store instead, with daily snapshots and holdings
news beside them. See [local-store](local-store.md).

- **Recomputed, never stored.** Positions, cash, the average cost (PMP, the
  French rule) and FIFO lots are recomputed from the transactions each time. A
  wrong position is fixed by adding a corrective transaction, never by
  editing a line.
- **Typing it in:** `portfolio deposit|withdraw <account> <amount>`, or
  `portfolio add buy|sell|dividend|fee|interest|tax|split --account <id> …`.
  The account is an envelope id from the profile (`pea`, `cto-ibkr`,
  `kraken`).
- **Importing statements:** `portfolio import <file> --format <f> --account <id>`.
  Always `--dry-run` first, and show the user what would be added.
  - **IBKR**: Flex Query (XML or CSV) and the Activity Statement CSV.
  - **Binance**: trade history and transaction history.
  - **Kraken**: `trades.csv` and `ledgers.csv`.
  - **Coinbase**: the transaction history.
  - **Any other CSV**: a column map (`--map '{"date":"Date",…}'`). The named
    maps `boursorama`, `fortuneo` and `trade-republic` are unverified layouts,
    checked against the file's headers. When its fee or tax rows carry both
    signs, the import is refused until `--fee-sign charge-negative` (a
    negative amount is paid, a positive one refunded) or
    `--fee-sign charge-positive` (the reverse) says which: ask the user or
    read the broker's statement, never guess. It applies to the type written
    with both signs only: a type written with one sign throughout is charges.
  - Re-importing the same file adds nothing, because transaction ids are
    content hashes.
  - A sell beyond holdings refuses the whole file.
- **Reading it:** `portfolio show` lists positions marked to market in the
  base currency (ECB rates). `portfolio perf` gives the money-weighted return
  (XIRR), the realised results and the circuit breaker's state. The XIRR, in
  `perf` and the dashboard, takes each deposit and withdrawal at the ECB rate
  of its own date; without that rate it is n/a, with a note (`xirrNotes`), and
  a transfer in or out is not counted as a contribution (a note says so).
- **Portfolio context:** `analyze` reads the real book to say whether the user
  holds the symbol, is flat, or has no ledger at all.

## Analytics — `portfolio <action>`

Each action works on a book marked to market, and every figure is an `[E#]`.

| Action | What it answers |
|---|---|
| `risk [--benchmark]` | Exposures by asset class, currency, sector and country; HHI and the effective number of positions; volatility; VaR/CVaR (historical, Cornish-Fisher, 10-day bootstrap); beta; drawdown; correlations; the diversification ratio; **profile limit breaches**. |
| `stress` | Replays of the GFC, COVID, the 2022 rate shock and the crypto winter on today's holdings, plus parametric shocks (equities, rates, USD, crypto). |
| `optimize [--universe a,b] [--max-weight <%>]` | Minimum-variance, risk-parity, HRP and max-Sharpe weights on a Ledoit-Wolf covariance, capped at `maxPositionPct`. Max-Sharpe rests on weak return estimates; prefer the risk-based ones. A single-stock cap of a few % forces equal weights on a book of a few diversified funds (an assurance-vie): `--max-weight 40` sets the cap for that run only. The risk-based methods then pile into the lowest-volatility funds (money market, short bonds) — they minimise risk, they do not weigh the user's goal. |
| `rebalance --targets <json>` | Band rebalancing (`--band` in points, `--rel-band` in %) into whole-share orders, with fees and tax notes (French envelopes only, quoting the flat-tax rates when researched for the year; another residence is told what to research). `--contribution` steers new cash to the underweights first, which is often cheaper than selling. |
| `location` | The best envelope for each holding (PEA, CTO, AV) for a French tax resident, and the PEA room left — the ceiling, holding periods and treaty rate are the researched `tax` facts of the year (`tax rules template --country FR --year Y`); a fact not researched is left out and the notes say which. Any other residence gets no advice: research its accounts. |
| `lookthrough` | ETF holdings from iShares, Amundi or SEC N-PORT (at least 60 days old), as shares of the whole portfolio. |
| `income` | Dividends received, the forward 12 months, yield on cost. |
| `goals --target --years [--monthly]` | A seeded Monte Carlo of reaching the target, and the monthly contribution that gets to 80 %. |

None of them places an order. A rebalance becomes orders only through `plan`
and `ticket`, one at a time, and the user approves each one.

Reading the results:
- Concentration first. Five positions above 60 % of the book, or an effective
  number below 5, is the headline whatever the VaR says.
- A stress replay keeps today's weights through a past crisis. It is a
  scenario, not a forecast.
- Currency exposure is risk too: USD assets for a EUR investor carry the
  dollar.
