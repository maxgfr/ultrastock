// `stats`: the statistical portrait of one price series, or how several move
// together. Pure functions over daily bars; the command fetches the bars.
//
// One symbol: the shape of daily log returns (skew, excess kurtosis), five
// volatility estimators, a GARCH(1,1) forecast, persistence (Hurst), a unit
// root test on the log price (ADF), the filtered probability of the turbulent
// state of a two-state HMM, drawdowns, value at risk, and performance against
// a benchmark. Several: Pearson and Spearman correlation of aligned daily log
// returns, lower-tail dependence, and pairwise Engle–Granger cointegration.
//
// Annualisation: 252 periods a year for exchange listings, 365 for crypto
// (which trades every day). Aligned series use the calendar they share.
import { logReturns } from "../../analytics/indicators.js";
import {
  cornishFisherVar,
  drawdowns,
  equityCurve,
  historicalCvar,
  historicalVar,
  performanceSummary,
  simpleReturns,
  ulcerIndex,
} from "../../analytics/performance.js";
import {
  adfTest,
  correlation,
  engleGranger,
  ewmaVol,
  excessKurtosis,
  garch11,
  garmanKlassVol,
  hmm2,
  hurstExponent,
  lowerTailDependence,
  mean,
  parkinsonVol,
  skewness,
  spearman,
  stdev,
  yangZhangVol,
} from "../../analytics/stats.js";
import type { Bar } from "../../providers/types.js";
import { fmt, type PointList } from "./common.js";

/** Window of the range-based volatility estimators: about three months of sessions. */
export const VOL_WINDOW = 63;

