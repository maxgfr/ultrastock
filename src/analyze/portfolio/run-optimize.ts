// `portfolio optimize` and `portfolio goals`: target weights by four methods
// on five years of daily returns, and the Monte Carlo of a savings goal.
// Neither places an order: optimize proposes weights, `portfolio rebalance
// --targets` turns chosen weights into a trade list.
import { stdev } from "../../analytics/stats.js";
import { mapLimit } from "../../engine.js";
import { type Resolved, resolveSymbol } from "../../providers/router.js";
import type { MarkedBook } from "./book.js";
import type { Findings } from "./findings.js";
import { GOAL_PATHS, GOAL_SEED, goalMonteCarlo, PROFILE_ASSUMPTIONS } from "./goals.js";
import { alignReturns } from "./history.js";
import { effectiveCap, MEAN_SHRINK, optimizeAll } from "./optimize.js";
import { portfolioReturns } from "./risk.js";
import { baseHistories } from "./series.js";

const pct = (x: number) => Number((x * 100).toFixed(6));
const money = (x: number) => Number(x.toFixed(2));
/** Five years of calendar days, plus a few for the first return. */
const FIVE_YEARS = 5 * 365 + 7;
/** At most this many assets are optimised. */
export const OPTIMIZE_MAX_ASSETS = 30;

export interface OptimizeResult {
  assets: string[];
  days: number;
  cap: number;
  shrinkage: number;
  methods: Array<{ method: string; label: string; weights: Record<string, number>; volPct: number; retPct: number }>;
}

