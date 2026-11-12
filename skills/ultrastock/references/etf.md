# ETFs — the fund, not just the price

An ETF is analysed as a fund: what it holds, what it costs, how it replicates,
where it is domiciled, whether it fits a PEA, how well it tracks — and how it
compares with the other funds on the same index.

```bash
ultrastock analyze CW8.PA --out <run>                    # → ETF.md (and BRIEF.md, TECHNICALS.md)
ultrastock etf compare CW8.PA,EWLD.PA,IWDA.AS --out <run>
ultrastock etf overlap IWDA.AS,EMIM.AS --out <run>
ultrastock etf find "MSCI World" --pea [--acc|--dist] [--ucits] [--currency EUR] --out <run>
ultrastock etf find --asset bond --currency EUR [--focus "Investment grade"] [--exposure europe] [--sort ter] --out <run>
ultrastock etf propose --envelope pea --risk 5 --amount 10000 --out <run>    # → PROPOSAL.md, TARGETS.json
```

## ETF.md

- **Costs and size**: TER, AUM, NAV, premium/discount to NAV, flows. AUM, NAV
  and flows are in the fund's reporting currency (often USD, even for a EUR
  listing): say which.
- **Distribution**: accumulating or distributing.
- **Replication**: the issuer's field (Amundi), else "Swap" in the name, else
  **unknown** — never guessed. A swap ETF holds a *substitute basket*: its lines
  are not its exposure (the index is), so no sector or country breakdown is drawn
  from them.
- **PEA**: the issuer's flag (Amundi `FUND_PEA`), else "PEA" in the name as a
  hint, else **unknown — check the KID or the broker**. Never deduced from the
  domicile (CW8 is Luxembourg-domiciled and PEA-eligible).
- **Domicile**: the fund's country (else the ISIN prefix), with what it means for
  withholding tax on dividends — the sentence you researched for that domicile
  (`facts research funds --country IE --out <run>`, then `facts set funds`),
  else "not researched" and the command. ultrastock states no treaty or rate.
- **Retail access to a US-domiciled ETF** is the profile country's researched
  rule `us-domiciled-etf` (in the EU/EEA, the PRIIPs key information
  document): unless it reads "allowed" — not researched included — ETF.md
  proposes **UCITS twins** (same index, ranked by TER then AUM), and `plan`
  blocks the order (the risk gate's PRIIPS check, with the research command).
- **Holdings** (physical funds): top 10, sectors, countries, line count (iShares,
  Amundi, SEC N-PORT for US funds), and the weighted multiples of the top lines
  from crible with their coverage.
- **Tracking**: NAV performance against funds on the **same index and the same
  fund currency**, each read on a listing in the same quote currency — NAV
  returns are in the listing's currency, so a USD line and a EUR line of the same
  fund differ by the exchange rate, not by tracking. Otherwise: not comparable.

## compare, overlap, find

- `compare` (2–6 funds): the fields above side by side, the correlation of daily
  returns, and the holdings overlap.
- `overlap`: the sum of the smaller weight over the common lines, and those lines.
  Unavailable for swap funds (no real holdings); matched by ticker or name when a
  file carries no ISIN (it then reads low — say so).
- `find`: funds on an index or a theme, one listing per fund, filters for PEA,
  accumulating/distributing, UCITS and the listing currency.

## Browsing the catalogue (`etf find` with no query)

TradingView's own fund taxonomy, verified live: `--asset` equity, bond (fixed
income), commodity, multi-asset (asset allocation); `money-market` is a bond
fund whose index names an overnight rate, a T-bill or a money-market index
(€STR, SOFR, SONIA…) and `real-estate` an equity fund whose focus is real
estate — TradingView has no class for either. `--focus` takes TradingView's
focus ("Large cap", "Small cap", "Investment grade", "High yield", "Gold",
"High dividend yield", "Theme", a sector…); `--exposure` the region of the
holdings (global, developed, emerging, europe, north-america, asia-pacific,
latin-america, global-ex-us, middle-east-africa). `--sort aum` (default),
`ter` (cheapest first) or `perf` (1-year NAV total return). Leveraged and
inverse funds are left out unless `--leveraged`. `--pea` with a bond or
commodity asset finds nothing: say why (a PEA holds no such fund).

## `etf propose` — a starting point from a stated convention

