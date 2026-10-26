import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readBrief, analyzeSymbol } from "./analyze/pack.js";
import { analyzeFull, DEPTHS, type Depth } from "./analyze/full.js";
import { calcEvidence, calcFromDocument } from "./calc.js";
import { checkAnswer, NOTE_KINDS } from "./check.js";
import { reportCommand } from "./commands/report.js";
import { researchCommand } from "./commands/research.js";
import { stackCommand } from "./commands/stack.js";
import { EvidenceStore, formatEvidence } from "./core/evidence.js";
import { ExprError } from "./core/expr.js";
import { clockNow, FixtureMiss, setNetMode } from "./core/net.js";
import { runDirFor } from "./core/paths.js";
import { technicalsCommand, valuationCommand } from "./commands/analytics.js";
import { calendarCommand } from "./commands/calendar.js";
import {
  analystCommand,
  congressCommand,
  dividendsCommand,
  filingsCommand,
  fundamentalsCommand,
  holdingsCommand,
  insidersCommand,
  resolveCommand,
  shortCommand,
} from "./commands/fundamentals.js";
import { cotCommand, fxCommand, macroCommand, newsCommand, ratesCommand, sentimentCommand, universeCommand } from "./commands/macro.js";
import { cryptoCommand, optionsCommand, predictCommand, snapshotCommand } from "./commands/markets.js";
import { backtestCommand, strategyCommand } from "./commands/backtest.js";
import { brokerCommand } from "./commands/broker.js";
import { serveMcp } from "./mcp.js";
import { decideCommand, journalCommand, knowledgeCommand, watchCommand } from "./commands/journal.js";
import { jurisdictionCommand, profileCommand } from "./commands/profile.js";
import { taxCommand } from "./commands/tax.js";
import { paperCommand, planCommand, portfolioCommand, ticketCommand } from "./commands/trading.js";
import { catalystsCommand, regimeCommand, sectorsCommand } from "./commands/regime.js";
import { screenCommand } from "./commands/screen.js";
import { etfCommand } from "./commands/etf.js";
import { valueCommand } from "./commands/value.js";
import { cryptoAnalysisCommand, optionsAnalysisCommand, predictAnalysisCommand, statsCommand } from "./commands/quant.js";
import { doctorReport, formatDoctor } from "./doctor.js";
import {
  argBool,
  argInt,
  argValue,
  type CliSpec,
  type CommandArgs,
  ENGINE_VERSION,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  isInvokedDirectly,
  jsonLine,
  parseArgs,
  runId,
  setCacheMode,
  UsageError,
} from "./engine.js";
import { getHistory, getQuote, resolveSymbol } from "./providers/router.js";
import { type Interval, ProviderError } from "./providers/types.js";
import { VERSION } from "./version.js";

