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
change once assigned; re-registering a key with the same value, unit and label
returns the same id, so a re-run into the same directory keeps an answer valid,
and moves its `fetchedAt` and `asOf` to the later read, so `check --max-age`
does not call a figure just read again stale. The same key in another unit or
under another label gets an id of its own.

## The check

`check` splits the answer into claims (paragraphs, list items, table rows,
blockquotes — the engine's claim parser — plus each heading and each table's
header row, which the parser sets aside as structure), reads every figure in
each claim with its own financial number reader (signs, `%`, `bn`/`Md`, French
and English separators, more than eight figures per row), and requires each
figure to be among the values of the `[E#]` the same claim cites, at the
precision written (`450.45` is not 450; no relative slack): a figure in a
heading or a header row needs its `[E#]` in that same line or row. Dates,
years, indicator settings, index names and spans are not figures, nor are a
heading's section number (`2.3`; in a heading that cites an `[E#]`, only the
closed form `2.` or `2.3.`) and a header cell holding only a whole number in a
row that cites no `[E#]` (a horizon or a year labelling its column); a heading
with no figure and no `[E#]` is a title, its date a label. A unit or scale
word the reader does not know, glued to a number (`777p`, `64GB`), never makes
the number vanish: the figure is held to an item stored in that unit. A
cited text item (a headline) holds the figures it writes; a document's plain
figures are read as written, never as a fraction a percentage could state. A
calendar date is checked on its own (`src/core/dates.ts` reads ISO, numeric,
French and English forms, `le 17/11` after a date word, and a range such as
`17–21 November 2026`): in a claim that cites evidence it must be a date a
cited `[E#]` holds or a cited document writes, and a date ahead with no `[E#]`
fails. Only a valid date is one: `2026-11-31` and `31/11/2026` are figures. A
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
each kind for its own TTL. Within one command, the same GET is sent once and
its answer shared between the slices that ask for it (`core/net.ts`); nothing
of that is kept from one command to the next.

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
| `facts/<domain>/<CC>-<period>.json` | facts the agent researched, each with its sources and date — today `facts/tax/<CC>-<year>.json`, the tax rules |
| `KILL` | the kill switch |

## From a view to an order

