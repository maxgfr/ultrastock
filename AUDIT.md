# Code audit — second pass, 11 November 2026

Scope: the whole repository from `4cebb58` (v1.12.39) to `df90a04` (v1.13.9), about 61 700 lines of
TypeScript in `src/` (the vendored engine excluded). The first pass (v1.12.1 → v1.12.37, 30 bugs, 6
optimizations) is this file at `d97d6ed`: `git show d97d6ed:AUDIT.md`.

Two sessions worked on `main` at the same time. This report covers the 37 commits of this pass. The other
session worked through the first report's "Not fixed" list; its commits are named in "Closed by the other
session" so the open list below is accurate at `df90a04`.

## Summary

1. The codebase was healthy at the start: typecheck, 1 141 tests, 59 offline evals, a reproducible build and
   `pnpm audit` all green; one lint warning, since removed.
2. 26 bugs are fixed in this pass, each with a test that fails without the fix. The serious ones were in the
   citation check (three ways a made-up figure passed), in the live-order follow-up (a fill could be booked
   twice) and in the journal (a decision could be back-dated and scored on prices already known).
3. Two optimizations are in, both measured; three dead exports and two duplicated helpers are gone.
4. One feature is new: `ultrastock serve`, a local read-only dashboard (v1.13.0).
5. The suite is now 104 files, 1 231 tests and 59 evals, all green; coverage is 81.7 % statements, 68.3 %
   branches, 84.4 % functions, 84.6 % lines. What is still open is listed below, ranked.

## Baseline and method

| Gate | At `4cebb58` | At `df90a04` |
|---|---|---|
| `pnpm run typecheck` | clean | clean |
| `pnpm run lint` | 1 warning (`commands/broker.ts:169`) | clean |
| `pnpm test` | 95 files, 1 141 passed, 1 skipped | 104 files, 1 231 passed, 1 skipped |
| `pnpm run check:build` | clean | clean |
| `pnpm run eval` (offline) | 59 passed | 59 passed |
| `pnpm audit` | no known vulnerability | not re-run (no dependency changed) |

Nothing failed at the start.

Each change is one signed commit: a failing test first (a measurement for an optimization), the fix, the
rebuilt bundle. Every fix was checked a second time by putting `src/` back to the parent commit and running
the commit's tests: all were red without their fix. The full gate (`pnpm run engine:gate`) ran before each
push. Commits were pushed in six batches rather than one by one.

The code was written by delegated engineers working in isolated worktrees and reviewed line by line before
integration. This pass read what the first one reached least: the command layer and MCP, the statement
importers, `check` and `calc`, the ETF, morning-brief, backtest and research code.

Two things went wrong on the way, neither with a lasting effect:

- The first push attempt failed on two tests that timed out while the machine slept during the gate. Rerun
  on the newest `main`, everything passed.
- One Release run failed (`c666c2d`): the next batch was pushed while it ran, so the release bot could not
  push its version commit. The following run published v1.13.7 with both batches.

## Bugs fixed

Commit ids are on `main`.

### The citation check

| Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|
| `7be6d35` | `check.ts`, `core/dates.ts` | Any word starting like a month was read as one and blanked with the number after it: "Operating margin 45 % [E1]" passed whatever E1 held ("margin 45" → "Mar 4"), as did "declined 12 %" and "marge 45 %". | A month is a whole word from the date reader's own list, the day a whole number. | `tests/check.test.ts` |
| `e543806` | `check.ts` | Everything in square brackets was blanked before reading: "LVMH [rose 45 %](https://…) … [E1]" passed, as did a date written as a link. | Link and image text is read; only citation tokens, footnote markers and link targets are set aside. | `tests/check.test.ts` |
| `955ed45` | `check.ts` | Headings and a table's header row were never read: "## Buy, target 450 €" passed with no evidence. | Both are claims. A heading's section number and a header cell holding only a whole number (`+5`, `20`, `2026`) stay labels. The 59 recorded answers give the same verdicts. | `tests/check.test.ts` |

### Live orders, codes, profile and limits

| Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|
| `f7f29ea` | `trading/live.ts` | `reconcile` and `liveCancel` ran outside `live.lock` and loaded the ticket before the network call: two follow-ups of a filled order each booked the fill (3 fills in the test). | One live operation at a time; each reads the ticket under the lock. | `tests/live.test.ts` |
| `ec44f8e` | `trading/otp.ts` | The wrong-code counter was read, incremented and written unlocked: three processes guessing at once each saw "2 tries left". | Read-change-write under `state/codes.lock`, issuing included. | `tests/live.test.ts` |
| `3960818` | `trading/live.ts` | `openOrders().catch(() => [])`: a failed read of the open orders counted as "not listed", and a not-placed code then freed the ticket. | A failed read leaves the ticket of unknown fate; the code is not consumed. | `tests/live.test.ts` |
| `b2b8886` | `commands/profile.ts` | `profile set`, `envelope`, `suitability` and `init` were unlocked read-modify-writes: 73 of 120 concurrent changes survived. | One lock around each. | `tests/profile.test.ts` |
| `df4326a` | `trading/limits.ts` | The same for the live limits (104–115 of 200 survived), and applying a matured loosening could erase a tightening. | One lock around every read-change-write. | `tests/live.test.ts` |
| `c25aae9` | `trading/brokers/http.ts`, `brokers/ibkr.ts` | Venue answers were read whole, whatever their size. | A 4 MiB cap; an oversized answer is a failed read, never a truncated body parsed as whole. | `tests/brokers.test.ts` |

### Journal, alerts and the store

| Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|
| `be3241d` | `commands/journal.ts` | `decide` let `decision.json` set `decidedAt`: a call dated in January was scored by `journal settle` on prices already known. Re-running `decide` also appended a duplicate. | A new decision is dated by the clock; a `decidedAt`, `id` or `run` in the file is ignored with a note; a file already recorded is not recorded twice. | `tests/decision-report.test.ts` |
| `c666c2d` | `journal/settle.ts` | A horizon was scored on a history that stopped before its end: with a history ending on the decision day, a "hold" scored 0 % and "right", for good. | A horizon waits until the symbol's and the benchmark's history reach its end; `settle` lists what waits and why. | `tests/journal-settle.test.ts` |
| `bdefcd3` | `alerts/alerts.ts` | `watch run` read the rules, waited on the network, then wrote the list back: a rule added meanwhile was lost, a removed one came back. | Re-read under a lock at save time; only the rules the run changed are written. | `tests/alerts-run.test.ts` |
| `62a1eae` | `alerts/alerts.ts` | The `stops` rule read the stop of the oldest filled ticket of a line, and of tickets from before the line was sold out and bought again. | The newest ticket filled since the line was last opened. | `tests/alerts-stops.test.ts` |
| `a685590` | `analyze/morning/run.ts` | The morning brief showed, and flagged HIGH on, a stop from before the line was closed and reopened. | Same rule; otherwise "no stop on record". | `tests/morning.test.ts` |
| `3802a44` | `core/db.ts` | `user_version` was read before the write lock: a second process opening the store during a migration failed with "table already exists". | The version is read again under the lock. Shipped migration SQL untouched. | `tests/store.test.ts` |

### Importers and numbers

| Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|
| `a4d3863` | `portfolio/import/binance.ts` | Amounts glued to a coin whose ticker starts with a digit: `100.51INCH` was booked as 100.51 INCH, `5000001000SATS` as 5 000 001 000 SATS. | The row's pair says which coin an amount can end with. | `tests/import-binance.test.ts` |
| `b68c799` | `portfolio/import/kraken.ts` | `XTZEUR` split as "XT" + `ZEUR`: every Tezos trade was booked as `XTEUR`, which nothing prices. | A legacy X/Z quote needs a base of three characters or more. | `tests/import-kraken.test.ts` |
| `d2fb93b` | `core/csv.ts` | "0,123" was read as 123. | A comma after a lone leading 0 is the decimal mark; every other reading is unchanged. | `tests/csv.test.ts` |
| `6385124` | `commands/trading.ts`, `serve/` | The XIRR took each deposit in its own currency as if it were the base: 10 000 EUR + 5 000 USD read −23.7 % a year instead of −2.5 %. | Each flow is converted at the ECB rate of its own date; without a rate the XIRR is n/a with a note. | `tests/ledger-gate.test.ts`, `tests/serve.test.ts`, `tests/commands.test.ts` |
| `919a554` | `analyze/etf.ts` | Fund overlap matched one line per name: two share classes of one company counted once (3.9 % instead of 7.3 %). | Every line under a key stays matchable. | `tests/etf.test.ts` |
| `a57b5d3` | `analyze/etf-propose.ts` | `--max-funds 1` folded the bond sleeve into the equity line: "world 100 %" next to evidence saying 25 % equity. | A usage error naming the minimum number of funds. | `tests/etf-propose.test.ts`, `tests/commands.test.ts` |

