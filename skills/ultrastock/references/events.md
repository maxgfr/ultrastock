# Market-moving events — ahead of time, and their impact on the book

`ultrastock events` answers "what is scheduled that can move what I hold, how
much could it cost, and what did the last one do?" — before the date, not after.

```bash
ultrastock events --out <run>                       # the next 60 days and the last 7, for the real book
ultrastock events --days 120 --country BR,US --out <run>
ultrastock events --all --days 30 --out <run>       # every market ultrastock knows, exposed or not
ultrastock watch add events --days 14 --min-weight 2   # warned before each event touching ≥ 2 % of the book
```

## What it reads

- **Elections and referendums**: Wikipedia's yearly *national electoral
  calendar* (community-maintained: a date can move — say so). Presidential,
  legislative, general elections and referendums; local ones are left out.
- **Rate decisions**: the Fed's and the ECB's own calendars (official). Other
  central banks (Copom, BoE, BoJ…) publish no calendar a keyless reader can
  parse: `calendar econ` lists their decisions in the current week.
- **Exposure**: the book's weight per country — by ISIN, else listing, else a
  single-country fund's name (EWZ → Brazil); a world or regional fund is
  multi-country (`portfolio lookthrough` breaks it down) — and per currency
  other than the base. A line with no price is weighed at cost, said so.

## What it computes, all as evidence

1. **Event study** — the same kind of event in the same country before (the
   previous presidential run-offs, the last FOMC decisions): the benchmark
   index and the currency from the last close before to the first close after,
   and five sessions on, **in the base currency**.
2. **Stress reference** — the index's worst single session in the base
   currency over at least ten years. A handful of past events is a small sample:
   Brazil's run-off of 2026 cost the Ibovespa −11.9 % in euros where none of the
   four before it had done worse than −2.2 %. Always read both.
3. **Book impact** — the country weight times the median, the worst past and
   the stress move: a stated scenario, not a forecast.
4. **Market pricing** — prediction markets (Manifold, play money; Polymarket only
   where lawful) and, for a vote within 60 days, the move the options of the
   country's US-listed ETF price to the first expiry after it.
5. **Just happened** — for an event of the last days: the index, the currency,
   the index in the base currency, and each of the user's exposed lines since
   the close before; plus the week's headlines on it (external text).

## How to answer

- Lead with the date and the size: "Brazil votes on 25 October; 30 % of the
  book is Brazilian; the stress scenario costs 5 % of the book in a session
  [E#]". The outcome is not the question — the position size is.
- The ways to cut the risk are to be weighed, never placed: trim before the
  date, hedge the currency leg, a put on the country ETF to the first expiry
  after the vote (its price is what the market expects), or keep it knowingly.
  Any trade goes through `plan`, the risk gate and the user's approval.
- After the event, separate the market's move from the line's own (EWZ fell
  more than the Ibovespa in euros: its dollar leg and its own composition) and
  research a line that did worse than its market.