export const HELP = `ultrastock v${VERSION} (webindex ${ENGINE_VERSION})
An investing copilot for an agent: US and European stocks and ETFs, crypto —
public, keyless data read from the exchanges and regulators themselves, every
figure registered as an evidence [E#] that the answer must cite, and a check
that refuses a figure the evidence does not hold.

USAGE
  ultrastock analyze <symbol> [--depth quick|standard|deep|full] [--since <run>] [--out <dir>] [--json]
  ultrastock quote <symbol> [--out <dir>] [--json]
  ultrastock history <symbol> [--from <date>] [--to <date>] [--interval 1d|1w|4h|1h|15m] [--limit <n>] [--json]
  ultrastock calc <run> <formula> --label <text> [--unit <unit>] [--key <key>] [--json]
  ultrastock calc <run> --from <E#> "<figure as the document writes it>" --label <text> [--unit <unit>] [--json]
  ultrastock evidence <run> [--json]
  ultrastock check <run> <answer.md> [--max-age <90m|36h|3d>] [--json]
  ultrastock report <run> [--answer <answer.md>] [--json]
  ultrastock profile init [--jurisdiction FR] [--currency EUR] [--json]
  ultrastock profile show|suitability [--answers <file>]|set <field> <value>|envelope <id> --type PEA [--broker <name>] [--json]
  ultrastock jurisdiction show|verify [--jurisdiction FR] [--venues binance,kraken,coinbase] [--out <dir>] [--json]
  ultrastock calendar sessions|holidays|verify [--market XPAR|XNYS|XMIL|XOSL|CRYPTO] [--days <n>] [--year <yyyy>] [--json]
  ultrastock calendar econ|earnings|dividends [<date>] [--limit <n>] [--out <dir>] [--json]
  ultrastock macro us|ea|fr|<country>|fred <ID> [--days <n>] [--out <dir>] [--json]
  ultrastock rates [us|ea] [--out <dir>] [--json]
  ultrastock fx [USD,GBP,…] [--out <dir>] [--json]
  ultrastock cot <market> [--report legacy|tff] [--out <dir>] [--json]
  ultrastock sentiment [all|cnn|crypto|vix|putcall] [--out <dir>] [--json]
  ultrastock research <symbol|name> [--kind equity|etf|crypto|company] [--focus results] [--ask "<question>"] [--name <search name>] --out <run> [--json]
  ultrastock research --out <run> --web-results <websearch.json|-> | --urls <a,b> | --search-with claude|codex | --engine-search [--browser] [--no-wayback] [--limit <n>] [--json]
  ultrastock research <symbol|name> --search-with claude|codex [--search-model <m>] --out <run> [--json]   (worklist, search and ingestion in one call)
  ultrastock news <query> [--symbol <SYM>] [--lang en|fr] [--days <n>] [--limit <n>] [--out <dir>] [--json]
  ultrastock universe <SPX|NDX|DJI|CAC40|SBF120|DAX|SX5E|AEX|UKX> [--out <dir>] [--json]
  ultrastock resolve <name|ticker|ISIN> [--out <dir>] [--json]
  ultrastock fundamentals <symbol> [--asof <date>] [--years <n>] [--quarters <n>] [--source sec|esef|crible] [--out <dir>] [--json]
  ultrastock screen <preset|query> [--engine tradingview|crible|builtin] [--market <m>] [--universe <idx|list>] [--limit <n>] [--sort <field>|-<field>] [--bootstrap] [--all-listings] [--out <dir>] [--json]
  ultrastock screen --list [--engine tradingview|crible|builtin] [--json]
  ultrastock etf compare <A,B,C> | etf overlap <A,B> | etf find "<index|theme>" [--pea] [--acc|--dist] [--ucits] [--currency EUR] [--limit <n>] [--out <dir>] [--json]
  ultrastock value [--style quality-value|deep-value|dividend|garp|magic-formula|all] [--region world|europe|pea|us|<ISO,…>] [--shortlist 30] [--top 10] [--min-cap-eur <n>] [--watch] [--out <run>] [--json]
  ultrastock regime [--market us|eu|crypto] [--out <dir>] [--json]
  ultrastock sectors [--market us|eu] [--out <dir>] [--json]
  ultrastock catalysts <symbol> [--days <1-90>] [--out <dir>] [--json]
  ultrastock technicals <symbol> [--interval 1d|1w|4h|1h|15m] [--indicators <name:k=v;…,…>] [--benchmark <symbol>] [--out <dir>] [--json]
  ultrastock valuation <symbol> [--erp <pct>] [--terminal <pct>] [--out <dir>] [--json]
  ultrastock filings <US symbol> [--forms 8-K,10-Q] [--days <n>] [--limit <n>] | filings --search <text> [--out <dir>] [--json]
  ultrastock insiders <symbol> [--limit <n>] [--out <dir>] [--json]
  ultrastock holdings <manager|CIK> [--limit <n>] [--out <dir>] [--json]
  ultrastock analyst <US symbol> [--out <dir>] [--json]
  ultrastock short <US symbol> [--out <dir>] [--json]
  ultrastock dividends <US symbol> [--limit <n>] [--out <dir>] [--json]
  ultrastock congress [--member <name>] [--doc <DocID>] [--year <yyyy>] [--limit <n>] [--out <dir>] [--json]
  ultrastock portfolio show|perf [--book real|paper] [--out <dir>] [--json]
  ultrastock portfolio risk|stress|optimize|location|lookthrough|income [--book real|paper] [--benchmark <sym>] [--universe a,b,c] [--out <dir>] [--json]
  ultrastock portfolio rebalance --targets <file.json|{"CW8.PA":60,"CASH":5}> [--band <pts>] [--rel-band <%>] [--contribution <amount>] [--book] [--out <dir>] [--json]
  ultrastock portfolio goals --target <amount> --years <n> [--monthly <amount>] [--book] [--out <dir>] [--json]
  ultrastock portfolio import <file> --format ibkr-flex|binance|kraken|coinbase|generic --account <id> [--book real|paper] [--map <json|name|file.json>] [--dry-run] [--json]
  ultrastock portfolio deposit|withdraw <account> <amount> [--currency EUR] [--date <date>] [--book real|paper]
  ultrastock portfolio add buy|sell|dividend|fee|interest|tax|split --account <id> [--symbol] [--quantity] [--price] [--amount] [--fee] [--currency] [--date] [--book]
  ultrastock plan <symbol> --account <id> [--entry <n>] [--stop <n>] [--target <a,b>] [--venue paper] [--ticket] [--out <dir>] [--json]
  ultrastock ticket list|show|check|cancel [<ticket-id>] [--status <s>] [--json]
  ultrastock paper book|submit <ticket-id>|sweep|readiness [--json]
  ultrastock decide <run> <decision.json> [--json]
  ultrastock tax report|lots [--regime fr|us] [--year YYYY] [--book real|paper] [--tmi <rate>] [--marginal-rate <rate>] [--filing single|joint|separate|head] [--income <n>] [--carryforward 2024=1200,…|short=…,long=…] [--envelope-value <account>:<date>=<value>] [--lot-method fifo|hifo|lifo] [--household single|couple] [--out <dir>] [--json]
  ultrastock tax harvest|rules|verify [--regime fr|us] [--year YYYY] [--json]
  ultrastock tax export --format 8949|2086|2074|koinly [--regime fr|us] [--year YYYY] [--out <dir>]
  ultrastock journal settle|hits|review|digest [--book real|paper] [--json]
  ultrastock journal thesis list|add|show|move [<id>] [<state>] [--symbol] [--thesis] [--invalidation] [--catalysts] [--review-by] [--note] [--outcome] [--ticket-id] [--json]
  ultrastock journal lesson <text> [--tags <a,b>] | journal lessons [--tag <t>] [--json]
  ultrastock knowledge import <file> [--title <text>] [--json]
  ultrastock backtest run <strategy> <symbol> [--from] [--to] [--years N] [--interval 1d|4h|1h|15m] [--capital N] [--fee|--maker|--taker|--slippage %] [--leverage N] [--perp] [--benchmark <sym>|none] [--universe INDEX] [--trail %] [--atr-stop p:m] [--time-stop N] [--risk %] [--max-dd %] [--entry market|limit] [--limit-offset %] [--stop %] [--target %] [--out <dir>] [--json]
  ultrastock backtest run <buy-and-hold|60-40|equal-weight|dual-momentum|risk-parity> <sym1,sym2,…> [--rebalance monthly|quarterly] [--lookback 12] [--cash-rate 0] [--out <dir>] [--json]
  ultrastock backtest walkforward|sweep|montecarlo|review <strategy> <symbol> [--grid alias.param=a,b;…] [--objective sharpe|sortino|cagr|calmar|profit-factor] [--train N] [--test N] [--anchored] [--trials N] [--groups 6] [--test-groups 2] [--purge 5] [--embargo N] [--paths 5000] [--seed 42] [--out <dir>] [--json]
  ultrastock backtest compare <s1,s2,…> <symbol> · backtest decisions [--rating buy|…] [--horizon 5|20|60] [--json]
  ultrastock broker status|setup <venue>|balances|open|limits [set]|panic [--venue binance|kraken|coinbase|ibkr] [--env test|live] [--max-order <n>] [--max-daily <n>] [--venues a,b] [--attest a,b] [--code <code>] [--json]
  ultrastock broker preview|code|submit|reconcile|cancel <ticket-id> [--venue <v>] [--env test|live] [--code <code>] [--conid <id>] [--json]
  ultrastock mcp [--transport stdio|http] [--port 8765] [--token <24+ chars>]
  ultrastock strategy list | show <name|file.json> | validate <name|file.json> | new <name> [--like <strategy>] [--json]
  ultrastock watch list|add <symbol> <condition>|add 8k <symbol>|add stops|rm <id>|run [--notify] [--message <text>] [--json]
  ultrastock options <symbol> [--expiries <n>] [--out <dir>] [--json]
  ultrastock options-analysis <symbol> [--expiry <date>] [--strategy <spec>] [--spot-moves=<list>] [--rate <pct>] [--out <dir>] [--json]
  ultrastock stats <symbol> [<symbol> …] [--days <n>] [--benchmark <symbol>] [--out <dir>] [--json]
  ultrastock crypto-analysis <coin> [--days <n>] | crypto-analysis yields <symbol> [--limit <n>] [--out <dir>] [--json]
  ultrastock predict-analysis kalshi <SERIES|market:TICKER> | manifold <terms> [--my-probability <p>] [--kalshi-fee <coef>] [--contracts <n>] [--limit <n>] [--out <dir>] [--json]
  ultrastock crypto global|top|coin|derivatives|defi|yields|stables|fees|onchain|dex|holders [<target>] [--limit <n>] [--out <dir>] [--json]
  ultrastock predict kalshi|manifold|polymarket [<query>] [--limit <n>] [--out <dir>] [--json]
  ultrastock predict order kalshi <TICKER> yes|no [buy|sell] --contracts <n> --price <0-1> [--account <id>] [--json]
  ultrastock snapshot <symbol> [--market <tv-market>] [--out <dir>] [--json]
  ultrastock searxng up|down|status [--json] · ultrastock firecrawl up|down|status · ultrastock stack up|down|status
  ultrastock doctor [--probe] [--json]
  ultrastock version

  Any command that reads the network also takes:
    --record <dir>   save every HTTP answer it reads as a replayable fixture
    --fixture <dir>  replay a recorded fixture instead of the network (offline)
    --refresh        ignore the dataset cache    --offline   serve only the cache

SYMBOLS
  MC.PA, ASML.AS, CW8.PA, an EU ISIN   Euronext — official end-of-day prices
  NVDA, QQQ, BRK.B                     US stocks and ETFs (api.nasdaq.com, unofficial)
  BTCUSDT, ETH-EUR, SOL/USDC           Binance spot (official, real time; -USD reads USDT)

COMMANDS
  analyze   Gather an instrument's evidence into one run directory. quick: price,
            52-week range, returns, averages and the trend state, RSI, MACD, ATR,
            Bollinger, volatility and drawdown. standard (default) adds the
            technical panel (TECHNICALS.md), valuation for a company
            (VALUATION.md), the 30-day catalysts, the market regime, a week of
            news, insiders (US, Paris) and analysts (US), the user's portfolio
            context (holding / flat / not provided), the profile's limits, the
            jurisdiction's rules and past decisions. deep: three debate rounds
            and more headlines. full: deep plus the statements over time, the
            peers (crible) and statistics against the benchmark and the peers,
            short interest and dividends (US), the option or crypto-derivatives
            reading, residual income / DDM / WACC, and the web-research
            worklist (RESEARCH.todo.json) the RUNBOOK starts with. --since <run> writes DELTA.md against an earlier
            run. BRIEF.md indexes the slices (a failed one is named, never
            filled in); RUNBOOK.md is the debate: analysts → bull / bear → judge
            → trader → risk trio → portfolio manager → decide → check → report.
  quote     The latest price. With --out, registers it in that run's evidence.
  history   Daily (or crypto intraday) bars, oldest first; --limit keeps the last n.
  calc      Compute a derived figure from evidence ids — "(E3 / E7 - 1) * 100" —
            and register it as a new [E#] (abs, min, max, round, pct, share, cagr…).
            --from E12 "4,2 Md€" registers a figure a document [E#] states — refused
            when the document does not state it.
  evidence  List a run's evidence, one [E#] per line.
  report    The run as a self-contained HTML page (report.html): the answer, the
            recorded decision, the debate's notes (notes/*.md), a price chart
            and every cited [E#] linked to its source. Refused while the answer
            fails check.
  check     Check an answer against its run: every figure sits in a claim citing
            an [E#] of the run, and is one of the values those [E#] hold (rounding
            allowed). --max-age also fails figures read longer ago than that.
            Exits 1 with a line-by-line report otherwise.
  profile   The investor: residence and tax residence, base currency, horizon,
            risk score and limits (the risk gate's rules), envelopes (PEA, CTO,
            AV…). \`suitability\` prints the questionnaire to ask; with --answers it
            scores it (1–7) and sets the limits. Every change is kept in history.
  jurisdiction  What the investor's country allows, rule by rule with sources;
            \`verify\` checks crypto venues against ESMA's MiCA register and
            regulator DNS blocks, and lists what a web search must confirm.
  calendar  Exchange sessions, holidays and early closes, computed from the
            exchanges' rules; \`verify\` lists what to confirm for a year;
            econ / earnings / dividends list the day's scheduled events.
  macro     Inflation, jobs, growth: US (BLS, FRED), euro area (ECB, Eurostat),
            France (INSEE), any country (World Bank); \`fred <ID>\` for one series.
  rates     Yield curves (US Treasury, euro AAA), policy rates and €STR, credit
            spreads (high yield, investment grade).
  fx        Euro reference rates (ECB; Frankfurter as fallback).
  cot       CFTC Commitments of Traders: net positioning and its 26- and
            156-week index (0–100) for a futures market.
  sentiment CNN Fear & Greed, crypto Fear & Greed, the VIX term structure,
            Cboe put/call ratios.
  news      Recent articles (Google News, GDELT; Yahoo for a symbol) — titles
            are external text, fenced as untrusted.
  research  Web sources compiled into evidence: writes the angles and queries
            (FR + EN) for your own web search — business model, results,
            governance, controversies, short-sellers…; an ETF's factsheet, KID,
            replication, PEA; --focus results for the latest report, --ask for
            one precise question — then, with --web-results, fetches the pages
            and PDFs, drops walls and duplicates, registers each as a document
            [E#] (sources/E#.md, DOSSIER.md, under-covered terms for a second
            round) and cross-checks a listed company against crible. \`check\`
            refuses a figure the cited document does not state. Hits come
            from your search (--web-results, - for stdin; --urls), or
            --search-with claude|codex (your agent CLI's own web search,
            headless, batched — billed to your plan), or --engine-search (a
            local SearXNG from \`webindex stack up\`, then keyless engines).
            A refused or walled page falls back to its Wayback copy
            (--no-wayback to skip) and, with --browser, a render in a separate
            browser; an official page's linked PDF reports are read too.
  universe  An index's current members (Wikipedia) — current only: a backtest
            over them has survivorship bias.
  resolve   A name, ticker or ISIN → the Euronext listings, the SEC registrant,
            the LEI (GLEIF) and FIGI identifiers that match.
  fundamentals  Key statement figures: SEC XBRL for US filers (annual, quarters,
            TTM; --asof keeps only what was filed by then — point in time), ESEF
            IFRS reports for European issuers, crible as fallback (with its
            Piotroski, Altman, Beneish and rank fields).
  screen    Screens on three engines. tradingview (its presets: value,
            quality-growth, momentum, breakout-52w, dividend-growth,
            oversold-quality, small-cap-value, magic-formula, garp, etf,
            pea-candidates) over a whole --market (america, france, germany, uk…,
            europe = 14 markets merged, crypto); builtin technical screens on
            daily bars for --universe SPX|NDX|CAC40|SBF120|DAX|SX5E|AEX|UKX|<list>
            (≤ 120 symbols: minervini, vcp, canslim-technical, momentum-burst,
            exhaustion-hammer, pullback-to-50, golden-cross, rs-leaders); crible
            (--engine crible: a crible preset or any DSL, e.g. "piotroski_f >= 7
            AND country IN ('FR','DE')"; --bootstrap downloads its dataset once,
            about a minute; primary listings only, ADRs of an issuer listed
            at home dropped, --all-listings keeps every line). --list prints
            every preset's rules and source.
  etf       ETFs as funds. compare (2–6): TER, AUM, NAV, flows, dividend
            treatment, domicile, UCITS, hedging, index, replication, PEA,
            holdings, the correlation of daily returns and the overlap of
            holdings. overlap: Σ of the smaller weight over common lines, and
            those lines. find: funds on an index or a theme (TradingView), one
            listing per fund; --pea keeps the issuer-flagged (Amundi FUND_PEA)
            and name hints, --acc/--dist, --ucits, --currency (the listing's).
            PEA is never deduced from the domicile; a swap ETF's substitute
            basket is never read as its exposure. analyze on an ETF writes ETF.md.
  value     A value search on crible's audited fundamentals: candidates by a
            minimal DSL per style (quality-value by default, deep-value,
            dividend, garp, magic-formula, all) over --region world (default),
            europe, pea (EU / EEA country AND ISIN — to confirm security by
            security), us or ISO codes, at least --min-cap-eur (500 M); hygiene
            (home exchanges, no ADRs, one line per issuer, sane multiples, a
            period under 18 months) and anti value-trap gates (Beneish, interest
            coverage, dilution, cash generation, Montier, Ohlson, Altman Z″,
            falling knife — null is "unknown", never a pass); a composite of
            sector-relative percentiles recomputed on the filtered universe;
            the --shortlist registered as evidence, the --top valued one after
            the other on the same run. Writes VALUE.md (why cheap, why not a
            trap, what would invalidate it, then the research runbook);
            --watch adds an alert on each top name.
  regime    Market regime and an exposure ceiling. us: SPY trend, RSP/SPY
            breadth, HYG/LQD credit, SPY/QQQ distribution days and follow-through,
            VIX/VIX3M, CNN Fear & Greed read contrarian, % of US large caps above
            their 200-day. eu: CAC 40 trend, euro-area large-cap breadth, VIX term;
            CW8 and the ECB AAA 2s10s as context. crypto: BTC trend and 30-day
            return, alt breadth, funding, drawdown from the high. Every signal,
            component, weight and the zone / max exposure / new-entries call is
            evidence; missing inputs renormalise the weights and are named.
  sectors   Sector leadership. us: the 11 SPDR sector ETFs vs SPY (1/3/6-month
            relative performance, RS rank, above the 50/200-day). eu: large caps
            of FR/DE/NL/IT/ES grouped by sector. Two or more defensives in the
            top four reads as risk-off.
  catalysts What can move an instrument in the next --days (default 30): next
            earnings, ex-dividend dates, important 8-Ks and insider cluster buys
            (US), high-impact macro releases for its currency, exchange holidays,
            the options-implied move to the first expiry after the window (US),
            and clusters of two or more catalysts within 3 sessions.
  technicals The full technical picture, each reading an [E#]: averages, ADX,
            Supertrend, Parabolic SAR, Ichimoku cloud, Aroon, RSI, MACD,
            stochastic, Williams %R, CCI, ROC, ATR, Bollinger %B and bandwidth,
            Keltner, Donchian, chandelier exit, MFI, Chaikin money flow,
            relative strength vs a benchmark, the 52-week range, Minervini's
            trend template, VCP, support and resistance, recent gaps, breakouts
            and candlesticks, and a bullish score with a reason per point;
            --indicators adds any of the 107 registry indicators. Writes TECHNICALS.md.
  valuation What the business earns and what the price assumes: Piotroski,
            Altman Z″ and Beneish scores with their components, quality (margins,
            ROIC, FCF after SBC, leverage, accruals), multiples, a bear/base/bull
            DCF on free cash flow at a CAPM cost of equity (10-year government
            rate, 2-year beta, --erp 5 by default), the growth the price implies,
            and the margin of safety — every input and output an [E#]. Writes
            VALUATION.md.
  filings   Recent SEC filings, 8-K items named and the important ones flagged;
            --search runs EDGAR full-text search.
  insiders  Insider trades: SEC Form 4 (open-market buys and sells, 90-day net,
            cluster buys) for US listings; AMF declarations for French issuers.
  holdings  An institution's latest 13F: top positions, weights, and what it
            bought, added, trimmed and sold since the previous quarter (45-day lag).
  analyst   Price targets, ratings, EPS estimates and surprises (Nasdaq, unofficial).
  short     Short interest and days to cover (Nasdaq) and daily short volume (FINRA).
  dividends Dividend history, yield and ex-dates (Nasdaq).
  congress  US House periodic transaction reports, and one report's trades.
  portfolio The user's holdings: an append-only ledger per book ("real" for what
            they hold, "paper" for simulation) — positions, cash, average cost
            (PMP) and FIFO lots recomputed from the transactions, marked to market
            in the base currency (ECB rates); perf gives the money-weighted return
            (XIRR), realised results and the circuit breaker's state. import
            reads a broker statement into the ledger: IBKR Flex Query (XML or
            CSV) and Activity Statement CSV, Binance trade and transaction
            history, Kraken trades.csv and ledgers.csv, Coinbase history, or any
            CSV through a column map (--map '{"date":"Date","type":"Type",
            "symbol":"Ticker","quantity":"Qty","price":"Price","fee":"Fees",
            "amount":"Amount","currency":"Ccy"}', or boursorama, fortuneo,
            trade-republic — unverified layouts, checked against the file's
            headers). French or English numbers, dates and type words; re-import
            adds nothing (content ids); a sell beyond holdings refuses the whole
            file; skipped rows are listed with their reason; --dry-run writes
            nothing. For crypto, --map '{"quote":"EUR"}' names the pair coin
            deposits and rewards are booked against.
            Analyses of a book marked to market, every figure an [E#]: risk
            (exposures by class, currency, sector, country; HHI, volatility,
            VaR/CVaR historical, Cornish-Fisher and 10-day bootstrap, beta,
            drawdown, correlations, limit breaches), stress (GFC, COVID, 2022
            rates, crypto winter replays and parametric shocks), optimize
            (min-variance, risk parity, HRP, max-Sharpe on Ledoit-Wolf, capped
            at maxPositionPct), rebalance (bands into whole-share orders with
            fees and tax notes), location (best envelope per holding, PEA room),
            lookthrough (ETF holdings from iShares, Amundi, SEC N-PORT), income
            (received, forward 12 months, yield on cost), goals (seeded Monte
            Carlo, the monthly contribution for 80 %). None places an order.
  plan      From a view to an order within the profile's limits: entry, a stop
            below support or 2 ATR, targets at 2R and 3R, the size from the risk
            per trade (and every cap), dry-run through the risk gate → ready,
            ready with conditions, not ready or reject. --ticket creates the ticket.
  ticket    The only way to an execution: list, show, check (re-runs the risk
            gate on fresh prices; a check lasts 15 minutes), cancel.
  paper     Paper trading on real prices: submit a checked ticket (crypto walks
            Binance's order book; others fill at the last price plus slippage,
            fees included), sweep working limit orders against the bars traded
            since, book, and readiness — whether the paper record is good enough
            (20 trades, 30 days, positive expectancy, profit factor > 1.2,
            drawdown < 15 %) to consider real money.
  decide    Validate a decision (rating, horizon, conviction, thesis, the [E#] it
            rests on, falsifiers, an optional plan with a stop) against the run's
            evidence, then record it in the journal for settlement.
  tax       The ledger through the tax regime of the profile's residence (or
            --regime fr|us) for a tax year (default: last year; harvest: this
            year). report: the year's totals, the form boxes (2042-C 3VG/3VH,
            2DC, 2TR, 2CK, 2AB, 3AN/3BN, 2086, 2074, 2047; 8949, Schedule D,
            NIIT…), obligations (2778-DIV, 3916 / 3916-bis, FBAR, 8938) and what
            is missing. FR: PMP, PFU vs the progressive scale with --tmi, losses
            carried 10 years (--carryforward 2024=1200), PEA / AV withdrawals
            (--envelope-value pea:2026-03-02=52000), crypto by the global
            formula of art. 150 VH bis (portfolio valued at each disposal).
            US: FIFO/HIFO/LIFO lots, wash sales, ST/LT, the $3,000 limit,
            0/15/20 % brackets with --income and --filing, NIIT. lots: every
            realised event; harvest: positions under water and what selling
            saves; rules: each envelope's rules; verify: every parameter with
            its sources and a search query to re-check this year; export:
            CSV for 8949, 2086, 2074 or Koinly. Every amount is converted at
            the ECB rate of its date. A preparation aid, not tax advice.
  journal   The learning loop: settle decisions at +5/+20/+60 sessions against a
            benchmark (alpha, right or wrong), hit rates by rating, post-trade
            reviews (the plan first, then the outcome in R, with best and worst
            excursions), a digest, theses with a life cycle (idea → entry-ready →
            active → closed) and review dates, and the user's own lessons.
  knowledge Keep a source document (an article, a report) as external text.
  backtest  Backtests a declarative strategy (\`strategy list\`) or an allocation
            rule (buy-and-hold, 60-40, equal-weight, dual-momentum, risk-parity) on
            daily or crypto intraday bars. Signals use closed bars and fill at the
            next open; a stop the market gaps through fills at the open; market
            orders pay taker, limits maker; crypto leverage adds Binance funding
            and liquidation. Every metric is an [E#]: CAGR, Sharpe, Sortino, max
            drawdown, Calmar, Ulcer, Omega, VaR, trade statistics in money and R,
            MAE/MFE, buy-and-hold, residual alpha (Newey-West t), probabilistic
            Sharpe, and the result with costs doubled. walkforward picks parameters
            on train windows and stitches the out-of-sample equity; sweep runs up
            to 500 variants with the deflated Sharpe, PBO and CPCV; montecarlo
            resamples the trades; review runs it all and answers PASS, REVISE or
            REJECT with reasons; decisions gives the journal's hit rates with
            Wilson intervals. Writes BACKTEST.md, equity.json, trades.json.
  broker    Live venues behind every guard. --env test (default): Binance
            testnet, Kraken validate-only, Coinbase preview-only, IBKR paper
            account; --env live: real money, only with ULTRASTOCK_LIVE=1 set by
            the user, Node ≥ 22 and a ready paper record. A ticket goes only when
            it is checked (≤ 15 min, unchanged), a limit order within 1 % of the
            venue's book, inside the per-order and per-day limits of the
            experience tier, on a venue switched on and authorised for the
            jurisdiction (MiCA register for crypto platforms), with a key that
            cannot withdraw, no kill switch, no tripped breaker — and a 6-digit
            code sent out of band (desktop notification, private ntfy, the
            user's terminal), never printed. One request per approval; a lost
            answer is "unknown" until reconcile asks the venue. setup shows how
            to store a key in the keychain; limits tighten at once and loosen
            only with a code, 24 hours later; panic sets the kill switch and
            cancels ultrastock's working orders.
  mcp       The commands as MCP tools (stdio, or HTTP on 127.0.0.1 with a
            mandatory bearer token): read-only tools plus ticket creation
            through plan. No tool submits an order, edits the profile or the
            ledger, stores a key or moves a limit.
  strategy  The strategies: 26 ported from ai-strategy-backtester plus sma-cross,
            and the user's own in <home>/strategies/ — list, show, validate (each
            error with its path), new (from a template or --like another).
  watch     Alerts that fire once when a condition becomes true and re-arm when
            it is false again: an expression over close, rsi14, sma50, sma200,
            macd_hist, atr14, high52w, volume_ratio… (e.g. "close < sma200 and
            rsi14 < 30"), important 8-Ks for a US symbol, or a stop reached by an
            open position. \`watch run\` is idempotent: schedule it. --notify sends to
            ULTRASTOCK_NTFY_URL (with ULTRASTOCK_NTFY_TOKEN) and allowlisted webhooks.
  options   An option chain summary per expiry — ATM IV, put/call open interest
            and volume, totals: US listings from CBOE (15 min delayed), BTC and
            ETH from Deribit with the DVOL volatility index.
  options-analysis  Per expiry: expected move (straddle and 1 sd), max pain, dealer
            gamma exposure (total, flip, call and put walls), put/call ratios,
            25-delta skew; the ATM-IV term structure, unusual activity, and IV
            rank once 20 days of IV are stored. --strategy prices a structure
            (long-call:K, bull-call:K1/K2, bear-put:K1/K2, iron-condor:Kp1/Kp2/Kc1/Kc2,
            straddle:K, strangle:Kp/Kc, covered-call:K, cash-secured-put:K,
            collar:Kp/Kc) at mid: max profit and loss, breakevens, and a P&L
            matrix by move, date and volatility. Pass --spot-moves=-30,0,30 with "=".
  stats     One symbol: return distribution, five volatility estimators, a GARCH
            forecast, Hurst, ADF, the HMM turbulent-state probability, drawdowns,
            VaR/CVaR/Cornish-Fisher, performance against a benchmark. Several (≤ 10):
            Pearson and Spearman correlations, tail dependence, pairwise cointegration.
  crypto-analysis  Funding (annualised, 30-day mean), basis, open interest, long/short
            ratios, DVOL, MVRV, realised volatility, drawdown from the all-time high,
            and a "leverage heat" reading; \`yields <symbol>\` judges DeFi pools'
            sustainability (reward share of the APY, TVL).
  predict-analysis  Kalshi or Manifold markets: implied probability, spread, YES+NO
            arbitrage net of fees (Kalshi taker fee 0.07 × C × P × (1 − P) by
            default), order-book imbalance, time to close; --my-probability adds a
            half-Kelly stake on an edge discounted by half the spread and the fee.
            Paper only for French residents; never Polymarket here.
  crypto    Market structure: global caps and dominance, top coins, one coin,
            derivatives positioning (funding, open interest, long/short ratios),
            DeFi TVL, yields (base vs reward APY), stablecoins, fees, on-chain
            metrics (CoinMetrics, mempool.space), DEX pairs, holder concentration.
  predict   Prediction markets: Kalshi (regulated), Manifold (play money),
            Polymarket — refused where the profile's jurisdiction blocks it.
            order: a paper ticket for a Kalshi contract (KALSHI:<TICKER>:YES|NO),
            checked by the risk gate — a venue blocked for the jurisdiction is
            refused even on paper, an unverified one is paper only — then filled
            by \`paper submit\` against Kalshi's live book with its taker fee.
            Questions and rules are external text, fenced as untrusted.
  snapshot  A cross-venue snapshot from TradingView's scanner (unofficial):
            price, valuation ratios, performance, technical rating.
  searxng   The optional local search stack (Docker), shared with the other
  firecrawl skills on the engine: SearXNG (:8888) makes research --engine-search
  stack     reliable and keyless; Firecrawl (:3002) reads pages through a real
            browser. up | down | status; stack = both.
  doctor    Version, state directory, Node, external tools; --probe also times a
            live call to each data source.

Runs live under --out, else ULTRASTOCK_HOME/runs/<symbol>-<time> (ULTRASTOCK_HOME
defaults to ~/.ultrastock).

ENVIRONMENT
  ULTRASTOCK_HOME        state directory (profile, runs, journal) — default ~/.ultrastock
  ULTRASTOCK_CACHE_DIR   dataset cache — default ULTRASTOCK_HOME/cache
  ULTRASTOCK_TIMEOUT_MS  network budget per attempt (default 20000)
  ULTRASTOCK_SEC_CONTACT an e-mail for SEC EDGAR's fair-access User-Agent (required by the SEC)
  ULTRASTOCK_FRED_API_KEY, ULTRASTOCK_COINGECKO_API_KEY, ULTRASTOCK_SOLANA_RPC   optional keys
  ULTRASTOCK_CRIBLE_CMD, ULTRASTOCK_CRIBLE_DATA_DIR   how to run crible, and where its dataset lives

Nothing here needs an API key. Exit codes: 0 done, 1 failed or refused, 2 bad invocation.`;