### Untrusted text and the morning brief

| Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|
| `f1d5ed8` | `journal/journal.ts` | An imported document holding the closing marker ended the `UNTRUSTED_DATA` fence early. | The body is sanitised as research sources are. | `tests/journal-alerts.test.ts` |
| `c600c95` | `research/dossier.ts` | A dropped hit's URL was printed raw in `DOSSIER.md`: a line break in it started a line of dossier text. | URL and reason are written as one line of data. | `tests/research-rounds.test.ts` |
| `dc7913e` | `research/dossier.ts` | A page read again in a later round overwrote `sources/E#.md`: an `[E#]` already cited pointed at other text. | A registered document keeps its text. | `tests/research-rounds.test.ts` |
| `3c03d76` | `analyze/morning/confirm.ts` | A results date from Nasdaq was "confirmed by the issuer's own page www.nasdaq.com". | The feed's own pages confirm nothing for its own date. | `tests/morning-confirm.test.ts` |
| `906ab7b` | `analyze/regime/catalysts.ts` | Counted from a closed day, the next session was 0: on a Saturday, Monday's earnings read "today". | The next session is 1. | `tests/regime-analysis.test.ts` |

## Optimizations

| Commit | Change | Measured |
|---|---|---|
| `65f18ee` | `providers/fundamentals/finra.ts`: the daily short-volume file of a day that is over is kept in the dataset cache; the last two days are always read again. | Stubbed CDN, 10 sessions, second run: 14 → 6 requests, 5.5 → 1.1 MB, about 2.0 s → 1.2 s. |
| `4af6472` | `providers/macro/news.ts`: each headline is split into words once, not once per pair compared. Same result, proven against the old code on 300 random rounds. | 2 000 headlines, median of 7: 10.8 s → 0.48 s. |

## Quality

- `bfbf396` — three exports nothing referenced, tests included: `baseParams`, `llamaProtocols`, `cribleStatus`.
- `2d513fe` — `isoDate`, `isoDayOf` and `isoDay` were one function three times.
- `c683540` — the `perf` figures move into one pure function shared by the CLI and the dashboard.
- `dbcf6c9` — the lint warning.
- `df90a04` — the references describe the rules above.

Not folded, because they differ: the three `splitPair` (currency hint, XBT/XDG mapping, quote lists), the
two `envelopeOf`, the two binary fetchers (fixture keys), `tax/regime.ts`'s `day` (slices a string).

## New: `ultrastock serve`

`5e9a59e`, `9b76a5e`, `229cc33`, `3e49729` — `ultrastock serve [--port 8766] [--token …] [--book real|paper]`.

- Pages: the book marked to market, its risk, stress, income, location and look-through figures, the
  ledger, the journal, the watchlist and alert rules, the tickets and the audit trail; each has an `/api/…`
  JSON twin. Server-rendered HTML, no script, no external asset.
- Read-only: nothing under `ULTRASTOCK_HOME` is written (a test compares the directory byte for byte); the
  dataset cache of quotes is written, as `portfolio show` does.
- Security: 127.0.0.1 only, `Host` allowlist, own-origin check, a token traded for an `HttpOnly;
  SameSite=Strict` cookie, `GET`/`HEAD` only, a CSP that allows no script.
