// The circuit breaker: losses beyond the profile's limits stop new risk, and a
// drawdown shrinks position sizes before it stops them. It reads the equity
// curve the book records (one snapshot per valuation) and the realised result
// of closed trades — nothing the agent can talk its way around.
//
//   daily loss ≥ maxDailyLossPct      → tripped until the next day
//   weekly loss ≥ maxWeeklyLossPct    → until the next week
//   monthly loss ≥ maxMonthlyLossPct  → until the next month
//   2 losing trades in a row          → a 24-hour cooling-off
//   drawdown from the equity peak: 10 % → sizes × 0.5, 15 % → × 0.25, 20 % → no new risk
//
// Losses and drawdowns are net of the deposits and withdrawals booked between
// two points (each point carries what they added up to): taking money out is
// not a loss, putting money in does not hide one.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withFileLockSync } from "../core/lock.js";
import { netMode } from "../core/net.js";
import { homeDir } from "../core/paths.js";
import type { Limits } from "../core/profile.js";
import { readJsonl, sealJsonlTail, type Warn } from "../portfolio/jsonl.js";
import type { Transaction } from "../portfolio/ledger.js";

export interface EquityPoint {
  at: string;
  equity: number;
  /**
   * The deposits less the withdrawals the ledger held when the point was taken,
   * in the base currency: between two points, the part of the change that is
   * money moved in or out, not a gain or a loss.
   */
  contributed?: number;
}

/**
 * What the ledger's deposits and withdrawals add up to, in the base currency at
 * `rates` (units of base per unit of each currency, as the book is valued).
 * Undefined when a currency has no rate: a point is then recorded without it.
 */
export function netContributed(txs: readonly Transaction[], rates: Record<string, number>, base: string): number | undefined {
  let sum = 0;
  for (const t of txs) {
    if (t.type !== "deposit" && t.type !== "withdrawal") continue;
    const rate = t.currency === base ? 1 : rates[t.currency];
    if (rate === undefined) return undefined;
    sum += (t.amount ?? 0) * rate;
  }
  return sum;
}

export function equityPath(book: string): string {
  return join(homeDir(), "state", `equity-${book}.jsonl`);
}

/** The equity curve; a last point cut short by a crash is skipped with a warning, an unreadable line before it is an error. */
export function readEquity(book: string, warn?: Warn): EquityPoint[] {
  return readJsonl<EquityPoint>(equityPath(book), warn).sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Append a point, under the curve's lock: a point a crashed append cut short is
 * moved aside first. Only on the wall clock: a fixture replayed or recorded
 * into stamps `at` with its own recording time (`clockNow`), and a point dated
 * in the future would stay the curve's last for ever — the breaker measuring
 * every loss from it. Returns whether it was written.
 */
export function recordEquity(book: string, equity: number, at: Date, contributed?: number): boolean {
  if (netMode().kind !== "live") return false;
  const path = equityPath(book);
  mkdirSync(join(homeDir(), "state"), { recursive: true });
  const point: EquityPoint = { at: at.toISOString(), equity, ...(contributed !== undefined ? { contributed } : {}) };
  withFileLockSync(`${path}.lock`, () => {
    sealJsonlTail(path);
    appendFileSync(path, `${JSON.stringify(point)}\n`, { mode: 0o600 });
  });
  return true;
}

export interface BreakerState {
  tripped: boolean;
  reason?: string;
  sizeMultiplier: number;
  dailyPct?: number;
  weeklyPct?: number;
  monthlyPct?: number;
  drawdownPct?: number;
  losingStreak: number;
  until?: string;
}

const startOf = (d: Date, unit: "day" | "week" | "month") => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), unit === "month" ? 1 : d.getUTCDate()));
  if (unit === "week") x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
};
const next = (d: Date, unit: "day" | "week" | "month") => {
  const s = startOf(d, unit);
  if (unit === "day") s.setUTCDate(s.getUTCDate() + 1);
  else if (unit === "week") s.setUTCDate(s.getUTCDate() + 7);
  else s.setUTCMonth(s.getUTCMonth() + 1);
  return s;
};

/** The last equity reading at or before `t` — the reference a period's loss is measured from. */
function equityAt(curve: readonly EquityPoint[], t: Date): EquityPoint | undefined {
  let v: EquityPoint | undefined;
  for (const p of curve) {
    if (Date.parse(p.at) <= t.getTime()) v = p;
    else break;
  }
  return v ?? curve[0];
}

