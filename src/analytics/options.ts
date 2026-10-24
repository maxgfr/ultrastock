// Option mathematics: prices, Greeks, implied volatility, American exercise,
// multi-leg payoffs, and the chain-level readings traders use (expected move,
// max pain, gamma exposure, put/call skew). Pure functions over numbers; the
// chain itself comes from a provider (CBOE for US listings, Deribit for crypto).
//
// Conventions: T in years, rates and yields continuously compounded, volatility
// annualised (0.25 = 25 %), prices per unit of underlying (multiply by the
// contract multiplier — 100 for US equity options — for money).
import { normCdf, normPdf } from "./stats.js";

export type Right = "call" | "put";

export interface BsInput {
  spot: number;
  strike: number;
  /** Years to expiry. */
  t: number;
  /** Risk-free rate. */
  r: number;
  vol: number;
  /** Continuous dividend (or carry) yield. */
  q?: number;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** Per 1.00 change in volatility (divide by 100 for per vol point). */
  vega: number;
  /** Per year (divide by 365 for per calendar day). */
  theta: number;
  /** Per 1.00 change in the rate. */
  rho: number;
}

function d1d2({ spot, strike, t, r, vol, q = 0 }: BsInput): [number, number] {
  const d1 = (Math.log(spot / strike) + (r - q + (vol * vol) / 2) * t) / (vol * Math.sqrt(t));
  return [d1, d1 - vol * Math.sqrt(t)];
}

