# How ultrastock works

```
symbol ─► router ─► provider ──► bars / quote ─► analytics ─► evidence.json ─► BRIEF.md
            │        (euronext,      (+ provenance:          ([E1]…[En], each with
            │         nasdaq,         source, url,            source, asOf, delay,
            │         binance)        fetchedAt, delay,       official)
            │                         official)                      │
            ▼                                                        ▼
       net layer ── live │ --record <dir> │ --fixture <dir>    agent writes answer.md
       (one door to      (raw HTTP answers,  (replay, offline,         │
        the network)      timestamped)        same ids)                ▼
                                                            calc ─► new [E#] (derived)
                                                                       │
                                                                       ▼
                                                      check: every figure cited and found
```

## The evidence register

`<run>/evidence.json` holds every figure the tool handed to the agent, in the
order it was registered: `id` (`E1`…), `key` (`MC.PA.rsi14`), `label`, `value`,
`unit`, and its provenance — `source`, `url`, `fetchedAt`, `asOf`, `delay`,
`official`, and for derived figures `derivedFrom` and `formula`. Ids never
change once assigned; re-registering a key with the same value returns the same
id, so a re-run into the same directory keeps an answer valid.

## The check

`check` splits the answer into claims (paragraphs, list items, table rows,
blockquotes — the engine's claim parser), reads every figure in each claim with
its own financial number reader (signs, `%`, `bn`/`Md`, French and English
separators, more than eight figures per row), and requires each figure to be
among the values of the `[E#]` the same claim cites, at the precision written.
Dates, years, indicator settings, index names and spans are not figures. A
closing sources list is set aside.

## Determinism

`--record` stores each raw HTTP answer under a hash of its request, with the
time of the recording; `--fixture` serves them back and takes the recording
time as "now", so the date windows ask for the same URLs. A request the
fixture never recorded is an error, not a live call. The offline evals and
the Node-18 CI job run entirely on fixtures.

## Look-ahead

Every indicator returns an array aligned with its input, `undefined` until its
window is full: index *i* only ever uses bars 0…*i*. Crypto bars still forming
at read time are dropped.
