# ultrastock

An investing copilot for an agent, built for real money. It covers US and
European stocks and ETFs (PEA, CTO, assurance-vie), crypto and prediction
markets. It reads public, keyless data from the exchanges, regulators and
filings themselves, and numbers every figure as an evidence `[E#]` with its
source, its date and its delay.

The agent analyses, debates, decides and writes. `ultrastock check` refuses
any answer that states a number the evidence does not hold. From there the
same tool sizes the trade within the user's limits, runs it through a
deterministic risk gate, paper-trades it, journals the call and settles it
against the market. It prepares the tax return. It can also send a real order,
but only behind hard guards and a code only the human can read.

```bash
npx skills add maxgfr/ultrastock
```

Works with any skills-compatible agent (Claude Code, Codex, Cursor, Gemini CLI,
OpenCode and [many more](https://github.com/vercel-labs/skills)). Add
`-a <agent>` to pick one, or `-g` to install it for every project. It also
runs as an MCP server (`ultrastock mcp`).

> ultrastock is decision support, not a licensed adviser (CIF/AMF, RIA). Its
> output is information, not personalised advice.

## Invocation

```text
/ultrastock analyse LVMH — faut-il renforcer ?
/ultrastock find quality-growth stocks eligible for a PEA
/ultrastock is the US market risk-on? how much should I be invested?
/ultrastock backtest a 50/200 moving-average cross on bitcoin, honestly
/ultrastock prépare ma déclaration 2025 : PEA, CTO chez IBKR, crypto sur Kraken
```

## Why

An agent asked about a stock answers from memory: last year's price, a P/E it
half remembers, a target it made up, a backtest that peeks at tomorrow.
ultrastock makes every figure a fetched, dated, sourced fact, and makes the
answer prove it:

1. `analyze MC.PA --out <dir>` gathers the evidence and writes `BRIEF.md` and
   `RUNBOOK.md`. The evidence covers price and risk, the technical panel,
   valuation, catalysts, the market regime, news, insiders, analysts, the
   user's position, limits and jurisdiction, and past decisions. The runbook
   is a TradingAgents-style debate: analysts → bull / bear → judge → trader →
   risk trio → portfolio manager.
2. The agent computes anything else with `calc <dir> "(E1 / E6 - 1) * 100"`,
   which registers the result as a new `[E#]`.
3. `decide` records the call. It refuses a call with no falsifier, or a plan
   with no stop. `check` exits 1 on any figure without an `[E#]`, or with one
   that does not hold it. `report` renders the page.
4. `journal settle` scores the call at +5, +20 and +60 sessions against a
   benchmark. The hit rates are the honest record.

## What it covers

| Area | Commands | Sources (keyless) |
|---|---|---|
| Prices | `quote`, `history`, `analyze` (`--depth full`: peers, statistics, extra valuations, the web-research worklist), `technicals` (107 indicators, patterns, Minervini, VCP) | Euronext (official, end of day), Nasdaq, Yahoo for other EU venues, Binance → Kraken → Coinbase |
| Companies | `fundamentals` (point in time), `valuation` (Piotroski, Altman, Beneish, DCF, reverse DCF), `filings`, `insiders`, `holdings`, `analyst`, `short`, `dividends`, `congress` | SEC EDGAR, ESEF filings (filings.xbrl.org), crible, AMF, FINRA, House Clerk |
| Ideas | `screen` (TradingView presets per market, builtin technical screens per index, crible DSL), `value` (quality-value, deep value, dividend, GARP, magic formula; anti value-trap gates, sector percentiles), `universe` | TradingView scanner, crible, Wikipedia |
| ETFs | `etf compare/overlap/find`, `analyze <ETF>` → ETF.md (TER, replication, PEA, domicile and PRIIPs twins, holdings, tracking) | TradingView, Amundi, iShares, SEC N-PORT, crible |
| Web research | `research` — the host agent searches, ultrastock reads the pages and PDFs, keeps the documents as evidence, `check` refuses a figure the cited page does not state; `calc --from` | Any page the agent finds, plus crible for a listed company's statements |
| The day | `morning` — the brief that starts the day: the held lines, the `watchlist`, open theses, alerts and tickets; their next earnings and ex-dividend dates, stops near the price, alert conditions true now, the regime, the sessions, today's macro and the rate decisions ahead, ranked into a "To watch" list; the headlines naming each line; each flagged results date confirmed (or not) against the issuer's own calendar page on the web | The sources of `catalysts`, `regime`, `events`, `calendar` and `news`; the issuer's site through `research --focus calendar` |
| Events | `events` — elections, referendums and Fed/ECB decisions ahead and just past, the book's exposure, past reactions, the stress scenario, the book impact; `watch add events` | Wikipedia's electoral calendar, federalreserve.gov, ecb.europa.eu, Yahoo, Manifold |
| Market | `regime` (exposure coach), `sectors`, `catalysts`, `macro`, `rates`, `fx`, `calendar`, `sentiment`, `cot`, `news` | Treasury, ECB, Eurostat, INSEE, BLS, World Bank, CBOE, CNN, CFTC, Nasdaq, Google News, GDELT |
| Derivatives, crypto, prediction | `options`, `options-analysis` (GEX, skew, P&L matrix), `crypto`, `crypto-analysis`, `predict`, `predict-analysis` | CBOE, Deribit, Binance futures, CoinGecko, DefiLlama, CoinMetrics, Kalshi, Manifold; Polymarket only where lawful |
| Portfolio | `portfolio show/perf/import/risk/stress/optimize/rebalance/location/lookthrough/income/goals` | The user's ledger, with statements imported from IBKR, Binance, Kraken, Coinbase or any CSV |
| Trading | `plan`, `ticket`, `paper`, `broker` | The risk gate; paper fills on live books; Binance, Kraken, Coinbase, IBKR and Kalshi behind every guard |
| Learning | `decide`, `journal`, `watch`, `knowledge`, `report` | The user's own journal |
| Research | `backtest` (walk-forward, CPCV, deflated Sharpe, PBO, Monte Carlo, review), `strategy`, `stats` | The same price sources |
| Tax | `tax report/lots/harvest/rules/verify/export` (FR and US) | Sourced, yearly parameters, with a verification checklist |

Optional free keys add sources: FRED, CoinGecko, a Solana RPC.
`doctor --probe` lists what is reachable and what is active, and the maturity
of each command: **stable**, **beta** (unofficial sources) or
**experimental** (live venues).

## Safety

- **No figure from the model.** Every number is an `[E#]` with its
  provenance, and the answer is checked against them.
- **External text is data.** Headlines, filings and market rules are fenced as
  untrusted. They never fill a ticket, an alert or a profile.
- **A deterministic risk gate.** Every check has a reason code: stop, risk per
  trade, position, sector and crypto caps, cash buffer, the kill switch, the
  circuit breaker (daily, weekly and monthly loss), the overtrading guard,
  PRIIPs and the jurisdiction.
- **Live orders behind every guard.**
  - The switches: `ULTRASTOCK_LIVE=1`, set by the user, plus a ready paper
    record.
  - Venue and key: the venue must be authorised for the user's country (the
    ESMA MiCA register for crypto platforms; Binance is not, for France), and
    the key must not be able to withdraw.
  - The order: a limit within 1 % of the venue's book, inside the per-order
    and per-day limits of the experience tier.
  - Approval: a **6-digit code delivered out of band**, never in the agent's
    output, bound to that exact order.
  - Sending: **one request**. A lost answer is reconciled with the venue,
    never resent.
- **Limits ratchet.** They tighten at once. Loosening takes a code and 24
  hours.
- **Keys stay in the OS keychain**, are never taken on a command line, and
  are redacted everywhere. No withdrawal or transfer endpoint exists in the
  code.
- **Jurisdiction.** Polymarket is blocked for France (ANJ) and not even
  paper-traded. Kalshi is paper only from France. A block is never worked
  around.
- **Tax figures** carry their sources and verification date. The skill makes
  the agent re-check each year's parameters by web search before stating an
  amount.

## Commands

`ultrastock --help` lists every command and flag. Everything takes `--json`.
Data commands take `--out <run>` so their figures become citable evidence.
Network commands take `--record <dir>` / `--fixture <dir>` (record and replay)
and `--refresh` / `--offline` (the dataset cache). Node ≥ 18 for analysis and
paper trading, Node ≥ 22 for live orders. Nothing to install.

| Variable | Sets |
|---|---|
| `ULTRASTOCK_HOME` | the state directory — profile, ledger, tickets, journal, runs, audit trail (default `~/.ultrastock`) |
| `ULTRASTOCK_CACHE_DIR` | the dataset cache (default `ULTRASTOCK_HOME/cache`) |
| `ULTRASTOCK_SEC_CONTACT` | your e-mail for SEC EDGAR's fair-access policy |
| `ULTRASTOCK_FRED_API_KEY`, `ULTRASTOCK_COINGECKO_API_KEY`, `ULTRASTOCK_SOLANA_RPC` | optional keys |
| `ULTRASTOCK_NTFY_URL` + `ULTRASTOCK_NTFY_TOKEN`, `ULTRASTOCK_WEBHOOK_URLS` + `ULTRASTOCK_WEBHOOK_ALLOWLIST` | alert and approval-code channels |
| `ULTRASTOCK_LIVE`, `ULTRASTOCK_IBKR_CA_FILE`, `ULTRASTOCK_IBKR_CERT_SHA256`, `ULTRASTOCK_IBKR_URL` | live trading, and the pinned IBKR gateway |
| `ULTRASTOCK_MCP_TOKEN` | the bearer token of `mcp --transport http` |

## MCP

`ultrastock mcp` serves the commands as tools over stdio. With
`--transport http --token <24+ chars>` it serves them over HTTP on 127.0.0.1,
and the bearer token is mandatory. The tools are read-only, plus ticket
creation through `plan`. No tool submits an order, edits the profile or the
ledger, stores a key or moves a limit: those stay in front of the user.

## Maintenance

How it works: [DOCUMENTATION.md](DOCUMENTATION.md). Contributing:
[CONTRIBUTING.md](CONTRIBUTING.md). The engine pin and the daily repin
workflow: [shared engine maintenance](ENGINE-MAINTENANCE.md).

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
