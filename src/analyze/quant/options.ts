// `options-analysis`: the chain readings an options trader looks at, per
// expiry, computed from a provider chain (CBOE for US listings, Deribit for
// BTC/ETH) with the pure functions of src/analytics/options.ts.
//
// Two conversions happen here, and both are stated in the output:
//   - the provider chain stores IV in PERCENT (40.4); the analytics expect a
//     FRACTION (0.404);
//   - Deribit's BTC/ETH options are inverse (premium in coin): premiums are
//     turned into USD at the index price, and Deribit sends no greeks in the
//     book summary, so delta and gamma are Black–Scholes on each expiry's own
//     future (r = 0: Black-76 on the forward).
//
// IV rank needs a history of IV that no keyless source serves: every run
// stores the day's 30-day ATM IV under <home>/state/iv-history/<SYM>.json, and
// the rank is computed once 20 days are stored.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blackScholes,
  type ChainOption,
  chainSentiment,
  expectedMove,
  gammaExposure,
  ivRank,
  type Leg,
  maxPain,
  payoffAtExpiry,
  pnlMatrix,
  strategyProfile,
  unusualActivity,
} from "../../analytics/options.js";
import { homeDir } from "../../core/paths.js";
import { UsageError, writeFileAtomic } from "../../engine.js";
import type { OptionChain } from "../../providers/options/chain.js";
import { fmt, moveKey, type PointList } from "./common.js";

const DAY = 86_400_000;
const YEAR = 365 * DAY;

export type OptionVenue = "cboe" | "deribit";

export interface QuantOption extends ChainOption {
  contract: string;
  /** The price this expiry is measured against: the underlying (CBOE) or the expiry's own future (Deribit). */
  forward: number;
}

export interface QuantChain {
  underlying: string;
  venue: OptionVenue;
  /** Spot (CBOE) or Deribit's index price. */
  spot: number;
  /** Currency of strikes and — after conversion — premiums. */
  currency: string;
  /** Units of underlying per contract: 100 for US equity options, 1 for Deribit. */
  multiplier: number;
  /** Rate used for Black–Scholes marks (0 for Deribit, which prices on the forward). */
  rate: number;
  options: QuantOption[];
  /** Expiries, nearest first, with calendar days to expiry. */
  expiries: Array<{ expiry: string; dte: number }>;
  notes: string[];
}

/** Settlement hour (UTC) of an expiry day: US equity options at the 16:00 New York close (~20:00 UTC), Deribit at 08:00 UTC. */
const SETTLE_HOUR: Record<OptionVenue, string> = { cboe: "20", deribit: "08" };

/**
 * A provider chain → the analytics' shape: IV as a fraction, T in years,
 * premiums in the strike currency, delta and gamma filled by Black–Scholes when
 * the venue does not send them.
 */
export function toQuantChain(chain: OptionChain, venue: OptionVenue, now: Date, rate: number): QuantChain {
  const inverse = chain.premiumCurrency === chain.underlying;
  const toCcy = inverse ? chain.underlyingPrice : 1;
  const r = venue === "deribit" ? 0 : rate;
  const notes: string[] = [];
  let filled = 0;
  const options: QuantOption[] = [];
  for (const c of chain.contracts) {
    const t = Math.max(0, (Date.parse(`${c.expiry}T${SETTLE_HOUR[venue]}:00:00Z`) - now.getTime()) / YEAR);
    const forward = c.underlyingPrice ?? chain.underlyingPrice;
    const iv = c.iv !== undefined && c.iv > 0 ? c.iv / 100 : undefined;
    let { delta, gamma } = c;
    if ((delta === undefined || gamma === undefined) && iv !== undefined && t > 0) {
      const g = blackScholes(c.right, { spot: forward, strike: c.strike, t, r, vol: iv });
      delta ??= g.delta;
      gamma ??= g.gamma;
      filled++;
    }
    const px = (v: number | undefined) => (v === undefined ? undefined : v * toCcy);
    options.push({
      contract: c.contract,
      right: c.right,
      strike: c.strike,
      t,
      expiry: c.expiry,
      forward,
      ...(px(c.bid) !== undefined ? { bid: px(c.bid) } : {}),
      ...(px(c.ask) !== undefined ? { ask: px(c.ask) } : {}),
      ...(px(c.last) !== undefined ? { last: px(c.last) } : {}),
      ...(iv !== undefined ? { iv } : {}),
      ...(delta !== undefined ? { delta } : {}),
      ...(gamma !== undefined ? { gamma } : {}),
      openInterest: c.openInterest,
      volume: c.volume,
    });
  }
  if (inverse) notes.push(`premiums quoted in ${chain.underlying} converted to ${chain.strikeCurrency} at the index price ${chain.underlyingPrice}`);
  if (filled) notes.push(`${filled} contract(s) had no greeks from the venue: delta and gamma are Black–Scholes from their IV (r = ${r})`);
  const expiries = [...new Set(options.map((o) => o.expiry))]
    .sort()
    .map((expiry) => ({ expiry, dte: Math.max(0, Math.round((Date.parse(`${expiry}T00:00:00Z`) - now.getTime()) / DAY)) }));
  return {
    underlying: chain.underlying,
    venue,
    spot: chain.underlyingPrice,
    currency: chain.strikeCurrency,
    multiplier: venue === "deribit" ? 1 : 100,
    rate: r,
    options,
    expiries,
    notes,
  };
}