/** Everything `portfolio optimize` registers. `universe` replaces the holdings when given. */
export async function optimizeAnalysis(m: MarkedBook, f: Findings, opts: { universe?: string[] } = {}): Promise<OptimizeResult | undefined> {
  const P = `PORTFOLIO.${m.bookName}.optimize`;
  let items: Array<{ symbol: string; resolved: Resolved; weightKey?: string; value?: number }>;
  if (opts.universe?.length) {
    const syms = [...new Set(opts.universe.map((s) => s.trim().toUpperCase()))].slice(0, OPTIMIZE_MAX_ASSETS);
    if (opts.universe.length > syms.length) f.note(`the universe is capped at ${OPTIMIZE_MAX_ASSETS} symbols`);
    const resolved = await mapLimit(syms, 4, async (s) => resolveSymbol(s).catch((e: Error) => e));
    items = [];
    syms.forEach((s, i) => {
      const r = resolved[i]!;
      if (r instanceof Error) f.note(`${s} left out: ${r.message}`);
      else {
        const held = m.holdings.find((h) => h.symbol === r.instrument.symbol || h.symbol === s);
        items.push({ symbol: r.instrument.symbol, resolved: r, weightKey: held?.keys.weight, value: held?.valueBase });
      }
    });
  } else
    items = m.holdings
      .filter((h) => h.resolved && h.valueBase !== undefined)
      .slice(0, OPTIMIZE_MAX_ASSETS)
      .map((h) => ({ symbol: h.symbol, resolved: h.resolved!, weightKey: h.keys.weight, value: h.valueBase }));
  const series = await baseHistories(items, FIVE_YEARS, "hist5y", f, m.now);
  const used = items.filter((i) => series.has(i.symbol));
  if (used.length < 2) {
    f.note("fewer than two assets with a price history: nothing to optimise");
    return undefined;
  }
  const aligned = alignReturns(used.map((u) => series.get(u.symbol)!.closes));
  const days = aligned.dates.length;
  if (days < 120) {
    f.note(`only ${days} common daily returns across the assets: too few to estimate a covariance (120 at least)`);
    return undefined;
  }
  if (days < 1000)
    f.note(`the common window is ${days} daily returns (${aligned.dates[0]} → ${aligned.dates.at(-1)}), shorter than 5 years: the youngest asset sets it`);
  const { cap, raised } = effectiveCap(m.profile.limits.maxPositionPct, used.length);
  if (raised)
    f.note(
      `the profile caps a position at ${m.profile.limits.maxPositionPct} %, which ${used.length} assets cannot reach 100 % under: the cap is raised to ${(cap * 100).toFixed(2)} % (1/n) here${cap * used.length <= 1 + 1e-9 ? " — which forces equal weights: add assets or raise limits.maxPositionPct for the methods to differ" : ""}`,
    );
  const current = used.every((u) => u.value !== undefined) ? used.map((u) => u.value!) : undefined;
  const { results, shrinkage, mu } = optimizeAll(aligned.returns, { cap, current });
  const histKeys = used.flatMap((u) => [series.get(u.symbol)!.key, ...(series.get(u.symbol)!.fxKey ? [series.get(u.symbol)!.fxKey!] : [])]);
  const how = `${days} aligned daily ${m.base} returns (${aligned.dates[0]} → ${aligned.dates.at(-1)})`;
  f.derive("estimation", `${P}.days`, "daily returns in the estimation window", days, "count", histKeys, how);
  f.derive(
    "estimation",
    `${P}.shrinkage`,
    "Ledoit–Wolf shrinkage intensity toward constant correlation",
    Number(shrinkage.toFixed(6)),
    "ratio",
    histKeys,
    `Ledoit & Wolf (2004) optimal intensity on ${how} (0 = sample covariance, 1 = target)`,
  );
  f.derive(
    "estimation",
    `${P}.cap`,
    "weight cap per asset",
    pct(cap),
    "%",
    histKeys,
    raised ? "max(profile maxPositionPct, 1/n)" : "profile limits.maxPositionPct",
  );
  used.forEach((u, i) =>
    f.derive(
      "estimation",
      `${P}.mu.${u.symbol}`,
      `${u.symbol} expected return used by max Sharpe (weak estimate)`,
      pct(mu[i]!),
      "%",
      [series.get(u.symbol)!.key],
      `annualised mean daily return × 252, shrunk ${MEAN_SHRINK * 100} % toward the cross-sectional average; past means predict future returns poorly`,
    ),
  );
  for (const r of results) {
    const from = r.method === "current" ? [...histKeys, ...used.map((u) => u.weightKey).filter((k): k is string => !!k)] : histKeys;
    used.forEach((u, i) =>
      f.derive(
        `${r.label}`,
        `${P}.${r.method}.${u.symbol}`,
        `${u.symbol} target weight — ${r.label}`,
        pct(r.weights[i]!),
        "%",
        from,
        r.method === "current" ? "today's value ÷ Σ values over the universe" : `${r.label}, long-only, cap ${pct(cap).toFixed(2)} %, Ledoit–Wolf covariance`,
      ),
    );
    f.derive(
      `${r.label}`,
      `${P}.${r.method}.vol`,
      `expected annual volatility — ${r.label}`,
      pct(r.vol),
      "%",
      from,
      "√(wᵀ Σ w × 252) with the shrunk covariance",
    );
    f.derive(
      `${r.label}`,
      `${P}.${r.method}.return`,
      `expected annual return — ${r.label} (weak)`,
      pct(r.ret),
      "%",
      [...from, ...used.map((u) => `${P}.mu.${u.symbol}`)],
      "Σ wᵢ μᵢ with the shrunk historical means",
    );
  }
  f.note(
    "max Sharpe leans on expected returns: the 5-year historical mean, shrunk halfway to the average, is a weak estimate — read its weights as a sensitivity, not a forecast; the risk-free rate is taken as 0",
    "risk parity and HRP have no cap of their own: their weights are clipped at the cap and the excess redistributed pro rata",
    "nothing is ordered: `portfolio rebalance --targets` turns chosen weights into a trade list",
  );
  return {
    assets: used.map((u) => u.symbol),
    days,
    cap,
    shrinkage,
    methods: results.map((r) => ({
      method: r.method,
      label: r.label,
      weights: Object.fromEntries(used.map((u, i) => [u.symbol, pct(r.weights[i]!)])),
      volPct: pct(r.vol),
      retPct: pct(r.ret),
    })),
  };
}

// ─── goals ─────────────────────────────────────────────────────────────────

/** Three years of common daily history at least before the portfolio's own mean and volatility are used. */
export const GOAL_MIN_DAYS = 756;

export interface GoalsResult {
  basis: "history" | "profile";
  ret: number;
  vol: number;
  probabilityPct: number;
  p5: number;
  median: number;
  p95: number;
  monthlyFor80?: number;
}

