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
ultrastock value --region pea --top 5 --research-with codex --research-top 2 --out <run>
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
the price, are off. Every venue ultrastock prices is valued — Euronext, the other
European venues, the US, and Yahoo's world venues (Tokyo, Hong Kong, Seoul,
Shanghai, Shenzhen, Taipei, São Paulo, Sydney, Johannesburg…); a name on a venue it
does not price (Lima) is "not valued", with the reason. A company reporting in
another currency than its quote (a Hong Kong line in CNY) is valued in its
statements' currency, the price converted as a derived [E#].

Then the runbook: for each of the first names, `ultrastock research <SYM> --ask
"pourquoi <name> est-il bon marché ?" --out <run> --for <SYM>`, your web search,
`research --out <run> --for <SYM> --web-results <file>` — a low multiple usually has
a story (a lawsuit, a lost contract, a cyclical peak, a holding discount) that the
screen cannot see. Each name's research files carry its symbol
(`RESEARCH.<SYM>.todo.json`, `DOSSIER.<SYM>.md`); the documents share the run's
one register, so `check` verifies the whole answer at once. Then the answer,
`check`, `report`. `--watch` adds an alert on each top name.

## `--research-with claude|codex`

Opt-in: after VALUE.md, the first `--research-top` names (3; across the styles, in
ranking order) are researched in the same run — the question "pourquoi <name>
est-il bon marché ?" made into a worklist, its queries searched by that agent
CLI's own web search (`research --search-with`, six queries a call, hits only),
the pages read and registered. VALUE.md is rewritten: a **Research** section names
each name's `DOSSIER.<SYM>.md`, the sources kept, the angles still under-covered
and the command for a second round (`research --out <run> --for <SYM>
--search-with codex`); the runbook starts from the dossiers. **Billed to the
user's plan** (about 2 cents a query with Claude's small model; Codex counts
against its quota; one name is about six queries) — use it when asked. A failed
search is reported for that name, never filled in; the other names go on.

## Rules

- A stale crible dataset (over 7 days, a newer one published) is said in VALUE.md's
  notes: say it in the answer, or refresh first (`screen --engine crible --bootstrap`).
- A screen result is a **candidate**, not a buy. Say what the gates could not
  judge (unknowns) and what the research found.
- Cheap against its sector is not cheap against its own history: say which.
- Never present a figure from VALUE.md without its [E#].
