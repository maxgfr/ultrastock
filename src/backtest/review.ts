// The review scorecard (after tradermonty's backtest-expert): PASS, REVISE or
// REJECT, each check with its value, its threshold and the reason. The
// thresholds are the conventional ones and live here, in the open:
//   sample       ≥ 30 trades (under 10: REJECT) and ≥ 3 years or a full cycle
//                (the asset itself fell ≥ 20 % and made a new high inside the window)
//   profit       a net profit at the modelled costs (a loss: REJECT)
//   robustness   walk-forward OOS Sharpe ≥ 50 % of the in-sample Sharpe (OOS ≤ 0:
//                REJECT); deflated Sharpe ≥ 0.95 (required for PASS); PBO < 0.5
//   costs        still profitable at ×2 fees and slippage
//   concentration no single trade above 25 % of the net profit
//   survivorship the symbol was not picked from today's index members
//   look-ahead   the engine's guarantee, re-checked on this run's own data
// Verdict: REJECT if any critical check fails, PASS if every check passes,
// REVISE otherwise.

export type CheckStatus = "pass" | "fail" | "n/a";

export interface ReviewCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** A failure here rejects the strategy outright. */
  critical: boolean;
  value?: number | string;
  threshold: string;
  reason: string;
}

export interface ReviewInputs {
  trades: number;
  years: number;
  fullCycle: boolean;
  netProfit: number;
  isSharpe?: number;
  oosSharpe?: number;
  dsr?: number;
  nTrials: number;
  pbo?: number;
  stressedNetProfit: number;
  largestWinSharePct?: number;
  /** The index the symbol was picked from, when it was. */
  universe?: string;
  /** Trades of a run on a truncated series that differ from the full run's (must be 0). */
  lookAheadMismatches: number;
  lookAheadCheckedAt?: string;
}

export interface Review {
  verdict: "PASS" | "REVISE" | "REJECT";
  checks: ReviewCheck[];
  reasons: string[];
}

const f2 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(2));