/**
 * A ledger date as an instant. A venue fill is written in UTC without its zone
 * ("2026-10-24T11:00:00"), which `Date.parse` alone would read as local time
 * and shift by the machine's offset.
 */
export function ledgerInstant(date: string): number {
  return Date.parse(/T\d{2}:\d{2}/.test(date) && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(date) ? `${date}Z` : date);
}

/**
 * Realised results of closed (sell) trades by average cost, in date order.
 *
 * Units moved between the user's own accounts keep their cost (a transfer out
 * hands it to the transfer in of the same symbol; a transfer in with a price
 * takes that price), and a split divides it. Units whose cost the ledger never
 * says (a transfer in from outside, with no price) are left out of the result:
 * selling them is neither a win nor a loss the breaker can count — counting
 * the whole proceeds as profit broke losing streaks and flattered the paper
 * record.
 */
export function closedTradeResults(txs: readonly Transaction[]): Array<{ date: string; pnl: number }> {
  type Held = { q: number; cost: number; unknown: number };
  const avg = new Map<string, Held>();
  // Units on their way between two of the user's accounts, per symbol: cost NaN when it is not known.
  const moving = new Map<string, Array<{ q: number; cost: number; account: string }>>();
  const out: Array<{ date: string; pnl: number }> = [];
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
  // Units a transfer out (by its index) already handed to a transfer in recorded before it on the same day.
  const handed = new Map<number, number>();
  const held = (account: string, symbol: string): Held => {
    const k = `${account}|${symbol}`;
    let p = avg.get(k);
    if (!p) avg.set(k, (p = { q: 0, cost: 0, unknown: 0 }));
    return p;
  };
  const add = (p: Held, units: number, cost: number) => {
    p.cost = p.q + units > 0 ? (p.cost * p.q + cost * units) / (p.q + units) : 0;
    p.q += units;
  };
  // Units leave in proportion: known-cost and unknown-cost alike.
  const take = (p: Held, units: number) => {
    const all = p.q + p.unknown;
    const known = all > 0 ? Math.min(units, all) * (p.q / all) : 0;
    const unknown = all > 0 ? Math.min(units, all) - known : 0;
    p.q = Math.max(0, p.q - known);
    p.unknown = Math.max(0, p.unknown - unknown);
    return { known };
  };
  /** Units leave `account` for another of the user's: on the moving list, with their cost. */
  const send = (account: string, symbol: string, units: number) => {
    const p = held(account, symbol);
    const cost = p.cost;
    const { known } = take(p, units);
    const list = moving.get(symbol) ?? [];
    list.push({ q: known, cost, account });
    if (units - known > 0) list.push({ q: units - known, cost: Number.NaN, account });
    moving.set(symbol, list);
  };
  /** Up to `units` arriving in `account` taken off the moving list, with the cost each part left with. */
  const receive = (account: string, symbol: string, units: number): Array<{ n: number; cost: number }> => {
    const got: Array<{ n: number; cost: number }> = [];
    let left = units;
    for (const m of moving.get(symbol) ?? []) {
      if (left <= 1e-12) break;
      if (m.account === account || m.q <= 0) continue;
      const n = Math.min(left, m.q);
      got.push({ n, cost: m.cost });
      m.q -= n;
      left -= n;
    }
    return got;
  };
  sorted.forEach((t, i) => {
    if (!t.symbol) return;
    const p = held(t.account, t.symbol);
    const q = t.quantity ?? 0;
    if (t.type === "buy") add(p, q, (q * t.price! + (t.fee ?? 0)) / q);
    else if (t.type === "sell") {
      const cost = p.cost;
      const { known } = take(p, q);
      // Only the units whose cost is known make a result; the fee is shared in proportion.
      if (known > 0) out.push({ date: t.date, pnl: (t.price! - cost) * known - (t.fee ?? 0) * (known / q) });
    } else if (t.type === "transfer-out") {
      const rest = q - (handed.get(i) ?? 0);
      if (rest > 1e-12) send(t.account, t.symbol, rest);
    } else if (t.type === "transfer-in") {
      const got = receive(t.account, t.symbol, q);
      // The other account's statement may come later the same day: its transfer out is matched now, at its cost now.
      const day = t.date.slice(0, 10);
      for (let j = i + 1; j < sorted.length && sorted[j]!.date.slice(0, 10) === day; j++) {
        const left = q - got.reduce((s, g) => s + g.n, 0);
        if (left <= 1e-12) break;
        const o = sorted[j]!;
        if (o.type !== "transfer-out" || o.symbol !== t.symbol || o.account === t.account) continue;
        const n = Math.min(left, (o.quantity ?? 0) - (handed.get(j) ?? 0));
        if (n <= 1e-12) continue;
        send(o.account, o.symbol, n);
        handed.set(j, (handed.get(j) ?? 0) + n);
        got.push(...receive(t.account, t.symbol, n));
      }
      // A stated price is the cost of all the units, matched or not; the units it matched have arrived, and
      // cannot be matched again by a later transfer in from outside.
      if (t.price !== undefined) add(p, q, t.price);
      else {
        for (const g of got)
          if (Number.isNaN(g.cost)) p.unknown += g.n;
          else add(p, g.n, g.cost);
        p.unknown += Math.max(0, q - got.reduce((s, g) => s + g.n, 0));
      }
    } else if (t.type === "split" && q > 0) {
      p.q *= q;
      p.unknown *= q;
      p.cost /= q;
    }
  });
  return out;
}