export const VALUE_FLAGS = [
  "out",
  "kind",
  "focus",
  "ask",
  "name",
  "web-results",
  "urls",
  "search-with",
  "search-model",
  "from",
  "to",
  "interval",
  "limit",
  "label",
  "unit",
  "key",
  "max-age",
  "record",
  "fixture",
  "jurisdiction",
  "currency",
  "answers",
  "answer",
  "depth",
  "since",
  "type",
  "broker",
  "venues",
  "market",
  "days",
  "year",
  "expiries",
  "report",
  "symbol",
  "lang",
  "asof",
  "years",
  "quarters",
  "source",
  "forms",
  "search",
  "member",
  "doc",
  "erp",
  "terminal",
  "indicators",
  "benchmark",
  "book",
  "regime",
  "tmi",
  "marginal-rate",
  "filing",
  "income",
  "carryforward",
  "envelope-value",
  "lot-method",
  "household",
  "account",
  "quantity",
  "price",
  "amount",
  "fee",
  "date",
  "entry",
  "stop",
  "target",
  "venue",
  "status",
  "thesis",
  "invalidation",
  "catalysts",
  "review-by",
  "note",
  "outcome",
  "tags",
  "tag",
  "title",
  "message",
  "ticket-id",
  "format",
  "map",
  "targets",
  "band",
  "rel-band",
  "contribution",
  "monthly",
  "expiry",
  "strategy",
  "spot-moves",
  "rate",
  "my-probability",
  "kalshi-fee",
  "contracts",
  "engine",
  "universe",
  "sort",
  "capital",
  "maker",
  "taker",
  "slippage",
  "leverage",
  "trail",
  "atr-stop",
  "time-stop",
  "risk",
  "max-dd",
  "limit-offset",
  "grid",
  "objective",
  "train",
  "test",
  "groups",
  "test-groups",
  "purge",
  "embargo",
  "trials",
  "paths",
  "seed",
  "rebalance",
  "lookback",
  "cash-rate",
  "rating",
  "horizon",
  "like",
  "env",
  "code",
  "conid",
  "max-order",
  "max-daily",
  "attest",
  "transport",
  "port",
  "token",
  "style",
  "region",
  "shortlist",
  "top",
  "min-cap-eur",
];
export const BOOL_FLAGS = [
  "json",
  "refresh",
  "offline",
  "probe",
  "ticket",
  "dry-run",
  "list",
  "bootstrap",
  "notify",
  "perp",
  "anchored",
  "all-listings",
  "engine-search",
  "browser",
  "no-wayback",
  "pea",
  "acc",
  "dist",
  "ucits",
  "watch",
];
export const COMMANDS = [
  "analyze",
  "report",
  "quote",
  "history",
  "calc",
  "evidence",
  "check",
  "profile",
  "jurisdiction",
  "calendar",
  "resolve",
  "fundamentals",
  "screen",
  "etf",
  "value",
  "regime",
  "sectors",
  "catalysts",
  "technicals",
  "valuation",
  "filings",
  "insiders",
  "holdings",
  "analyst",
  "short",
  "dividends",
  "congress",
  "options",
  "options-analysis",
  "stats",
  "crypto-analysis",
  "predict-analysis",
  "crypto",
  "predict",
  "snapshot",
  "macro",
  "rates",
  "fx",
  "cot",
  "sentiment",
  "news",
  "research",
  "searxng",
  "firecrawl",
  "stack",
  "universe",
  "portfolio",
  "plan",
  "ticket",
  "paper",
  "decide",
  "journal",
  "tax",
  "knowledge",
  "watch",
  "backtest",
  "strategy",
  "broker",
  "mcp",
  "doctor",
];