/** The single-symbol portrait as points under `<SYM>.stats.…`. Bars are closed daily bars, oldest first. */
export function singleStatsPoints(sym: string, bars: readonly Bar[], perYear: number, out: PointList): string[] {
  const notes: string[] = [];
  const k = `${sym}.stats`;
  const closes = bars.map((b) => b.close);
  const lr = logReturns(closes);
  const last = bars[bars.length - 1]!;
  const span = `${bars[0]!.date} → ${last.date}, ${lr.length} returns`;
  const ann = Math.sqrt(perYear);
  out.num(`${k}.returns.count`, `${sym} daily returns in the sample (${span})`, lr.length, "count");
  out.num(`${k}.returns.meanAnnual`, `${sym} mean daily log return, annualised`, mean(lr) * perYear * 100, "%", `mean(log returns) × ${perYear} × 100`);
  out.num(`${k}.returns.skew`, `${sym} skewness of daily log returns`, skewness(lr), "ratio", "adjusted Fisher–Pearson sample skewness");
  out.num(
    `${k}.returns.kurtosis`,
    `${sym} excess kurtosis of daily log returns`,
    excessKurtosis(lr),
    "ratio",
    "bias-corrected sample excess kurtosis (0 = normal)",
  );

  // Volatility estimators, annualised.
  const recent = bars.slice(-VOL_WINDOW);
  const rlr = logReturns(recent.map((b) => b.close));
  const w = `last ${recent.length} bars`;
  out.num(
    `${k}.vol.closeToClose`,
    `${sym} close-to-close volatility (${w}), annualised`,
    stdev(rlr) * ann * 100,
    "%",
    `stdev(log returns) × √${perYear} × 100`,
  );
  out.num(
    `${k}.vol.closeToClose.full`,
    `${sym} close-to-close volatility (${span}), annualised`,
    stdev(lr) * ann * 100,
    "%",
    `stdev(log returns) × √${perYear} × 100`,
  );
  const ohlc = recent.filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.high >= b.low);
  if (ohlc.length === recent.length) {
    out.num(
      `${k}.vol.parkinson`,
      `${sym} Parkinson volatility (${w}), annualised`,
      parkinsonVol(ohlc) * ann * 100,
      "%",
      `√(Σ ln(H/L)² / (4 ln 2 · n)) × √${perYear} × 100`,
    );
    out.num(
      `${k}.vol.garmanKlass`,
      `${sym} Garman–Klass volatility (${w}), annualised`,
      garmanKlassVol(ohlc) * ann * 100,
      "%",
      `√(mean(½ ln(H/L)² − (2 ln 2 − 1) ln(C/O)²)) × √${perYear} × 100`,
    );
    out.num(
      `${k}.vol.yangZhang`,
      `${sym} Yang–Zhang volatility (${w}), annualised`,
      yangZhangVol(ohlc) * ann * 100,
      "%",
      `overnight + k·open-to-close + (1 − k)·Rogers–Satchell variance, √ × √${perYear} × 100`,
    );
  } else notes.push(`${sym}: some recent bars lack a usable open/high/low — range-based volatility estimators skipped`);
  out.num(
    `${k}.vol.ewma`,
    `${sym} EWMA volatility (λ 0.94), annualised`,
    ewmaVol(lr, 0.94) * ann * 100,
    "%",
    `RiskMetrics σ²_t = 0.94 σ²_{t−1} + 0.06 r²_t, √ × √${perYear} × 100`,
  );

  // GARCH(1,1).
  if (lr.length >= 50) {
    try {
      const g = garch11(lr, 10);
      const avg10 = Math.sqrt(mean(g.forecast.map((v) => v * v)));
      out.num(
        `${k}.garch.forecast10d`,
        `${sym} GARCH(1,1) volatility forecast over the next 10 sessions, annualised`,
        avg10 * ann * 100,
        "%",
        `√(mean of the 10 forecast variances) × √${perYear} × 100, Gaussian QML fit`,
      );
      out.num(`${k}.garch.current`, `${sym} GARCH(1,1) conditional volatility now, annualised`, g.currentVol * ann * 100, "%", `√h_T × √${perYear} × 100`);
      // Near α + β = 1 the long-run variance ω / (1 − α − β) is not identified: report it only below 0.995.
      if (g.persistence < 0.995)
        out.num(
          `${k}.garch.longRun`,
          `${sym} GARCH(1,1) long-run volatility, annualised`,
          g.longRunVol * ann * 100,
          "%",
          `√(ω / (1 − α − β)) × √${perYear} × 100`,
        );
      else
        notes.push(
          `${sym}: GARCH persistence ${fmt(g.persistence, 4)} ≈ 1 (integrated): shocks barely decay and the long-run volatility is not identified — not reported`,
        );
      out.num(`${k}.garch.persistence`, `${sym} GARCH(1,1) persistence α + β`, g.persistence, "ratio", `α ${fmt(g.alpha, 4)} + β ${fmt(g.beta, 4)}`);
    } catch (e) {
      notes.push(`${sym}: GARCH(1,1) did not fit (${(e as Error).message})`);
    }
  } else notes.push(`${sym}: fewer than 50 returns — no GARCH(1,1)`);

  // Persistence and stationarity.
  const h = hurstExponent(lr);
  out.num(
    `${k}.hurst`,
    `${sym} Hurst exponent of daily log returns`,
    h,
    "ratio",
    "rescaled range over doubling windows; ≈0.5 random walk, > 0.5 trending, < 0.5 mean-reverting",
  );
  if (lr.length >= 30) {
    const adf = adfTest(closes.map((c) => Math.log(c)));
    out.num(`${k}.adf.stat`, `${sym} ADF statistic on log price (${adf.lags} lags)`, adf.stat, "t", "Δy = a + γ y₋₁ + Σ φ Δy₋ᵢ; t-statistic of γ");
    out.num(`${k}.adf.critical5`, `${sym} ADF 5 % critical value (constant, MacKinnon)`, adf.critical["5%"], "t");
    out.text(
      `${k}.adf.verdict`,
      `${sym} log price unit-root verdict`,
      adf.stationary5 ? "stationary at 5 % (mean-reverting level)" : "unit root not rejected at 5 % (behaves like a random walk)",
      "ADF statistic vs the 5 % critical value",
    );
  }

  // Regime.
  if (lr.length >= 30) {
    try {
      const m = hmm2(lr);
      out.num(
        `${k}.hmm.turbulent`,
        `${sym} probability of the turbulent regime now (2-state HMM)`,
        m.turbulentProbability[m.turbulentProbability.length - 1]! * 100,
        "%",
        "Baum–Welch Gaussian HMM on daily log returns; FILTERED probability (data up to the last bar only)",
      );
      out.num(`${k}.hmm.calmVol`, `${sym} calm-regime volatility (HMM), annualised`, m.vols[0] * ann * 100, "%", `state σ × √${perYear} × 100`);
      out.num(`${k}.hmm.turbulentVol`, `${sym} turbulent-regime volatility (HMM), annualised`, m.vols[1] * ann * 100, "%", `state σ × √${perYear} × 100`);
    } catch (e) {
      notes.push(`${sym}: the regime model did not fit (${(e as Error).message})`);
    }
  }

  // Drawdowns.
  const eq = closes.map((c) => c / closes[0]!);
  const dd = drawdowns(eq);
  out.num(`${k}.maxDrawdown`, `${sym} maximum drawdown (${span})`, dd.maxDrawdown * 100, "%", "min of (close / running peak − 1) × 100");
  out.text(`${k}.maxDrawdown.window`, `${sym} maximum drawdown window`, `${bars[dd.peakIndex]!.date} → ${bars[dd.troughIndex]!.date}`);
  out.num(
    `${k}.drawdownNow`,
    `${sym} drawdown from the sample high now`,
    (dd.series[dd.series.length - 1] ?? 0) * 100,
    "%",
    "(last close / running peak − 1) × 100",
  );
  out.num(`${k}.ulcer`, `${sym} Ulcer index`, ulcerIndex(eq), "index", "√(mean of squared percentage drawdowns)");

  // Value at risk, one day, on simple returns.
  const sr = simpleReturns(closes);
  for (const c of [0.95, 0.99]) {
    const pc = Math.round(c * 100);
    out.num(
      `${k}.var${pc}`,
      `${sym} 1-day historical VaR ${pc} %`,
      historicalVar(sr, c) * 100,
      "%",
      `−quantile(daily simple returns, ${fmt(1 - c, 2)}) × 100 (a positive loss)`,
    );
    out.num(
      `${k}.cvar${pc}`,
      `${sym} 1-day expected shortfall (CVaR) ${pc} %`,
      historicalCvar(sr, c) * 100,
      "%",
      "−mean of returns at or below the VaR quantile × 100",
    );
    out.num(
      `${k}.cfVar${pc}`,
      `${sym} 1-day Cornish–Fisher VaR ${pc} %`,
      cornishFisherVar(sr, c) * 100,
      "%",
      "Gaussian quantile corrected for skewness and excess kurtosis",
    );
  }
  return notes;
}

