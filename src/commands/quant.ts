// Quantitative analysis commands on top of the data layer: option-chain
// readings and strategy payoffs, return statistics and co-movement, crypto
// leverage and yield sustainability, and prediction-market pricing and
// sizing. Every figure is a dataset point carrying the provenance of the data
// it was computed from and a formula saying how; thresholds live in
// src/analyze/quant/*.ts.
//
// Fan-out is capped and polite: stats takes at most 10 symbols and fetches
// 4 at a time; predict-analysis reads at most 10 order books, 2 at a time;
// crypto-analysis runs its (distinct-host) sources 4 at a time. A source that
// fails is named in the notes, never silently dropped.
import { ruleStatus } from "../core/jurisdiction.js";
import type { Dataset } from "../core/datasets.js";
import { clockNow } from "../core/net.js";
import { loadProfile } from "../core/profile.js";
import { argInt, argList, argValue, type CommandArgs, mapLimit, UsageError } from "../engine.js";
import { binanceFuturesPositioning } from "../providers/crypto/binance-futures.js";
import { coingeckoMarkets } from "../providers/crypto/coingecko.js";
import { coinmetricsAssetMetrics } from "../providers/crypto/coinmetrics.js";
import { llamaYields } from "../providers/crypto/defillama.js";
import { mempoolNetwork } from "../providers/crypto/mempool.js";
import { cboeChain } from "../providers/options/cboe.js";
import { deribitChain, deribitDvol } from "../providers/options/deribit.js";
import type { OrderBook } from "../providers/prediction/common.js";
import { kalshiMarket, kalshiMarkets, kalshiOrderbook } from "../providers/prediction/kalshi.js";
import { manifoldSearch, PLAY_MONEY_NOTE } from "../providers/prediction/manifold.js";
import { getHistory, resolveSymbol } from "../providers/router.js";
import type { Bar, PriceSeries } from "../providers/types.js";
import { mergedProvenance, PointList } from "../analyze/quant/common.js";
import { leverageHeat, poolsFromPoints, realisedPoints, yieldSustainability } from "../analyze/quant/crypto.js";
import {
  buildStrategy,
  expiryPoints,
  ivHistoryPath,
  ivRankPoints,
  type OptionVenue,
  parseStrategySpec,
  pickExpiries,
  recordIv,
  STRATEGY_USAGE,
  strategyPoints,
  termPoints,
  termStructure,
  toQuantChain,
  unusualPoints,
} from "../analyze/quant/options.js";
import { kalshiQuotesFromPoints, kalshiReadingPoints, manifoldQuotesFromPoints, manifoldReadingPoints, type PredictOptions } from "../analyze/quant/predict.js";
import { alignCloses, benchmarkPoints, multiStatsPoints, singleStatsPoints } from "../analyze/quant/stats.js";
import { emitDatasets } from "./emit.js";

const DAY = 86_400_000;
const DERIBIT = new Set(["BTC", "ETH", "BTCUSDT", "ETHUSDT", "BTC-USD", "ETH-USD"]);
/** Most symbols `stats` fetches in one run (45 pairs at 10). */
export const STATS_MAX_SYMBOLS = 10;
/** Most Kalshi order books `predict-analysis` reads in one run. */
export const PREDICT_MAX_BOOKS = 10;

const dataset = (kind: string, title: string, subject: string, points: PointList, provenance: Dataset["provenance"], notes: string[] = []): Dataset => ({
  kind,
  title,
  subject,
  points: points.points,
  provenance,
  notes,
});

/**
 * Closed daily bars only: a crypto day closes at 00:00 UTC, so today's bar is
 * still forming; an exchange's bar dated today is dropped before 21:00 UTC
 * (after the US close, and well after the European ones).
 */
export function closedBars(bars: readonly Bar[], crypto: boolean, now: Date): Bar[] {
  const today = now.toISOString().slice(0, 10);
  const last = bars[bars.length - 1];
  if (last && last.date >= today && (crypto || now.getUTCHours() < 21)) return bars.slice(0, -1);
  return [...bars];
}

const fraction = (v: string | undefined, flag: string, lo: number, hi: number): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new UsageError(`--${flag} is a number between ${lo} and ${hi} (got ${v})`);
  return n;
};

// --- options-analysis ------------------------------------------------------------------

const OPTIONS_USAGE = `usage: ultrastock options-analysis <symbol> [--expiry YYYY-MM-DD] [--strategy <spec>] [--spot-moves=-30,-10,0,10,50] [--rate <pct>] [--out <dir>] — ${STRATEGY_USAGE}`;