/** A standard monthly expiry: the third Friday (US listed) or the last Friday of the month (Deribit). */
export function isMonthlyExpiry(expiry: string, venue: OptionVenue): boolean {
  const d = new Date(`${expiry}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCDay() !== 5) return false;
  const day = d.getUTCDate();
  if (venue === "cboe") return day >= 15 && day <= 21;
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return day + 7 > daysInMonth;
}

/** The default expiries: the next `n` monthlies at least `minDays` out, topped up with the nearest others when fewer are listed. */
export function pickExpiries(expiries: ReadonlyArray<{ expiry: string; dte: number }>, venue: OptionVenue, n = 3, minDays = 7): string[] {
  const far = expiries.filter((e) => e.dte >= minDays);
  const monthly = far.filter((e) => isMonthlyExpiry(e.expiry, venue)).slice(0, n);
  const picked = new Set(monthly.map((e) => e.expiry));
  for (const e of far) {
    if (picked.size >= n) break;
    picked.add(e.expiry);
  }
  return [...picked].sort();
}

const midOf = (o: ChainOption): { price: number; basis: "mid" | "last" } | undefined =>
  o.bid !== undefined && o.ask !== undefined && o.ask > 0 && o.bid > 0 && o.ask >= o.bid
    ? { price: (o.bid + o.ask) / 2, basis: "mid" }
    : o.last !== undefined && o.last > 0
      ? { price: o.last, basis: "last" }
      : undefined;

/** Per-expiry readings as points under `<U>.quant.opt.<expiry>.…`. */
export function expiryPoints(q: QuantChain, expiry: string, out: PointList): void {
  const U = q.underlying;
  const at = q.options.filter((o) => o.expiry === expiry);
  if (!at.length) return;
  const k = `${U}.quant.opt.${expiry}`;
  const s = `${U} ${expiry}`;
  const fwd = at[0]!.forward;
  const t = at[0]!.t;
  const dte = q.expiries.find((e) => e.expiry === expiry)?.dte;
  out.num(`${k}.dte`, `${s} calendar days to expiry`, dte, "days");
  if (q.venue === "deribit") out.num(`${k}.forward`, `${s} future price the expiry prices off (Deribit)`, fwd, q.currency);
  const em = expectedMove(at, fwd, expiry);
  if (em) {
    out.num(`${k}.atmStrike`, `${s} at-the-money strike`, em.atmStrike, q.currency, "strike nearest the underlying");
    out.num(`${k}.straddle`, `${s} ATM straddle price (per unit)`, em.straddle, q.currency, "call + put at the ATM strike, priced at mid (bid/ask), else last");
    out.num(`${k}.straddlePct`, `${s} ATM straddle as % of the underlying`, (em.straddle / fwd) * 100, "%", "straddle / underlying × 100");
    out.num(`${k}.move1sd.straddle`, `${s} one-standard-deviation move implied by the straddle`, em.move1sd, q.currency, "straddle × √(π/2) ≈ 1.25 × straddle");
    out.num(`${k}.move.low`, `${s} lower bound of the 1-sd range (straddle)`, fwd - em.move1sd, q.currency, "underlying − move1sd");
    out.num(`${k}.move.high`, `${s} upper bound of the 1-sd range (straddle)`, fwd + em.move1sd, q.currency, "underlying + move1sd");
    if (em.atmIv !== undefined) {
      out.num(`${k}.atmIv`, `${s} ATM implied volatility`, em.atmIv * 100, "%", "mean of the ATM call and put IV");
      out.num(
        `${k}.move1sd.iv`,
        `${s} one-standard-deviation move from ATM IV`,
        fwd * em.atmIv * Math.sqrt(t),
        q.currency,
        `underlying × IV × √T, T = ${fmt(t, 4)} years`,
      );
    }
  }
  const mp = maxPain(at, expiry);
  if (mp) {
    out.num(`${k}.maxPain`, `${s} max pain strike`, mp.strike, q.currency, "expiry price minimising option holders' total intrinsic value (OI-weighted)");
    out.num(`${k}.maxPain.distance`, `${s} max pain vs underlying`, (mp.strike / fwd - 1) * 100, "%", "(max pain / underlying − 1) × 100");
  }
  const gex = gammaExposure(at, fwd, q.multiplier);
  if (gex.byStrike.length) {
    out.num(
      `${k}.gex.total`,
      `${s} dealer gamma exposure (${q.currency} per 1 % move)`,
      gex.total,
      q.currency,
      `Σ Γ × OI × ${q.multiplier} × S² × 1 %, calls +, puts − (assumes dealers long calls, short puts)`,
    );
    out.text(
      `${k}.gex.sign`,
      `${s} dealer gamma regime`,
      gex.total >= 0 ? "positive: dealer hedging tends to damp moves" : "negative: dealer hedging tends to amplify moves",
      "sign of the total gamma exposure — an approximation: dealers' real books are unknown",
    );
    out.num(
      `${k}.gex.flip`,
      `${s} gamma flip strike`,
      gex.flip,
      q.currency,
      "first strike where cumulative GEX (low to high strike) turns from negative to non-negative",
    );
    out.num(`${k}.gex.callWall`, `${s} call wall (largest call OI)`, gex.callWall, q.currency, "strike with the largest call open interest");
    out.num(`${k}.gex.putWall`, `${s} put wall (largest put OI)`, gex.putWall, q.currency, "strike with the largest put open interest");
  }
  const sent = chainSentiment(at);
  out.num(`${k}.pcOi`, `${s} put/call open-interest ratio`, sent.putCallOi, "ratio", "Σ put OI / Σ call OI");
  out.num(`${k}.pcVolume`, `${s} put/call volume ratio`, sent.putCallVolume, "ratio", "Σ put volume / Σ call volume");
  out.num(
    `${k}.skew25d`,
    `${s} 25-delta skew (put IV − call IV)`,
    sent.skew25d === undefined ? undefined : sent.skew25d * 100,
    "vol pts",
    "IV of the put nearest −0.25 delta − IV of the call nearest +0.25 delta, in volatility points",
  );
}

/**
 * ATM IV per expiry (the term structure) and the 30-day constant-maturity ATM
 * IV interpolated in total variance. An expiry counts only where the strike
 * nearest its underlying has a two-sided quote (bid and ask > 0) on BOTH the
 * call and the put: an unquoted illiquid weekly carries a model IV that is
 * noise, and one such point can drag the 30-day figure far off.
 */
export function termStructure(
  q: QuantChain,
  maxDays = 400,
): { points: Array<{ expiry: string; dte: number; atmIv: number; strike: number }>; skipped: string[]; iv30?: number } {
  const quoted = (o: QuantOption | undefined) => !!o && o.bid !== undefined && o.ask !== undefined && o.bid > 0 && o.ask > 0 && o.iv !== undefined;
  const points: Array<{ expiry: string; dte: number; atmIv: number; strike: number }> = [];
  const skipped: string[] = [];
  for (const { expiry, dte } of q.expiries) {
    if (dte < 1 || dte > maxDays) continue;
    const at = q.options.filter((o) => o.expiry === expiry);
    const fwd = at[0]!.forward;
    let best: { strike: number; iv: number } | undefined;
    for (const k of new Set(at.map((o) => o.strike))) {
      const c = at.find((o) => o.strike === k && o.right === "call");
      const p = at.find((o) => o.strike === k && o.right === "put");
      if (!quoted(c) || !quoted(p)) continue;
      if (!best || Math.abs(k - fwd) < Math.abs(best.strike - fwd)) best = { strike: k, iv: ((c!.iv! + p!.iv!) / 2) * 100 };
    }
    // The nearest two-sided strike must still be near the money (within 10 %).
    if (best && Math.abs(best.strike / fwd - 1) <= 0.1) points.push({ expiry, dte, atmIv: best.iv, strike: best.strike });
    else skipped.push(expiry);
  }
  return { points, skipped, iv30: constantMaturityIv(points, 30) };
}

/** ATM IV at `days` by linear interpolation of total variance σ²·T between the bracketing expiries (flat beyond the ends). */
export function constantMaturityIv(points: ReadonlyArray<{ dte: number; atmIv: number }>, days: number): number | undefined {
  if (!points.length) return undefined;
  const below = [...points].reverse().find((p) => p.dte <= days);
  const above = points.find((p) => p.dte >= days);
  if (!below) return above!.atmIv;
  if (!above) return below.atmIv;
  if (above.dte === below.dte) return below.atmIv;
  const v1 = below.atmIv ** 2 * below.dte;
  const v2 = above.atmIv ** 2 * above.dte;
  const v = v1 + ((v2 - v1) * (days - below.dte)) / (above.dte - below.dte);
  return Math.sqrt(v / days);
}

export function termPoints(U: string, term: ReturnType<typeof termStructure>, out: PointList): void {
  for (const p of term.points)
    out.num(
      `${U}.quant.term.${p.expiry}`,
      `${U} ATM implied volatility, ${p.expiry} (${p.dte} days, strike ${p.strike})`,
      p.atmIv,
      "%",
      "mean of call and put IV at the two-sided-quoted strike nearest the expiry's underlying",
    );
  const front = term.points.find((p) => p.dte >= 7);
  const back = [...term.points].reverse().find((p) => p.dte <= 365);
  if (front && back && back.expiry !== front.expiry) {
    const slope = back.atmIv - front.atmIv;
    out.num(`${U}.quant.term.slope`, `${U} term-structure slope (${back.expiry} − ${front.expiry} ATM IV)`, slope, "vol pts", "back ATM IV − front ATM IV");
    out.text(
      `${U}.quant.term.shape`,
      `${U} term-structure shape`,
      slope > 0.5 ? "contango (upward: calm front)" : slope < -0.5 ? "backwardation (inverted: stress priced near term)" : "flat",
      "contango if slope > 0.5 vol pts, backwardation if < −0.5, else flat",
    );
  }
  out.num(
    `${U}.quant.iv30`,
    `${U} 30-day constant-maturity ATM implied volatility`,
    term.iv30,
    "%",
    "total variance σ²·T interpolated linearly between the expiries around 30 days",
  );
}

/** Contracts flagged by the modified z-score of traded premium (> 3.5) with volume above open interest. */
export function unusualPoints(q: QuantChain, expiries: readonly string[], out: PointList, limit = 5): number {
  const pool = q.options.filter((o) => expiries.includes(o.expiry));
  const hits = unusualActivity(pool, 3.5, q.multiplier).slice(0, limit) as Array<QuantOption & { premium: number; volOi: number; z: number }>;
  const U = q.underlying;
  hits.forEach((h, i) => {
    const k = `${U}.quant.unusual.${i + 1}`;
    const s = `${U} unusual activity #${i + 1} (${h.contract})`;
    out.text(`${k}.contract`, `${U} unusual activity #${i + 1} contract`, `${h.contract} — ${h.right} ${h.strike} ${h.expiry}`);
    out.num(`${k}.volume`, `${s} volume`, h.volume, "contracts");
    out.num(`${k}.oi`, `${s} open interest`, h.openInterest, "contracts");
    out.num(`${k}.volOi`, `${s} volume / open interest`, h.volOi, "ratio", "volume / max(1, OI)");
    out.num(`${k}.premium`, `${s} traded premium`, h.premium, q.currency, `mid (else last) × volume × ${q.multiplier}`);
    out.num(`${k}.z`, `${s} modified z-score of traded premium`, h.z, "z", "0.6745 × (premium − median) / MAD over the selected expiries' traded contracts");
  });
  out.num(`${U}.quant.unusual.count`, `${U} contracts flagged as unusual (selected expiries)`, hits.length, "count", "modified z-score > 3.5 and volume > OI");
  return hits.length;
}

