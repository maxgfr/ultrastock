# The morning brief — what to look at before the open

`ultrastock morning` answers "what do my lines and the names I follow face
today and in the next two weeks, and what is the market doing?" in one run.
It writes `MORNING.md`; every figure and date in it is an `[E#]`.

```bash
ultrastock morning --out <run>                          # real book, 14 days of dated events
ultrastock morning --book paper --days 7 --out <run>
ultrastock morning --symbols ALO.PA,NVDA --out <run>    # extra names for this brief only
ultrastock morning --market eu,us --out <run>           # force the regimes read
ultrastock morning --research-with claude --out <run>  # also search the flagged results dates on the web (billed to the plan)
ultrastock morning --confirm --out <run>                # after YOUR web search of the run's calendar worklists
ultrastock morning --no-news --out <run>                # skip the headlines
ultrastock morning --notify                             # also send the HIGH flags (ntfy / webhooks)
ultrastock watchlist add ALO.PA SAP.DE --note "earnings season"
ultrastock watchlist list · watchlist rm SAP.DE
```

## The names it follows

The user defines them; the brief reads every place they live, each name
tagged with why it is there:

| Origin | Where it comes from |
|---|---|
| `held` | the ledger's open positions (`--book real|paper`), priced, with the last session's change |
| `ticket` | open tickets (draft, checked, working, submitted) |
| `thesis` | open theses (`idea`, `entry-ready`, `active`) — `journal thesis add` |
| `alert` | the symbols of `watch add <SYM> "<condition>"` rules |
| `watchlist` | `watchlist add <SYM>` — names followed without holding them |
| `asked` | `--symbols A,B`, for this run only |

At most 30 names are read; the rest are named in a note. With no profile or
no ledger, the holdings are skipped and said so; the rest still runs.

## What it reads

- **Company dates**: the next earnings and ex-dividend dates per name, the
  light mode of `catalysts` (US: Nasdaq/Zacks, TradingView standing in; elsewhere
  TradingView — unofficial; a projected date says so). Sessions to go are
  counted on the listing's calendar.
- **Guard rails**: the stop of each filled buy ticket against the latest price;
  the open tickets; the `watch` conditions **true now** — read without saving
  the rules' state, so `watch run` still fires on its edge; theses past their
  review date.
- **Market**: the regime (`regime --market …`) of the markets the names live in
  (Europe by default for a EUR profile with nothing followed); the next session
  and the closures of each venue; the high-impact macro releases of the
  currencies in play today and on the next weekday; the Fed and ECB decisions
  in the window, and the elections that touch the book (with its weight).
- **Headlines** of the last two days for the held lines, the names that moved
  3 % or more and those reporting within 3 sessions (Google News, the company's
  name searched as a phrase): only titles that name the company, never a quote
  page. External text — what was written, not what is true.
- **Not in any data feed**: general-meeting (AGM) dates. The calendar worklist
  asks the web for them; without a page that states one, say "unavailable".

## Dates on the web

A results date from a feed is unofficial. For each flagged one (at most 4),
the brief writes a `research --focus calendar` worklist in the run
(`RESEARCH.<SYM>.todo.json`: the issuer's financial calendar, the next
results, the general meeting) and the section **Dates on the web** says what
the pages read state:

| Status | Meaning — what to write |
|---|---|
| **confirmed** | the issuer's own page states the date: cite it (and the derived `[E#]` that records the confirmation) |
| press-only | only pages off the issuer's domain state it: "selon la presse" |
| **differs** | the issuer's page dates its next results otherwise: give the issuer's date, and say the feed disagrees |
| unconfirmed | none of the pages read states it: say so; the next round's queries are in the worklist |
| not searched | no page read yet: search it |

The loop, with your own web search (free, best index):

1. `morning --out <run>` → read `RESEARCH.<SYM>.todo.json`.
2. Run each query with your web search; save the hits as
   `[{ "angle": "financial-calendar", "query": "…", "results": [{ "url": "…", "title": "…" }] }]`
   (prefer the issuer's site: `…/finance/financial-calendar`, the investor
   pages, the last release that announces the next date).
3. `research --out <run> --for <SYM> --web-results <file>` — the pages become
   documents `[E#]`.
4. `morning --confirm --out <run>` — rewrites **Dates on the web**.

`--research-with claude|codex|ccs` does steps 2–4 inside `morning` (billed to
the user's plan, about 2 cents a query).

## The flags ("To watch")

Deterministic, most urgent first:

| Level | When |
|---|---|
| HIGH | earnings within 3 sessions on a followed name · a stop within 3 % of the latest price (or crossed) · an election or rate decision touching ≥ 2 % of the book within 2 days |
| MEDIUM | earnings later in the window · ex-dividend date of a held line · a `watch` condition true now · a thesis past its review date · a held line that moved ≥ 3 % over the last session · high-impact macro today · an event touching ≥ 2 % of the book later in the window · a Fed/ECB decision within 2 days |
| INFO | a held line's next earnings after the window (its results stay in sight) · entry-ready thesis · ex-dividend of a followed name within 3 sessions · a followed name's ≥ 3 % move · macro on the next weekday · later Fed/ECB decisions · a closed or half day today or on the next weekday |

Each flag ends with the command that digs into it.

## Writing the answer

1. Lead with **To watch**: the HIGH flags, each date with its `[E#]` and its
   timing (before the open / after the close). Before earnings on a held line,
   say that a stop does not protect against a gap — the size decides the risk.
2. Then the lines (session move, result against the average cost, weight),
   the names followed, the market in two or three sentences.
3. A results date is cited to the issuer's page once **confirmed**; until then
   say it is projected or unofficial (TradingView, Nasdaq/Zacks "expected").
4. Dig before concluding: `catalysts <SYM>` (US: the options-implied move),
   `research <SYM> --focus results`, `analyze <SYM>`; a headline that matters
   is read, not paraphrased: `research <SYM> --ask "…"`.
5. `ultrastock check <run> <run>/answer.md --max-age 36h` — it holds every date
   to the evidence: a results date copied wrong, or a date ahead with no
   `[E#]`, fails. One line: decision support, not personalised advice.

## Every day

`morning` is read-only on the user's state: it can run from cron or launchd
(`--notify` sends the HIGH flags to `ULTRASTOCK_NTFY_URL` with its token, or
to allowlisted webhooks — the same channels as `watch run`). `portfolio track`
once a day keeps the book's history next to it.