export async function optionsAnalysisCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const raw = args.positional[0]?.toUpperCase();
  if (!raw) throw new UsageError(OPTIONS_USAGE);
  const venue: OptionVenue = DERIBIT.has(raw) ? "deribit" : "cboe";
  const now = clockNow();
  const rate = (fraction(argValue(args, "rate"), "rate", 0, 20) ?? 4) / 100;
  const spec = argValue(args, "strategy") ? parseStrategySpec(argValue(args, "strategy")!) : undefined;
  const movesArg = argList(args, "spot-moves");
  const moves = movesArg.length ? movesArg.map((m) => fraction(m.replace(/%$/, ""), "spot-moves", -95, 500)! / 100).sort((a, b) => a - b) : undefined;
  const chain = venue === "deribit" ? await deribitChain(raw.slice(0, 3)) : await cboeChain(raw);
  const q = toQuantChain(chain, venue, now, rate);
  const U = q.underlying;
  const asked = argValue(args, "expiry");
  let expiries: string[];
  if (asked) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asked)) throw new UsageError("--expiry is a date, YYYY-MM-DD");
    if (!q.expiries.some((e) => e.expiry === asked))
      throw new UsageError(
        `${U} has no ${asked} expiry — listed: ${q.expiries
          .filter((e) => e.dte >= 0)
          .slice(0, 12)
          .map((e) => e.expiry)
          .join(", ")}`,
      );
    expiries = [asked];
  } else expiries = pickExpiries(q.expiries, venue);
  if (!expiries.length) throw new Error(`${U}: no expiry at least 7 days out`);
  const prov = { ...chain.provenance, asOf: chain.asOf.slice(0, 10) };

  const readings = new PointList();
  readings.num(`${U}.quant.spot`, `${U} underlying price (${chain.provenance.source})`, q.spot, q.currency);
  if (venue === "cboe")
    readings.num(`${U}.quant.rate`, `${U} risk-free rate assumed for Black–Scholes marks`, rate * 100, "%", "assumption (--rate, default 4 %)");
  for (const e of expiries) expiryPoints(q, e, readings);
  unusualPoints(q, expiries, readings);

  const vol = new PointList();
  const term = termStructure(q);
  termPoints(U, term, vol);
  const volNotes: string[] = [];
  if (term.skipped.length)
    volNotes.push(
      `${term.skipped.length} expiry(ies) left out of the term structure: no two-sided call and put quote near the money (${term.skipped.slice(0, 6).join(", ")}${term.skipped.length > 6 ? "…" : ""})`,
    );
  if (term.iv30 !== undefined) {
    const day = chain.asOf.slice(0, 10);
    const hist = recordIv(U, day, term.iv30);
    ivRankPoints(U, hist, term.iv30, vol);
    volNotes.push(`today's 30-day ATM IV is stored in ${ivHistoryPath(U)} (one reading per date): IV rank becomes available after 20 stored days`);
  } else volNotes.push("no ATM IV could be read: no term structure, no IV history update");

  const out: Dataset[] = [
    dataset("options-analysis", `${U} option chain readings (${expiries.join(", ")})`, U, readings, prov, [
      ...q.notes,
      ...chain.notes,
      asked
        ? `expiry ${asked} as asked`
        : `expiries: the next ${expiries.length} monthly-style expiries at least 7 days out (topped up with the nearest when fewer)`,
      "gamma exposure assumes dealers are long calls and short puts — their real books are unknown",
    ]),
    dataset("options-analysis", `${U} implied-volatility term structure and IV rank`, U, vol, prov, volNotes),
  ];
  if (spec) {
    const expiry = asked ?? expiries[0]!;
    const legs = buildStrategy(q, expiry, spec);
    const sp = new PointList();
    const notes = strategyPoints(q, expiry, spec, legs, sp, { moves });
    out.push(dataset("options-strategy", `${U} ${spec.kind} ${spec.strikes.join("/")} on ${expiry}: payoff and P&L matrix`, U, sp, prov, notes));
  }
  emitDatasets(args, out, asJson);
}

// --- stats ---------------------------------------------------------------------------

const STATS_USAGE = `usage: ultrastock stats <sym1> [<sym2> …] [--days 750] [--benchmark <sym>] [--out <dir>] — one symbol: distribution, volatility, GARCH, Hurst, ADF, HMM, drawdowns, VaR, vs a benchmark; several (≤ ${STATS_MAX_SYMBOLS}): correlations, tail dependence, cointegration`;

