# Fundamentals, filings and who is trading

## Statements — `fundamentals <symbol>`

| Listing | Source | Official |
|---|---|---|
| US filers | SEC XBRL company facts: annual (10-K), quarters (10-Q, derived from year-to-date when needed), TTM when four quarters exist | yes |
| European issuers (by ISIN) | ESEF annual reports (IFRS, consolidated) from filings.xbrl.org | yes (the issuer's filing) |
| fallback, or `--source crible` | maxgfr/crible: the latest period plus its Piotroski, Altman, Beneish and composite ranks | no (aggregated) |

- **Point in time**: `--asof 2025-06-30` keeps only what had been *filed* by
  that date — what an investor could know then. Restatements resolve to the
  latest filing, and each figure names the form and the filing date.
- Labels say the period (FY2025, FY2026Q2, TTM) and the concept read. A
  figure absent from the filing is absent from the evidence — never infer it.
- Free cash flow is operating cash flow minus capital expenditure (a formula
  point). Share-based compensation is a real cost: say when FCF is flattered.
- Set `ULTRASTOCK_SEC_CONTACT` to an e-mail: the SEC asks automated tools for one.

## Filings — `filings <US symbol> [--forms 8-K,10-Q]`, `filings --search "<text>"`

8-K items are named and the material ones flagged (results 2.02, acquisitions
2.01, impairments 2.06, auditor changes 4.01, non-reliance on past statements
4.02, officer departures 5.02…). A 4.02 or a 4.01 is a red flag to read first.

## Who is trading

- `insiders <symbol>`: SEC Form 4 for US listings — open-market purchases (P)
  matter; grants (A), option exercises (M) and tax sales (F) mostly do not;
  10b5-1 plan sales are scheduled. The 90-day net and a **cluster buy** (three
  or more insiders buying within 30 days) are the useful reads. French issuers:
  AMF declarations of managers' transactions (pledges, gifts and sales are
  classified from the declared nature).
- `holdings <manager>`: an institution's latest 13F (a name, found through
  EDGAR's name search and its list of 13F filers, ranked by EDGAR's own
  weight, so "bridgewater" is Bridgewater Associates; or a CIK) with its
  changes since the previous quarter. 13Fs are filed up to 45 days after the
  quarter: old news by design.
- `congress`: US House periodic transaction reports (amounts are ranges).
- `people`: one public figure's trades across sources — see below.

## Public figures — `people`

Who someone is, and what they filed, is asked of the official source every
time; nothing is kept as a list of people.

- `people search "<name>"` asks each source live and lists the refs
  (`source:id`) it may mean:
  - `house:` House members who filed a PTR (the Clerk's index)
  - `oge:` the President, the Vice President and Senate-confirmed officials
    (OGE's index)
  - `sec:<CIK>` an SEC filer: a fund filing 13Fs, a holder above 5%
    (Schedules 13D/13G), a person filing Form 4 as reporting owner, across
    every issuer
- `people show "<ref or name>" [--since <date>] [--filings <n>] [--limit <n>]
  [--positions]` lists the newest filings and their trades, each one an
  `[E#]` linked to its filing. A name that means several filers is refused,
  with the candidates listed.
- What each source gives:

  | Source | Due | Precision |
  |---|---|---|
  | House PTR | within 45 days of the trade (often later) | value bands |
  | OGE 278-T | within 30 days of notice, 45 days of the trade | value bands, scanned PDFs read through their OCR layer |
  | Form 4 | within two business days | exact shares and prices |
  | 13F-HR | up to 45 days after the quarter | positions at the quarter's end, changes against the previous 13F |
  | 13D / 13G | 13D within 5 business days of the event, 13G later | the stake's share of the class |

- **Positions:** `--positions` gives what the filings say is held:
  - a 13F's positions
  - the shares left after each issuer's latest Form 4
  - the latest 13D/13G stake
  - for a PTR or a 278-T, which report trades and not holdings: the net of
    the trades read, per asset, in value bands. The annual report (House FD,
    OGE 278e) is where holdings are listed.
- **OCR:** a 278-T row whose type, date or amount does not read to one value
  is counted ("rows that did not read") or left blank, never guessed. Install
  pdftotext (poppler) to read 278-Ts and more House PTRs (`doctor` says
  whether it is there).
- **The Senate:** eFD (efdsearch.senate.gov) is the only official source of
  senators' trades. It refuses automated clients (HTTP 403 since October 2026)
  and needs a terms-accepted session. ultrastock says so and does not work
  around it; no unofficial copy is substituted. Search a senator by hand.
- **The web on top — `people research "<ref or name>" --out <run>`:** the
  official figures are registered in the run, beside a research worklist
  (kind `person`; FR + EN queries on the filings themselves, trades, holdings,
  new and exited positions, strategy, conflicts of interest). Run the queries
  with your own web search and ingest them:
  `research --out <run> --web-results <file>`. webindex fetches, cleans and
  ranks the pages and PDFs, and each source becomes a document `[E#]` in
  DOSSIER.md. `--search-with claude|codex|ccs` or `--engine-search` runs the
  search in the same call. A name no official source knows — a European fund
  (its reports are on its site), a senator (eFD pages the press links) — is
  researched on the web alone. Web sources are context: a figure a filing
  gives is cited from the filing.
- **Follow:** `people follow "<ref>"` adds an alert that fires once per new
  filing (the filings already out are the starting point). `people check` runs
  those alerts, as does `watch run` (see journal-alerts).
- `short <symbol>`: short interest and days to cover (twice a month) and FINRA
  daily short *volume* — volume is not interest: most short volume is market
  making.
- `analyst <symbol>`: consensus targets, ratings, EPS estimates and surprises
  (unofficial). A consensus is an opinion with a herd; use it as context.
