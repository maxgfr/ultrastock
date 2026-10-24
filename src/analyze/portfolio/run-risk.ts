// `portfolio risk` and `portfolio stress`: exposures, concentration, the
// one-year risk of today's weights and the profile's limits; then historical
// episodes and parametric shocks replayed on the same weights.
import { bootstrapVar, cornishFisherVar, drawdowns, equityCurve, historicalCvar, historicalVar, relativeTo } from "../../analytics/performance.js";
import { stdev } from "../../analytics/stats.js";
import { mapLimit } from "../../engine.js";
import { tradingviewSnapshot } from "../../providers/markets/tradingview.js";
import { getHistory, type Resolved, resolveSymbol } from "../../providers/router.js";
import type { PriceSeries } from "../../providers/types.js";
import type { Holding, MarkedBook } from "./book.js";
import type { Findings } from "./findings.js";
import { alignReturns, closesOf, dailyHistory, windowCloses } from "./history.js";
import { concentration, diversificationRatio, isinCountry, keySlug, knownSector, limitChecks, pairwiseCorrelations, portfolioReturns } from "./risk.js";
import { baseHistories } from "./series.js";
import { looksLikeBondFund, parametricShocks, replay, SCENARIOS, SHOCKS, type StressLine } from "./stress.js";

const DAY = 86_400_000;
const pct = (x: number) => Number((x * 100).toFixed(6));
const money = (x: number) => Number(x.toFixed(2));

/** The benchmark of a EUR investor: Amundi MSCI World (CW8.PA); of a USD one, SPY. */
export const benchmarkFor = (base: string) => (base === "EUR" ? "CW8.PA" : "SPY");

/** The TradingView ticker of a holding: the Yahoo-style mapping, or EXCHANGE:TICKER from a US listing's exchange. */
function tvTicker(h: Holding): string | undefined {
  const i = h.instrument;
  if (!i) return undefined;
  if (i.market !== "us") return h.symbol;
  const ex = (i.mic ?? "").toUpperCase();
  const prefix = ex.includes("NASDAQ")
    ? "NASDAQ"
    : ex.includes("NYSE") && !ex.includes("ARCA") && !ex.includes("AMERICAN")
      ? "NYSE"
      : ex.includes("ARCA")
        ? "AMEX"
        : undefined;
  return prefix ? `${prefix}:${i.symbol.replace(/\./g, "_")}` : undefined;
}

const valued = (m: MarkedBook) => m.holdings.filter((h) => h.valueBase !== undefined && h.keys.weight);

/** Group weights and register each group's sum, cited from its members' weight keys (and the extra keys given). */
function groupWeights(
  f: Findings,
  m: MarkedBook,
  section: string,
  key: string,
  what: string,
  rows: Array<{ label: string; weight: number; from: string[] }>,
): Array<{ label: string; weight: number }> {
  const groups = new Map<string, { weight: number; from: string[] }>();
  for (const r of rows) {
    const g = groups.get(r.label) ?? { weight: 0, from: [] };
    g.weight += r.weight;
    g.from.push(...r.from);
    groups.set(r.label, g);
  }
  const out = [...groups.entries()].map(([label, g]) => ({ label, weight: g.weight, from: g.from })).sort((a, b) => b.weight - a.weight);
  for (const g of out)
    f.derive(
      section,
      `${key}.${keySlug(g.label)}`,
      `${what} ${g.label}, % of the portfolio`,
      Number(g.weight.toFixed(4)),
      "%",
      [...g.from, m.keys.total],
      `Σ weights of the ${what} ${g.label} lines`,
    );
  return out.map(({ label, weight }) => ({ label, weight }));
}

export interface RiskResult {
  byClass: Array<{ label: string; weight: number }>;
  byCurrency: Array<{ label: string; weight: number }>;
  bySector: Array<{ label: string; weight: number }>;
  byCountry: Array<{ label: string; weight: number }>;
  concentration: { hhi: number; effectiveN: number; top5: number };
  days?: number;
  volatility?: number;
  var?: Record<string, number>;
  beta?: number;
  maxDrawdown?: number;
  diversificationRatio?: number;
  breaches: Array<{ kind: string; subject: string; reason: string }>;
}