const NET = ["record", "fixture", "refresh", "offline", "json"];
const SPEC: CliSpec = {
  commands: COMMANDS,
  valueFlags: VALUE_FLAGS,
  boolFlags: BOOL_FLAGS,
  commandFlags: {
    analyze: ["depth", "since", "out", ...NET],
    quote: ["out", ...NET],
    history: ["from", "to", "interval", "limit", ...NET],
    calc: ["label", "unit", "key", "from", "json"],
    evidence: ["json"],
    check: ["max-age", "json"],
    report: ["answer", "json"],
    profile: ["jurisdiction", "currency", "answers", "type", "broker", "json"],
    jurisdiction: ["jurisdiction", "venues", "out", ...NET],
    calendar: ["market", "days", "year", "limit", "out", ...NET],
    macro: ["days", "out", ...NET],
    rates: ["out", ...NET],
    fx: ["out", ...NET],
    cot: ["report", "out", ...NET],
    sentiment: ["out", ...NET],
    news: ["symbol", "lang", "days", "limit", "out", ...NET],
    searxng: ["json"],
    firecrawl: ["json"],
    stack: ["json"],
    research: [
      "kind",
      "focus",
      "ask",
      "name",
      "web-results",
      "urls",
      "search-with",
      "search-model",
      "engine-search",
      "browser",
      "no-wayback",
      "limit",
      "out",
      ...NET,
    ],
    universe: ["out", ...NET],
    resolve: ["out", ...NET],
    fundamentals: ["asof", "years", "quarters", "source", "out", ...NET],
    value: ["style", "region", "shortlist", "top", "min-cap-eur", "watch", "out", ...NET],
    regime: ["market", "out", ...NET],
    sectors: ["market", "out", ...NET],
    catalysts: ["days", "out", ...NET],
    screen: ["engine", "market", "universe", "limit", "sort", "list", "bootstrap", "all-listings", "out", ...NET],
    etf: ["pea", "acc", "dist", "ucits", "currency", "limit", "out", ...NET],
    technicals: ["interval", "indicators", "benchmark", "out", ...NET],
    valuation: ["erp", "terminal", "out", ...NET],
    filings: ["forms", "days", "limit", "search", "out", ...NET],
    insiders: ["limit", "out", ...NET],
    holdings: ["limit", "out", ...NET],
    analyst: ["out", ...NET],
    short: ["out", ...NET],
    dividends: ["limit", "out", ...NET],
    congress: ["member", "doc", "year", "limit", "out", ...NET],
    portfolio: [
      "book",
      "account",
      "symbol",
      "quantity",
      "price",
      "amount",
      "fee",
      "currency",
      "date",
      "format",
      "map",
      "dry-run",
      "benchmark",
      "universe",
      "targets",
      "band",
      "rel-band",
      "contribution",
      "target",
      "years",
      "monthly",
      "out",
      ...NET,
    ],
    plan: ["account", "entry", "stop", "target", "venue", "ticket", "out", ...NET],
    ticket: ["status", ...NET],
    paper: ["out", ...NET],
    decide: ["json"],
    tax: [
      "regime",
      "year",
      "book",
      "tmi",
      "marginal-rate",
      "filing",
      "income",
      "carryforward",
      "envelope-value",
      "lot-method",
      "household",
      "format",
      "out",
      ...NET,
    ],
    backtest: [
      "from",
      "to",
      "years",
      "interval",
      "capital",
      "fee",
      "maker",
      "taker",
      "slippage",
      "leverage",
      "benchmark",
      "universe",
      "trail",
      "atr-stop",
      "time-stop",
      "risk",
      "max-dd",
      "limit-offset",
      "entry",
      "stop",
      "target",
      "grid",
      "objective",
      "train",
      "test",
      "groups",
      "test-groups",
      "purge",
      "embargo",
      "trials",
      "paths",
      "seed",
      "rebalance",
      "lookback",
      "cash-rate",
      "rating",
      "horizon",
      "perp",
      "anchored",
      "out",
      ...NET,
    ],
    strategy: ["like", "json"],
    mcp: ["transport", "port", "token"],
    broker: ["venue", "env", "code", "conid", "max-order", "max-daily", "venues", "attest", "json"],
    journal: ["book", "symbol", "thesis", "invalidation", "catalysts", "review-by", "note", "outcome", "ticket-id", "tags", "tag", "out", ...NET],
    knowledge: ["title", "json"],
    watch: ["notify", "message", ...NET],
    options: ["expiries", "out", ...NET],
    "options-analysis": ["expiry", "strategy", "spot-moves", "rate", "out", ...NET],
    stats: ["days", "benchmark", "out", ...NET],
    "crypto-analysis": ["days", "limit", "out", ...NET],
    "predict-analysis": ["my-probability", "kalshi-fee", "contracts", "limit", "out", ...NET],
    crypto: ["limit", "out", ...NET],
    predict: ["limit", "contracts", "price", "account", "out", ...NET],
    snapshot: ["market", "out", ...NET],
    doctor: ["probe", "json"],
  },
};