`ultrastock etf propose [--goal core|growth|income|defensive] [--envelope
pea|cto|av] [--risk 1-7] [--amount <EUR>] [--max-funds 4] [--acc|--dist]
[--currency EUR] [--hedged] --out <run>` writes `PROPOSAL.md` (the allocation,
each fund's figures, why it was chosen, two alternatives, what the envelope
cannot hold, the assumptions, a runbook) and `TARGETS.json` — the
`{"SYMBOL": weight}` object `portfolio rebalance --targets` takes.

The risk score is `--risk`, else the profile's (`profile suitability`); with
neither, the command refuses — never guess one. Present the result as **a
convention, not advice**, and say which convention:

| Risk | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Equity share (core, income) | 10 % | 25 % | 40 % | 55 % | 70 % | 85 % | 100 % |

Defensive takes 15 points off, growth adds 10 (within 0–100). Each sleeve is
then split by the goal:

| Goal | Equity sleeve | The rest |
|---|---|---|
| core | world 75, emerging 15, small caps 10 | euro government bonds 100 |
| growth | world 60, Nasdaq-100 25, emerging 15 | euro government bonds 100 |
| income (distributing) | high dividend 70, world 30 | euro government 60, euro corporate 40 |
| defensive | world 100 | euro government 65, money market 35 |

A line under 5 % of the plan, or beyond `--max-funds`, is folded into its
sleeve's first line; weights are whole percentages summing to 100. A
`--max-funds` below the plan's sleeves (one fund each for the equity and the
rest) is a usage error that names the minimum.

- **Envelope.** Inside a PEA, a line keeps only funds whose issuer flags them
  eligible (Amundi FUND_PEA) or that say "PEA" in their name (a hint) —
  ultrastock asserts no eligibility rule of its own. A line no such fund fills
  (the bonds, in practice) is placed **outside**, in a CTO or an
  assurance-vie, and PROPOSAL.md says so — never silently dropped; an equity
  line with no eligible fund (world small caps) folds into the world line.
  PEA eligibility is the issuer's flag or the name hint; no other issuer publishes the flag keylessly (iShares'
  screener is gone, BNP Paribas Easy, Xtrackers and HSBC expose none, Euronext
  gives the SRD only). For an assurance-vie: the fund list is the insurer's —
  say "check your contract's list".
- **Funds.** Candidates are TradingView funds on the bucket's indexes (MSCI
  World / FTSE All-World / MSCI ACWI; MSCI EM; Nasdaq-100; Bloomberg Euro
  Treasury / Euro Aggregate / iBoxx Euro Sovereigns…), listed in the currency
  asked, kept when: plain index (no factor, sector or maturity slice — an ESG
  version only when no plain one qualifies, said so), UCITS and not
  US-domiciled unless the researched `us-domiciled-etf` rule reads "allowed"
  (for a US profile, not non-US unless the researched `pfic` rule reads
  "allowed"), not leveraged or inverse, not
  currency-hedged unless `--hedged`, AUM ≥ 100 M (reporting currency), launched
  ≥ 1 year ago when known (age then only weighs in the score), the distribution asked (income: distributing).
  Younger funds that pass everything else are named in the notes.
- **Score** (out of 100): 40 × cost (1 − TER / 0.50 %) + 30 × size
  (log10(AUM / 100 M) / 2) + 20 × tracking (0.5 + the 1-year NAV total-return
  gap to the other kept funds on the same index and fund currency, in points;
  0.5 without peers) + 10 × age (years / 10). The best is the pick, the next
  two are alternatives.
- **Between the picks**: the correlation of daily returns (one year) and the
  holdings overlap where both funds are physical and a keyless source covers
  them; a pair at ρ ≥ 0.95 or ≥ 50 % overlap is flagged redundant.

Then follow PROPOSAL.md's runbook: `analyze` each pick (ETF.md), `research
<ETF> --kind etf` for its factsheet and KID, answer citing the [E#] (weights,
TER, AUM, scores), name what the envelope could not hold, `check`.

## Rules

- Two funds on one index differ by cost, replication, domicile, distribution and
  tracking — compare those, not the price.
- PEA eligibility and replication are facts from the issuer or unknown; say
  which.
- At full depth (`analyze <ETF> --depth full`) the research worklist covers the
  factsheet, the KID, holdings, replication, PEA and tracking difference: the KID
  is the document that settles PEA and costs.