interface Fetched {
  sym: string;
  series?: PriceSeries;
  bars: Bar[];
  crypto: boolean;
  us: boolean;
  error?: string;
}

async function fetchBars(raw: string, from: Date, now: Date): Promise<Fetched> {
  try {
    const r = await resolveSymbol(raw);
    const series = await getHistory(r, { from, to: now, interval: "1d" });
    const crypto = r.instrument.market === "crypto";
    return { sym: r.instrument.symbol, series, bars: closedBars(series.bars, crypto, now), crypto, us: r.instrument.market === "us" };
  } catch (e) {
    return { sym: raw.toUpperCase(), bars: [], crypto: false, us: false, error: (e as Error).message };
  }
}

export async function statsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const syms = [...new Set(args.positional.map((s) => s.trim()).filter(Boolean))];
  if (!syms.length) throw new UsageError(STATS_USAGE);
  if (syms.length > STATS_MAX_SYMBOLS) throw new UsageError(`stats takes at most ${STATS_MAX_SYMBOLS} symbols (got ${syms.length})`);
  const days = argInt(args, "days", { min: 60, max: 3650 }) ?? 750;
  const now = clockNow();
  const from = new Date(now.getTime() - days * DAY);
  const got = await mapLimit(syms, 4, (s) => fetchBars(s, from, now));
  const ok = got.filter((g) => g.series && g.bars.length >= 30);
  const failed = got.filter((g) => !ok.includes(g)).map((g) => `${g.sym}: ${g.error ?? `only ${g.bars.length} closed daily bars`}`);
  if (!ok.length) throw new Error(`no usable history — ${failed.join("; ")}`);
  const unavailable = failed.map((f) => `unavailable — ${f}`);
  const out: Dataset[] = [];

  if (syms.length === 1) {
    const a = ok[0]!;
    const perYear = a.crypto ? 365 : 252;
    const pts = new PointList();
    const notes = singleStatsPoints(a.sym, a.bars, perYear, pts);
    const asOf = a.bars[a.bars.length - 1]!.date;
    out.push(
      dataset("stats", `${a.sym} return statistics (${a.bars.length} daily bars)`, a.sym, pts, { ...a.series!.provenance, asOf }, [
        ...a.series!.notes,
        ...notes,
        `annualised with ${perYear} periods a year (${a.crypto ? "crypto trades every day" : "exchange sessions"}); closed daily bars only`,
      ]),
    );
    const benchRaw = argValue(args, "benchmark") ?? (a.us ? "SPY" : "CW8.PA");
    const b = await fetchBars(benchRaw, from, now);
    if (b.series && b.bars.length >= 30 && b.sym !== a.sym) {
      const rp = new PointList();
      const perYearRel = a.crypto && b.crypto ? 365 : 252;
      const relNotes = benchmarkPoints(a.sym, b.sym, a.bars, b.bars, perYearRel, rp);
      out.push(
        dataset("stats", `${a.sym} performance vs ${b.sym}`, a.sym, rp, mergedProvenance([a.series!.provenance, b.series.provenance], asOf), [
          ...relNotes,
          `returns on the dates both trade, annualised with ${perYearRel}${a.crypto !== b.crypto ? " (a crypto asset against an exchange benchmark: each return spans the gap between shared sessions)" : ""}`,
        ]),
      );
    } else if (b.sym !== a.sym) unavailable.push(`unavailable — benchmark ${benchRaw}: ${b.error ?? "too little history"}`);
  } else {
    const aligned = alignCloses(ok.map((g) => g.bars));
    if (aligned.dates.length < 30) throw new Error(`only ${aligned.dates.length} dates shared by ${ok.map((g) => g.sym).join(", ")} — not enough to compare`);
    const pts = new PointList();
    const notes = multiStatsPoints(
      ok.map((g) => g.sym),
      aligned,
      pts,
    );
    out.push(
      dataset(
        "stats",
        `Co-movement of ${ok.map((g) => g.sym).join(", ")}`,
        "MULTI",
        pts,
        mergedProvenance(
          ok.map((g) => g.series!.provenance),
          aligned.dates[aligned.dates.length - 1],
        ),
        [
          ...notes,
          "returns on the dates every symbol has a close (crypto weekends drop out against exchange listings)",
          "cointegration regresses the first symbol's log price on the second's; a pair can be cointegrated one way and not the other in small samples",
        ],
      ),
    );
  }
  if (unavailable.length) out[out.length - 1]!.notes.push(...unavailable);
  emitDatasets(args, out, asJson);
}

