# Valuation and quantitative statistics

## `valuation <symbol>`

The command starts from the statements: SEC companyfacts for US issuers, ESEF
filings for European ones, and crible to fill gaps. Every input and every
output is an `[E#]`, and `VALUATION.md` is written in the run. It covers:

- **Scores with their components**: Piotroski F (nine tests), Altman Z″ and
  Beneish M (eight indices). Read the failing components, not just the total.
  A Beneish M above −1.78 flags possible earnings manipulation; it proves
  nothing.
- **Quality**: gross, operating and net margins; ROIC; free cash flow after
  stock-based compensation; leverage (net debt / EBITDA); accruals; dividend
  cover.
- **Multiples**: P/E, EV/EBITDA, EV/sales, P/B, FCF yield, PEG, the Graham
  number, the magic-formula earnings yield and return on capital.
- **DCF** in three scenarios (bear, base, bull) on free cash flow, discounted
  at a CAPM cost of equity. The inputs are the 10-year government rate, a
  2-year beta against the market index, and an equity risk premium (`--erp 5`
  by default). `--terminal` sets the terminal growth.
- **Reverse DCF**: the growth the current price implies. This is often the
  most useful line, so ask whether that growth is plausible.
- **Margin of safety** of the price against each scenario.

How to use it:
- A DCF is a sensitivity table, not a price target. Give the range and say
  which assumption moves it most.
- Banks and insurers: free-cash-flow DCFs do not apply. Use P/B against ROE and
  the dividend.
- Read IFRS (ESEF) and US GAAP figures with their differences in mind: leases,
  R&D capitalisation.
- The data is point in time: `fundamentals --asof <date>` reads the filings
  that were public on that date. Use it for any historical comparison.

## `stats <symbol> [<symbol> …]`

**With one symbol:**
- the distribution of returns: mean, volatility, skew, kurtosis;
- five volatility estimators: close-to-close, EWMA, Parkinson, Garman-Klass
  and Yang-Zhang;
- a GARCH(1,1) forecast;
- Hurst (below 0.5 means mean-reverting, above 0.5 trending) and ADF
  (stationarity);
- the two-state HMM's probability of the turbulent state;
- drawdowns;
- historical VaR/CVaR and Cornish-Fisher VaR;
- performance: CAGR, Sharpe, Sortino, Calmar, Ulcer index, and the
  probabilistic Sharpe ratio (the chance the true Sharpe is above 0);
- against a benchmark: beta, alpha, correlation, tracking error, information
  ratio, up and down capture, hit rate.

**With several symbols (up to 10):** Pearson and Spearman correlations, tail
dependence, and pairwise Engle-Granger cointegration with the hedge ratio and
the half-life.

How to read it:
- A Sharpe ratio on one or two years of data is noise. Quote the probabilistic
  Sharpe (the chance the true Sharpe is above 0) next to it.
- VaR understates fat tails. Quote the CVaR and the Cornish-Fisher VaR with it.
- Correlations rise in crises. Tail dependence says how much.
- Cointegration found on one window breaks often. Re-test it out of sample
  before trading the pair.