```
plan ─► ticket (draft) ─► ticket check ─► risk gate ─► checked (15 min, this exact order)
                                             │ block → blocked, with reason codes
checked ─► paper submit ─► fill on the live book / last price ± slippage ─► paper ledger
checked ─► broker preview (venue dry run) ─► broker code (out of band) ─► broker submit
             └─ preconditions: live switch, venue on, jurisdiction (researched: the
                crypto regime, then ESMA's MiCA register or the venue's fact), kill switch,
                breaker, limit order, no short, tier limits, no withdrawal right,
                1 % price band, the code bound to the fingerprint, the venue,
                the environment and the venue symbol
           ─► lock, audit, ONE request, audit ─► filled / accepted / rejected / unknown
           unknown ─► broker reconcile (query by clientOrderId, where the order went) — never a resend
                      not found ≠ never placed: the ticket stays unknown until the user
                      declares it, by code, ten minutes after the send at the earliest
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

ultrastock contains no tax law. `src/tax/rules.ts` holds only the schema:
for France and the United States the keys their engines read (each with a
label, a type, a unit, a search query and the kind of official source to
prefer — service-public.fr / BOFiP / Légifrance, IRS publications / Rev.
Proc.), and for any other country a generic list (capital gains rates and how
they apply, holding periods, cost method, crypto, allowances, dividends and
interest, loss carry-forward, wash-sale-like rules, reporting forms). Form
line and box numbers stay engine structure; the template lists those whose
numbering is year-dependent.

The values are the agent's research, stored per country and tax year in
`<home>/facts/tax/<CC>-<year>.json` through the researched-facts store
(`src/core/researched.ts`, see below). The workflow:

1. `tax rules template --country CC --year Y` prints the JSON skeleton, every
   value `null`.
2. The agent web-searches each key on official sources for that country and
   year, and fills `value`, `sources` (at least one URL), `verifiedAt` and
   `confidence`.
3. `tax rules set --file <json>` validates strictly (types, every value
   sourced, the year, no unknown key for an engine country) and stores it.
4. `tax report` computes (FR, US) or lists the facts (any other country, or
   `--neutral`); `tax rules show` prints the stored research and `tax verify`
   is the checklist of what to research or re-check.

Without a file for the exact year, or with a key an engine reads missing, the
engines refuse with a usage error naming the file, the missing keys and the
template command — never an earlier year's values.

The neutral facts report (`src/tax/neutral.ts`) is for any country: each
disposal with its proceeds and its cost under FIFO and under the weighted
average (the researched `costMethod` marks one), the acquisition dates and
holding periods, income (dividends, interest, rewards) with what was withheld,
and fees — in the base currency at each date's ECB rate. It computes no tax:
the researched rules are shown beside the facts for the agent to apply.
`tax export --format neutral|neutral-json` writes it.

Two choices are named rather than settled silently. US wash sales: §1091 and
Reg. 1.1091-1 speak of shares "acquired" within the window, and no authority
settles replacement shares sold before the loss sale; the engine applies the
text (they count) and warns on that event. A generic CSV that writes fee or tax
rows with both signs must say which sign is a charge
(`portfolio import --fee-sign charge-negative|charge-positive`): it is the
file's convention, not a tax rule, and is not guessed.

## Researched facts

`src/core/researched.ts` is the one store for facts that change over time and
are not built into the code. A domain (`defineDomain`) registers its keys per
country (name, label, type, unit, search query, preferred official source);
a file per domain, country and period (a year or a date) lives in
`<home>/facts/<domain>/<CC>-<period>.json`, written atomically. Validation is
strict, and a fact past its `expiresAt` or older than its key's `maxAgeDays`
reads as unknown. A `text` key may list its only accepted `values` (a status);
a domain may accept keys outside its list with their own spec (`extraKey`: a
per-venue key such as `cryptoVenue.kraken`). A `date` domain is read with
`loadLatestFacts`: each key's newest fact across the stored dates, so
researching one key on a later day keeps the others' earlier conclusions.

The domains — `src/core/domains.ts` is their registry: what `facts
research|template|set|show <domain>` and the MCP `facts` tool accept, each
domain's country and its default period:

| Domain | Keyed by | Keys | Read by |
|---|---|---|---|
| `tax` | country, tax year | the FR / US engines' rates, thresholds and periods; free keys elsewhere | `tax` (see above) |
| `jurisdiction` | country, research date | `polymarket`, `kalshi` (90 days), `us-domiciled-etf`, `crypto-casp`, `crypto-register` (`esma-mica`, `other`, `none`), `foreign-accounts`, `pfic` (US only) (180 days); `cryptoVenue.<venue>` and `cryptoVenue.<venue>.lei` | the risk gate (PRIIPS, JURISDICTION), live preconditions (Kalshi, crypto platforms), `broker status`, `predict polymarket`, `events`, `etf propose`, `analyze` / `etf`, `doctor`, `jurisdiction show|verify` |
| `funds` | fund domicile, research date | `withholding` | the domicile line of `analyze` / `etf` |
| `venues` | country of residence, research date | `<venue>.<market>.fees` ({maker, taker}), `ibkr.perUnit`, `ibkr.minimum`, `kalshi.feeFormula`, `kalshi.fees` (365 days); free `account.<id>.fees|perUnit|minimum` for another broker | paper fills, `backtest` (crypto), `portfolio rebalance`, Kalshi arbitrage |
| `calendar` | the exchange's country (US for XNYS, FR for XPAR, IT for XMIL, NO for XOSL), year (default this year) | `<MIC>.open`, `<MIC>.close` (local HH:MM), `<MIC>.specialClosures` (dates, `[]` for none), max age 120 days | `calendar`, session counts (journal settle, morning, catalysts), the closed-bar rule, option settlement times |
| `geo` | `EU` (the only country), the date the membership holds from | `eu.members`, `eea.nonEuMembers`, `euroArea.members` (ISO codes, max age 365 days) | the PEA first pass, the `pea-candidates` screen, `value --region europe\|pea`, European peers, the ECB exposure in `events` |

Every message that names a research command builds it with `researchCommand`,
`factsTemplateCommand` or `factsSetCommand` (core/researched.ts), so it names a
registered domain and flags the parser takes.

Every jurisdiction key is a status — `allowed`, `restricted`, `blocked` or
`unknown` — with a note saying what the sources state (`crypto-register`
names a register). `src/core/jurisdiction.ts` declares the keys and reads
them (`ruleFact`, `ruleStatus`, `rulesFor`, `cryptoVenueGate`); it holds no
status. A key never researched, stale, or concluded unknown reads as unknown,
and every reader fails closed on it with a refusal naming
`ultrastock facts research jurisdiction --country CC --key <key> --out <run>`.
A crypto platform passes when `crypto-casp` is `allowed`, or `restricted`
with the venue on the register `crypto-register` names: ESMA's MiCA register
is read at order time (its CSV links discovered on ESMA's MiCA page, the
first dated path only as a reported fallback; matched on the venue's LEI when
`cryptoVenue.<venue>.lei` is stored, else on its name and then the LEIs that
name found; an entry serves its home state and the states it passports to —
an entry with no passport list serves its home state only); any other
register needs the venue's own `cryptoVenue.<venue>` fact. The one per-country
hint left in code is the ANJ's DNS block page host, used only to report a DNS
block (`doctor`, `jurisdiction verify`), never to allow or refuse anything.

`facts research <domain> [--country] [--key] --out <run>` (src/research/facts.ts)
builds each key's queries (its `query`, and the same with `site:` for each
host its `prefer` names), runs the keyless search cascade of
`research --engine-search` — or takes the agent's own hits (`--web-results`,
one list per key, `angle` = the key) — reads the top hits on official hosts
(government suffixes, a list of regulators, the preferred hosts; a key with
none gets its best other hit, flagged unofficial) through the research reader
(HTML, PDFs, the Wayback rung, `--browser`), registers each as a document
`[E#]`, and writes `FACTS.<domain>.<CC>.md` (per key: the documents to read,
the fact to fill) and `FACTS.<domain>.<CC>.json` (the template with each key's
`evidence`). Nothing is concluded by the CLI: the model reads, fills the JSON
and stores it with `facts set <domain> --file <json>`. `facts template|show <domain>`
print the skeleton and what is stored; `facts … tax` runs `tax rules …`. The
MCP server exposes `facts show|template` only.

