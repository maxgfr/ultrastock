# Tax: your research, the ledger's facts

**ultrastock contains no tax law.** It holds no rate, no threshold, no
ceiling, no holding period. You look up the rules for the user's country of
tax residence and tax year on official sources, and store them with their
sources and the date you checked them. Without them, `tax` refuses to compute
and says what to research.

Say in the answer, once: the rules are your research (with their sources),
the figures are a preparation aid and not tax advice, and the user should have
a professional confirm them. For FR and US the broker's IFU / 1099 and the
official notices decide.

## The workflow — every country, every year

1. **Template.** `ultrastock tax rules template --country <CC> --year <Y>`
   prints a JSON skeleton: every key to research with `value: null`, its
   label, type, unit, a search query and the kind of official source to
   prefer.
   - FR and US: the full list of keys their engines read (rates, thresholds,
     ceilings, holding periods, windows, deadlines, penalties), plus the form
     lines whose numbering you must check on the year's forms.
   - Any other country: a generic list — capital gains rates and how they
     apply, holding-period rules, cost method, crypto treatment, annual
     allowances, dividend and interest taxation, loss carry-forward,
     wash-sale-like rules, reporting forms. Add `--currency <code>` (the tax
     currency); add any other key your research finds.
2. **Research.** Web-search each key for that country and **that** tax year.
   Prefer the official text: FR service-public.fr, impots.gouv.fr, BOFiP,
   Légifrance; US irs.gov publications, topic pages, Rev. Procs, the Code; for
   other countries the tax administration's own site and the tax code.
   Secondary sources only to find the official one — then say `medium` or
   `low` confidence.
3. **Fill.** For each key: `value` (a rate is a fraction: 30 % is `0.3`),
   `sources` (at least one URL of a public page), `verifiedAt` (today), `confidence`
   (`high` / `medium` / `low`), and a `note` for anything subtle (net of fees?
   threshold itself included?). Set `researchedAt`. Remove a key you could not
   research rather than guess it (an engine then refuses and names it).
4. **Store.** `ultrastock tax rules set --file <file.json>` validates strictly
   (types — years and days whole numbers, rates and thresholds in order — every
   value sourced and dated, the year — next year at the latest — no unknown key
   for FR / US)
   and stores it in `<home>/facts/tax/<CC>-<Y>.json`. A year already stored
   keeps the keys the new file does not hold (re-research one key with
   `--key` and store just it); the output says which were kept and which
   replaced. It lists what is still missing.
5. **Report.** `ultrastock tax report --year <Y>` (the country defaults to the
   profile's tax residence; `--country` overrides it).

`tax rules show` prints the stored research; `tax verify` is the checklist —
each key, its status (missing / researched / stale), its query and source.
Run it when a year starts or the law changed, and re-research what it flags.
A file of one year is never used for another.

## France and the United States: the engines

The engines compute with your stored values only. A missing file, a missing
key or a file for another year is refused with the file's path, the missing
keys and the template command.

- **France** — securities at the household's weighted average cost (PMP);
  the flat tax (PFU) against the progressive scale with `--tmi`; loss
  carry-forward (`--carryforward 2024=1200`); PEA / PEA-PME and assurance-vie
  withdrawals (`--envelope-value pea:2026-03-02=52000`, `--household couple`);
  crypto by the global portfolio formula of CGI art. 150 VH bis (one
  portfolio, whatever the platform or pair); foreign withholding credits;
  2778-DIV, 3916 / 3916-bis obligations. Exports: `--format 2074`, `2086`.
- **United States** — lots per account (`--lot-method fifo|hifo|lifo`), the
  basis carried by asset in dollars at the acquisition date whatever the pair
  (BTCEUR, BTCUSD, BTCUSDT are BTC); short / long term; wash sales; netting
  and the loss limit (`--carryforward short=…,long=…`); the long-term brackets
  with `--income` and `--filing`; NIIT; FBAR / 8938; PFICs. Exports:
  `--format 8949`, `koinly`.
- **Wash sale, an open question.** Replacement shares bought within the window
  but sold before the loss sale: §1091 and Reg. 1.1091-1 speak only of shares
  "acquired", and no authority settles the case. The engine applies the text
  (they count) and warns on that event; tell the user to confirm with a
  professional. Never counted there: shares that already replaced a loss,
  shares of the same purchase as those sold, and the shares of a loss sale
  whose loss the lot sold holds (Reg. 1.1091-1(e): that loss is deducted when
  the replacement shares are sold, IRS Pub. 550).

## Any other country: the neutral facts report

`tax report --country <CC>` (or `--neutral` for FR / US) computes **no tax**.
It lists, in the tax currency at each date's ECB rate:

- each disposal: date, asset, quantity, proceeds net of fees, the cost under
  FIFO **and** under the weighted average (the researched `costMethod` marks
  one when it names that method alone and plainly; a text that names both,
  excludes one or describes another is shown "as described", neither marked), the FIFO lots' acquisition dates and holding periods in days, and
  whether it was a crypto-to-crypto exchange;
- income: dividends, interest, staking and other rewards, with what was
  withheld; account fees.

The researched rules are printed beside the facts. **You** apply them —
rates, exemptions after a holding period, allowances, loss rules — and show
the arithmetic with `calc`, citing the facts' `[E#]` and the rules' sources.
`tax export --format neutral` (CSV) or `neutral-json` writes the report.

## Harvesting — `tax harvest` (FR, US)

Open positions under water and what selling would save this year at today's
prices, with the researched rates. The US flags the wash-sale risk and the
date before which not to rebuy. Selling is the user's decision, through
`plan` and the risk gate like any order.

## Importing statements

A generic CSV whose fee or tax rows carry both signs is refused until
`portfolio import … --fee-sign charge-negative|charge-positive` says which
sign is a charge: it is the file's convention, never guessed. The flag reads
only the type written with both signs; a type written with one sign
throughout is charges.