// --- crypto-analysis -------------------------------------------------------------------

const CRYPTO_USAGE =
  "usage: ultrastock crypto-analysis <coin> [--days 365] [--out <dir>] | crypto-analysis yields <symbol> [--limit 20] — funding, basis, OI, long/short, DVOL, MVRV, fees, realised vol, drawdown from ATH, leverage heat; or DeFi yield sustainability";

/** Run named tasks 4 at a time; keep what answers, name what did not. */
async function settle(tasks: Array<[string, () => Promise<Dataset[]>]>): Promise<{ datasets: Map<string, Dataset[]>; failed: string[] }> {
  const datasets = new Map<string, Dataset[]>();
  const failed: string[] = [];
  await mapLimit(tasks, 4, async ([name, run]) => {
    try {
      datasets.set(name, await run());
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message}`);
    }
  });
  return { datasets, failed };
}

const pointValue = (ds: readonly Dataset[] | undefined, key: string): { value: number; ds: Dataset } | undefined => {
  for (const d of ds ?? []) {
    const p = d.points.find((x) => x.key === key);
    if (p && typeof p.value === "number") return { value: p.value, ds: d };
  }
  return undefined;
};

export async function cryptoAnalysisCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [first, second] = args.positional;
  if (!first) throw new UsageError(CRYPTO_USAGE);
  if (first.toLowerCase() === "yields") return yieldsAnalysis(args, second, asJson);
  const coin = first.toUpperCase().replace(/[-/]?(USDT|USDC|USD)$/, "");
  if (!/^[A-Z0-9]{2,12}$/.test(coin)) throw new UsageError(CRYPTO_USAGE);
  const days = argInt(args, "days", { min: 30, max: 1000 }) ?? 365;
  const now = clockNow();
  const major = coin === "BTC" || coin === "ETH";
  let bars: { series: PriceSeries; bars: Bar[] } | undefined;
  const tasks: Array<[string, () => Promise<Dataset[]>]> = [
    // 90 settled 8-hour fundings = the last 30 days.
    ["Binance futures positioning", () => binanceFuturesPositioning(coin, { fundingLimit: 90 })],
    [
      "daily bars",
      async () => {
        const r = await resolveSymbol(`${coin}USDT`);
        const series = await getHistory(r, { from: new Date(now.getTime() - days * DAY), to: now, interval: "1d" });
        bars = { series, bars: closedBars(series.bars, true, now) };
        return [];
      },
    ],
    [
      "CoinGecko markets (ATH)",
      async () => {
        // BTC and ETH sit in the top 10; anything else is looked for in the top 250.
        const all = await coingeckoMarkets({ limit: major ? 10 : 250 });
        const pts = all.points.filter((p) => p.key.startsWith(`${coin}.market.`));
        if (!pts.length) throw new Error(`${coin} is not among CoinGecko's top ${major ? 10 : 250} coins by market cap`);
        return [{ ...all, title: `${coin} market data and all-time high (CoinGecko)`, subject: coin, points: pts }];
      },
    ],
  ];
  if (major) {
    tasks.push(["Deribit DVOL", async () => [(await deribitDvol(coin, 90, now)).dataset]]);
    tasks.push(["Coin Metrics (MVRV)", async () => [await coinmetricsAssetMetrics(coin.toLowerCase(), 30)]]);
  }
  if (coin === "BTC") tasks.push(["mempool.space fees", async () => (await mempoolNetwork()).slice(0, 1)]);
  const { datasets, failed } = await settle(tasks);
  const out: Dataset[] = [];
  for (const [name] of tasks) out.push(...(datasets.get(name) ?? []));
  const notes: string[] = [];
  if (!major) notes.push(`${coin}: DVOL (Deribit) and MVRV (Coin Metrics community tier) cover BTC and ETH only`);

  // Realised volatility and drawdown from daily bars.
  let rv30: { value: number; prov: Dataset["provenance"] } | undefined;
  if (bars && bars.bars.length >= 31) {
    const pts = new PointList();
    realisedPoints(coin, bars.bars, pts, 365);
    const asOf = bars.bars[bars.bars.length - 1]!.date;
    const prov = { ...bars.series.provenance, asOf };
    const v = pts.points.find((p) => p.key === `${coin}.quant.realised.vol30d`)?.value;
    if (typeof v === "number") rv30 = { value: v, prov };
    out.push(
      dataset("crypto-analysis", `${coin} realised volatility and drawdown (${bars.bars.length} closed daily bars)`, coin, pts, prov, bars.series.notes),
    );
  } else if (bars) notes.push(`${coin}: only ${bars.bars.length} closed daily bars — no realised volatility`);

  // Leverage heat and funding.
  const fut = datasets.get("Binance futures positioning");
  const fundAnn = pointValue(fut, `${coin}.deriv.funding.binance.annualized`);
  const fundMean = pointValue(fut, `${coin}.deriv.funding.binance.mean`);
  const oiChange = pointValue(fut, `${coin}.deriv.oi.binance.change`);
  if (fut) {
    const pts = new PointList();
    pts.num(
      `${coin}.quant.funding.mean30d.annualized`,
      `${coin} mean funding over the last 30 days, annualised (Binance)`,
      fundMean ? fundMean.value * 3 * 365 : undefined,
      "%",
      "mean settled funding % per 8h × 3 × 365",
    );
    const heat = leverageHeat(fundAnn?.value, oiChange?.value);
    pts.text(
      `${coin}.quant.leverageHeat`,
      `${coin} leverage heat`,
      heat.label,
      `crowded when funding > 20 %/yr annualised AND open interest rising — ${heat.reasons.join("; ")}`,
    );
    out.push(
      dataset("crypto-analysis", `${coin} leverage heat (Binance perpetual)`, coin, pts, fut[0]!.provenance, [
        "funding annualised assumes 8-hourly settlement (3 × 365 a year); the open-interest change is over Binance's last 30 daily snapshots",
      ]),
    );
  }

  // Implied over realised: the volatility risk premium.
  const dvol = pointValue(datasets.get("Deribit DVOL"), `${coin}.deriv.dvol`);
  if (dvol && rv30) {
    const pts = new PointList();
    pts.num(
      `${coin}.quant.volPremium`,
      `${coin} DVOL minus 30-day realised volatility`,
      dvol.value - rv30.value,
      "vol pts",
      "DVOL (30-day implied) − realised vol30d",
    );
    out.push(
      dataset("crypto-analysis", `${coin} implied vs realised volatility`, coin, pts, mergedProvenance([dvol.ds.provenance, rv30.prov], rv30.prov.asOf)),
    );
  }
  if (!out.length) throw new Error(`no source answered for ${coin} — ${failed.join("; ")}`);
  out[out.length - 1]!.notes.push(...notes, ...failed.map((f) => `unavailable — ${f}`));
  emitDatasets(args, out, asJson);
}

