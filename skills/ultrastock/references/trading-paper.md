# From a view to an order: plan, risk gate, tickets, paper trading

ultrastock never sends an order from a model's say-so. The only path to an
execution is: `plan` → `ticket` → `ticket check` (the risk gate on fresh
prices) → `paper submit` (or, later, a live broker behind its own guardrails).
The user decides at every step.

## `plan <symbol> --account <id>`

Given a view, `plan` proposes the trade:
- the entry (`--entry`, by default the last price);
- a stop below support, or 2 ATR (`--stop` overrides it);
- targets at 2R and 3R (`--target a,b` overrides them);
- the size, from the profile's risk per trade, then cut by every cap: largest
  position, sector, crypto share, the cash buffer, lot size and tick.

It then dry-runs the risk gate and gives a verdict:
- **ready**;
- **ready with conditions** (the warnings to accept);
- **not ready** (fix the inputs);
- **reject** (a hard block).

`--ticket` creates the ticket from the plan. `--out <run>` registers the
plan's figures as `[E#]` in the analysis run.

## The risk gate

The gate is deterministic: the same order and the same state always give the
same result, and each check has a code. Blocks:

| Code | Blocks when |
|---|---|
| `KILL_SWITCH` | `<home>/KILL` exists; only risk-reducing orders pass |
| `BREAKER` | the daily, weekly or monthly loss limit tripped, or two losses in a row started the cooldown |
| `STALE_QUOTE` | the last price is older than the freshness limit — refresh first |
| `PRICE_BAND` | the order price is more than 10 % from the last price (a warning above 2 %) |
| `NO_STOP`, `STOP_SIDE` | a new position has no stop, or the stop is on the wrong side |
| `PRIIPS` | a US-domiciled ETF for an EU retail investor; use the UCITS equivalent |
| `JURISDICTION` | the venue is blocked for the user's country (Polymarket for FR) |
| `NO_CRYPTO`, `NO_OPTIONS`, `NO_PREDICTION`, `NO_SHORT`, `NO_LEVERAGE`, `EXCLUDED` | the profile forbids it |
| `RISK_PER_TRADE`, `POSITION_PCT`, `SECTOR_PCT`, `CRYPTO_PCT`, `MAX_POSITIONS`, `CASH_BUFFER` | the risk to the stop or a cap would be exceeded after the order, pending orders included |
| `FREQUENCY` | too many orders today, the overtrading guard |

Warnings: `MARKET_ORDER`, `DRAWDOWN_SIZING` (in a drawdown, sizes are cut) and
`EVENT_RISK` (earnings or a macro release inside the window).

Never argue an order past a block. Explain the block, and say what would have
to change.

## Tickets

- `ticket list|show|check|cancel`.
- A ticket records the order, the gate's fingerprint and each state change,
  in `<home>/audit/orders.jsonl`, append-only and synced to disk.
- A check expires after 15 minutes, and an order whose fields changed after
  its check is refused.

## Paper trading

- `paper submit <ticket>` fills a checked ticket on real prices. Crypto walks
  Binance's order book; other assets fill at the last price plus slippage.
  Fees follow the venue.
- `paper sweep` works limit orders against the bars traded since.
- `paper book` lists the paper positions.
- `paper readiness` says whether the paper record supports real money:
  - at least 20 trades over 30 days;
  - a positive expectancy;
  - a profit factor above 1.2;
  - a drawdown under 15 %.

  Until it passes, say so plainly: the strategy has not shown an edge yet.
