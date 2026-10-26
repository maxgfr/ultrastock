# ETFs — the fund, not just the price

An ETF is analysed as a fund: what it holds, what it costs, how it replicates,
where it is domiciled, whether it fits a PEA, how well it tracks — and how it
compares with the other funds on the same index.

```bash
ultrastock analyze CW8.PA --out <run>                    # → ETF.md (and BRIEF.md, TECHNICALS.md)
ultrastock etf compare CW8.PA,EWLD.PA,IWDA.AS --out <run>
ultrastock etf overlap IWDA.AS,EMIM.AS --out <run>
ultrastock etf find "MSCI World" --pea [--acc|--dist] [--ucits] [--currency EUR] --out <run>
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
  withholding tax on dividends (qualitative — no rate is stated without a
  source).
- **PRIIPs**: a US-domiciled ETF has no KID, so an EU retail investor cannot buy
  it — for a French profile ETF.md proposes **UCITS twins** (same index, ranked
  by TER then AUM), and `plan` blocks the order (the risk gate's PRIIPS check).
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

## Rules

- Two funds on one index differ by cost, replication, domicile, distribution and
  tracking — compare those, not the price.
- PEA eligibility and replication are facts from the issuer or unknown; say
  which.
- At full depth (`analyze <ETF> --depth full`) the research worklist covers the
  factsheet, the KID, holdings, replication, PEA and tracking difference: the KID
  is the document that settles PEA and costs.