async function yieldsAnalysis(args: CommandArgs, symbol: string | undefined, asJson: boolean): Promise<void> {
  if (!symbol) throw new UsageError("usage: ultrastock crypto-analysis yields <symbol> [--limit 20] — e.g. USDC, ETH, SOL");
  const limit = argInt(args, "limit", { min: 1, max: 50 }) ?? 20;
  const ds = await llamaYields({ symbol, limit });
  const pts = new PointList();
  let fragile = 0;
  const pools = poolsFromPoints(ds.points);
  for (const p of pools) {
    const v = yieldSustainability(p);
    if (v.verdict === "fragile") fragile++;
    pts.text(`YIELD.${p.id}.quant.sustainability`, `${p.label} yield sustainability`, v.verdict, v.reasons.join("; "));
  }
  pts.num(
    `YIELD.${symbol.toUpperCase()}.quant.fragileCount`,
    `Pools with ${symbol.toUpperCase()} judged fragile`,
    fragile,
    "count",
    "reward share > 50 % or TVL < 10 M USD",
  );
  emitDatasets(
    args,
    [
      ds,
      dataset("crypto-analysis", `Yield sustainability of ${pools.length} ${symbol.toUpperCase()} pools`, "YIELD", pts, ds.provenance, [
        "fragile = more than half the APY paid in emissions, or TVL under 10 M USD; base APY (fees, interest) is what survives when emissions stop",
      ]),
    ],
    asJson,
  );
}

// --- predict-analysis ------------------------------------------------------------------

const PREDICT_USAGE =
  "usage: ultrastock predict-analysis kalshi <SERIES|market:TICKER> | manifold <terms> [--my-probability 0.62] [--kalshi-fee <coef>] [--contracts 100] [--limit 5] [--out <dir>]";