const INTERVALS: Interval[] = ["1d", "1w", "4h", "1h", "15m"];

function fail(msg: string, code = EXIT_FAILURE): never {
  process.stderr.write(`ultrastock: ${msg}\n`);
  process.exit(code);
}
function usage(msg: string): never {
  return fail(msg, EXIT_USAGE);
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function arity(args: CommandArgs): number {
  if (args.command === "doctor" || args.command === "version" || args.command === "value") return 0;
  if (args.command === "check" || args.command === "calc") return 2;
  if (args.command === "profile") return 3;
  if (args.command === "crypto" || args.command === "calendar" || args.command === "macro" || args.command === "crypto-analysis") return 2;
  if (
    args.command === "stats" ||
    args.command === "predict-analysis" ||
    args.command === "screen" ||
    args.command === "etf" ||
    args.command === "regime" ||
    args.command === "sectors" ||
    args.command === "catalysts"
  )
    return Number.POSITIVE_INFINITY;
  if (args.command === "news" || args.command === "cot" || args.command === "resolve") return Number.POSITIVE_INFINITY;
  if (args.command === "congress") return 0;
  if (args.command === "portfolio") return 3;
  if (args.command === "ticket" || args.command === "paper" || args.command === "decide" || args.command === "knowledge") return 2;
  if (
    args.command === "journal" ||
    args.command === "watch" ||
    args.command === "tax" ||
    args.command === "backtest" ||
    args.command === "strategy" ||
    args.command === "broker"
  )
    return Number.POSITIVE_INFINITY;
  if (args.command === "predict") return Number.POSITIVE_INFINITY;
  return 1;
}

/** "90m", "36h", "3d", "1w" → milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/i.exec(s.trim());
  if (!m) throw new UsageError(`--max-age takes a duration like 90m, 36h or 3d, not "${s}"`);
  const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]!.toLowerCase() as "m"]!;
  return Number(m[1]) * unit;
}

function parseDate(s: string | undefined, flag: string): Date | undefined {
  if (s === undefined) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59Z` : s);
  if (Number.isNaN(d.getTime())) throw new UsageError(`--${flag} takes a date like 2026-01-31, not "${s}"`);
  return d;
}

function configureNetwork(args: CommandArgs): void {
  const record = argValue(args, "record");
  const fixture = argValue(args, "fixture");
  if (record && fixture) usage("--record and --fixture are opposites: record a fixture, or replay one");
  if (fixture) setNetMode({ kind: "fixture", dir: resolve(fixture) });
  else if (record) setNetMode({ kind: "record", dir: resolve(record) });
  setCacheMode({ refresh: argBool(args, "refresh"), offline: argBool(args, "offline") });
}

async function run(args: CommandArgs): Promise<void> {
  const cmd = args.command;
  const asJson = argBool(args, "json");
  configureNetwork(args);

  if (cmd === "analyze") {
    const symbol = args.positional[0];
    if (!symbol) usage("usage: ultrastock analyze <symbol> [--depth quick|standard|deep|full] [--since <run>] [--out <dir>] [--json]");
    const depth = (argValue(args, "depth") ?? "standard") as Depth;
    if (!(DEPTHS as readonly string[]).includes(depth)) usage(`--depth is one of ${DEPTHS.join(", ")}`);
    const dir = runDirFor(argValue(args, "out"), `${symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, "_")}-${runId()}`);
    const since = argValue(args, "since");
    const r = await analyzeFull(symbol, dir, { depth, since: since ? resolve(since) : undefined });
    if (asJson) process.stdout.write(jsonLine(r));
    else process.stdout.write(`${readBrief(dir)}\nrun: ${dir}\n`);
    return;
  }

  if (cmd === "quote") {
    const symbol = args.positional[0];
    if (!symbol) usage("usage: ultrastock quote <symbol> [--out <dir>] [--json]");
    const resolved = await resolveSymbol(symbol);
    const q = await getQuote(resolved);
    const out = argValue(args, "out");
    let id: string | undefined;
    if (out) {
      const store = EvidenceStore.open(resolve(out), { subject: q.instrument.symbol });
      id = store.add({
        key: `${q.instrument.symbol}.quote.price`,
        label: `${q.instrument.symbol} latest price`,
        value: q.price,
        unit: q.instrument.currency,
        ...q.provenance,
        asOf: q.at,
      });
      store.save();
    }
    if (asJson) process.stdout.write(jsonLine({ ...q, evidence: id }));
    else {
      const ch = q.changePct !== undefined ? ` (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)} %)` : "";
      process.stdout.write(
        `${id ? `[${id}] ` : ""}${q.instrument.symbol}${q.instrument.name ? ` — ${q.instrument.name}` : ""}: ${q.price} ${q.instrument.currency}${ch}, as of ${q.at} (${q.provenance.source}, ${q.provenance.delay}${q.provenance.official ? "" : ", unofficial"})\n` +
          q.notes.map((n) => `  note: ${n}\n`).join(""),
      );
    }
    return;
  }

  if (cmd === "history") {
    const symbol = args.positional[0];
    if (!symbol) usage("usage: ultrastock history <symbol> [--from <date>] [--to <date>] [--interval 1d] [--limit <n>] [--json]");
    const interval = (argValue(args, "interval") ?? "1d") as Interval;
    if (!INTERVALS.includes(interval)) usage(`--interval must be one of ${INTERVALS.join(", ")}, not "${interval}"`);
    const to = parseDate(argValue(args, "to"), "to") ?? clockNow();
    const from = parseDate(argValue(args, "from"), "from") ?? new Date(to.getTime() - 365 * 86400_000);
    if (from > to) usage("--from is after --to");
    const series = await getHistory(await resolveSymbol(symbol), { from, to, interval });
    const limit = argInt(args, "limit", { min: 1 });
    const bars = limit ? series.bars.slice(-limit) : series.bars;
    if (asJson) process.stdout.write(jsonLine({ ...series, bars }));
    else {
      process.stdout.write(
        `date,open,high,low,close,volume\n${bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume ?? ""].join(",")).join("\n")}\n`,
      );
      process.stderr.write(
        `  ${plural(bars.length, "bar")} ${series.instrument.symbol} ${series.interval} from ${series.provenance.source} (${series.provenance.delay}${series.adjusted ? ", adjusted" : ""})\n` +
          series.notes.map((n) => `  note: ${n}\n`).join(""),
      );
    }
    return;
  }

  if (cmd === "calc") {
    const [dir, formula] = args.positional;
    const label = argValue(args, "label");
    const from = argValue(args, "from");
    if (!dir || !formula || !label)
      usage('usage: ultrastock calc <run> "<formula over E ids>" --label <text> [--unit <unit>] | calc <run> --from <E#> "<figure>" --label <text>');
    let r: ReturnType<typeof calcEvidence>;
    try {
      const opts = { label, unit: argValue(args, "unit"), key: argValue(args, "key") };
      r = from ? calcFromDocument(resolve(dir), from, formula, opts) : calcEvidence(resolve(dir), formula, opts);
    } catch (e) {
      if (e instanceof ExprError) usage(`formula: ${e.message}`);
      return fail((e as Error).message);
    }
    if (asJson) process.stdout.write(jsonLine(r.item));
    else process.stdout.write(`${formatEvidence(r.item)} — ${formula}\n`);
    return;
  }

  if (cmd === "evidence") {
    const dir = args.positional[0];
    if (!dir) usage("usage: ultrastock evidence <run> [--json]");
    const store = EvidenceStore.load(resolve(dir));
    if (!store) fail(`${dir} holds no evidence.json`);
    if (asJson) process.stdout.write(jsonLine({ dir: resolve(dir), subject: store.subject, items: store.items }));
    else process.stdout.write(`${store.items.map(formatEvidence).join("\n")}\n`);
    return;
  }

  if (cmd === "report") return reportCommand(args, asJson);
  if (cmd === "check") {
    const [dir, file] = args.positional;
    if (!dir || !file) usage("usage: ultrastock check <run> <answer.md> [--max-age <duration>] [--json]");
    const maxAge = argValue(args, "max-age");
    let answer: string;
    try {
      answer = readFileSync(file, "utf8");
    } catch {
      return fail(`cannot read ${file}`);
    }
    const r = checkAnswer(resolve(dir), answer, { maxAgeMs: maxAge ? parseDuration(maxAge) : undefined });
    if ("error" in r) fail(r.error);
    const failing = r.problems.filter((p) => !NOTE_KINDS.has(p.kind));
    if (asJson) process.stdout.write(jsonLine({ ok: failing.length === 0, ...r }));
    else {
      const head = `${plural(r.claims, "claim")}, ${plural(r.figures, "figure")}, ${plural(r.citations, "citation")} of ${plural(r.evidence, "evidence item")}`;
      process.stdout.write(
        failing.length ? `ultrastock check: ${plural(failing.length, "problem")} in ${file} (${head})\n` : `ultrastock check: OK — ${head}\n`,
      );
      for (const p of r.problems) process.stdout.write(`  ${p.line ? `line ${p.line}` : "note"}: ${NOTE_KINDS.has(p.kind) ? "(note) " : ""}${p.message}\n`);
    }
    if (failing.length) process.exit(EXIT_FAILURE);
    return;
  }

  if (cmd === "profile") return profileCommand(args, asJson);
  if (cmd === "jurisdiction") return jurisdictionCommand(args, asJson);
  if (cmd === "calendar") return calendarCommand(args, asJson);
  if (cmd === "resolve") return resolveCommand(args, asJson);
  if (cmd === "fundamentals") return fundamentalsCommand(args, asJson);
  if (cmd === "valuation") return valuationCommand(args, asJson);
  if (cmd === "technicals") return technicalsCommand(args, asJson);
  if (cmd === "screen") return screenCommand(args, asJson);
  if (cmd === "etf") return etfCommand(args, asJson);
  if (cmd === "value") return valueCommand(args, asJson);
  if (cmd === "regime") return regimeCommand(args, asJson);
  if (cmd === "sectors") return sectorsCommand(args, asJson);
  if (cmd === "catalysts") return catalystsCommand(args, asJson);
  if (cmd === "filings") return filingsCommand(args, asJson);
  if (cmd === "insiders") return insidersCommand(args, asJson);
  if (cmd === "holdings") return holdingsCommand(args, asJson);
  if (cmd === "analyst") return analystCommand(args, asJson);
  if (cmd === "short") return shortCommand(args, asJson);
  if (cmd === "dividends") return dividendsCommand(args, asJson);
  if (cmd === "congress") return congressCommand(args, asJson);
  if (cmd === "portfolio") return portfolioCommand(args, asJson);
  if (cmd === "decide") return decideCommand(args, asJson);
  if (cmd === "journal") return journalCommand(args, asJson);
  if (cmd === "tax") return taxCommand(args, asJson);
  if (cmd === "knowledge") return knowledgeCommand(args, asJson);
  if (cmd === "watch") return watchCommand(args, asJson);
  if (cmd === "backtest") return backtestCommand(args, asJson);
  if (cmd === "strategy") return strategyCommand(args, asJson);
  if (cmd === "broker") return brokerCommand(args, asJson);
  if (cmd === "mcp") {
    const port = argValue(args, "port");
    return serveMcp({ transport: argValue(args, "transport"), port: port ? Number(port) : undefined, token: argValue(args, "token") });
  }
  if (cmd === "plan") return planCommand(args, asJson);
  if (cmd === "ticket") return ticketCommand(args, asJson);
  if (cmd === "paper") return paperCommand(args, asJson);
  if (cmd === "options") return optionsCommand(args, asJson);
  if (cmd === "options-analysis") return optionsAnalysisCommand(args, asJson);
  if (cmd === "stats") return statsCommand(args, asJson);
  if (cmd === "crypto-analysis") return cryptoAnalysisCommand(args, asJson);
  if (cmd === "predict-analysis") return predictAnalysisCommand(args, asJson);
  if (cmd === "crypto") return cryptoCommand(args, asJson);
  if (cmd === "predict") return predictCommand(args, asJson);
  if (cmd === "snapshot") return snapshotCommand(args, asJson);
  if (cmd === "macro") return macroCommand(args, asJson);
  if (cmd === "rates") return ratesCommand(args, asJson);
  if (cmd === "fx") return fxCommand(args, asJson);
  if (cmd === "cot") return cotCommand(args, asJson);
  if (cmd === "sentiment") return sentimentCommand(args, asJson);
  if (cmd === "news") return newsCommand(args, asJson);
  if (cmd === "research") return researchCommand(args, asJson);
  if (cmd === "searxng" || cmd === "firecrawl" || cmd === "stack") return stackCommand(args, asJson);
  if (cmd === "universe") return universeCommand(args, asJson);

  if (cmd === "doctor") {
    const report = await doctorReport({ probe: argBool(args, "probe") });
    if (asJson) process.stdout.write(jsonLine(report));
    else process.stdout.write(formatDoctor(report));
    return;
  }
}

/** The CLI, as a function: tests drive it; the bundle calls it with process.argv. */
export async function main(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv, SPEC);
  } catch (e) {
    return usage((e as Error).message);
  }
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const args: CommandArgs = parsed;
  if (args.positional.length > arity(args)) usage(`unexpected argument "${args.positional[arity(args)]}" — run \`ultrastock --help\``);
  try {
    await run(args);
  } catch (e) {
    if (e instanceof UsageError) usage(e.message);
    if (e instanceof ProviderError || e instanceof FixtureMiss || e instanceof Error) fail(e.message);
    throw e;
  }
}

function isStartedFile(): boolean {
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

// Only when run as a program: `webindex skill bundle` imports the built file to
// read HELP and the flag tables, and importing must not start anything.
if (isInvokedDirectly() || isStartedFile()) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE") process.exit(EXIT_OK);
      throw e;
    });
  }
  main(process.argv.slice(2)).catch((e) => fail((e as Error).message));
}