- Tried for real on a seeded book: every route answers, 401 without the token, 403 on a foreign `Host` or
  `Origin`, 405 on `POST`; light and dark rendering checked on screenshots.

Left out of this version: tax pages, headlines, optimize/rebalance/goals, any write.

## User-facing behaviour changes

All are corrections except the last.

- `check` is stricter: figures after month-like words, in link text, in headings and in table header rows
  are checked. An answer that leaned on any of these now fails.
- `decide` ignores a `decidedAt`, `id` or `run` in `decision.json` (with a note) and does not record the same
  file twice.
- `journal settle` leaves a horizon pending while the history stops short; a delisted name stays pending.
- `portfolio perf`: the XIRR changes for any book funded in another currency, and is n/a when a rate is
  missing; the JSON gains `xirrNotes`.
- `etf propose --max-funds` below the plan's sleeves is a usage error. `etf overlap` reads higher when a file
  has no ISINs.
- `broker reconcile|cancel` and `submit` run one at a time and can wait up to 10 s for each other; a
  reconcile whose open-orders read fails changes nothing.
- The morning brief and `watch` stops no longer use a stop from before a line was reopened; weekend briefs
  count sessions one further; a Nasdaq date is no longer "confirmed" by Nasdaq.
- Binance amounts in digit-led tickers, Kraken Tezos pairs and "0,123" are read differently. A statement
  imported before these fixes holds the old reading: re-importing adds corrected rows next to the wrong ones.
- A venue answer over 4 MiB is a failed read. Under `--offline`, an uncached past FINRA day is skipped.
- A `'` in a report is now written `&#39;` (same rendering).
- New command: `serve`.

## Closed by the other session

From the first report's "Not fixed" list, on `main` today: `c0abf51` (a crashed reader is a defect, not an
outage), `c9678eb` (SEC 4/A, joint filers), `2e2ff5a` (ESEF currency), `bbf0fb9` (`X-USD` on fallbacks),
`fb60a34` (Coinbase Convert in France), `b625d19` (profile ratchet — the last critical), `e186011` (dry-run
orders), `a330396` (sector limit), `c8d3b3c` (`--fixture` writing state), `95b908d` (breaker across
transfers and splits), `1c43f31` (closed-bar rule), `6adb37f` (crible quoting), `45033db` (negative
numbers in CSV). Critical 2 and 3 were closed before this pass (`dcdd087`, `45bca79`).

## Not fixed

Open at `df90a04`. The other session has announced it is working on the first report's remaining items
(tax and ledger semantics, the evidence store saved whole after `analyze`, recursive `portfolio db query`,
torn JSONL lines, cache eviction, `check` reading any path through MCP, `ULTRASTOCK_LIVE`, Piotroski,
rolling indicators); they are not repeated here.

### Critical

None known.

### Important

- **`check` converts % and ratio for any unit** (`check.ts:161`): "XRP up 45 % [E2]" passes when E2 is a
  price of 0.45 USD. *Recommendation:* convert only for unitless or ratio items, after checking how every
  producer labels fractions.
- **Tickets move on unlocked reads** (`trading/tickets.ts:99-111,137-150`): `recordCheck` checks the status
  outside the ticket lock and `transition` accepts any from-state, so a check racing a submit could move a
  `submitted` ticket back to `checked` (a resend is still blocked by the pending guard). *Recommendation:*
  check the from-state inside `transition`. *Seen, not reproduced.*
- **A cancelled order later reported filled is booked again** (`trading/live.ts`, the reconcile result
  branch): only a recorded `filled` state skips the booking. *Seen, not reproduced.*
- **Prediction-market lines are unpriced in every portfolio analysis and in `serve`**
  (`analyze/portfolio/book.ts`): `loadMarkedBook` has no branch for them, unlike `markBook`.
- **MCP annotations** (`mcp.ts`): `calc`, `portfolio show|perf` (they append an equity point the breaker
  reads) and `analyze` are declared read-only and idempotent. A `string[]` element holding a comma is split
  in two; `null` passes the required-argument check. *Not reproduced.*
