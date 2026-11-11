# Citation format

## The token

An evidence id in square brackets: `[E3]`. Several at once: `[E3] [E7]`, or
`[E3, E7]` / `[E3; E7]` (read as the same thing). The ids are the run's — the
ones `BRIEF.md`, `evidence` or `calc` printed — and a run's ids never change
once assigned.

## What counts as a claim

Each paragraph, list item, table row and blockquote is a claim — and so is
each heading and each table's header row. A claim that states a figure must
cite, **in the same claim**, the `[E#]` that holds it: a table row cites in its
own cells, a list item in its own text, a heading in its own line, a header
row in its own cells (a column never grounds its header) — a lead-in sentence
above a list grounds nothing below it. `## Buy, target 450 €` with no `[E#]`
is refused.

Labels are not figures: a heading's section number (`## 1. Thesis`,
`### 2.3 Risks`; `2.3 bn` opening a heading is still a figure), a header cell
holding only a whole number (horizons and years heading columns: `+5`, `20`,
`J+60`, `2026`), and everything listed below. A heading with no figure and no
`[E#]` is a title: a date in it labels the section and is not held to the rule
for dates ahead.

A **figure** is any number written as a quantity: `383,00 €`, `−1.24 %`,
`$1.6 trillion`, `188,6 Md€`, `31.4x`, `12 bps`, `39,539,690 shares`. These are
not figures: dates (`2026-10-23`, `23/10/2026`, `Oct 23, 2026`), times, years
on their own, indicator settings (`RSI(14)`, `MACD(12,26,9)`, `MM50`, and a
moving average at a usual period: `SMA 200`, `EMA 50`), a chart timeframe
before an indicator (`15m RSI`, `4h MACD`), index names with their own number
(`CAC 40`, `S&P 500`, `Nasdaq 100`, `Nikkei 225`), filing forms (`10-K`,
`10-Q`, `20-F`, `40-F`, `8-K`, `6-K`), spans (`52 weeks`, `3 mois`, `5-day`),
week numbers (`Week 46`, `semaine 46`), an allocation split summing to 100
(`60/40`, `70/20/10`), labels glued to letters (`Q3`, `FY2025`, `J+5`), whole
numbers under ten (`3 positions`), and footnote markers (`[^3]`, or a number
glued to its word: `revenue[12]`). A value after an indicator's or an index's
name is a figure: `RSI 85`, `ADX 45`, `SMA 412`, `the Nasdaq 21000 level`. A link's text and a bracketed phrase are read like
any other text: `target [450]` and `results on [2026-12-01]` are a figure and a
date.

A **date** is checked on its own terms. In a claim that cites evidence, every
calendar date must be one a cited `[E#]` holds — its value, label or as-of day
(not the day it was read), or the text of a cited document — in any usual form: `2026-11-17`,
`17/11/2026`, `17 novembre 2026`, `Nov 17, 2026`, `le 17 novembre` (no year:
matched on the day). Only a valid date is one: in `85 may fall`, `In May 45 %
of revenue` and `en mars 12 % du CA` the number is a figure (a day past 31, a
unit after it, and `may` / `march` in lowercase are no date). A results date
copied wrong is refused even next to the right `[E#]`. A date **ahead** stated with no `[E#]` at all is refused too (the
user acts on it); a past day with no citation — "cours au 2026-10-27" — is
context and passes.

## What `check` accepts

A figure matches a cited `[E#]` when it is that value at the precision written:
`383` and `383,00` for 383.00; `12.3 %` for 12.34 %; `41,5 %` for −41.4999 %
(the sign may be carried by words: "41.5 % below" — but a minus written on the
figure is a claim too: `−41,5 %` is refused against +41.5); `188.6 bn` for
188 576 644 501; a fraction written as a percentage and back (`27.3 %` for
a unitless or ratio item of 0.2733 — a price, a count or an index of 0.45 is
not `45 %`). French and
English separators both read: `1 234,5`, `1,234.5`, `0,25`.

## Derived figures

A figure the evidence does not hold — a distance to a level, a ratio, a
difference, a CAGR — must be computed by the tool:

```bash
ultrastock calc <dir> "(E1 / E6 - 1) * 100" --label "MC.PA above its 52-week low" --unit %
# [E27] MC.PA above its 52-week low = 1.9566% (calc, as of 2026-10-23, eod) — (E1 / E6 - 1) * 100
```

Cite the new id. The formula reads only `E` ids (no constants alone), with
`+ - * / ^ %`, comparisons, `abs min max round pct share cagr`. Its provenance
is the stalest and least official of its inputs.

## What `check` refuses

| Problem | Meaning |
|---|---|
| `uncited` | a claim states figures, or a date ahead, and cites no `[E#]` |
| `dangling` | a cited `[E#]` is not in the run |
| `unsupported` | a figure or a date is in none of the claim's cited `[E#]` — the model wrote a number (or a day) of its own |
| `stale` | with `--max-age`, a cited figure was read longer ago than allowed |
| `empty` | the answer states nothing to check |

Notes, which do not fail: `inert` (an id only in code or a closing sources
list) and `unsourced` (a long claim with no figure and no citation — fine for
reasoning, not for a fact).