/** Everything `portfolio risk` registers. */
export async function riskAnalysis(m: MarkedBook, f: Findings, opts: { benchmark?: string } = {}): Promise<RiskResult> {
  const P = `PORTFOLIO.${m.bookName}.risk`;
  const hs = valued(m);
  const cashW = m.totalBase > 0 ? (m.cashBase / m.totalBase) * 100 : 0;

  // Exposures by class and currency.
  const byClass = groupWeights(f, m, "exposure by asset class", `${P}.class`, "asset class", [
    ...hs.map((h) => ({ label: h.assetClass, weight: h.weightPct!, from: [h.keys.weight!, `${h.symbol}.instrument.kind`] })),
    ...(m.cashBase ? [{ label: "cash", weight: cashW, from: [m.keys.cash] }] : []),
  ]);
  const stable = (c: string) => (c === "USDT" || c === "USDC" || c === "FDUSD" ? "USD" : c);
  const byCurrency = groupWeights(f, m, "exposure by currency", `${P}.currency`, "currency", [
    ...hs.map((h) => ({ label: stable(h.currency), weight: h.weightPct!, from: [h.keys.weight!] })),
    ...m.cash
      .filter((c) => c.amountBase !== undefined && m.totalBase > 0)
      .map((c) => ({ label: stable(c.currency), weight: (c.amountBase! / m.totalBase) * 100, from: [m.keys.cash] })),
  ]);
  const foreign = byCurrency.filter((c) => c.label !== m.base).reduce((s, c) => s + c.weight, 0);
  f.derive(
    "exposure by currency",
    `${P}.fxExposure`,
    `share of the portfolio not in ${m.base} (currency risk of a ${m.base} investor)`,
    Number(foreign.toFixed(4)),
    "%",
    [...hs.map((h) => h.keys.weight!), m.keys.cash],
    `Σ weights of the lines priced in another currency than ${m.base}; stablecoins count as USD`,
  );
  if (hs.some((h) => h.currency !== stable(h.currency))) f.note("stablecoin-priced lines (USDT/USDC) are counted as US-dollar exposure");

  // Sector and country of the direct shares (TradingView snapshot; ETFs: see `portfolio lookthrough`).
  const allEquities = hs.filter((h) => h.assetClass === "equity");
  const equities = allEquities.slice(0, 30);
  const sectorRows: Array<{ label: string; weight: number; from: string[] }> = [];
  const countryRows: Array<{ label: string; weight: number; from: string[] }> = [];
  const snapshots = await mapLimit(equities, 4, async (h) => {
    const ticker = tvTicker(h);
    if (!ticker) return { error: "no TradingView ticker for its listing" };
    try {
      return { ds: await tradingviewSnapshot(ticker, { columns: ["sector", "isin", "country"] }) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  equities.forEach((h, i) => {
    const snap = snapshots[i]!;
    let sector: string | undefined;
    let sectorKey: string | undefined;
    let isin = h.isin;
    let isinKey: string | undefined = h.isin ? `${h.symbol}.instrument.isin` : undefined;
    if (snap.ds) {
      const ds = snap.ds;
      f.input({ ...ds, title: `${h.symbol} sector and ISIN (TradingView snapshot)`, subject: h.symbol });
      const sp = ds.points.find((p) => p.key.endsWith(".tv.sector"));
      sector = knownSector(sp?.value);
      sectorKey = sp?.key;
      const ip = ds.points.find((p) => p.key.endsWith(".tv.isin"));
      if (!isin && typeof ip?.value === "string" && isinCountry(ip.value)) {
        isin = ip.value;
        isinKey = ip.key;
      }
      if (sp && !sector) f.note(`${h.symbol}: TradingView's sector label is not one of its known sectors — counted as unclassified`);
    } else f.note(`${h.symbol}: no sector (${snap.error})`);
    sectorRows.push({ label: sector ?? "unclassified", weight: h.weightPct!, from: [h.keys.weight!, ...(sectorKey ? [sectorKey] : [])] });
    const country = isinCountry(isin) ?? (h.instrument?.market === "us" ? "US" : undefined);
    if (!isinCountry(isin) && country === "US") f.note(`${h.symbol}: country taken from its US listing (no ISIN read)`);
    countryRows.push({ label: country ?? "unknown", weight: h.weightPct!, from: [h.keys.weight!, ...(isinKey ? [isinKey] : [])] });
  });
  for (const h of hs.filter((x) => x.assetClass !== "equity"))
    countryRows.push({ label: h.assetClass === "crypto" ? "crypto" : "funds", weight: h.weightPct!, from: [h.keys.weight!] });
  if (allEquities.length > equities.length)
    f.note(
      `sector lookups are capped at 30 shares: ${allEquities
        .slice(30)
        .map((h) => h.symbol)
        .join(", ")} not classified`,
    );
  const bySector = groupWeights(f, m, "exposure by sector (direct shares)", `${P}.sector`, "sector", sectorRows);
  const byCountry = groupWeights(f, m, "exposure by country (direct shares: ISIN prefix)", `${P}.country`, "country", countryRows);
  if (hs.some((h) => h.assetClass === "etf" || h.assetClass === "fund"))
    f.note("funds are not split by sector or country here: `portfolio lookthrough` reads their holdings where the issuer publishes them");
  f.note("country = the ISIN's prefix, i.e. where the issuer is incorporated — not where it earns its revenue");

  // Concentration over the invested lines.
  const conc = concentration(hs.map((h) => h.valueBase!));
  const wKeys = hs.map((h) => h.keys.weight!);
  f.derive(
    "concentration",
    `${P}.hhi`,
    "Herfindahl–Hirschman index of the invested weights",
    Number(conc.hhi.toFixed(6)),
    "ratio",
    wKeys,
    "Σ wᵢ² with wᵢ = value ÷ Σ invested value (cash excluded)",
  );
  f.derive("concentration", `${P}.effectiveN`, "effective number of positions", Number(conc.effectiveN.toFixed(4)), "count", [`${P}.hhi`], "1 ÷ HHI");
  f.derive(
    "concentration",
    `${P}.top5`,
    "weight of the 5 largest positions in the invested part",
    pct(conc.top5),
    "%",
    wKeys,
    "Σ of the 5 largest wᵢ (cash excluded) × 100",
  );

  const result: RiskResult = { byClass, byCurrency, bySector, byCountry, concentration: conc, breaches: [] };

  // One year of daily returns of today's weights, in EUR.
  const bench = opts.benchmark ?? benchmarkFor(m.base);
  let benchResolved: Resolved | undefined;
  try {
    benchResolved = await resolveSymbol(bench);
  } catch (e) {
    f.note(`benchmark ${bench} unavailable: ${(e as Error).message}`);
  }
  const items = hs.filter((h) => h.resolved).map((h) => ({ symbol: h.symbol, resolved: h.resolved! }));
  if (benchResolved && !items.some((i) => i.symbol === benchResolved!.instrument.symbol))
    items.push({ symbol: benchResolved.instrument.symbol, resolved: benchResolved });
  const series = await baseHistories(items, 372, "hist1y", f, m.now);
  const withHist = hs.filter((h) => series.has(h.symbol));
  const benchSeries = benchResolved ? series.get(benchResolved.instrument.symbol) : undefined;
  const missingW = hs.filter((h) => !series.has(h.symbol)).reduce((s, h) => s + h.weightPct!, 0);
  if (missingW > 0) f.note(`${missingW.toFixed(2)} % of the portfolio has no history and is left out of the return series (treated like cash)`);
  if (withHist.length) {
    const aligned = alignReturns([...withHist.map((h) => series.get(h.symbol)!.closes), ...(benchSeries ? [benchSeries.closes] : [])]);
    const assetR = aligned.returns.slice(0, withHist.length);
    const w = withHist.map((h) => h.valueBase! / m.totalBase);
    const r = portfolioReturns(w, assetR);
    const histKeys = withHist.flatMap((h) => [series.get(h.symbol)!.key, ...(series.get(h.symbol)!.fxKey ? [series.get(h.symbol)!.fxKey!] : [])]);
    const from = [...histKeys, ...withHist.map((h) => h.keys.weight!)];
    const span = aligned.dates.length ? `${aligned.dates[0]}…${aligned.dates[aligned.dates.length - 1]}` : "";
    const how = `daily returns of today's weights over ${r.length} aligned weekdays (${span}), in ${m.base} at ECB daily rates; cash earns 0`;
    if (r.length < 60) f.note(`only ${r.length} aligned daily returns: the risk figures are not computed (60 at least)`);
    else {
      result.days = r.length;
      f.derive("risk (1 year, daily)", `${P}.days`, "daily returns in the risk window", r.length, "count", from, how);
      result.volatility = stdev(r) * Math.sqrt(252);
      f.derive(
        "risk (1 year, daily)",
        `${P}.volatility`,
        "annualised volatility of today's portfolio",
        pct(result.volatility),
        "%",
        from,
        `stdev(daily returns) × √252; ${how}`,
      );
      const vars: Record<string, number> = {};
      for (const c of [0.95, 0.99]) {
        const tag = String(Math.round(c * 100));
        const measures: Array<[string, string, number, string]> = [
          [`var${tag}`, `1-day historical VaR ${tag} %`, historicalVar(r, c), `−quantile(daily returns, ${(1 - c).toFixed(2)})`],
          [`cvar${tag}`, `1-day historical CVaR (expected shortfall) ${tag} %`, historicalCvar(r, c), "−mean of the returns at or below the VaR quantile"],
          [`cfVar${tag}`, `1-day Cornish–Fisher VaR ${tag} %`, cornishFisherVar(r, c), "−(mean + z_cf × stdev), z corrected for skewness and excess kurtosis"],
        ];
        const b10 = bootstrapVar(r, 10, c, 5000, 42);
        measures.push(
          [
            `var${tag}d10`,
            `10-day bootstrap VaR ${tag} %`,
            b10.var,
            "5 000 seeded paths (seed 42) of 10 daily returns resampled with replacement, compounded; −quantile",
          ],
          [`cvar${tag}d10`, `10-day bootstrap CVaR ${tag} %`, b10.cvar, "mean loss beyond the 10-day bootstrap VaR"],
        );
        for (const [k, label, v, formula] of measures) {
          vars[k] = v;
          const key = f.derive("value at risk", `${P}.${k}`, `${label} (loss, % of the portfolio)`, pct(v), "%", from, `${formula}; ${how}`);
          if (key)
            f.derive(
              "value at risk",
              `${P}.${k}.amount`,
              `${label} (loss in ${m.base})`,
              money(v * m.totalBase),
              m.base,
              [key, m.keys.total],
              "loss % × portfolio total",
            );
        }
      }
      result.var = vars;
      const dd = drawdowns(equityCurve(r));
      result.maxDrawdown = dd.maxDrawdown;
      f.derive(
        "risk (1 year, daily)",
        `${P}.maxDrawdown`,
        "maximum drawdown of today's weights over the window",
        pct(dd.maxDrawdown),
        "%",
        from,
        `worst peak-to-trough of the compounded daily returns; ${how}`,
      );
      const dr = diversificationRatio(w, assetR);
      result.diversificationRatio = dr;
      f.derive(
        "risk (1 year, daily)",
        `${P}.diversificationRatio`,
        "diversification ratio",
        Number(dr.toFixed(4)),
        "ratio",
        from,
        "Σ wᵢ σᵢ ÷ σ(portfolio): 1 = no diversification benefit",
      );
      if (benchSeries) {
        const br = aligned.returns[withHist.length]!;
        const rel = relativeTo(r, br, 252);
        result.beta = rel.beta;
        const bfrom = [...from, benchSeries.key];
        f.derive(
          "risk (1 year, daily)",
          `${P}.beta`,
          `beta to ${benchSeries.symbol}`,
          Number(rel.beta.toFixed(4)),
          "ratio",
          bfrom,
          `cov(portfolio, ${benchSeries.symbol}) ÷ var(${benchSeries.symbol}), daily, in ${m.base}`,
        );
        f.derive(
          "risk (1 year, daily)",
          `${P}.benchCorrelation`,
          `correlation with ${benchSeries.symbol}`,
          Number(rel.correlation.toFixed(4)),
          "ratio",
          bfrom,
          "Pearson correlation of the daily returns",
        );
      }
      // Correlations of the 5 largest holdings with a history.
      const top = [...withHist].sort((a, b) => b.valueBase! - a.valueBase!).slice(0, 5);
      if (top.length >= 2) {
        const idx = top.map((t) => withHist.indexOf(t));
        for (const c of pairwiseCorrelations(
          top.map((t) => t.symbol),
          idx.map((i) => assetR[i]!),
        ))
          f.derive(
            "correlation of the top holdings",
            `${P}.corr.${c.a}.${c.b}`,
            `correlation of ${c.a} and ${c.b} (daily, 1 year)`,
            Number(c.rho.toFixed(4)),
            "ratio",
            [series.get(c.a)!.key, series.get(c.b)!.key],
            `Pearson correlation of the aligned daily ${m.base} returns`,
          );
      }
    }
  }

  // Limits.
  const cryptoPct = hs.filter((h) => h.assetClass === "crypto").reduce((s, h) => s + h.weightPct!, 0);
  const checks = limitChecks(m.profile.limits, {
    positions: hs.map((h) => ({ label: h.symbol, weight: h.weightPct! })),
    sectors: bySector.filter((s) => s.label !== "unclassified"),
    cryptoPct,
    cashPct: cashW,
  });
  for (const c of checks) {
    const from =
      c.kind === "position"
        ? [hs.find((h) => h.symbol === c.subject)!.keys.weight!]
        : c.kind === "sector"
          ? [`${P}.sector.${keySlug(c.subject)}`]
          : c.kind === "crypto"
            ? [...hs.filter((h) => h.assetClass === "crypto").map((h) => h.keys.weight!), m.keys.total]
            : [m.keys.cash, m.keys.total];
    f.derive(
      "profile limits",
      `${P}.limit.${c.kind}.${keySlug(c.subject)}`,
      `${c.kind} limit${c.kind === "position" || c.kind === "sector" ? ` — ${c.subject}` : ""}`,
      c.breach ? "BREACH" : "ok",
      undefined,
      from,
      c.reason,
    );
    if (c.breach) result.breaches.push({ kind: c.kind, subject: c.subject, reason: c.reason });
  }
  return result;
}

// ─── stress ────────────────────────────────────────────────────────────────

/** Equity proxies in order of preference (a EUR world tracker, then the S&P 500 in USD); bonds: the US aggregate; crypto: bitcoin. */
const PROXIES = { equity: ["CW8.PA", "SPY"], bond: ["AGG"], crypto: ["BTCUSDT"] } as const;
/** Binance's first BTCUSDT day; no crypto window starts before it. */
const CRYPTO_START = "2017-08-17";
/** At most this many holdings are replayed (the largest); the rest are reported as uncovered. */
export const STRESS_MAX_HOLDINGS = 15;

export interface StressResult {
  scenarios: Array<{ id: string; label: string; from: string; to: string; impactPct: number; coveredPct: number; lines: StressLine[] }>;
  shocks: Array<{ id: string; label: string; impactPct: number }>;
}

/** Everything `portfolio stress` registers. */
export async function stressAnalysis(m: MarkedBook, f: Findings): Promise<StressResult> {
  const P = `PORTFOLIO.${m.bookName}.stress`;
  const hs = valued(m)
    .sort((a, b) => b.valueBase! - a.valueBase!)
    .slice(0, STRESS_MAX_HOLDINGS);
  if (valued(m).length > hs.length) f.note(`only the ${STRESS_MAX_HOLDINGS} largest holdings are replayed; the others count as uncovered`);
  type Win = { symbol: string; id: string; start: { date: string; close: number }; end: { date: string; close: number }; key: string; series: PriceSeries };
  const windowCache = new Map<string, Promise<Win | undefined>>();
  const windowOf = (symbol: string, resolved: Resolved | undefined, from: string, to: string, id: string) => {
    const k = `${symbol}|${id}`;
    if (!windowCache.has(k))
      windowCache.set(
        k,
        (async () => {
          const r = resolved ?? (await resolveSymbol(symbol));
          if (r.instrument.market === "crypto" && to < CRYPTO_START) return undefined;
          const a = new Date(Date.parse(`${from}T00:00:00Z`) - 10 * DAY);
          const b = new Date(Date.parse(`${to}T00:00:00Z`) + 10 * DAY);
          const s = r.instrument.market === "crypto" ? await getHistory(r, { from: a, to: b, interval: "1d" }) : await dailyHistory(r, a, b, m.now);
          const w = windowCloses(closesOf(s), from, to);
          return w ? { symbol, id, ...w, key: `${symbol}.stress.${id}`, series: s } : undefined;
        })().catch(() => undefined),
      );
    return windowCache.get(k)!;
  };
  const register = (w: Win) =>
    f.input({
      kind: "history",
      title: `${w.symbol} over the ${w.id} window`,
      subject: w.symbol,
      points: [
        {
          key: `${w.key}.start`,
          label: `${w.symbol} close at the start of the ${w.id} window`,
          value: w.start.close,
          unit: w.series.instrument.currency,
          asOf: w.start.date,
        },
        {
          key: `${w.key}.end`,
          label: `${w.symbol} close at the end of the ${w.id} window`,
          value: w.end.close,
          unit: w.series.instrument.currency,
          asOf: w.end.date,
        },
      ],
      provenance: { ...w.series.provenance, asOf: w.end.date },
      notes: w.series.notes,
    });

  const result: StressResult = { scenarios: [], shocks: [] };
  for (const sc of SCENARIOS) {
    const section = `${sc.label} (${sc.from} → ${sc.to})`;
    // Fetch concurrently; register and derive in holding order (stable evidence ids).
    const found = await mapLimit(hs, 4, async (h) => {
      const own = await windowOf(h.symbol, h.resolved, sc.from, sc.to, sc.id);
      if (own) return { win: own, proxy: undefined };
      const chain = h.assetClass === "crypto" ? PROXIES.crypto : looksLikeBondFund(h.instrument?.name) ? PROXIES.bond : PROXIES.equity;
      for (const p of chain) {
        const w = await windowOf(p, undefined, sc.from, sc.to, sc.id);
        if (w) return { win: w, proxy: p as string };
      }
      return { win: undefined, proxy: undefined };
    });
    const lines: StressLine[] = [];
    const from: string[] = [];
    hs.forEach((h, i) => {
      const { win, proxy } = found[i]!;
      const line: StressLine = { symbol: h.symbol, weight: h.weightPct! / 100, basis: "none" };
      if (win) {
        register(win);
        line.basis = proxy ? "proxy" : "own";
        if (proxy) line.proxy = proxy;
        line.move = win.end.close / win.start.close - 1;
        const key = f.derive(
          section,
          `${P}.${sc.id}.${h.symbol}.move`,
          `${h.symbol} move over the ${sc.label} window${proxy ? ` (proxy ${proxy})` : ""}`,
          pct(line.move),
          "%",
          [`${win.key}.start`, `${win.key}.end`],
          `end close ÷ start close − 1, in the series' own currency${proxy ? `; ${h.symbol} had no prices then — ${proxy} stands in` : ""}`,
        );
        if (key) from.push(key, h.keys.weight!);
      } else if (h.assetClass === "crypto" && sc.to < CRYPTO_START) {
        line.move = SHOCKS.crypto;
        line.basis = "shock";
        const key = f.derive(
          section,
          `${P}.${sc.id}.${h.symbol}.move`,
          `${h.symbol} move over the ${sc.label} window (no crypto market then: the crypto shock stands in)`,
          pct(SHOCKS.crypto),
          "%",
          [h.keys.weight!],
          "parametric crypto shock (no crypto prices exist for the window)",
        );
        if (key) from.push(key, h.keys.weight!);
      }
      lines.push(line);
    });
    const rp = replay(lines);
    if (!from.length) {
      f.note(`${sc.label}: no holding or proxy has prices over ${sc.from} → ${sc.to}`);
      continue;
    }
    const proxied = lines.filter((l) => l.basis === "proxy").map((l) => `${l.symbol} → ${l.proxy}`);
    const k = f.derive(
      section,
      `${P}.${sc.id}.impact`,
      `portfolio move if the ${sc.label} replayed on today's weights`,
      pct(rp.portfolio),
      "%",
      from,
      `Σ weightᵢ × moveᵢ; cash 0 %; moves in each series' currency (currency moves not included)${proxied.length ? `; proxies: ${proxied.join(", ")}` : ""}`,
    );
    if (k)
      f.derive(
        section,
        `${P}.${sc.id}.loss`,
        `portfolio gain/loss in ${m.base} in the ${sc.label} replay`,
        money(rp.portfolio * m.totalBase),
        m.base,
        [k, m.keys.total],
        "move × portfolio total",
      );
    if (rp.uncovered > 0)
      f.note(`${sc.label}: ${(rp.uncovered * 100).toFixed(2)} % of the portfolio has neither its own prices nor a proxy for the window and is left at 0 %`);
    if (proxied.length) f.note(`${sc.label}: proxies used — ${proxied.join(", ")}`);
    result.scenarios.push({ id: sc.id, label: sc.label, from: sc.from, to: sc.to, impactPct: rp.portfolio * 100, coveredPct: rp.covered * 100, lines });
  }

  // Cash in a foreign currency moves with it: USD cash is in the USD shock.
  const cashLines = m.cash
    .filter((c) => c.amountBase !== undefined && c.currency !== m.base && m.totalBase > 0)
    .map((c) => ({ symbol: `cash:${c.account}:${c.currency}`, weight: c.amountBase! / m.totalBase, assetClass: "cash", currency: c.currency }));
  for (const s of parametricShocks([
    ...valued(m).map((h) => ({ symbol: h.symbol, weight: h.weightPct! / 100, assetClass: h.assetClass, currency: h.currency, name: h.instrument?.name })),
    ...cashLines,
  ])) {
    const hit = valued(m).filter((h) => s.hit.includes(h.symbol));
    const hitCash = cashLines.some((c) => s.hit.includes(c.symbol));
    if (!hit.length && !hitCash) {
      f.note(`shock "${s.label}": no holding concerned`);
      result.shocks.push({ id: s.id, label: s.label, impactPct: 0 });
      continue;
    }
    const k = f.derive(
      "parametric shocks",
      `${P}.shock.${s.id}`,
      `portfolio move under the shock: ${s.label}`,
      pct(s.impact),
      "%",
      [...hit.map((h) => h.keys.weight!), ...(hitCash ? [m.keys.cash, m.keys.total] : [])],
      `${s.formula} (lines: ${s.hit.join(", ")})`,
    );
    if (k)
      f.derive(
        "parametric shocks",
        `${P}.shock.${s.id}.loss`,
        `portfolio loss in ${m.base} under the shock: ${s.label}`,
        money(s.impact * m.totalBase),
        m.base,
        [k, m.keys.total],
        "move × portfolio total",
      );
    result.shocks.push({ id: s.id, label: s.label, impactPct: s.impact * 100 });
  }
  if (valued(m).some((h) => looksLikeBondFund(h.instrument?.name)))
    f.note("bond funds are read from their names; durations are assumed (2 for 1–3-year funds, 6 otherwise), not read from the fund");
  f.note("historical windows use each holding's own prices when it was listed then (Yahoo when the primary source keeps less history), else the stated proxy");
  return result;
}
