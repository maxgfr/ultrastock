# Code audit — November 2026

Scope: the whole repository at `a26cc40` (v1.12.1), about 59 000 lines of TypeScript in `src/`
(the vendored engine in `src/vendor/` excluded). Result: 39 commits on `main`, v1.12.1 → v1.12.37.

## Summary

1. The codebase is in good shape: strict TypeScript, one door to the network, recorded fixtures, a
   deterministic gate. Typecheck, lint, 1 094 tests and 58 offline evals were all green before the audit.
2. The serious defects were in the paths tests reach least: live-order follow-up (a lost live order could
   be declared "never placed" and sent again), concurrent writers, and the tax engines.
3. 30 bugs are fixed, each with a test that fails without the fix; 6 optimizations are in, each measured.
4. Three critical issues are **not** fixed because they need a design decision, all in live trading:
   see "Not fixed". Live trading should stay off until they are settled.
5. The suite is now 95 files, 1 138 tests and 59 evals, all green; coverage is 80 % statements, 67 %
   branches, 83 % functions, 83 % lines, above the configured thresholds.

## Baseline and method

| Gate | Before | After |
|---|---|---|
| `pnpm run typecheck` | clean | clean |
| `pnpm run lint` | clean, 336 files | clean, 341 files |
| `pnpm test` | 91 files, 1 094 passed, 1 skipped | 95 files, 1 138 passed, 1 skipped |
| `pnpm run check:build` | clean | clean |
| `pnpm run eval` (offline) | 58 passed | 59 passed |
| `pnpm audit` | no known vulnerability | no known vulnerability |

Nothing failed at the start. One environment note: `node_modules` held an older `@maxgfr/webindex` than
`package.json` pins; `pnpm install --frozen-lockfile` fixed it.

Each change was one commit: a failing test first (or a measurement for an optimization), the fix, the
rebuilt bundle, the full gate (`pnpm run engine:gate`), a signed commit, a push to `main`. As chosen, every
commit was pushed on its own, so the 36 `fix`/`perf` commits cut 36 patch releases. The Release and CI runs
of every commit are green.

The first pass over the code was done by reading, in three slices (security and state, providers and
network, numeric and accounting). Findings marked *not reproduced* below come from that reading and were
not confirmed by a run.

## Bugs fixed

Every row has a test that reproduces the defect. Commit ids are on `main`.

### Live orders, the gate, paper trading

| Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|
| `baebd49` | `commands/broker.ts`, `trading/live.ts` | `broker reconcile` and `broker cancel` built their adapter from `--env` (default `test`), not from where the order went. A live order whose answer was lost was looked up on the testnet, read as "never placed" and became resendable. | Both use the ticket's own venue and environment and refuse a contradicting flag; `reconcile`/`liveCancel` refuse an adapter for anywhere else. | `tests/live.test.ts` |
| `baebd49` | `trading/live.ts` | A refused cancel came back as `rejected`, which blocked the ticket and let it be approved and sent again while the order was working or already filled. | A refusal leaves the ticket pending and asks the venue what became of the order; a finished order is not cancelled. | `tests/live.test.ts` |
| `baebd49` | `trading/live.ts`, `brokers/kalshi.ts` | What filled before a cancel was never booked; a Kalshi order cancelled after a partial fill stayed `submitted` for ever. | A cancel with fills books them; Kalshi reports it as `cancelled` with its fills. | `tests/live.test.ts`, `tests/brokers-kalshi.test.ts` |
| `d7fb944` | `trading/paper.ts` | Two `paper submit`, or a submit racing `paper sweep`, each booked a fill: the ticket's state was read outside any lock. | One paper execution at a time, under a lock; the sweep re-reads the ticket inside it. | `tests/paper.test.ts` |
| `69957f6` | `trading/context.ts` | Pending buys counted only checked and working tickets of the order's own venue. An order accepted by a venue (`submitted`), or waiting at another venue, did not count although every live venue settles in the one `real` book. | Every buy still to be paid from the same book counts; testnet orders do not. | `tests/ledger-gate.test.ts` |
| `8026289` | `trading/breaker.ts` | A live fill is booked in UTC without its zone and was parsed as local time: the 24-hour cooling-off ended early in Europe, late in America. | Zone-less ledger timestamps are read as UTC. | `tests/ledger-gate.test.ts` |
| `8026289` | `trading/breaker.ts` | A buy after units sold without a recorded buy (shares transferred in, then sold) divided by a quantity netting to zero: the cost became NaN and silently broke the losing streak and the paper readiness figures. | The average restarts from that buy. | `tests/ledger-gate.test.ts` |

