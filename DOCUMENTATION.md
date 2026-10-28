# How ultrastock works

```
symbol ─► router ─► provider ──► bars / quote ─► analytics ─► evidence.json ─► BRIEF.md
            │        (euronext,      (+ provenance:          ([E1]…[En], each with
            │         nasdaq,         source, url,            source, asOf, delay,
            │         binance)        fetchedAt, delay,       official)
            │                         official)                      │
            ▼                                                        ▼
       net layer ── live │ --record <dir> │ --fixture <dir>    agent writes answer.md
       (one door to      (raw HTTP answers,  (replay, offline,         │
        the network)      timestamped)        same ids)                ▼
                                                            calc ─► new [E#] (derived)
                                                                       │
                                                                       ▼
                                                      check: every figure cited and found
```

## The evidence register

`<run>/evidence.json` holds every figure the tool handed to the agent, in the
order it was registered: `id` (`E1`…), `key` (`MC.PA.rsi14`), `label`, `value`,
`unit`, and its provenance — `source`, `url`, `fetchedAt`, `asOf`, `delay`,
`official`, and for derived figures `derivedFrom` and `formula`. Ids never
change once assigned; re-registering a key with the same value returns the same
id, so a re-run into the same directory keeps an answer valid.

## The check

`check` splits the answer into claims (paragraphs, list items, table rows,
blockquotes — the engine's claim parser), reads every figure in each claim with
its own financial number reader (signs, `%`, `bn`/`Md`, French and English
separators, more than eight figures per row), and requires each figure to be
among the values of the `[E#]` the same claim cites, at the precision written.
Dates, years, indicator settings, index names and spans are not figures. A
closing sources list is set aside.

## Determinism

`--record` stores each raw HTTP answer under a hash of its request, with the
time of the recording; `--fixture` serves them back and takes the recording
time as "now", so the date windows ask for the same URLs. A request the
fixture never recorded is an error, not a live call. The offline evals and
the Node-18 CI job run entirely on fixtures.

## Look-ahead

Every indicator returns an array aligned with its input, `undefined` until its
window is full: index *i* only ever uses bars 0…*i*. Crypto bars still forming
at read time are dropped.

## Datasets and sources

Every data command returns datasets: a title, points (`key`, `label`,
`value`, `unit`, `asOf`) and one provenance (`source`, `url`, `fetchedAt`,
`delay`, `official`). `--out` registers each point as an `[E#]`. External
text (headlines, filing titles, market rules) is flagged `untrusted`, and is
printed between `<<<UNTRUSTED_DATA` fences. The router tries the sources of a
market in order (Euronext → Yahoo; Nasdaq → Yahoo; Binance → Kraken →
Coinbase), and records the stand-in as `fallbackFrom`. A dataset cache keeps
each kind for its own TTL.

## The user's state

`ULTRASTOCK_HOME` holds the state below. It lives outside the skill, nothing
in it is sent anywhere, and files are created 0600.

| Path | Holds |
|---|---|
| `profile.json` | jurisdiction, tax residence, envelopes, limits, constraints, suitability score |
| `ledger/<book>.jsonl` | append-only transactions; positions, PMP, FIFO lots and cash are recomputed, never stored |
| `tickets/`, `audit/orders.jsonl` | every order's life, appended and fsync'd before and after anything executes |
| `journal/`, `theses/`, `knowledge/` | decisions and their settlements, theses, lessons, imported documents |
| `state/` | alert rules, the watchlist, live limits, approval codes (scrypt-hashed) |
| `KILL` | the kill switch |

## From a view to an order

```
plan ─► ticket (draft) ─► ticket check ─► risk gate ─► checked (15 min, this exact order)
                                             │ block → blocked, with reason codes
checked ─► paper submit ─► fill on the live book / last price ± slippage ─► paper ledger
checked ─► broker preview (venue dry run) ─► broker code (out of band) ─► broker submit
             └─ preconditions: live switch, venue on, jurisdiction (MiCA), kill switch,
                breaker, limit order, no short, tier limits, no withdrawal right,
                1 % price band, the code bound to the fingerprint
           ─► lock, audit, ONE request, audit ─► filled / accepted / rejected / unknown
           unknown ─► broker reconcile (query by clientOrderId) — never a resend
```

The gate is a pure function of the order and a context: the profile, the
book marked to market, pending orders, the quote and its age, the breaker,
and the orders already placed today. Its result is fingerprinted, and
changing any number of the order voids the check.

## The analysis

`analyze` runs its slices one after the other (each source is rate-limited,
and a fixture replays the same order) into one evidence register. `BRIEF.md`
indexes them, and names an unavailable slice instead of filling it in.
`RUNBOOK.md` scripts the debate, with role notes in `notes/<role>.md`, ending
in `decision.json`. `decide` validates the decision against the register and
appends it to the journal. `report` renders the checked answer, the decision,
the notes, a price chart and the cited evidence as one HTML page.

## Backtests

A strategy is declarative JSON over the indicator registry and the
expression language. The simulator works on closed bars:
- a signal fills at the next open;
- a stop the market gaps through fills at the open;
- when a stop and a target share a bar, the stop wins;
- fees follow the order type (taker for market, maker for limit);
- crypto leverage adds funding and liquidation.

A truncation test proves that no strategy reads ahead. The validation layer
covers walk-forward, CPCV with purge and embargo, the deflated Sharpe, PBO,
Monte Carlo on trades and costs doubled. `review` turns these into PASS,
REVISE or REJECT.

## Tax

`TaxRegime` is abstract, with `FranceRegime` and `UsRegime` as its
implementations. It replays the ledger up to the year's end and converts each
amount at the ECB rate of its own date. Outputs:
- the year's events;
- totals and form boxes, each with its formula;
- obligations (2778-DIV, 3916, FBAR…);
- warnings for everything the engine cannot know, such as a PEA's value on
  the day of a withdrawal.

Parameters (`src/tax/rules.ts`) are versioned by year, and each carries its
sources and verification date. A missing year falls back with a staleness
warning, and `tax verify` prints the checklist to re-check by web search.

## MCP

`mcp` exposes the commands as tools, each one running the bundle in a child
process with `--json`, so a command's output can never corrupt the protocol
stream. The tools are read-only, plus ticket creation. HTTP binds to
127.0.0.1 and requires a bearer token.