// --- IV history (for IV rank) -------------------------------------------------------

export interface IvHistory {
  symbol: string;
  /** date (YYYY-MM-DD) → 30-day ATM IV in percent. */
  series: Record<string, number>;
}

export function ivHistoryPath(symbol: string): string {
  return join(homeDir(), "state", "iv-history", `${symbol.replace(/[^A-Z0-9._-]/gi, "_")}.json`);
}

/** Store today's IV for `symbol` (one value per date, the latest run wins) and return the whole history. */
export function recordIv(symbol: string, date: string, iv: number): IvHistory {
  const path = ivHistoryPath(symbol);
  let h: IvHistory = { symbol, series: {} };
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as IvHistory;
      if (raw && typeof raw.series === "object") h = { symbol, series: raw.series };
    } catch {
      // A corrupt file is replaced: the history restarts rather than the run failing.
    }
  }
  h.series[date] = Number(iv.toFixed(4));
  mkdirSync(join(homeDir(), "state", "iv-history"), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(h, null, 2)}\n`);
  return h;
}

/** IV rank and percentile once at least 20 dated readings exist (the current one included). */
export function ivRankPoints(U: string, history: IvHistory, current: number, out: PointList): void {
  const dates = Object.keys(history.series).sort();
  const values = dates.map((d) => history.series[d]!);
  out.num(`${U}.quant.ivHistory.days`, `${U} days of stored 30-day IV history`, values.length, "count", "readings stored by previous options-analysis runs");
  const r = ivRank(values, current);
  if (!r) {
    out.text(
      `${U}.quant.ivRank.status`,
      `${U} IV rank availability`,
      `unavailable: IV rank needs a stored history of at least 20 days (${values.length} stored since ${dates[0]}); each run adds today's reading`,
    );
    return;
  }
  const span = `${dates[0]} → ${dates[dates.length - 1]}`;
  out.num(`${U}.quant.ivRank`, `${U} IV rank over the stored history (${span})`, r.rank, "%", "(IV − min) / (max − min) × 100 over stored daily readings");
  out.num(`${U}.quant.ivPercentile`, `${U} IV percentile over the stored history (${span})`, r.percentile, "%", "share of stored readings below today's × 100");
}