/** Everything `portfolio goals` registers. */
export async function goalsAnalysis(m: MarkedBook, f: Findings, opts: { target: number; years: number; monthly: number }): Promise<GoalsResult> {
  const P = `PORTFOLIO.${m.bookName}.goals`;
  const hs = m.holdings.filter((h) => h.resolved && h.valueBase !== undefined).slice(0, OPTIMIZE_MAX_ASSETS);
  const series = await baseHistories(
    hs.map((h) => ({ symbol: h.symbol, resolved: h.resolved! })),
    FIVE_YEARS,
    "hist5y",
    f,
    m.now,
  );
  const withHist = hs.filter((h) => series.has(h.symbol));
  let basis: "history" | "profile" = "profile";
  let ret = 0;
  let vol = 0;
  let from: string[] = [];
  let formula = "";
  if (withHist.length && withHist.length === hs.length) {
    const aligned = alignReturns(withHist.map((h) => series.get(h.symbol)!.closes));
    const invested = withHist.reduce((s, h) => s + h.valueBase!, 0);
    const r = portfolioReturns(
      withHist.map((h) => h.valueBase! / invested),
      aligned.returns,
    );
    if (r.length >= GOAL_MIN_DAYS) {
      basis = "history";
      ret = (r.reduce((s, x) => s + x, 0) / r.length) * 252;
      vol = stdev(r) * Math.sqrt(252);
      from = [...withHist.map((h) => series.get(h.symbol)!.key), ...withHist.map((h) => h.keys.weight!)];
      formula = `today's invested weights over ${r.length} aligned daily ${m.base} returns (${aligned.dates[0]} → ${aligned.dates.at(-1)}): mean × 252 and stdev × √252`;
      f.note("the history-based return is the past mean of today's holdings — a weak guide to the next years; cash is assumed invested like the rest");
    } else f.note(`only ${r.length} common daily returns (fewer than ${GOAL_MIN_DAYS}, 3 years): the profile-based assumption is used instead of the history`);
  } else if (hs.length) f.note("not every holding has a 5-year history: the profile-based assumption is used");
  if (basis === "profile") {
    const score = m.profile.riskScore ?? 4;
    const a = PROFILE_ASSUMPTIONS[Math.min(7, Math.max(1, Math.round(score)))]!;
    ret = a.ret;
    vol = a.vol;
    from = [m.keys.total];
    formula = `assumption for risk score ${score}${m.profile.riskScore === undefined ? " (no suitability score in the profile: 4, balanced, assumed)" : ""}: a blend from cash/bonds (1) to all-equity (5+)`;
  }
  const kRet = f.derive("assumptions", `${P}.return`, `expected annual return used (${basis})`, pct(ret), "%", from, formula);
  const kVol = f.derive("assumptions", `${P}.volatility`, `annual volatility used (${basis})`, pct(vol), "%", from, formula);
  const res = goalMonteCarlo({ start: m.totalBase, target: opts.target, years: opts.years, monthly: opts.monthly, ret, vol });
  const inputs = [kRet, kVol, m.keys.total].filter((k): k is string => !!k);
  const how = `${GOAL_PATHS} seeded paths (seed ${GOAL_SEED}) of monthly log-normal returns over ${opts.years} years from ${money(m.totalBase)} ${m.base}, +${opts.monthly} ${m.base} a month`;
  f.derive(
    "outcome",
    `${P}.probability`,
    `probability of reaching ${opts.target} ${m.base} in ${opts.years} years`,
    pct(res.probability),
    "%",
    inputs,
    `share of paths ending ≥ target; ${how}`,
  );
  f.derive("outcome", `${P}.p5`, "5th percentile outcome", money(res.p5), m.base, inputs, `quantile 5 % of the final values; ${how}`);
  f.derive("outcome", `${P}.median`, "median outcome", money(res.median), m.base, inputs, `quantile 50 %; ${how}`);
  f.derive("outcome", `${P}.p95`, "95th percentile outcome", money(res.p95), m.base, inputs, `quantile 95 %; ${how}`);
  f.derive("outcome", `${P}.contributed`, "money put in (start + contributions)", money(res.contributed), m.base, [m.keys.total], "start + monthly × months");
  if (res.monthlyFor80 !== undefined)
    f.derive(
      "outcome",
      `${P}.monthlyFor80`,
      "monthly contribution for an 80 % probability",
      money(res.monthlyFor80),
      m.base,
      inputs,
      `bisection on the contribution over the same seeded paths until P(final ≥ target) = 80 %; ${how}`,
    );
  else f.note("no monthly contribution found that reaches 80 % (searched up to about a million a month)");
  f.note("nominal euros, before tax and inflation; returns are i.i.d. log-normal — real markets have fatter tails and regimes");
  return { basis, ret, vol, probabilityPct: res.probability * 100, p5: res.p5, median: res.median, p95: res.p95, monthlyFor80: res.monthlyFor80 };
}