### Security and state

| Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|
| `94407f5` | `research/ingest.ts`, `core/net.ts`, new `core/public-url.ts` | SSRF: `research` fetched any http(s) URL an agent, a search engine or a page named, redirects followed — `http://169.254.169.254/`, a service on localhost. | The net layer takes the engine's `authorizeUrl`; research passes `isPublicUrl` (http(s), public addresses only, every redirect checked). A refused link gets no rescue attempt. | `tests/public-url.test.ts` |
| `e6fd1d7` | `core/net.ts`, `providers/macro/fred.ts`, `providers/crypto/solana.ts` | `--record` stored request URLs verbatim: the FRED API key, or a private Solana RPC URL, ended up in fixtures meant to be committed. | A request can name the URL it is recorded as; FRED redacts the key, Solana records the public endpoint. | `tests/net-record.test.ts` |
| `8b15d73` | `alerts/alerts.ts` | The webhook allowlist was a string prefix: `https://hooks.example.com` also admitted `https://hooks.example.com.evil.net/` and `https://hooks.example.com@evil.net/`. | Same origin, no credentials, the entry's path as a whole-segment prefix. | `tests/journal-alerts.test.ts` |
| `30327a2` | `report/html.ts` | The evidence table of the HTML report linked any URL: a `javascript:` one from a feed became a link that runs script. | http(s) only; the item id is escaped. | `tests/decision-report.test.ts` |
| `23b681e` | `core/datasets.ts` | A headline's link was printed raw inside the `<<<UNTRUSTED_DATA` fence: a URL holding a line break and the closing marker ended the fence early. | Label and link are cleaned like the value. | `tests/datasets.test.ts` |
| `50d9db7` | `core/evidence.ts`, `calc.ts`, `core/datasets.ts`, `core/lock.ts` | No lock on the evidence register: 8 parallel `calc` on one run returned 6 distinct ids and lost 2 results (measured on the released bundle). | `calc` and data commands writing a run directory read, number and write under a lock on the run. Same test: 8 ids, 8 items. | `evals/run.mjs` (concurrency), `tests/lock.test.ts` |
| `00b3491` | `core/lock.ts` | A process killed while holding the `.recovery` lock, or between creating a lock file and writing it, left a lock nobody could ever recover. | A dead recovery owner is removed; an unwritten lock is stale after 5 s. | `tests/lock.test.ts` |
| `52e2fdd` | `check.ts` | `check` compared magnitudes only: "−12.3 % [E2]" passed when E2 held +12.3 %. | A minus written on the number itself is refused against a positive value. Unsigned figures, a plus sign, a spaced dash and figures found in documents are unchanged. | `tests/check.test.ts` |

### Providers and network

| Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|
| `d35e535` | `research/ingest.ts` | A PDF served from a URL that does not look like one (`/static-files/<id>`) came back with an empty body and was dropped as "a near-empty page". | An empty text read is read again as bytes and sent down the PDF ladder. Older fixtures replay unchanged. | `tests/research.test.ts` |
| `4184d36` | `analyze/full.ts` | At full depth, as soon as peers existed, the instrument's own statistics and its benchmark disappeared (`stats` reads `--benchmark` for one symbol only) while the slice was still titled "against SPY". | The instrument is always measured alone against its benchmark, then against benchmark and peers. | `tests/full-depth.test.ts` |
| `d962113` | `core/net.ts` | A response without Content-Length cut at the size cap was returned as `ok` and recorded. | It is a failed read, with the reason. | `tests/net-record.test.ts` |
| `37bfb24` | `providers/binance.ts`, `providers/markets/coinbase.ts` | Histories are paged forward a capped number of pages; past the cap the newest bars were silently missing (15-minute bars beyond 520 days on Binance, 187 on Coinbase). | The series carries a note naming where it stops. | `tests/providers.test.ts`, `tests/markets-crypto-fallbacks.test.ts` |
| `da3ddb4` | `providers/types.ts`, Yahoo, Coinbase, Kraken, Binance quotes | A previous close of 0 (a first session) gave a change of Infinity, which the evidence register refuses: the whole quote, and `analyze` with it, failed. | One helper computes the change and returns nothing without a positive reference. | `tests/providers.test.ts` |
| `d563909` | `providers/external/crible.ts` | The `crible mcp` client parsed JSON inside a stream listener: a bad line was an uncaught exception that ended the command. An early exit waited 120 s; stderr was never read. | Every case rejects the call with what happened. | `tests/crible-mcp.test.ts` |
| `c995c9c` | `providers/crypto/binance-futures.ts` | Seven sequential endpoints, any failure discarding everything: a 429 on a statistics endpoint threw away the funding already read. | Price and funding stay required; open interest and ratios degrade to a note. | `tests/crypto-binance-futures.test.ts` |
| `de6ef98` | `providers/macro/elections.ts` | "30 December – 2 January" ended in the page's year, eleven months before it began. | A span into an earlier month ends the next year. | `tests/events.test.ts` |