export async function predictAnalysisCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [venue, ...rest] = args.positional;
  const query = rest.join(" ").trim();
  if (venue === "polymarket")
    throw new UsageError("predict-analysis does not read Polymarket (jurisdiction-gated: see `ultrastock predict polymarket` and `jurisdiction show`)");
  if ((venue !== "kalshi" && venue !== "manifold") || !query) throw new UsageError(PREDICT_USAGE);
  const myP = fraction(argValue(args, "my-probability"), "my-probability", 0, 1);
  if (myP !== undefined && (myP <= 0 || myP >= 1)) throw new UsageError("--my-probability is strictly between 0 and 1, like 0.62");
  const opts: PredictOptions = {
    now: clockNow(),
    myProbability: myP,
    // Kalshi taker fees: ceil(M × 0.07 × C × P × (1 − P)), M = 1 by default (July 2026 schedule as reported by
    // oddsshopper.com and quantvps.com; the official PDF was not reachable here). 0.07 is the cautious default:
    // a fee left out invents arbitrage that does not exist.
    feeCoefficient: fraction(argValue(args, "kalshi-fee"), "kalshi-fee", 0, 0.5) ?? 0.07,
    contracts: argInt(args, "contracts", { min: 1, max: 100_000 }) ?? 100,
  };
  const limit = argInt(args, "limit", { min: 1, max: PREDICT_MAX_BOOKS }) ?? 5;
  const profile = loadProfile();
  const status = profile ? ruleStatus(profile.jurisdiction, "kalshi") : undefined;
  const paper = `sizing is for paper trading only for French residents (no known French authorisation for Kalshi event contracts)${
    profile ? ` — your profile: ${profile.jurisdiction}, kalshi rule ${status}` : " — set your jurisdiction with `ultrastock profile init`"
  }`;

  if (venue === "kalshi") {
    const ds = query.toLowerCase().startsWith("market:")
      ? await kalshiMarket(query.slice(7))
      : await kalshiMarkets({ status: "open", limit: Math.max(limit, 20), seriesTicker: query.toUpperCase() });
    const quotes = kalshiQuotesFromPoints(ds.points).slice(0, limit);
    const notes: string[] = [];
    const books = await mapLimit(quotes, 2, async (q) => {
      try {
        return await kalshiOrderbook(q.ticker);
      } catch (e) {
        notes.push(`unavailable — order book ${q.ticker}: ${(e as Error).message}`);
        return undefined;
      }
    });
    const pts = new PointList();
    quotes.forEach((q, i) => notes.push(...kalshiReadingPoints(q, books[i]?.book as OrderBook | undefined, opts, pts)));
    const bookDs = books.filter((b): b is NonNullable<typeof b> => !!b).map((b) => b.dataset);
    const feeNote =
      opts.feeCoefficient > 0
        ? `Kalshi taker fee modelled as ceil_to_cent(${opts.feeCoefficient} × C × P × (1 − P)) per ${opts.contracts}-contract order (schedule of July 2026 as reported by secondary sources; some series carry a fee multiplier, and resting maker orders pay 0 or 0.0175) — check kalshi.com/docs/kalshi-fee-schedule.pdf`
        : "no Kalshi fee modelled: the published schedule (commonly 0.07 × C × P × (1 − P), rounded up to the cent) could not be verified here — pass --kalshi-fee 0.07 after checking kalshi.com/docs/kalshi-fee-schedule.pdf";
    emitDatasets(
      args,
      [
        { ...ds, points: ds.points.filter((p) => quotes.some((q) => p.key.startsWith(`KALSHI.${q.ticker}.`))) },
        ...bookDs,
        dataset(
          "predict-analysis",
          `Kalshi market readings (${quotes.length} market${quotes.length > 1 ? "s" : ""})`,
          ds.subject ?? "KALSHI",
          pts,
          ds.provenance,
          [
            feeNote,
            ...(myP !== undefined
              ? ["half-Kelly with the edge discounted by half the spread (and the fee): a cap on the stake, not a target", paper]
              : [paper]),
            ...notes,
          ],
        ),
      ],
      asJson,
    );
    return;
  }

  const ds = await manifoldSearch(query, { limit, filter: "open" });
  const pts = new PointList();
  const quotes = manifoldQuotesFromPoints(ds.points);
  for (const q of quotes) manifoldReadingPoints(q, opts, pts);
  emitDatasets(
    args,
    [
      ds,
      dataset("predict-analysis", `Manifold market readings (${quotes.length})`, "MANIFOLD", pts, ds.provenance, [
        PLAY_MONEY_NOTE,
        "no order book or fee on Manifold: no spread, no complement arbitrage; Kelly here is illustrative only",
      ]),
    ],
    asJson,
  );
}