// --- Strategies -----------------------------------------------------------------------

export type StrategyKind =
  | "long-call"
  | "long-put"
  | "bull-call"
  | "bear-put"
  | "iron-condor"
  | "straddle"
  | "strangle"
  | "covered-call"
  | "cash-secured-put"
  | "collar";

const ARITY: Record<StrategyKind, number> = {
  "long-call": 1,
  "long-put": 1,
  "bull-call": 2,
  "bear-put": 2,
  "iron-condor": 4,
  straddle: 1,
  strangle: 2,
  "covered-call": 1,
  "cash-secured-put": 1,
  collar: 2,
};

export const STRATEGY_USAGE =
  "--strategy long-call:K | long-put:K | bull-call:K1/K2 | bear-put:K1/K2 | iron-condor:Kp1/Kp2/Kc1/Kc2 | straddle:K | strangle:Kp/Kc | covered-call:K | cash-secured-put:K | collar:Kp/Kc";

/** "bull-call:100/110" → kind and strikes (sorted ascending), or a UsageError. */
export function parseStrategySpec(spec: string): { kind: StrategyKind; strikes: number[] } {
  const m = /^([a-z-]+):([0-9.]+(?:\/[0-9.]+)*)$/.exec(spec.trim().toLowerCase());
  const kind = m?.[1] as StrategyKind | undefined;
  if (!m || !kind || !(kind in ARITY)) throw new UsageError(`unknown strategy "${spec}" — ${STRATEGY_USAGE}`);
  const strikes = m[2]!.split("/").map(Number);
  if (strikes.length !== ARITY[kind] || strikes.some((k) => !Number.isFinite(k) || k <= 0))
    throw new UsageError(`${kind} takes ${ARITY[kind]} strike(s) — ${STRATEGY_USAGE}`);
  return { kind, strikes: [...strikes].sort((a, b) => a - b) };
}