/** Black–Scholes–Merton price and Greeks of a European option. */
export function blackScholes(right: Right, input: BsInput): Greeks {
  const { spot, strike, t, r, vol, q = 0 } = input;
  if (t <= 0 || vol <= 0) {
    const intrinsic = right === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    const itm = right === "call" ? spot > strike : spot < strike;
    return { price: intrinsic, delta: itm ? (right === "call" ? 1 : -1) : 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const [d1, d2] = d1d2(input);
  const dq = Math.exp(-q * t);
  const dr = Math.exp(-r * t);
  const sq = Math.sqrt(t);
  const gamma = (dq * normPdf(d1)) / (spot * vol * sq);
  const vega = spot * dq * normPdf(d1) * sq;
  if (right === "call") {
    return {
      price: spot * dq * normCdf(d1) - strike * dr * normCdf(d2),
      delta: dq * normCdf(d1),
      gamma,
      vega,
      theta: (-spot * dq * normPdf(d1) * vol) / (2 * sq) - r * strike * dr * normCdf(d2) + q * spot * dq * normCdf(d1),
      rho: strike * t * dr * normCdf(d2),
    };
  }
  return {
    price: strike * dr * normCdf(-d2) - spot * dq * normCdf(-d1),
    delta: -dq * normCdf(-d1),
    gamma,
    vega,
    theta: (-spot * dq * normPdf(d1) * vol) / (2 * sq) + r * strike * dr * normCdf(-d2) - q * spot * dq * normCdf(-d1),
    rho: -strike * t * dr * normCdf(-d2),
  };
}

/**
 * Implied volatility from a market price: Newton–Raphson from Brenner–
 * Subrahmanyam's guess, bisection when Newton leaves the bracket. Undefined
 * when the price is outside the no-arbitrage bounds.
 */
export function impliedVol(right: Right, price: number, input: Omit<BsInput, "vol">): number | undefined {
  const { spot, strike, t, r, q = 0 } = input;
  if (t <= 0 || price <= 0) return undefined;
  const lower =
    right === "call" ? Math.max(0, spot * Math.exp(-q * t) - strike * Math.exp(-r * t)) : Math.max(0, strike * Math.exp(-r * t) - spot * Math.exp(-q * t));
  const upper = right === "call" ? spot * Math.exp(-q * t) : strike * Math.exp(-r * t);
  if (price < lower - 1e-9 || price > upper + 1e-9) return undefined;
  let lo = 1e-4;
  let hi = 5;
  let v = Math.max(0.05, Math.min(2, Math.sqrt((2 * Math.PI) / t) * (price / spot)));
  for (let i = 0; i < 100; i++) {
    const g = blackScholes(right, { ...input, vol: v });
    const diff = g.price - price;
    if (Math.abs(diff) < 1e-8) return v;
    if (diff > 0) hi = v;
    else lo = v;
    const next = g.vega > 1e-10 ? v - diff / g.vega : Number.NaN;
    v = next > lo && next < hi ? next : (lo + hi) / 2;
  }
  return Math.abs(blackScholes(right, { ...input, vol: v }).price - price) < 1e-5 ? v : undefined;
}

/** American option by a Cox–Ross–Rubinstein binomial tree (early exercise checked at every node). */
export function americanBinomial(right: Right, input: BsInput, steps = 400): { price: number; delta: number; earlyExercisePremium: number } {
  const { spot, strike, t, r, vol, q = 0 } = input;
  const dt = t / steps;
  const u = Math.exp(vol * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp((r - q) * dt) - d) / (u - d);
  const disc = Math.exp(-r * dt);
  const payoff = (s: number) => (right === "call" ? Math.max(0, s - strike) : Math.max(0, strike - s));
  let values = Array.from({ length: steps + 1 }, (_, i) => payoff(spot * u ** (steps - i) * d ** i));
  let level1: number[] = [];
  for (let n = steps - 1; n >= 0; n--) {
    values = Array.from({ length: n + 1 }, (_, i) => Math.max(disc * (p * values[i]! + (1 - p) * values[i + 1]!), payoff(spot * u ** (n - i) * d ** i)));
    if (n === 1) level1 = values;
  }
  const price = values[0]!;
  const delta = (level1[0]! - level1[1]!) / (spot * u - spot * d);
  return { price, delta, earlyExercisePremium: price - blackScholes(right, input).price };
}

// --- Multi-leg strategies -----------------------------------------------------------

export interface Leg {
  right: Right | "stock";
  /** + long, − short; options in contracts' units of underlying (1 = one unit), stock in shares. */
  quantity: number;
  strike?: number;
  /** Premium paid (+) or received (−) per unit at entry; stock: entry price. */
  price: number;
  /** Implied volatility for mark-to-model before expiry. */
  vol?: number;
  /** Years to this leg's expiry at entry. */
  t?: number;
}

/** Profit of the position at expiry for one underlying price. */
export function payoffAtExpiry(legs: readonly Leg[], spotAtExpiry: number): number {
  let pnl = 0;
  for (const l of legs) {
    if (l.right === "stock") pnl += l.quantity * (spotAtExpiry - l.price);
    else {
      const intrinsic = l.right === "call" ? Math.max(0, spotAtExpiry - l.strike!) : Math.max(0, l.strike! - spotAtExpiry);
      pnl += l.quantity * (intrinsic - l.price);
    }
  }
  return pnl;
}

export interface StrategyProfile {
  maxProfit: number;
  maxLoss: number;
  /** Prices where the expiry payoff crosses zero. */
  breakevens: number[];
  /** Net premium: + paid, − received. */
  netDebit: number;
  unlimitedUpside: boolean;
  unlimitedDownside: boolean;
}

/** Max profit, max loss and breakevens at expiry, scanning prices from 0 to 3× the highest strike. */
export function strategyProfile(legs: readonly Leg[], reference: number): StrategyProfile {
  const strikes = legs.map((l) => l.strike ?? l.price).filter((x) => x > 0);
  const top = Math.max(reference, ...strikes) * 3;
  const pts: number[] = [];
  const grid = 3000;
  for (let i = 0; i <= grid; i++) pts.push((top * i) / grid);
  for (const k of strikes) pts.push(k);
  pts.sort((a, b) => a - b);
  const pnl = pts.map((s) => payoffAtExpiry(legs, s));
  const breakevens: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pnl[i - 1]!;
    const b = pnl[i]!;
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) breakevens.push(pts[i - 1]! + ((0 - a) * (pts[i]! - pts[i - 1]!)) / (b - a));
  }
  // Slope beyond the last strike tells whether the upside is capped.
  const slopeUp = legs.reduce((s, l) => s + (l.right === "stock" || l.right === "call" ? l.quantity : 0), 0);
  const slopeDownAtZero = payoffAtExpiry(legs, 0);
  return {
    maxProfit: slopeUp > 0 ? Number.POSITIVE_INFINITY : Math.max(...pnl),
    maxLoss: slopeUp < 0 ? Number.NEGATIVE_INFINITY : Math.min(...pnl, slopeDownAtZero),
    breakevens: [...new Set(breakevens.map((b) => Number(b.toFixed(4))))],
    netDebit: legs.reduce((s, l) => s + (l.right === "stock" ? 0 : l.quantity * l.price), 0),
    unlimitedUpside: slopeUp > 0,
    unlimitedDownside: slopeUp < 0,
  };
}

