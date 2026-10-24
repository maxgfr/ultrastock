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
- `holdings <manager>`: an institution's latest 13F (berkshire,
  pershing-square, bridgewater… or a CIK) with its changes since the previous
  quarter. 13Fs are filed up to 45 days after the quarter: old news by design.
- `congress`: US House periodic transaction reports (amounts are ranges).
- `short <symbol>`: short interest and days to cover (twice a month) and FINRA
  daily short *volume* — volume is not interest: most short volume is market
  making.
- `analyst <symbol>`: consensus targets, ratings, EPS estimates and surprises
  (unofficial). A consensus is an opinion with a herd; use it as context.