export interface PricedLeg extends Leg {
  contract?: string;
  basis: "mid" | "last" | "spot";
}

/** Strategies whose upside is capped: a strongly bullish thesis gives up the move beyond the cap. */
export const CAPPED: ReadonlySet<StrategyKind> = new Set(["covered-call", "iron-condor", "collar", "bull-call", "cash-secured-put"]);

/** The legs of a strategy on one expiry, each priced at mid (else last) from the chain. */
export function buildStrategy(q: QuantChain, expiry: string, spec: { kind: StrategyKind; strikes: number[] }): PricedLeg[] {
  const at = q.options.filter((o) => o.expiry === expiry);
  const fwd = at[0]?.forward ?? q.spot;
  const leg = (right: "call" | "put", strike: number, quantity: number): PricedLeg => {
    const o = at.find((x) => x.right === right && Math.abs(x.strike - strike) < 1e-6);
    if (!o) {
      const listed = [...new Set(at.filter((x) => x.right === right).map((x) => x.strike))].sort((a, b) => Math.abs(a - strike) - Math.abs(b - strike));
      throw new UsageError(`no ${right} at strike ${strike} on ${expiry} — nearest listed: ${listed.slice(0, 5).join(", ")}`);
    }
    const p = midOf(o);
    if (!p) throw new Error(`${o.contract} has no two-sided quote and no last trade: it cannot be priced`);
    const atmIv = expectedMove(at, fwd, expiry)?.atmIv;
    return { right, strike, quantity, price: p.price, vol: o.iv ?? atmIv, t: o.t, contract: o.contract, basis: p.basis };
  };
  const stock = (): PricedLeg => ({ right: "stock", quantity: 1, price: fwd, basis: "spot" });
  const [a, b, c, d] = spec.strikes as [number, number, number, number];
  switch (spec.kind) {
    case "long-call":
      return [leg("call", a, 1)];
    case "long-put":
      return [leg("put", a, 1)];
    case "bull-call":
      return [leg("call", a, 1), leg("call", b, -1)];
    case "bear-put":
      return [leg("put", b, 1), leg("put", a, -1)];
    case "iron-condor":
      return [leg("put", a, 1), leg("put", b, -1), leg("call", c, -1), leg("call", d, 1)];
    case "straddle":
      return [leg("call", a, 1), leg("put", a, 1)];
    case "strangle":
      return [leg("put", a, 1), leg("call", b, 1)];
    case "covered-call":
      return [stock(), leg("call", a, -1)];
    case "cash-secured-put":
      return [leg("put", a, -1)];
    case "collar":
      return [stock(), leg("put", a, 1), leg("call", b, -1)];
  }
}