export function reviewScorecard(i: ReviewInputs): Review {
  const checks: ReviewCheck[] = [];
  const add = (c: ReviewCheck) => checks.push(c);
  add({
    id: "sample.trades",
    label: "Sample size: trades",
    status: i.trades >= 30 ? "pass" : "fail",
    critical: i.trades < 10,
    value: i.trades,
    threshold: "≥ 30 (under 10 rejects)",
    reason: i.trades >= 30 ? `${i.trades} closed trades` : `${i.trades} closed trades is too few to tell skill from luck`,
  });
  add({
    id: "sample.span",
    label: "Sample size: span",
    status: i.years >= 3 || i.fullCycle ? "pass" : "fail",
    critical: false,
    value: Number(i.years.toFixed(2)),
    threshold: "≥ 3 years, or a full cycle (a ≥ 20 % fall and a new high)",
    reason:
      i.years >= 3
        ? `${i.years.toFixed(1)} years`
        : i.fullCycle
          ? `${i.years.toFixed(1)} years covering a full cycle`
          : `${i.years.toFixed(1)} years without a full cycle`,
  });
  add({
    id: "profit.base",
    label: "Net profit at modelled costs",
    status: i.netProfit > 0 ? "pass" : "fail",
    critical: i.netProfit <= 0,
    value: Number(i.netProfit.toFixed(2)),
    threshold: "> 0",
    reason: i.netProfit > 0 ? "profitable after fees, slippage and funding" : "loses money after costs",
  });
  if (i.oosSharpe === undefined || i.isSharpe === undefined)
    add({ id: "robust.oos", label: "Out-of-sample Sharpe", status: "n/a", critical: false, threshold: "≥ 50 % of in-sample", reason: "no walk-forward ran" });
  else {
    const ok = i.isSharpe > 0 && i.oosSharpe >= 0.5 * i.isSharpe;
    add({
      id: "robust.oos",
      label: "Out-of-sample Sharpe vs in-sample",
      status: ok ? "pass" : "fail",
      critical: !(i.oosSharpe > 0),
      value: `${f2(i.oosSharpe)} vs ${f2(i.isSharpe)}`,
      threshold: "OOS ≥ 50 % of IS (OOS ≤ 0 rejects)",
      reason: ok
        ? `walk-forward kept ${((i.oosSharpe / i.isSharpe) * 100).toFixed(0)} % of the in-sample Sharpe`
        : i.oosSharpe > 0
          ? "the edge shrinks by more than half out of sample"
          : "no edge out of sample",
    });
  }
  add({
    id: "robust.dsr",
    label: "Deflated Sharpe ratio",
    status: i.dsr === undefined ? "n/a" : i.dsr >= 0.95 ? "pass" : "fail",
    critical: false,
    value: i.dsr === undefined ? undefined : Number(i.dsr.toFixed(4)),
    threshold: "≥ 0.95 for PASS",
    reason:
      i.dsr === undefined
        ? "not computed"
        : `probability the Sharpe beats the best of ${i.nTrials} skill-less variant(s): ${(i.dsr * 100).toFixed(1)} %${i.dsr >= 0.95 ? "" : " — not shown beyond the search that found it"}`,
  });
  add({
    id: "robust.pbo",
    label: "Probability of backtest overfitting",
    status: i.pbo === undefined ? "n/a" : i.pbo < 0.5 ? "pass" : "fail",
    critical: false,
    value: i.pbo === undefined ? undefined : Number(i.pbo.toFixed(4)),
    threshold: "< 0.5",
    reason:
      i.pbo === undefined
        ? "needs ≥ 2 variants and enough bars"
        : `the in-sample best ranked in the bottom half out of sample in ${(i.pbo * 100).toFixed(0)} % of splits`,
  });
  add({
    id: "costs.x2",
    label: "Profit at ×2 costs",
    status: i.stressedNetProfit > 0 ? "pass" : "fail",
    critical: false,
    value: Number(i.stressedNetProfit.toFixed(2)),
    threshold: "> 0",
    reason: i.stressedNetProfit > 0 ? "survives doubled fees and slippage" : "the edge is eaten by doubled fees and slippage",
  });
  add({
    id: "concentration",
    label: "Largest trade's share of net profit",
    status: i.largestWinSharePct === undefined ? "n/a" : i.largestWinSharePct <= 25 ? "pass" : "fail",
    critical: false,
    value: i.largestWinSharePct === undefined ? undefined : Number(i.largestWinSharePct.toFixed(2)),
    threshold: "≤ 25 %",
    reason:
      i.largestWinSharePct === undefined
        ? "no net profit to divide"
        : i.largestWinSharePct <= 25
          ? "profit spread over many trades"
          : "one trade carries the result — remove it and the edge may vanish",
  });
  add({
    id: "survivorship",
    label: "Survivorship",
    status: i.universe ? "fail" : "pass",
    critical: false,
    value: i.universe,
    threshold: "not picked from today's index members",
    reason: i.universe
      ? `picked from today's ${i.universe} members: the companies that left the index are missing, which biases results upward`
      : "a single symbol named by the user (no index membership involved)",
  });
  add({
    id: "lookahead",
    label: "Look-ahead",
    status: i.lookAheadMismatches === 0 ? "pass" : "fail",
    critical: i.lookAheadMismatches > 0,
    value: i.lookAheadMismatches,
    threshold: "0 trades differ on a truncated series",
    reason:
      i.lookAheadMismatches === 0
        ? `signals use closed bars only and fill at the next open; re-run on the series cut at ${i.lookAheadCheckedAt ?? "two thirds"} gives the same trades`
        : `${i.lookAheadMismatches} trade(s) changed when future bars were removed — the strategy reads the future`,
  });
  const critical = checks.filter((c) => c.status === "fail" && c.critical);
  const failed = checks.filter((c) => c.status === "fail");
  const verdict = critical.length ? "REJECT" : failed.length || checks.some((c) => c.id === "robust.dsr" && c.status !== "pass") ? "REVISE" : "PASS";
  const reasons = (critical.length ? critical : failed).map((c) => `${c.label}: ${c.reason}`);
  if (verdict === "PASS") reasons.push("every check passed, including a deflated Sharpe ≥ 0.95");
  return { verdict, checks, reasons };
}
