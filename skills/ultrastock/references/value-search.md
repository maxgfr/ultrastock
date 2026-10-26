# Value search — `ultrastock value`

`value` looks for cheap companies in crible's audited fundamentals (SEC, ESEF,
registers; ~95 000 equities) and keeps out the ones that are cheap for a reason.
It ranks, it values the best names, and it hands you a runbook: why each one is
cheap is a question for the web, not for the screen.

```bash
ultrastock value --out <run>                                  # quality-value, whole world
ultrastock value --style deep-value --region pea --top 10 --out <run>
ultrastock value --style dividend --region FR,DE,IT --min-cap-eur 1000000000 --out <run>
ultrastock value --style all --region us --shortlist 40 --out <run> [--watch]
```

## Styles

| Style | Cheap means | Quality / safety read |
|---|---|---|
| `quality-value` (default) | high earnings yield | ROIC, Piotroski F, Altman Z, net debt / EBITDA |
| `deep-value` | NCAV / market cap, Graham number and its margin, P/E × P/B < 22.5 | current ratio |
| `dividend` | weighted dividend yield (capped near 12 % — above is a trap or a data error) | dividend coverage, payout, shareholder yield; TradingView's consecutive dividend growth on the shortlist |
| `garp` | PEG | 3-year revenue and net-income CAGR, ROIC, Mohanram G |
| `magic-formula` | Greenblatt earnings yield and return on capital (rank) | — financials and utilities excluded |
| `all` | every style, one ranking each | |

## Regions

`world` (default), `europe`, `us`, `pea`, or ISO country codes (`FR,DE,IT`).
crible's own `region` field is not geography (`world` there means "the rest");
`value` filters on the company's country. **PEA** needs both an EU/EEA country
and an EU/EEA ISIN prefix — VALUE.md marks it "to be confirmed security by
security": the broker and the issuer's documents decide, not a screen.

## What keeps a name out

**Hygiene** — a home listing on a real exchange (OTC lines, depositary receipts
and foreign echoes dropped, one line per issuer), sane multiples (0 < earnings
yield < 50 %, P/B > 0.05), a fiscal period under 18 months old, at least
`--min-cap-eur` (500 M). yfinance-sourced figures are marked unofficial.

**Anti value-trap gates** — each answers pass, fail, **unknown** (the field is
null: a distinct reason, never a pass) or skipped (does not apply):
Beneish M (managed earnings), interest coverage (debt service; skipped for a
financial), dilution (share count growth, net issuance), cash generation (years
of positive FCF, TTM FCF), Montier C (aggressive accounting), Ohlson O
(bankruptcy odds), Altman Z″ (distress; skipped for a financial), the falling
knife (52-week-high proximity, momentum rank). A name with too many unknowns is
set aside, and said so.

## Ranking

Percentiles **within each sector**, recomputed by ultrastock on the universe
that survived — a bank is compared with banks. A missing component counts as
the sector median, and no sector may take the whole shortlist. crible's own ranks
(by region × sector) are shown, never used. Every component is exposed.

## VALUE.md

The ranking, each figure with its [E#]; for each name, **why it is cheap**, **why
it is not a trap** (the gates), and **what would invalidate the thesis**. The
`--top` names are valued (`valuation`, one after the other, same register); a
margin of safety beyond ±100 % is flagged — it usually means the DCF inputs, not
the price, are off. Names ultrastock has no price history for are "not valued".

Then the runbook: for each of the first names, `ultrastock research <SYM> --ask
"pourquoi <name> est-il bon marché ?" --out <run>`, your web search, `research
--out <run> --web-results <file>` — a low multiple usually has a story
(a lawsuit, a lost contract, a cyclical peak, a holding discount) that the screen
cannot see. Then the answer, `check`, `report`. `--watch` adds an alert on each
top name.

## Rules

- A screen result is a **candidate**, not a buy. Say what the gates could not
  judge (unknowns) and what the research found.
- Cheap against its sector is not cheap against its own history: say which.
- Never present a figure from VALUE.md without its [E#].
