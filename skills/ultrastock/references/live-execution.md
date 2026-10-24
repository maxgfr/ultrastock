# Live execution: guarded, approved by the human, one request at a time

Real money moves only through `broker submit`. It sends one request, after
every condition below is met, with a code the **user** reads from a channel
the agent cannot see. As the agent, you prepare and explain. You never
approve, never retry, and never work around a refusal.

## Environments

| `--env` | Binance | Kraken | Coinbase | IBKR | Kalshi |
|---|---|---|---|---|---|
| `test` (default) | testnet | `validate=true` (nothing placed) | preview only | paper account (`DU…`) | demo exchange |
| `live` | real | real | real | real (`U…`) | real — where the jurisdiction allows it |

**Live needs** `ULTRASTOCK_LIVE=1`, which the user sets in their own shell,
plus Node ≥ 22 and a paper record that passes `paper readiness`.

## One-time setup (by the user)

1. **Store a key.** `broker setup <venue> --env test|live` prints the keychain
   commands: macOS `security`, Linux `secret-tool`.
   - The key gets **trading permission only**: no withdrawal, no transfer, no
     margin, restricted to the user's IP when the venue allows it.
   - **Never ask for a key in the conversation.**
2. **IBKR.** Run the Client Portal Gateway and log in in the browser, then set
   `ULTRASTOCK_IBKR_CA_FILE` (the gateway's certificate, which pins TLS) and
   optionally `ULTRASTOCK_IBKR_CERT_SHA256`.
3. **Switch the venue on.** `broker code limits --venues kraken` sends a code,
   then `broker limits set --venues kraken --code <code>` takes effect **24
   hours later**. Do the same with `--attest kraken` for venues that cannot be
   asked whether the key can withdraw (Kraken).
4. **Add a harness approval rule.** It is a second human gate on top of the
   code. For Claude Code, in `.claude/settings.json`:
   ```json
   { "permissions": { "ask": ["Bash(*ultrastock.mjs broker submit*)", "Bash(*ultrastock.mjs broker limits set*)"] } }
   ```
   For Codex or Gemini CLI, keep approvals on for commands that contain
   `broker submit`.

## The chain for one order

1. `plan <symbol> --account <id> --venue <venue> --ticket` creates the ticket.
2. `ticket check <id>` runs the risk gate. The check stays valid for 15
   minutes, and only for that exact order.
3. `broker preview <id> --venue <v> --env <e>` runs the venue's own dry run
   and lists every ultrastock condition still unmet.
4. `broker code <id>` sends a 6-digit code, valid 2 minutes, bound to this
   order's fingerprint. It goes to a desktop notification, a private ntfy
   topic (with a token) or the user's terminal. **It is never printed to the
   output you read.**
5. The **user** runs `broker submit <id> --venue <v> --env <e> --code <code>`
   themselves, or approves your call when the harness asks.
6. If the answer is lost, the order is **unknown**. Nothing is resent until
   `broker reconcile <id>` has asked the venue. A fill is booked in the ledger:
   the `real` book live, the `live-test` book in test.

## Refusal codes

| Code | Meaning |
|---|---|
| `LIVE_OFF`, `NODE`, `NOT_READY` | live is not switched on, Node is too old, or the paper record is not ready |
| `VENUE_OFF`, `VENUE_MISMATCH` | the venue is not switched on, or the ticket was planned for another venue |
| `BLOCKED_JURISDICTION` | live: the crypto platform is not an authorised MiCA CASP for the profile's country (**Binance, for France**), or Kalshi is not "allowed" there (**France**) |
| `KILL_SWITCH`, `BREAKER` | `<home>/KILL` exists, or a loss limit tripped |
| `TICKET` | not checked, older than 15 minutes, or changed since the check |
| `MARKET_ORDER`, `ASSET`, `NO_SHORT` | live orders are limit orders only, on spot shares, ETFs, crypto or Kalshi contracts; no selling what is not held |
| `ORDER_LIMIT`, `DAILY_LIMIT` | the per-order or per-day limit of the experience tier: 250 / 500 at first, then 1 000 / 2 500 after 20 live fills, 5 000 / 10 000 after 100 |
| `WITHDRAW_RIGHT`, `ATTEST`, `TRADE_RIGHT` | the key can withdraw, or no attestation was given for a venue that cannot be asked, or the key cannot trade |
| `PRICE_BAND` | the limit is more than 1 % beyond the venue's best price right now |
| `CODE` | no code, an expired code, a wrong code, or a code issued for a different order |
| `PENDING` | this ticket already went out: reconcile it first |

## Always allowed

- Cancelling: `broker cancel <id>`.
- `broker panic`: sets the kill switch and cancels ultrastock's working orders.
  It sells nothing; closing positions is a decision.

## Never

- Withdrawals or transfers: no endpoint exists in the code.
- Margin, shorting, futures or options.
- Polymarket orders.
- Getting around a jurisdiction block.