- **XIRR and transfers**: a transfer in or out is not a contribution, so its value reads as return (a note
  says so). Fixing it depends on the ledger decision about the cost of a transfer. Crypto and stablecoin
  deposits give n/a.
- **`serve` on a ledger kept in SQLite**: `readLedger` opens the store writable and migrates an older
  schema (`portfolio/ledger.ts:105`) — the one place the dashboard is not strictly read-only. Documented.
- **Tax command inputs** (`commands/tax.ts:36,61,69`): `--income 85,000` becomes NaN and so do the US tax
  figures; any `--household` other than "couple" means single; `--book foo` reads an empty ledger.
  *Recommendation:* usage errors.

### Minor

- `portfolio/import/index.ts:47`: `--map constructor` is looked up without `Object.hasOwn` and ends in a
  misleading "needs --map".
- `check.ts`: an item's `fetchedAt` day counts as a date it holds (`:285`); "15m RSI" reads as 15 million;
  "## Week 46" and "60/40" in a heading are figures, as they are in a sentence. *Not reproduced, except the
  last.*
- `core/evidence.ts:178`: `addDerived` takes the newest `asOf`; its comment and `calc` say the stalest.
- Importers: a positive tax or fee refund is forced negative (`generic.ts:231`); "2:30 PM" is not read, so an
  AM and a PM fill collapse (`shared.ts:133`); 2026-02-30 is accepted (`ledger.ts:129`). *Not reproduced.*
- `commands/markets.ts:186`: `predict order` creates the ticket before the gate's context is built.
- Backtests: with a single variant `--trials` has no effect on the deflated Sharpe (`metrics.ts:167`); a
  command-line stop overrides the swept grid, and the identical variants still count as trials
  (`validation.ts:48,57`).
- Morning brief: the same release from two calendars counts twice in the high-impact flag
  (`catalysts.ts:254-276`); a line closed and reopened on one day, with date-only rows, keeps an older stop.
- `research/run.ts:204`: a redirected page is fetched again every round (its text is now protected).
- `journal.ts:128` ignores short round trips; `stats.ts:500` (`hmm2`) is fitted on the whole series, so it
  must not drive a backtest; `etf.ts:769` can list a fund among its own peers. *Not reproduced.*
- `analytics/options.ts:45,104`: at zero volatility the price is the undiscounted intrinsic value (no caller
  reaches it); `americanBinomial` has no caller and returns NaN at `t = 0`.
- `check.ts` `nearClaim` tokenises the whole cited document once per matching figure.
- Browsers do not separate cookies by port: the dashboard's cookie is sent to any other server on
  127.0.0.1. It is `HttpOnly`, named after the port, and a foreign `Origin` is refused.
- The multi-process tests added in this pass take about 2 s each; one full run failed once under load
  without the test being identified, and five reruns were green.
- `filterProtocols` and `protocolListPoints` (`providers/crypto/defillama.ts`) are now used by tests only.
- Every push to `main` cuts a release; a push made while a Release run is in flight makes that run fail.

## Open questions

1. **This file.** The two sessions hold opposite instructions: deliver `AUDIT.md` here, remove it there.
   It is delivered; say whether it stays.
2. **`journal settle` on a delisted or renamed name**, or when a benchmark can never be read: such horizons
   now wait for ever. Settle on the last bar after a delay, drop them, or leave them?
3. **`check` and counts in headings**: "## Trades (12)" now needs an `[E#]`. Is that wanted?
4. **`serve`**: read-only by choice. Are data entry (import, add a transaction, watchlist), tax pages and
   headlines wanted?
5. **MCP**: should a tool that appends an equity snapshot be declared a writing tool?
6. **The dashboard's test fixture** holds no historical rate, so its XIRR is n/a in the test. Re-record it?
7. **Already-imported statements** misread before the importer fixes: is a repair command wanted?
8. Still open from the first report: the sign rule in `check`, ledger identity and same-day ordering, the
   305 € exemption, the breaker on equity that includes deposits, orders per day, `research --urls` on
   localhost, `blsSeries` and `polymarketEvents`.