/** Closes of several series on the dates they all share, oldest first. */
export function alignCloses(series: ReadonlyArray<readonly Bar[]>): { dates: string[]; closes: number[][] } {
  if (!series.length) return { dates: [], closes: [] };
  const maps = series.map((bars) => new Map(bars.map((b) => [b.date, b.close])));
  const dates = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  return { dates, closes: maps.map((m) => dates.map((d) => m.get(d)!)) };
}

/** Performance against a benchmark on shared dates (simple returns), under `<SYM>.stats.vs.<BENCH>.…`. */
export function benchmarkPoints(sym: string, bench: string, bars: readonly Bar[], benchBars: readonly Bar[], perYear: number, out: PointList): string[] {
  const { dates, closes } = alignCloses([bars, benchBars]);
  if (dates.length < 30) return [`${sym} vs ${bench}: only ${dates.length} shared dates — no relative statistics`];
  const r = simpleReturns(closes[0]!);
  const b = simpleReturns(closes[1]!);
  const ps = performanceSummary(r, perYear, { benchmark: b });
  const k = `${sym}.stats.vs.${bench}`;
  const s = `${sym} (${dates[0]} → ${dates[dates.length - 1]}, ${r.length} shared-date returns)`;
  out.num(`${k}.cagr`, `${s} compound annual growth`, ps.cagr * 100, "%", `(last / first)^(${perYear} / periods) − 1`);
  out.num(`${k}.volatility`, `${s} annualised volatility`, ps.volatility * 100, "%", `stdev(simple returns) × √${perYear}`);
  out.num(`${k}.sharpe`, `${s} Sharpe ratio (risk-free 0)`, ps.sharpe, "ratio", `mean / stdev × √${perYear}`);
  out.num(`${k}.sortino`, `${s} Sortino ratio`, ps.sortino, "ratio", `mean / downside deviation × √${perYear}`);
  out.num(`${k}.calmar`, `${s} Calmar ratio`, ps.calmar, "ratio", "CAGR / |max drawdown|");
  out.num(`${k}.psr`, `${s} probabilistic Sharpe ratio (vs 0)`, ps.probabilisticSharpe * 100, "%", "Bailey & López de Prado (2012)");
  out.num(`${k}.hitRate`, `${s} share of up periods`, ps.hitRate * 100, "%");
  const rel = ps.relative;
  if (rel) {
    out.num(`${k}.beta`, `${s} beta vs ${bench}`, rel.beta, "x", "cov(r, r_bench) / var(r_bench)");
    out.num(`${k}.alpha`, `${s} Jensen's alpha vs ${bench}, annualised`, rel.alpha * 100, "%", `(mean r − β mean r_bench) × ${perYear}`);
    out.num(`${k}.correlation`, `${s} correlation with ${bench}`, rel.correlation, "ratio");
    out.num(`${k}.trackingError`, `${s} tracking error vs ${bench}`, rel.trackingError * 100, "%", `stdev(r − r_bench) × √${perYear}`);
    out.num(`${k}.informationRatio`, `${s} information ratio vs ${bench}`, rel.informationRatio, "ratio");
    out.num(`${k}.upCapture`, `${s} up-capture vs ${bench}`, rel.upCapture * 100, "%", "mean r / mean r_bench over the benchmark's up periods");
    out.num(`${k}.downCapture`, `${s} down-capture vs ${bench}`, rel.downCapture * 100, "%", "mean r / mean r_bench over the benchmark's down periods");
  }
  const bdd = drawdowns(equityCurve(b));
  out.num(`${k}.benchMaxDrawdown`, `${bench} maximum drawdown over the same dates`, bdd.maxDrawdown * 100, "%");
  return [];
}

