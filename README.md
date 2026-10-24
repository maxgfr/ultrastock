# ultrastock

An investing copilot for an agent, built for real money: it reads prices from
the exchanges and regulators themselves — Euronext, Nasdaq, Binance — computes
the indicators, and numbers every figure as an evidence `[E#]` with its source,
its date and its delay. The agent writes the analysis; `ultrastock check`
refuses any answer that states a number the evidence does not hold. Keyless.

```bash
npx skills add maxgfr/ultrastock
```

Works with any skills-compatible agent (Claude Code, Codex, Cursor, Gemini CLI,
OpenCode and [many more](https://github.com/vercel-labs/skills)); add `-a <agent>`
to pick one, `-g` to install it for every project.

> **Status — 0.x, under construction.** Today: analysis of Euronext, US and
> crypto instruments with cited, checked evidence. Coming, milestone by
> milestone ([issues](https://github.com/maxgfr/ultrastock/issues)): profile and
> jurisdiction rules (PEA, MiCA, PRIIPs), every public data source
> (fundamentals from SEC and ESEF filings, macro, options, smart money, news),
> screening, a multi-perspective debate, portfolio and risk, a deterministic
> risk gate, paper trading, backtesting without look-ahead, FR/US tax, and
> guarded opt-in brokers. ultrastock is decision support, not a licensed
> adviser, and it places no order today.

## Invocation

```text
/ultrastock analyse LVMH
/ultrastock should I buy NVDA? technical read only
/ultrastock quelle est la tendance du bitcoin ?
```

## Why

An agent asked about a stock answers from memory: last year's price, a P/E it
half remembers, a target it made up. ultrastock makes every figure a fetched,
dated, sourced fact, and makes the answer prove it:

1. `analyze MC.PA --out <dir>` writes `evidence.json` — `[E1] MC.PA latest price
   = 383 EUR (euronext, as of 2026-10-23, eod)` and 25 more — and `BRIEF.md`.
2. The agent computes anything else with `calc <dir> "(E1 / E6 - 1) * 100"`,
   which registers the result as a new `[E#]`.
3. `check <dir> answer.md` exits 1 on a figure with no `[E#]`, an `[E#]` the run
   does not hold, or a figure none of its `[E#]` holds — "385,00 € is in none
   of [E1] [E2]".

## What you get

| Data | Source | Delay | Official |
|---|---|---|---|
| Euronext equities, ETFs, indices (Paris, Amsterdam, Brussels, Lisbon, Milan, Oslo, Dublin) | live.euronext.com | end of day, 2 years | yes |
| US stocks and ETFs | api.nasdaq.com | delayed / last sale, 10 years | no |
| Crypto spot pairs | api.binance.com | real time, closed bars | yes |

Per instrument: latest price, 52-week range, 1m/3m/6m/1y returns, SMA50/SMA200
and the trend state, RSI(14), MACD(12,26,9), ATR(14), Bollinger(20,2),
annualised volatility and maximum drawdown — each an `[E#]`.

## Commands

| Command | What it does |
|---|---|
| `ultrastock analyze <symbol>` | The instrument's evidence into a run: `evidence.json`, `BRIEF.md`, `RUNBOOK.md`. |
| `ultrastock quote <symbol>` | The latest price; `--out <dir>` registers it as evidence. |
| `ultrastock history <symbol>` | Daily bars (`--from`, `--to`, `--limit`), crypto down to 15 minutes (`--interval`). |
| `ultrastock calc <run> <formula>` | A derived figure from `E` ids, registered as a new `[E#]` (`--label`, `--unit`). |
| `ultrastock evidence <run>` | The run's evidence, one `[E#]` per line. |
| `ultrastock check <run> <answer.md>` | Every figure cited and found; `--max-age 1d` also fails stale figures. Exits 1 with a report otherwise. |
| `ultrastock doctor` | Version, state directory, Node, external tools; `--probe` times each source. |

Network commands take `--record <dir>` / `--fixture <dir>` (record and replay
what the sources answered), `--refresh` and `--offline` (the dataset cache);
every command takes `--json`. Node ≥ 18, nothing to install.

| Variable | Sets |
|---|---|
| `ULTRASTOCK_HOME` | state directory — runs now; profile, ledger and journal later (default `~/.ultrastock`) |
| `ULTRASTOCK_CACHE_DIR` | dataset cache (default `ULTRASTOCK_HOME/cache`) |
| `ULTRASTOCK_TIMEOUT_MS` | network budget per attempt (default 20000) |

## Security

- No API key, no account, nothing sent anywhere but the public data sources it reads.
- State lives outside the skill directory, under `ULTRASTOCK_HOME`; the repository holds no personal data.
- The formula language of `calc` is parsed, never evaluated as code: it reads only evidence ids and a whitelist of functions.
- A source's refusal (a jurisdiction block, a rate limit) is reported, never worked around.
- The engine is [webindex](https://github.com/maxgfr/webindex), vendored by tag and sha256 (`src/vendor/webindex.meta.json`) and checked in CI (`webindex skill vendor --check`).

## Maintenance

How it works: [DOCUMENTATION.md](DOCUMENTATION.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). See [shared engine maintenance](ENGINE-MAINTENANCE.md) for the engine pin and the daily repin workflow.

## License

MIT.

## On request or explicit-only

The skill ships **model-invocable, on request**: the agent may call it through
its skill tool, but the skill's description restricts it to explicit requests,
so the agent calls it when you ask, not on its own. Install it with `npx skills
add maxgfr/ultrastock`, or use the bundle directly: `node
skills/ultrastock/scripts/ultrastock.mjs --help`.

Making it explicit-only is one setting, read by Claude Code and OpenCode,
applied to the **installed** copy of the skill:

| Host | Shipped, on request | Explicit-only |
| --- | --- | --- |
| Claude Code, OpenCode | no `disable-model-invocation` in `SKILL.md` | add `disable-model-invocation: true` |

Claude Code can do it without touching the file:
`"skillOverrides": { "ultrastock": "user-invocable-only" }` in `settings.json`
leaves `/ultrastock` working while hiding the skill from the model. Updating or
reinstalling the skill restores the shipped default, so reapply the change afterwards.
