# Analysis workflow

1. **Gather.** Run `ultrastock analyze <symbol> --out <dir> --json`, then read
   `<dir>/BRIEF.md` whole. It is the only source of figures for the answer.
   - The slice table says what is there and what is unavailable.
   - TECHNICALS.md and VALUATION.md sit beside it, in the same register.
   - An ETF gets ETF.md instead of VALUATION.md: costs, replication, PEA,
     domicile, holdings, tracking — see [etf](etf.md).
   - `--depth quick` keeps only the price and risk figures; `deep` runs three
     debate rounds.
   - `--depth full` is the complete analysis: deep, plus the statements over
     time, the peers (crible) with the premium or discount to their median,
     statistics against the benchmark and the peers, short interest and
     dividends (US), the option chain or crypto derivatives, residual income /
     dividend discount / WACC next to the DCF, and `RESEARCH.todo.json` — the
     web research the RUNBOOK starts with (step 0, see [research](research.md)).
     A slice that fails or runs over its time budget is listed unavailable.
   - `--since <old run>` adds DELTA.md: what moved since then.
2. **Debate.** Follow `<dir>/RUNBOOK.md` and write one note per role in
   `<dir>/notes/<role>.md`:
   - at full depth, the web research first (step 0): search the worklist,
     ingest it, search the under-covered angles again;
   - analysts (market, fundamentals or ETF, news and catalysts, and research at
     full depth), independent of each other;
   - then the bull and bear rounds;
   - then the judge (a rating on buy / overweight / hold / underweight / sell,
     a conviction, falsifiers);
   - then the trader (`plan`), the risk trio, and the portfolio manager's
     `decision.json`.

   With subagents (Claude Code, Codex, Gemini), run the analysts in parallel.
   Otherwise play each role in turn. Read the past decisions in BRIEF.md
   before you decide again.
3. **Decide.** `ultrastock decide <dir> <dir>/decision.json` refuses an [E#]
   the run does not hold, a missing falsifier, or a plan without a stop. It
   records the call in the journal, to be settled later.
4. **Read the state.** The trend state (`uptrend`, `downtrend`, `mixed`) is the
   alignment of the close with its 50- and 200-day averages; RSI(14) below 30 or
   above 70 is stretched, not a signal on its own; the MACD histogram's sign
   is momentum's direction; ATR(14) as a % of the price is a normal day's move.
5. **Compute what you need.** A distance to a level, a gap between two figures:
   `ultrastock calc <dir> "<formula>" --label …`, then cite the new `[E#]`.
6. **Form a view, with its horizon.** Technical evidence speaks to weeks and
   months, not to value. Say what the evidence supports and what it does not;
   name the level or the event that would change the view.
7. **Write and check.** Write `<dir>/answer.md`, then run `ultrastock check
   <dir> <dir>/answer.md` until it passes.
8. **Report.** `ultrastock report <dir>` writes `<dir>/report.html`, a
   self-contained page. It holds the answer, the decision (`decision.json`),
   each role's note from `<dir>/notes/<role>.md` folded, a one-year price
   chart, and the cited evidence linked to its sources.

## Pitfalls

- At full depth, a figure from a web page cites that page's [E#] and is written
  as the page writes it: `check` reads the page. Don't let the dossier replace
  the filings — when crible's statement figures and the press disagree, say
  which period each one covers.

- A falling price is not cheap and a rising one is not expensive: price action
  says nothing about valuation.
- An oversold RSI in a downtrend often stays oversold.
- A 52-week range on two years of Euronext history is complete; a 1-year return
  on a crypto pair counts calendar days, not sessions.
- Unofficial sources (Nasdaq's API) can change shape overnight: when a figure
  matters, say where it came from.