### Numbers and accounting

| Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|
| `5d9d6d7` | `backtest/metrics.ts` | Intraday bars of a listed security were annualised with 252 periods: a year of hourly bars counted as seven years (a +20 % year reported as 2.6 % CAGR, Sharpe divided by √7). | 252 × the bars a session holds, counted on the series. | `tests/backtest-validation.test.ts` |
| `90836d5` | `backtest/simulate.ts` | MAE/MFE left out the bar a stop or target is hit in: a trade stopped at −10 % reported −1 %. | The excursions run to the exit price. | `tests/backtest-simulate.test.ts` |
| `727fed6` | `analytics/sizing.ts` | `Math.floor(0.3 / 0.1)` is 2: a 3 % cap gave 0.2 instead of 0.3; 2.9 / 0.1 gave 28 shares instead of 29. | The lot count is taken within a billionth; rounding still only goes down. | `tests/portfolio.test.ts` |
| `9d36f0c` | `backtest/allocation.ts` | 31 March minus one month became 3 March (a 28-day lookback). | The day is clamped to the month's last. | `tests/backtest-validation.test.ts` |
| `58098d2` | `journal/settle.ts` | A horizon settled on the day it ended: run in the morning, a +5 call was scored on four sessions, and a settlement is never re-scored. | A horizon matures the day after it ends. | `tests/journal-alerts.test.ts` |
| `3888ec5` | `tax/regime.ts`, `tax/inputs.ts` | The tax engines sorted on the day only. A statement listed newest-first sold before it bought: US basis 0 and a phantom lot; French gain computed before the acquisition. | Full-date order, as the portfolio book. | `tests/tax.test.ts` |
| `f5916ed` | `tax/us.ts`, `tax/fr.ts` | A withholding reversed and taken again (−15, +15, −15) counted as 45 withheld. | The withholding is the opposite of the cash moved; a refund is shown as one. | `tests/tax.test.ts` |
| `a0cab4e` | `tax/us.ts` | "Likely qualified" looked at lots sold out long ago. | Only lots with shares remaining. | `tests/tax.test.ts` |
| `3620834` | `tax/fr.ts`, `tax/regime.ts` | The French report threw "no BNB→EUR rate" on any row quoted in a crypto-asset, even for a fee of zero — any Binance ledger. | A zero amount asks for no rate; the fee of a crypto-quoted trade is not converted. | `tests/tax.test.ts` |
| `3f24e98` | `tax/fr.ts` | After a disposal of unknown portfolio value, later gains were computed on too high an acquisition price and reported as firm (300 € where the 2086 notice finds 675 €). | Those disposals carry a note and the report warns once. Figures unchanged. | `tests/tax.test.ts` |

## Optimizations

| Commit | Change | Measured |
|---|---|---|
| `ce42157` | `core/net.ts`: within one process (one command, one MCP tool call) the same GET is sent once and shared, in flight included. Only answers are kept, bodies over 8 MB are not, nothing survives the command. | Live, same machine: `analyze AAPL --depth full` 111 → 90 requests (22 repeats → 0), 42 s → 37 s; `analyze SAP.DE --depth full` 41 → 33 (8 repeats → 0), 36 s → 32 s. Evidence identical key for key. |
| `48f7ff0` | `backtest/strategy.ts`: each indicator is computed once per series and parameter set across a sweep's variants. | Preparing variants on 20 000 bars: sma-cross ×162, 1 001 → 355 ms; supertrend ×100, 1 343 → 444 ms; rsi-macd-trend-ride ×100, 3 585 → 344 ms. Same results to the last trade. |
| `d1e009e` | `core/calendar.ts`: a market's holidays are worked out once per year instead of once per day asked. | Three horizons + next five sessions for 2 000 decisions: 4 616 → 209 ms. |
| `11ebea3` | `tax/inputs.ts`: the ledger is sorted and classified once per report for the crypto portfolio values. | 5 000-row ledger, 1 000 disposals: 3 960 → 71 ms. |
| `71ecc59` | `providers/macro/elections.ts`: the electoral calendar of a year that is over is kept a week. | Live, 24 past years: 14.5 s on the first study, 4.0 s on the next. |
| `c990463` | VIX term structure and central-bank calendars: independent pages asked together, read in order. | Live, median of five: 281 → 106 ms; 487 → 426 ms. |