export function breakerState(curve: readonly EquityPoint[], trades: ReadonlyArray<{ date: string; pnl: number }>, limits: Limits, now: Date): BreakerState {
  let streak = 0;
  for (let i = trades.length - 1; i >= 0 && trades[i]!.pnl < 0; i--) streak++;
  const lastLoss = streak ? trades[trades.length - 1]!.date : undefined;
  const st: BreakerState = { tripped: false, sizeMultiplier: 1, losingStreak: streak };
  if (curve.length) {
    const last = curve[curve.length - 1]!;
    const nowEq = last.equity;
    // A point as it would read with the money the book holds now put in: what came in since is added, what went out
    // taken away. A point recorded before contributions were (legacy) reads as it was.
    const asNow = (p: EquityPoint) =>
      p.contributed !== undefined && last.contributed !== undefined ? p.equity + (last.contributed - p.contributed) : p.equity;
    const change = (unit: "day" | "week" | "month") => {
      const ref = equityAt(curve, new Date(startOf(now, unit).getTime() - 1));
      return ref?.equity ? (nowEq / asNow(ref) - 1) * 100 : undefined;
    };
    st.dailyPct = change("day");
    st.weeklyPct = change("week");
    st.monthlyPct = change("month");
    const peak = Math.max(...curve.map(asNow));
    st.drawdownPct = peak > 0 ? (nowEq / peak - 1) * 100 : 0;
    const trip = (reason: string, until: Date) => {
      if (!st.tripped) {
        st.tripped = true;
        st.reason = reason;
        st.until = until.toISOString();
      }
    };
    if (st.dailyPct !== undefined && st.dailyPct <= -limits.maxDailyLossPct)
      trip(`today's loss ${st.dailyPct.toFixed(2)} % reached the ${limits.maxDailyLossPct} % daily limit`, next(now, "day"));
    if (st.weeklyPct !== undefined && st.weeklyPct <= -limits.maxWeeklyLossPct)
      trip(`this week's loss ${st.weeklyPct.toFixed(2)} % reached the ${limits.maxWeeklyLossPct} % weekly limit`, next(now, "week"));
    if (st.monthlyPct !== undefined && st.monthlyPct <= -limits.maxMonthlyLossPct)
      trip(`this month's loss ${st.monthlyPct.toFixed(2)} % reached the ${limits.maxMonthlyLossPct} % monthly limit`, next(now, "month"));
    const dd = -st.drawdownPct;
    st.sizeMultiplier = dd >= 20 ? 0 : dd >= 15 ? 0.25 : dd >= 10 ? 0.5 : 1;
    if (dd >= 20) trip(`drawdown of ${dd.toFixed(1)} % from the equity peak: no new risk until the plan is reviewed`, new Date(now.getTime() + 7 * 86_400_000));
  }
  if (streak >= 2 && lastLoss && now.getTime() - ledgerInstant(lastLoss) < 24 * 3_600_000 && !st.tripped) {
    st.tripped = true;
    st.reason = `${streak} losing trades in a row: a 24-hour cooling-off before the next entry`;
    st.until = new Date(ledgerInstant(lastLoss) + 24 * 3_600_000).toISOString();
  }
  return st;
}