/**
 * The counterfactual P&L matrix: the position marked by Black–Scholes at each
 * spot move (rows) and each date before expiry (columns), volatility shifted
 * by `volShift`. What the position does if the underlying moves +10 %, +20 %…
 */
export function pnlMatrix(
  legs: readonly Leg[],
  spot: number,
  r: number,
  opts: { moves?: number[]; daysForward?: number[]; volShift?: number } = {},
): { moves: number[]; days: number[]; pnl: number[][] } {
  const moves = opts.moves ?? [-0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.35, 0.5];
  const days = opts.daysForward ?? [0, 7, 30];
  const pnl = moves.map((m) =>
    days.map((dd) =>
      legs.reduce((s, l) => {
        const sp = spot * (1 + m);
        if (l.right === "stock") return s + l.quantity * (sp - l.price);
        const t = Math.max(0, (l.t ?? 0) - dd / 365);
        const mark = blackScholes(l.right, { spot: sp, strike: l.strike!, t, r, vol: Math.max(0.01, (l.vol ?? 0.3) + (opts.volShift ?? 0)) }).price;
        return s + l.quantity * (mark - l.price);
      }, 0),
    ),
  );
  return { moves, days, pnl };
}

// --- Chain readings -------------------------------------------------------------------

export interface ChainOption {
  right: Right;
  strike: number;
  /** Years to expiry. */
  t: number;
  expiry: string;
  bid?: number;
  ask?: number;
  last?: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  openInterest?: number;
  volume?: number;
}

const mid = (o: ChainOption) => (o.bid !== undefined && o.ask !== undefined && o.ask > 0 ? (o.bid + o.ask) / 2 : o.last);

/**
 * Expected move to an expiry from the at-the-money straddle. Under Black–Scholes
 * an ATM straddle is worth ≈ √(2/π)·S·σ√T, so one standard deviation of the
 * price at expiry is the straddle × √(π/2) ≈ 1.25 × straddle. Both are reported.
 */
export function expectedMove(
  chain: readonly ChainOption[],
  spot: number,
  expiry: string,
): { straddle: number; move1sd: number; atmStrike: number; atmIv?: number } | undefined {
  const at = chain.filter((o) => o.expiry === expiry);
  if (!at.length) return undefined;
  const strikes = [...new Set(at.map((o) => o.strike))];
  const atmStrike = strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
  const call = at.find((o) => o.strike === atmStrike && o.right === "call");
  const put = at.find((o) => o.strike === atmStrike && o.right === "put");
  const c = call ? mid(call) : undefined;
  const p = put ? mid(put) : undefined;
  if (c === undefined || p === undefined) return undefined;
  const ivs = [call?.iv, put?.iv].filter((x): x is number => x !== undefined && x > 0);
  return { straddle: c + p, move1sd: (c + p) * Math.sqrt(Math.PI / 2), atmStrike, atmIv: ivs.length ? ivs.reduce((a, b) => a + b) / ivs.length : undefined };
}

/** Max pain: the expiry price at which option holders' aggregate intrinsic value is smallest. */
export function maxPain(chain: readonly ChainOption[], expiry: string): { strike: number; payout: number } | undefined {
  const at = chain.filter((o) => o.expiry === expiry && (o.openInterest ?? 0) > 0);
  if (!at.length) return undefined;
  let best: { strike: number; payout: number } | undefined;
  for (const k of [...new Set(at.map((o) => o.strike))]) {
    const payout = at.reduce((s, o) => s + (o.openInterest ?? 0) * (o.right === "call" ? Math.max(0, k - o.strike) : Math.max(0, o.strike - k)), 0);
    if (!best || payout < best.payout) best = { strike: k, payout };
  }
  return best;
}

/**
 * Dealer gamma exposure, the common convention: dealers long calls, short puts.
 * GEX per strike = Γ × OI × multiplier × S² × 1 % (money per 1 % move); calls +,
 * puts −. The sign of the total, and where the cumulative profile flips,
 * are the reading — not the units. An approximation: dealers' real books are unknown.
 */