/** Correlation (Pearson, Spearman), lower-tail dependence and Engle–Granger cointegration of aligned series. */
export function multiStatsPoints(syms: readonly string[], aligned: { dates: string[]; closes: number[][] }, out: PointList): string[] {
  const notes: string[] = [];
  const rets = aligned.closes.map((c) => logReturns(c));
  const logs = aligned.closes.map((c) => c.map((x) => Math.log(x)));
  const span = `${aligned.dates[0]} → ${aligned.dates[aligned.dates.length - 1]}, ${rets[0]?.length ?? 0} aligned daily log returns`;
  out.num("MULTI.stats.aligned.returns", `Aligned daily log returns used (${span})`, rets[0]?.length ?? 0, "count", "dates on which every symbol has a close");
  for (let i = 0; i < syms.length; i++)
    for (let j = i + 1; j < syms.length; j++) {
      const a = syms[i]!;
      const b = syms[j]!;
      const k = `${a}~${b}.stats`;
      const s = `${a} vs ${b}`;
      out.num(`${k}.pearson`, `${s} Pearson correlation of daily log returns`, correlation(rets[i]!, rets[j]!), "ratio", "cov / (σ_a σ_b) on aligned returns");
      out.num(
        `${k}.spearman`,
        `${s} Spearman rank correlation of daily log returns`,
        spearman(rets[i]!, rets[j]!),
        "ratio",
        "Pearson on ranks (ties averaged)",
      );
      out.num(
        `${k}.tail5`,
        `${s} lower-tail dependence (worst 5 % days)`,
        lowerTailDependence(rets[i]!, rets[j]!, 0.05) * 100,
        "%",
        `P(${b} in its worst 5 % | ${a} in its worst 5 %) × 100, empirical`,
      );
      if (logs[i]!.length < 60) continue;
      try {
        const eg = engleGranger(logs[i]!, logs[j]!);
        out.num(`${k}.coint.hedgeRatio`, `${s} hedge ratio (log ${a} on log ${b})`, eg.beta, "ratio", "OLS slope β in ln a = α + β ln b");
        out.num(
          `${k}.coint.adf`,
          `${s} Engle–Granger ADF statistic on the spread`,
          eg.adf.stat,
          "t",
          "ADF on OLS residuals; 5 % critical −3.34 (two variables)",
        );
        out.text(
          `${k}.coint.verdict`,
          `${s} cointegration at 5 %`,
          eg.cointegrated5 ? "cointegrated (spread mean-reverts)" : "not cointegrated at 5 %",
          "residual ADF statistic < −3.34",
        );
        out.num(`${k}.coint.halfLife`, `${s} spread half-life`, eg.halfLife, "days", "ln 2 / −λ from Δspread = λ spread₋₁ (absent when not reverting)");
        out.num(`${k}.coint.z`, `${s} spread z-score now`, eg.zScore, "z", "(last spread − mean) / stdev over the sample");
      } catch (e) {
        notes.push(`${s}: cointegration test failed (${(e as Error).message})`);
      }
    }
  return notes;
}