Measured and **not** changed: caching the fixture clock (`clockNow` re-reads `fixture.json` on every call
in replay) — no measurable gain on the eval or test run, so the change was discarded.

## Quality

- `b643967` — dead code removed: `topTradeShare` (no caller), a doubled `store.save()`, an impossible
  condition around the approval-code check.
- `593326c` — six identical "print the result" helpers under three names folded into `printResult`.
- `67b34ac` — three comments corrected (`trading/transport.ts` does not exist; the profile's "will require
  a confirmation once live trading exists"; `xirr` is a bisection).

## User-facing behaviour changes

All are corrections, listed so nothing surprises:

- `broker reconcile|cancel` follow the ticket's venue and environment; a contradicting `--venue`/`--env`
  is a usage error; cancelling a finished order is an error; a refused cancel leaves the ticket pending.
- The risk gate is stricter: orders working at any live venue count as pending.
- `research` refuses URLs at private addresses, including `--urls` pointing at localhost.
- `check` fails "−12.3 %" against +12.3 (documented in `references/citation-format.md`).
- `analyze --depth full` on a symbol with peers registers more evidence, so its `[E#]` numbering differs.
- Intraday backtests of listed securities report different CAGR, Sharpe, Sortino and volatility; MAE/MFE
  change wherever a stop or a target is hit.
- `journal settle` settles a horizon one day later.
- Tax reports: same-day trades are replayed by time; withholding totals change where a statement holds
  reversals; the French report no longer stops on crypto-quoted rows and adds "understated" warnings.
- Sizing can return one more lot at exact boundaries; dual momentum looks back from month ends correctly.
- A fixture recorded with a FRED key or a private Solana RPC before `e6fd1d7` no longer replays (it held
  the secret). None is in the repository.
- Crypto histories longer than the page cap, Binance futures with a refused endpoint, truncated
  responses and quotes without a previous close now say so instead of failing or staying silent.

## Not fixed

### Critical — live trading

1. **Profile limits and jurisdiction loosen at once** (`commands/profile.ts`, `core/profile.ts`).
   `profile set limits.maxDailyLossPct 50` widens the breaker immediately; `profile set jurisdiction US`
   skips the MiCA check and makes Kalshi "allowed". The header comment promised a confirmation and a
   delay "once live trading exists". *Recommendation:* the same ratchet as the live limits — tightening
   at once, loosening behind an out-of-band code and 24 hours.
2. **The approval code is not bound to the environment or the venue symbol** (`trading/live.ts`). A code
   approved for a test run is accepted with `--env live`, and `--conid` overrides the symbol on every
   venue, not only IBKR. *Recommendation:* put the environment and the venue symbol in the code's
   binding; accept `--conid` for IBKR only.
3. **"Not found at the venue" is trusted as "never placed"** (`trading/live.ts`, every adapter's `query`).
   Lookups are windowed (Coinbase 5 pages, Kalshi 200 orders, IBKR the current session, Kraken the first
   closed page; Binance answers −2013 right after a timeout). *Recommendation:* never unblock on absence
   alone — cross-check open orders, require a minimum delay and the user's explicit confirmation.
   *Not reproduced.*

### Important

- **Orders, gate and state**
  - Test-environment orders on Kraken (validate) and Coinbase (preview) are reported `accepted` and stay
    `submitted` for ever (`brokers/kraken.ts`, `brokers/coinbase.ts`). Report a dry run as its own state.
  - The sector limit is never enforced: nothing sets `sectorValueBase` or `order.sector`
    (`trading/riskgate.ts`). Feed them from the instrument's sector, or remove the limit from the profile.
  - `ticket check --fixture` writes real state on a replayed clock; a crafted `fixture.json` could move
    the breaker's reference points (`trading/context.ts`). Refuse network flags on commands that write
    state. *Not reproduced.*
  - Realised results ignore transfers and splits (`trading/breaker.ts`): a sale of transferred-in shares
    counts its whole proceeds as profit, a sale after a split as a loss.
  - The wrong-code counter is not locked on the `limits` path (`trading/otp.ts`); alert rules are read,
    used across network calls and written back (`alerts/alerts.ts`); `user_version` is read outside its
    transaction and a recursive query can run until the MCP timeout (`core/db.ts`). *Not reproduced.*
  - A store kept open for a whole `analyze` still saves what it read at its start: a `calc` written to
    the same run meanwhile is lost. Merge on save, or lock the run for the whole command.
- **Tax semantics** (each with its scenario, left for your decision)
  - A Coinbase *Convert* is imported as a sell and a buy in euros, so France taxes a crypto-to-crypto
    exchange: 1 ETH bought 1 000 €, converted at 3 000 € → 2 000 € taxed, expected 0.
  - Pairs with the fiat as base (EURUSDT) are classified by their quote: neither the purchase nor the
    cash-out is taxed in France.
  - The US engine loses cost basis and holding period on a transfer between own accounts: bought at
    $150 in 2020, moved in 2023, sold at $190 → $1 900 short-term, expected $400 long-term.
  - A US wash sale moves the holding period of the whole replacement lot, and repeatedly.
  - The envelope follows the account: crypto held at a stockbroker is taxed as securities.
  - The US engine throws on a trade quoted in a crypto-asset (no rate), as the French one did.
  - France pools cost by ticker, not by security: the same share under two symbols has two pools.
- **Ledger**
  - A date-only row sorts before a timed row of the same day, so an IBKR split (dated the day) is
    replayed before that day's trades (`portfolio/ledger.ts`, `import/ibkr.ts`).
  - Two genuine identical fills in the same second collapse into one: the transaction id ignores the
    broker's trade id.
  - A transfer in without a price enters a new account at a cost of 0.
- **Providers** (*not reproduced*)
  - SEC Form 4/A is summed on top of the form it restates; joint filers count as distinct buyers.
  - ESEF statements keep their own currency and are divided into a price in another.
  - Quote escaping in crible queries differs between three call sites.
  - An `X-USD` crypto symbol becomes USDT on every fallback, so Coinbase is asked for BTC-USDT.

### Minor

- The dataset cache never evicts; atomic writes are not fsync'd; one torn JSONL line blocks the gate
  until repaired by hand; broker HTTP reads have no size cap; per-host pacing lives in one process, so
  parallel MCP calls exceed published paces.
- `check` (MCP) reads any path it is given; `ULTRASTOCK_LIVE=1` is read from the process environment.
- Piotroski compares ROA on two asset conventions; `parseLooseNumber` reads "0,123" as 123.
- Rolling indicators (`percentRank`, regression slope, Aroon, Vortex) are O(n·w). Not rewritten: running
  sums change the last digits of figures that are registered as evidence.
- The FINRA fallback downloads whole daily files uncached; `dedupeArticles` is quadratic.
- Duplication left in place: two binary fetchers with different fixture keys, two CSV readers, two
  `splitPair`, two `envelopeOf`, several date helpers, `redact` beside `scrubSecrets`.
- Exported with no caller: `blsSeries`, `polymarketEvents`; several more are used by tests only.
- Dev dependencies have majors available (TypeScript 7, vitest 5, tsup 9): left to dependabot.

## Open questions

1. **Two defaults I took** (the questions timed out): tax fixes limited to the contained ones, and the
   narrow sign rule in `check`. Say if you want the tax semantics above reworked, or the sign rule
   stricter (also refuse "+" against a negative) or reverted.
2. **Profile ratchet**: should loosening a profile limit or the jurisdiction need a code and a delay?
3. **`ULTRASTOCK_LIVE=1`**: is it meant to hold against the agent, which can set it for its own command?
4. **Fallback strictness** (`core/fallback.ts`): any error that is not a `ProviderError` routes to the next
   source, a parser crash included. Fixture replays depend on that for missing recordings. Keep, or fail
   loudly on programming errors?
5. **Ledger identity**: adding the broker's trade id to the transaction id fixes collapsed fills but
   changes ids, so re-imports would duplicate without a migration.
6. **Ordering of date-only rows** against timed rows of the same day.
7. **French 305 € exemption**: the rule's label says gross proceeds, its note says net of fees.
8. **Breaker on equity including deposits and withdrawals**: a withdrawal trips it, a deposit hides a loss.
9. **Orders per day** counts ticket transitions (working → filled counts twice), across books.
10. **`research --urls` on localhost** is now refused: is an opt-in for local documents wanted?
11. **`blsSeries` and `polymarketEvents`**: wire them to a command, or delete them?