const DEFAULT_MOVES = [-0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.35, 0.5];

/** Profile (max profit/loss, breakevens, net debit), the P&L matrix and the capped-upside note, as points. */
export function strategyPoints(
  q: QuantChain,
  expiry: string,
  spec: { kind: StrategyKind; strikes: number[] },
  legs: readonly PricedLeg[],
  out: PointList,
  opts: { moves?: number[] } = {},
): string[] {
  const U = q.underlying;
  const k = `${U}.quant.strategy`;
  const name = `${spec.kind} ${spec.strikes.join("/")} ${expiry}`;
  const s = `${U} ${name}`;
  const unit = `${q.currency} per unit`;
  const notes: string[] = [];
  const fwd = q.options.find((o) => o.expiry === expiry)?.forward ?? q.spot;
  out.text(`${k}.spec`, `${U} strategy analysed`, name);
  legs.forEach((l, i) => {
    const what = l.right === "stock" ? `long 1 unit of ${U} at ${fmt(l.price, 4)}` : `${l.quantity > 0 ? "long" : "short"} ${l.right} ${l.strike}`;
    out.num(
      `${k}.leg${i + 1}.price`,
      `${s} leg ${i + 1} entry price (${what})`,
      l.price,
      q.currency,
      l.basis === "spot" ? "underlying price" : `${l.basis} of ${l.contract}`,
    );
  });
  const p = strategyProfile(legs, fwd);
  out.num(`${k}.netDebit`, `${s} net premium (+ paid, − received)`, p.netDebit, unit, "Σ quantity × entry price over option legs");
  if (p.unlimitedUpside) out.text(`${k}.maxProfit`, `${s} maximum profit at expiry`, "unlimited", "net long calls or stock beyond the top strike");
  else out.num(`${k}.maxProfit`, `${s} maximum profit at expiry`, p.maxProfit, unit, "max of the expiry payoff scanned from 0 to 3× the top strike");
  if (p.unlimitedDownside) out.text(`${k}.maxLoss`, `${s} maximum loss at expiry`, "unlimited", "net short calls beyond the top strike");
  else out.num(`${k}.maxLoss`, `${s} maximum loss at expiry`, p.maxLoss, unit, "min of the expiry payoff scanned from 0 to 3× the top strike");
  p.breakevens.forEach((be, i) =>
    out.num(`${k}.breakeven${i + 1}`, `${s} breakeven ${i + 1} at expiry`, be, q.currency, "underlying price where the expiry payoff crosses zero"),
  );
  if (spec.kind === "cash-secured-put")
    out.num(`${k}.cashSecured`, `${s} cash to secure the short put`, spec.strikes[0]! * q.multiplier, q.currency, `strike × ${q.multiplier} per contract`);
  const moves = opts.moves ?? DEFAULT_MOVES;
  for (const shift of [0, 0.1, -0.1]) {
    const m = pnlMatrix(legs, fwd, q.rate, { moves, daysForward: [0, 7, 30], volShift: shift });
    const vs = shift === 0 ? "IV unchanged" : `IV ${shift > 0 ? "+" : "−"}10 pts`;
    m.moves.forEach((mv, i) =>
      m.days.forEach((dd, j) =>
        out.num(
          `${k}.pnl.m${moveKey(mv)}.d${dd}.v${moveKey(shift)}`,
          `${s} P&L if the underlying moves ${moveKey(mv)} % in ${dd} days, ${vs}`,
          m.pnl[i]![j]!,
          unit,
          `Black–Scholes mark − entry, r = ${q.rate}, T reduced by ${dd} days (intrinsic once expired)`,
        ),
      ),
    );
  }
  const dte = q.expiries.find((e) => e.expiry === expiry)?.dte ?? 0;
  if (dte < 30) notes.push(`${expiry} expires in ${dte} days: the 30-day column of the P&L matrix is the payoff at expiry`);
  if (!p.unlimitedUpside) {
    const up = moves[moves.length - 1] ?? 0.5;
    const target = fwd * (1 + up);
    const strat = payoffAtExpiry(legs, target);
    const stock = target - fwd;
    out.num(`${k}.bullCase.pnl`, `${s} P&L at expiry if the underlying rises ${moveKey(up)} %`, strat, unit, "expiry payoff at underlying × (1 + move)");
    out.num(`${k}.bullCase.stockPnl`, `${U} long 1 unit P&L if it rises ${moveKey(up)} % (comparison)`, stock, unit, "underlying × move");
    // Where the cap binds: the lowest short-call strike (covered call, collar, bull call, iron condor), else the
    // short put strike (a cash-secured put earns at most its premium once the underlying is above it).
    const shortCalls = legs.filter((l) => l.right === "call" && l.quantity < 0).map((l) => l.strike!);
    const shortPuts = legs.filter((l) => l.right === "put" && l.quantity < 0).map((l) => l.strike!);
    const cap = shortCalls.length ? Math.min(...shortCalls) : shortPuts.length ? Math.max(...shortPuts) : undefined;
    if (CAPPED.has(spec.kind) && cap !== undefined) {
      out.num(
        `${k}.capLevel`,
        `${s} underlying price above which the payoff stops growing`,
        cap,
        q.currency,
        "lowest short-call strike (else the short put strike): above it the expiry payoff stops growing",
      );
      const msg = `capped upside: ${spec.kind} stops gaining above ${fmt(cap, 2)} ${q.currency} (${moveKey(cap / fwd - 1)} % from ${fmt(fwd, 2)}), at a maximum of ${fmt(p.maxProfit, 2)} per unit — if your thesis is strongly bullish, a capped structure caps the payoff of being right; long stock or a long call keeps the move beyond the cap`;
      out.text(`${k}.upsideCapped`, `${s} upside capped`, true, msg);
      notes.push(msg);
    }
  }
  if (legs.some((l) => l.basis === "last")) notes.push("at least one leg had no two-sided quote and was priced at its last trade, which can be stale");
  notes.push(
    `prices per unit of underlying, at mid — you pay the ask and receive the bid, so real entry is worse; multiply by ${q.multiplier} for one contract`,
  );
  return notes;
}