`src/core/geo.ts` is the only place EU, EEA and euro-area membership is read.
No keyless machine-readable official list was found to read live, so it reads
the latest stored `geo` research; without a current one it uses one built-in
list (as of 2026-01-01: 27 EU states, Iceland, Liechtenstein and Norway, the
21-state euro area with Bulgaria, sourced from europa.eu and efta.int), and
every output using it says so with the command to research a current one
(`ultrastock facts research geo --country EU --out <run>`). The lists are written in the
order earlier requests were recorded with (by English name; peers by code).

`src/core/calendar.ts` computes the holiday rules (observance, Easter, early
closes; `calendar verify` lists them against the exchange's page). What no rule
predicts is a `calendar` fact: the year's trading hours and one-off closures.
Without researched hours it uses the hours published when the file was written
(dated, sourced; `calendar sessions` says so). The past one-off closures stay
recorded up to the date they were checked; past it, without a researched list,
every session count (journal settle, the morning brief, catalyst clusters)
carries a note that it assumes no unresearched closure. Session times are
computed in the exchange's time zone with Intl, daylight saving included: a
bar dated today is final 15 minutes after the New York close (US), 20 minutes
after the Paris close (Euronext, Europe, funds: the auction and a 15-minute
feed), 75 minutes after New York's (world); US options settle at the New York
close, Deribit's at 08:00 UTC (its contract specification).

## MCP

`mcp` exposes the commands as tools, each one running the bundle in a child
process with `--json`, so a command's output can never corrupt the protocol
stream. The tools are read-only, plus ticket creation; a read-only tool's
process runs with `ULTRASTOCK_READ_ONLY=1`, so its ledger reads never migrate
the local store (`journal review` on a store of an older schema asks for
`portfolio show` instead). HTTP binds to
127.0.0.1 and requires a bearer token. A file a tool reads must sit in the
run directory of the same call; `check` asks more, since any tool given `out`
writes an `evidence.json` where it is told: the run holds one and is not the
home directory, a root or an ancestor of the home, and the answer is a `.md` or
`.txt` file at the run's top level written after the run was created. Any
other pair is refused before the file is read.

## Local dashboard

`serve` renders the user's state as server-side HTML pages in the style of
`report`, each with an `/api/…` twin returning the same view model as JSON:

| Route | Shows | Read from |
|---|---|---|
| `/` | total, cash, positions (quantity, average cost, price, day change, value, weight, P&L vs average cost), cash by account, unpriced lines, XIRR, realised P&L and dividends per currency, the breaker, the value over time | `loadMarkedBook`, the equity curve, the store's snapshots (read-only) |
| `/analysis/risk\|stress\|income\|location\|lookthrough` | the figures of `portfolio <analysis>` by section, with their formula, notes and sources | the same analyses, on an in-memory register |
| `/ledger` | the transactions, newest first, filtered by account or symbol | the ledger |
| `/journal` | decisions, settlements, hit rates, theses (overdue flagged), lessons | the journal |
| `/watch` | the watchlist and the alert rules (listed, not evaluated) | `state/` |
| `/tickets` | the tickets and the latest lines of the order audit trail | `tickets/`, `audit/` |

Every page takes `?book=real|paper` and states when it was computed and,
next to each input, its source and delay.

It writes nothing to `ULTRASTOCK_HOME`. The book is marked without recording
an equity snapshot (the breaker reads the recorded curve plus today's value,
in memory), the analyses register nothing, the SQLite store is opened
read-only without migrating, alerts are not evaluated and decisions are not
settled. When the ledger itself lives in the SQLite store (`portfolio db
init`) and that store was written by an older version, the page says so and
asks for `portfolio show` once, which migrates it: the dashboard never does.
The one file a page can cause to be written is the dataset cache of
the quotes and rates it reads (`ULTRASTOCK_CACHE_DIR`, by default
`ULTRASTOCK_HOME/cache`), exactly as `portfolio show` does. A test hits every
route and checks the home directory is unchanged byte for byte. The value over
time needs the local store (Node ≥ 22.5, `portfolio db init`, then
`portfolio track` daily); without it the page says so in one line. A missing
profile or an empty book is a hint naming the command to run, not an error.

Security, since the page is a person's finances:

- it binds 127.0.0.1 only (there is no flag to bind elsewhere) and answers only
  `Host: 127.0.0.1:<port>` or `localhost:<port>`, so a DNS-rebinding page
  cannot reach it under its own name; an `Origin` other than the dashboard's
  own (another site, or another local port) is refused;
- every route needs the token (`--token` or `ULTRASTOCK_SERVE_TOKEN`, 24+
  URL-safe characters, else 48 random hex digits per start). The printed URL
  carries it once: the first visit trades it for an `HttpOnly; SameSite=Strict`
  cookie and a redirect to the clean URL. `Authorization: Bearer` works too.
  Tokens are compared in constant time (SHA-256 digests, `timingSafeEqual`);
- `GET` and `HEAD` only (405 otherwise), no CORS header, and on every answer
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`;
- every value is HTML-escaped; `book` and the ledger filters must be values
  the dashboard knows (400 otherwise), and no part of a request becomes a
  path; an error shows its message, never a stack.

Concurrent requests for the same page and book share one computation, and the
net layer answers an identical GET from memory for five minutes, so a refresh
does not hammer the sources.
