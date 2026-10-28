# The morning brief — what to look at before the open

`ultrastock morning` answers "what do my lines and the names I follow face
today and in the next two weeks, and what is the market doing?" in one run.
It writes `MORNING.md`; every figure and date in it is an `[E#]`.

```bash
ultrastock morning --out <run>                          # real book, 14 days of dated events
ultrastock morning --book paper --days 7 --out <run>
ultrastock morning --symbols ALO.PA,NVDA --out <run>    # extra names for this brief only
ultrastock morning --market eu,us --out <run>           # force the regimes read
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
- **Not available**: general-meeting (AGM) dates — no keyless source gives
  them. Say "unavailable", never guess.

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
3. Say which dates are projected or unofficial (TradingView, Nasdaq/Zacks
   "expected"): confirm on the issuer's investor-relations page before acting.
4. Dig before concluding: `catalysts <SYM>` (US: the options-implied move),
   `research <SYM> --focus results`, `analyze <SYM>`, `portfolio news`.
5. `ultrastock check <run> <run>/answer.md --max-age 36h`. One line: decision
   support, not personalised advice.

## Every day

`morning` is read-only on the user's state: it can run from cron or launchd
(`--notify` sends the HIGH flags to `ULTRASTOCK_NTFY_URL` with its token, or
to allowlisted webhooks — the same channels as `watch run`). `portfolio track`
once a day keeps the book's history next to it.
