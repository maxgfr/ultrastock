# Backtesting and strategy research

A backtest says how a rule **would have** behaved. It is not evidence that the
rule will work. Report it as "would have", always beside the review verdict.

## Strategies — `strategy`

- `strategy list` shows the 27 built-ins (26 ported from ai-strategy-backtester,
  plus `sma-cross`) and the user's own strategies in `<home>/strategies/`.
- `strategy show <name>` prints the JSON. `strategy validate <file>` names the
  path of each error.
- `strategy new <name> [--like <strategy>]` starts a strategy from a template
  or from a copy.
- A strategy is declarative JSON: indicators by registry name and parameters,
  entry and exit conditions in the safe expression language, and risk rules
  (stop, target, trailing stop, ATR stop, time stop, risk per trade).

## Backtests — `backtest run <strategy> <symbol>`

These rules fix the biases of the original engine:
- a signal on a closed bar **fills at the next bar's open**, plus slippage;
- a stop the market **gaps through fills at the open**, not at the stop;
- when a stop and a target are both touched in the same bar, the stop counts;
- market orders pay the taker fee, limit orders the maker fee;
- crypto leverage (`--leverage`, `--perp`) adds Binance funding and liquidation;
- truncating the data never changes earlier signals, which is tested on 7
  strategies.

Defaults are 5 years (`--years`, or `--from`/`--to`) and 10 000 of capital.
Fees are 0.1 % per side for spot and listed securities and 0.02/0.05 % for
perpetuals, with 0.05 % slippage.

Every metric is an `[E#]`:
- **returns and risk:** CAGR, Sharpe, Sortino, max drawdown, Calmar, Ulcer,
  Omega, VaR and CVaR;
- **trades:** number, win rate, profit factor, expectancy (in money and in R),
  MAE/MFE, exposure;
- **comparisons:** buy-and-hold, residual alpha against the benchmark
  (Newey-West t-stat), and the run with **costs doubled**.

Allocation rules (`buy-and-hold`, `60-40`, `equal-weight`, `dual-momentum`,
`risk-parity`) run over a list of symbols, with `--rebalance`, `--lookback`
and `--cash-rate`.

## Validation

| Command | What it guards against |
|---|---|
| `walkforward --grid … --train N --test N [--anchored]` | in-sample fitting: parameters are chosen on each train window and the out-of-sample windows are stitched together |
| `sweep --grid … [--trials N]` | data mining: up to 500 variants, with the **deflated Sharpe**, the **probability of backtest overfitting** and CPCV (purge and embargo) |
| `montecarlo [--paths 5000]` | the luck of the trade order: trades resampled, giving percentiles of final equity and drawdown and the probabilities of loss and ruin |
| `compare <s1,s2,…> <symbol>` | strategies side by side on the same data |
| `review` | all of the above, plus sample size, costs ×2, the largest trade's share of profit, survivorship and a look-ahead re-check → **PASS, REVISE or REJECT**, with the reasons |
| `decisions [--rating] [--horizon]` | the journal's own calls: hit rates and alpha with Wilson intervals |

Rules for the answer:
- Lead with the review verdict and its failing checks, then the figures.
- A strategy that fails the deflated Sharpe or PBO has not shown an edge. Say
  so in those words, however good its CAGR looks.
- `--universe INDEX` declares that the symbols came from today's index
  members, and triggers the survivorship warning. Repeat it in the answer.
- Paper-trade a PASS before real money: `paper readiness` is the next gate.
