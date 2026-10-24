# Tax: France and the United States

`tax` reads the ledger through the regime of the profile's tax residence (or
`--regime fr|us`) for one tax year. The default is last year; `harvest` uses
this year. Every amount is converted at the ECB rate of its own date.

It is a **preparation aid**: the broker's IFU (FR) or 1099 (US) and the
official notices decide. Say so once in the answer.

## Verify the rules first — every year

Tax parameters change every year. For example, the 2026 social-security law
raised the CSG on investment income, and the US brackets are indexed to
inflation. Each parameter in `src/tax/rules.ts` carries its value, its sources,
its `verifiedAt` date and a confidence level.

1. Run `ultrastock tax verify --regime fr --year <year>`. It lists every
   parameter, with a search query and its sources. When the year has no rules
   yet, it names the year it falls back to.
2. Web-search each parameter that matters to the user's question. Prefer the
   official text: BOFiP, impots.gouv, service-public, Légifrance, irs.gov.
3. If a value changed, tell the user. Do not use the stale figure, and say the
   code needs updating (value, sources, verifiedAt).

Parameters marked `medium` confidence rest on consistent secondary sources
only.

## France (`--regime fr`)

- **Securities on a CTO.** The gain is the net sale price minus the weighted
  average cost (PMP) of that security across the household's ordinary
  accounts, fees included.
  - A net loss is carried forward 10 years (`--carryforward 2024=1200,2023=300`).
  - The forms are 3VG / 3VH, and 2074 for the detail (`tax export --format 2074`).
- **PFU or the progressive scale.** The PFU is 12.8 % of income tax plus the
  prélèvements sociaux.
  - `--tmi 30` compares it with the scale: the 40 % dividend allowance and the
    deductible CSG.
  - The 2OP option covers **all** the household's investment income for the
    year.
- **Dividends** go in 2DC and interest in 2TR.
  - At a French broker, the 12.8 % instalment is withheld (2CK).
  - At a foreign broker (IBKR, Degiro, Trade Republic…), the user pays it with
    **2778-DIV** by the 15th of the next month.
- **Foreign withholding.** For US shares with a W-8BEN it is 15 %. It is
  credited in 2AB, up to the French tax on that income.
- **Foreign accounts.** Each one goes on **form 3916**, and each crypto
  account abroad on **3916-bis**. The penalties per undeclared account are
  listed in the output.
- **PEA / PEA-PME.** Nothing is taxed inside the plan.
  - A withdrawal is taxed on its share of the plan's gain. It needs the plan's
    value that day: `--envelope-value pea:2026-03-02=52000`.
  - After 5 years: social levies only.
  - Before 5 years: the plan closes, and 12.8 % is added.
- **Assurance-vie.** The gain share of a withdrawal is taxed at 7.5 % after 8
  years, beyond the 4 600 € / 9 200 € allowance (`--household couple`), and
  at 12.8 % before 8 years. Social levies are 17.2 %.
- **Crypto (CGI art. 150 VH bis, form 2086).** Only disposals for fiat or
  goods are taxed. Crypto-to-crypto trades, stablecoins included, are
  deferred.
  - The gain is the price minus the total acquisition price × price / the
    portfolio's value at that moment. ultrastock values the holdings at each
    disposal's daily close.
  - The year is exempt when disposals total 305 € or less.
  - Crypto losses only offset crypto gains of the same year.
  - The boxes are 3AN / 3BN. `tax export --format 2086` fills the form's
    lines.

## United States (`--regime us`)

- **Lots.** FIFO by default, or `--lot-method hifo|lifo`. The method must match
  the broker's standing instruction.
- **Holding period.** A sale after the first anniversary is long-term.
- **Wash sales.** A loss is disallowed when the same security is bought within
  30 days before or after the sale, in any account, an IRA included (then the
  loss is lost for good). The loss moves into the replacement's basis (code W
  on the 8949). Crypto is not covered as of the verification date; verify
  each year.
- **Losses.** Short-term nets against short-term and long-term against
  long-term, then across. Up to $3,000 ($1,500 married filing separately) of
  net loss deducts from ordinary income, and the rest carries forward
  (`--carryforward short=…,long=…`).
- **Rates.**
  - `--income <taxable ordinary income> --filing single|joint|separate|head`
    places long-term gains and qualified dividends in the 0 / 15 / 20 %
    brackets and computes the 3.8 % NIIT.
  - `--marginal-rate` taxes the short-term part.
- **Foreign accounts.** FBAR and Form 8938 obligations are flagged. PEA and AV
  are foreign accounts, and non-US funds are PFICs (Form 8621).
- **Exports:** `tax export --format 8949`, and `--format koinly` for the crypto
  transactions.

## Harvesting — `tax harvest`

`tax harvest` lists open positions under water and what selling them would
save this year, at today's prices.
- **FR:** there is no wash-sale rule, but a same-day sale and repurchase done
  purely for tax can be challenged. For crypto, the global formula realises a
  loss only when the portfolio is worth less than its acquisition price.
- **US:** it flags the wash-sale risk and the date before which the user must
  not rebuy.

Selling is the user's decision, through `plan` and the risk gate like any
order.
