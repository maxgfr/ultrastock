// Position sizing: how much to buy, decided by how much the trade can lose.
// Every method returns the quantity, the money at risk and why — and the
// quantity is always the SMALLEST of what the methods and the caps allow.

export interface SizingInput {
  /** Portfolio equity in the account currency. */
  equity: number;
  entry: number;
  /** Protective stop. Required for risk-based sizing. */
  stop?: number;
  /** Risk per trade as % of equity (the profile's riskPerTradePct). */
  riskPct: number;
  /** Cap on the position as % of equity (the profile's maxPositionPct). */
  maxPositionPct: number;
  /** Cash available to spend (after the cash buffer). */
  cash?: number;
  /** Lot size: 1 for shares, 0.0001 for a crypto quantity step, 100 for some lots. */
  lot?: number;
  /** Fractional quantities allowed (crypto, some brokers). */
  fractional?: boolean;
  /** Average daily volume in units: the order stays under `maxAdvPct` of it. */
  adv?: number;
  maxAdvPct?: number;
}

export interface SizingResult {
  quantity: number;
  notional: number;
  /** Money lost if the stop is hit (before slippage and fees). */
  riskAmount?: number;
  riskPct?: number;
  positionPct: number;
  /** Which constraint set the size. */
  binding: string;
  reasons: string[];
}

function roundDown(q: number, lot: number, fractional: boolean): number {
  if (fractional) return Math.floor(q / lot) * lot;
  return Math.floor(q / Math.max(1, lot)) * Math.max(1, lot);
}

/** Fixed-fractional risk sizing: quantity = equity × risk% / |entry − stop|, then every cap applies. */
export function sizePosition(i: SizingInput): SizingResult {
  const reasons: string[] = [];
  const lot = i.lot ?? 1;
  const fractional = i.fractional ?? false;
  const candidates: Array<[string, number]> = [];
  if (i.stop !== undefined) {
    const perUnit = Math.abs(i.entry - i.stop);
    if (perUnit <= 0) throw new Error("the stop equals the entry: no risk to size against");
    const q = (i.equity * (i.riskPct / 100)) / perUnit;
    candidates.push(["risk per trade", q]);
    reasons.push(`risk ${i.riskPct} % of ${i.equity.toFixed(2)} over ${perUnit.toFixed(4)} per unit to the stop → ${q.toFixed(4)}`);
  } else reasons.push("no stop given: size by the position cap only — a position without a stop has no defined risk");
  const capQ = (i.equity * (i.maxPositionPct / 100)) / i.entry;
  candidates.push(["position cap", capQ]);
  reasons.push(`position cap ${i.maxPositionPct} % → ${capQ.toFixed(4)}`);
  if (i.cash !== undefined) {
    candidates.push(["available cash", i.cash / i.entry]);
    reasons.push(`cash ${i.cash.toFixed(2)} → ${(i.cash / i.entry).toFixed(4)}`);
  }
  if (i.adv !== undefined) {
    const q = i.adv * ((i.maxAdvPct ?? 5) / 100);
    candidates.push(["liquidity (share of daily volume)", q]);
    reasons.push(`${i.maxAdvPct ?? 5} % of average daily volume ${i.adv.toFixed(0)} → ${q.toFixed(4)}`);
  }
  const [binding, raw] = candidates.reduce((a, b) => (b[1] < a[1] ? b : a));
  const quantity = Math.max(0, roundDown(raw, lot, fractional));
  if (quantity === 0)
    reasons.push(`rounded to the lot size (${lot}${fractional ? ", fractional" : ""}) the quantity is zero — the trade is too small for these limits`);
  const notional = quantity * i.entry;
  const riskAmount = i.stop !== undefined ? quantity * Math.abs(i.entry - i.stop) : undefined;
  return {
    quantity,
    notional,
    riskAmount,
    riskPct: riskAmount !== undefined ? (riskAmount / i.equity) * 100 : undefined,
    positionPct: (notional / i.equity) * 100,
    binding,
    reasons,
  };
}

/** A stop `multiple` ATRs from the entry, on the side that protects the position. */
export function atrStop(entry: number, atr: number, multiple = 2, side: "long" | "short" = "long"): number {
  return side === "long" ? entry - multiple * atr : entry + multiple * atr;
}

/**
 * Kelly fraction f* = p − (1 − p)/b for a win rate p and payoff ratio b, then
 * discounted: half-Kelly by default, a tenth when fewer than 30 trades back the
 * estimates, never negative. A cap, not a target.
 */
export function kellyFraction(
  winRate: number,
  payoff: number,
  opts: { fraction?: number; sampleSize?: number } = {},
): { full: number; applied: number; reason: string } {
  const full = winRate - (1 - winRate) / payoff;
  const frac = (opts.sampleSize ?? 0) < 30 ? 0.1 : (opts.fraction ?? 0.5);
  const applied = Math.max(0, full * frac);
  return {
    full,
    applied,
    reason:
      full <= 0
        ? "no edge: the Kelly fraction is not positive — do not bet"
        : `full Kelly ${(full * 100).toFixed(1)} %, × ${frac} → ${(applied * 100).toFixed(2)} %${(opts.sampleSize ?? 0) < 30 ? " (fewer than 30 trades: a tenth of Kelly)" : ""}`,
  };
}

/** Kelly for a binary contract bought at `price` (0–1) when you believe the probability is `p`. */
export function binaryKelly(p: number, price: number, fraction = 0.5): number {
  if (price <= 0 || price >= 1) return 0;
  const b = (1 - price) / price;
  return Math.max(0, (p - (1 - p) / b) * fraction);
}

/** Volatility targeting: the weight that gives the position `targetVol` annualised volatility. */
export function volTargetWeight(assetVol: number, targetVol: number, maxWeight = 1): number {
  return assetVol > 0 ? Math.min(maxWeight, targetVol / assetVol) : 0;
}

/** Expectancy in R multiples and the profit factor of closed trades (R = P&L / initial risk). */
export function expectancy(rMultiples: readonly number[]): { expectancyR: number; winRate: number; avgWinR: number; avgLossR: number; profitFactor: number } {
  const wins = rMultiples.filter((r) => r > 0);
  const losses = rMultiples.filter((r) => r <= 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    expectancyR: rMultiples.length ? sum([...rMultiples]) / rMultiples.length : 0,
    winRate: rMultiples.length ? wins.length / rMultiples.length : 0,
    avgWinR: wins.length ? sum(wins) / wins.length : 0,
    avgLossR: losses.length ? sum(losses) / losses.length : 0,
    profitFactor: sum(losses) < 0 ? sum(wins) / -sum(losses) : Number.POSITIVE_INFINITY,
  };
}

/** Reward-to-risk of a plan: (target − entry) / (entry − stop), for a long. */
export function rewardRisk(entry: number, stop: number, target: number): number {
  return (target - entry) / (entry - stop);
}