export function gammaExposure(
  chain: readonly ChainOption[],
  spot: number,
  multiplier = 100,
): { total: number; byStrike: Array<{ strike: number; gex: number }>; flip?: number; callWall?: number; putWall?: number } {
  const by = new Map<number, number>();
  let total = 0;
  for (const o of chain) {
    if (o.gamma === undefined || !o.openInterest) continue;
    const g = o.gamma * o.openInterest * multiplier * spot * spot * 0.01 * (o.right === "call" ? 1 : -1);
    by.set(o.strike, (by.get(o.strike) ?? 0) + g);
    total += g;
  }
  const byStrike = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([strike, gex]) => ({ strike, gex }));
  let cum = 0;
  let flip: number | undefined;
  for (const { strike, gex } of byStrike) {
    const before = cum;
    cum += gex;
    if (flip === undefined && before < 0 && cum >= 0) flip = strike;
  }
  const calls = chain.filter((o) => o.right === "call" && o.openInterest);
  const puts = chain.filter((o) => o.right === "put" && o.openInterest);
  const wall = (xs: ChainOption[]) =>
    xs.reduce<ChainOption | undefined>((a, b) => (!a || (b.openInterest ?? 0) > (a.openInterest ?? 0) ? b : a), undefined)?.strike;
  return { total, byStrike, flip, callWall: wall(calls), putWall: wall(puts) };
}

/** Put/call ratios of open interest and volume, and the 25-delta skew (put IV − call IV) when deltas are known. */
export function chainSentiment(chain: readonly ChainOption[]): { putCallOi?: number; putCallVolume?: number; skew25d?: number } {
  const sum = (right: Right, f: (o: ChainOption) => number | undefined) => chain.filter((o) => o.right === right).reduce((s, o) => s + (f(o) ?? 0), 0);
  const coi = sum("call", (o) => o.openInterest);
  const cv = sum("call", (o) => o.volume);
  const near = (right: Right, target: number) =>
    chain
      .filter((o) => o.right === right && o.delta !== undefined && o.iv)
      .reduce<ChainOption | undefined>((a, b) => (!a || Math.abs(b.delta! - target) < Math.abs(a.delta! - target) ? b : a), undefined);
  const p25 = near("put", -0.25);
  const c25 = near("call", 0.25);
  return {
    putCallOi: coi ? sum("put", (o) => o.openInterest) / coi : undefined,
    putCallVolume: cv ? sum("put", (o) => o.volume) / cv : undefined,
    skew25d: p25?.iv && c25?.iv ? p25.iv - c25.iv : undefined,
  };
}

/** IV rank and percentile of the current IV against its own history (both 0–100). */
export function ivRank(history: readonly number[], current: number): { rank: number; percentile: number } | undefined {
  if (history.length < 20) return undefined;
  const lo = Math.min(...history);
  const hi = Math.max(...history);
  return { rank: hi > lo ? ((current - lo) / (hi - lo)) * 100 : 50, percentile: (history.filter((v) => v < current).length / history.length) * 100 };
}

/**
 * Unusual activity: contracts whose volume is far above their open interest
 * and whose traded premium is an outlier by the modified z-score
 * (0.6745·(x − median)/MAD > threshold, Iglewicz & Hoaglin).
 */
export function unusualActivity(
  chain: readonly ChainOption[],
  threshold = 3.5,
  multiplier = 100,
): Array<ChainOption & { premium: number; volOi: number; z: number }> {
  const rows = chain
    .filter((o) => (o.volume ?? 0) > 0)
    .map((o) => ({ ...o, premium: (mid(o) ?? 0) * (o.volume ?? 0) * multiplier, volOi: (o.volume ?? 0) / Math.max(1, o.openInterest ?? 0) }));
  if (rows.length < 5) return [];
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const prem = rows.map((r) => r.premium);
  const m = med(prem);
  const mad = med(prem.map((p) => Math.abs(p - m)));
  if (mad === 0) return [];
  return rows
    .map((r) => ({ ...r, z: (0.6745 * (r.premium - m)) / mad }))
    .filter((r) => r.z > threshold && r.volOi > 1)
    .sort((a, b) => b.z - a.z);
}
