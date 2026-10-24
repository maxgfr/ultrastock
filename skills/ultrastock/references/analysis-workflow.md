# Analysis workflow

1. **Gather.** `ultrastock analyze <symbol> --out <dir> --json`. Read
   `<dir>/BRIEF.md` whole: Price, Range and returns, Trend and momentum, Risk.
   It is the only source of figures for the answer.
2. **Read the state.** The trend state (`uptrend`, `downtrend`, `mixed`) is the
   alignment of the close with its 50- and 200-day averages; RSI(14) below 30 or
   above 70 is stretched, not a signal on its own; the MACD histogram's sign
   is momentum's direction; ATR(14) as a % of the price is a normal day's move.
3. **Compute what you need.** A distance to a level, a gap between two figures:
   `ultrastock calc <dir> "<formula>" --label …`, then cite the new `[E#]`.
4. **Form a view, with its horizon.** Technical evidence speaks to weeks and
   months, not to value. Say what the evidence supports and what it does not;
   name the level or the event that would change the view.
5. **Write and check.** Write `<dir>/answer.md`, then run `ultrastock check
   <dir> <dir>/answer.md` until it passes.
6. **Report.** `ultrastock report <dir>` writes `<dir>/report.html`, a
   self-contained page. It holds the answer, the decision (`decision.json`),
   each role's note from `<dir>/notes/<role>.md` folded, a one-year price
   chart, and the cited evidence linked to its sources.

## Pitfalls

- A falling price is not cheap and a rising one is not expensive: price action
  says nothing about valuation.
- An oversold RSI in a downtrend often stays oversold.
- A 52-week range on two years of Euronext history is complete; a 1-year return
  on a crypto pair counts calendar days, not sessions.
- Unofficial sources (Nasdaq's API) can change shape overnight: when a figure
  matters, say where it came from.
