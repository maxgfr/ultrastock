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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../core/paths.js";
import type { Limits } from "../core/profile.js";
import type { Transaction } from "../portfolio/ledger.js";

export interface EquityPoint {
  at: string;
  equity: number;
}

export function equityPath(book: string): string {
  return join(homeDir(), "state", `equity-${book}.jsonl`);
}

export function readEquity(book: string): EquityPoint[] {
  const p = equityPath(book);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EquityPoint)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function recordEquity(book: string, equity: number, at: Date): void {
  mkdirSync(join(homeDir(), "state"), { recursive: true });
  appendFileSync(equityPath(book), `${JSON.stringify({ at: at.toISOString(), equity })}\n`, { mode: 0o600 });
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
function equityAt(curve: readonly EquityPoint[], t: Date): number | undefined {
  let v: number | undefined;
  for (const p of curve) {
    if (Date.parse(p.at) <= t.getTime()) v = p.equity;
    else break;
  }
  return v ?? curve[0]?.equity;
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
  const avg = new Map<string, { q: number; cost: number; unknown: number }>();
  const moving = new Map<string, Array<{ q: number; cost: number; account: string }>>();
  const out: Array<{ date: string; pnl: number }> = [];
  for (const t of [...txs].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!t.symbol) continue;
    const k = `${t.account}|${t.symbol}`;
    const p = avg.get(k) ?? { q: 0, cost: 0, unknown: 0 };
    const q = t.quantity ?? 0;
    const add = (units: number, cost: number) => {
      p.cost = p.q + units > 0 ? (p.cost * p.q + cost * units) / (p.q + units) : 0;
      p.q += units;
    };
    // Units leave in proportion: known-cost and unknown-cost alike.
    const take = (units: number) => {
      const held = p.q + p.unknown;
      const known = held > 0 ? Math.min(units, held) * (p.q / held) : 0;
      const unknown = held > 0 ? Math.min(units, held) - known : 0;
      p.q = Math.max(0, p.q - known);
      p.unknown = Math.max(0, p.unknown - unknown);
      return { known, short: Math.max(0, units - held) };
    };
    if (t.type === "buy") add(q, (q * t.price! + (t.fee ?? 0)) / q);
    else if (t.type === "sell") {
      const cost = p.cost;
      const { known } = take(q);
      // Only the units whose cost is known make a result; the fee is shared in proportion.
      if (known > 0) out.push({ date: t.date, pnl: (t.price! - cost) * known - (t.fee ?? 0) * (known / q) });
    } else if (t.type === "transfer-out") {
      const cost = p.cost;
      const { known } = take(q);
      const list = moving.get(t.symbol) ?? [];
      list.push({ q: known, cost, account: t.account });
      if (q - known > 0) list.push({ q: q - known, cost: Number.NaN, account: t.account });
      moving.set(t.symbol, list);
    } else if (t.type === "transfer-in") {
      if (t.price !== undefined) add(q, t.price);
      else {
        let left = q;
        const list = moving.get(t.symbol) ?? [];
        for (const m of list) {
          if (left <= 0) break;
          if (m.account === t.account || m.q <= 0) continue;
          const n = Math.min(left, m.q);
          if (Number.isNaN(m.cost)) p.unknown += n;
          else add(n, m.cost);
          m.q -= n;
          left -= n;
        }
        p.unknown += left;
      }
    } else if (t.type === "split" && q > 0) {
      p.q *= q;
      p.unknown *= q;
      p.cost /= q;
    }
    avg.set(k, p);
  }
  return out;
}

export function breakerState(curve: readonly EquityPoint[], trades: ReadonlyArray<{ date: string; pnl: number }>, limits: Limits, now: Date): BreakerState {
  let streak = 0;
  for (let i = trades.length - 1; i >= 0 && trades[i]!.pnl < 0; i--) streak++;
  const lastLoss = streak ? trades[trades.length - 1]!.date : undefined;
  const st: BreakerState = { tripped: false, sizeMultiplier: 1, losingStreak: streak };
  if (curve.length) {
    const nowEq = curve[curve.length - 1]!.equity;
    const change = (unit: "day" | "week" | "month") => {
      const ref = equityAt(curve, new Date(startOf(now, unit).getTime() - 1));
      return ref ? (nowEq / ref - 1) * 100 : undefined;
    };
    st.dailyPct = change("day");
    st.weeklyPct = change("week");
    st.monthlyPct = change("month");
    const peak = Math.max(...curve.map((p) => p.equity));
    st.drawdownPct = (nowEq / peak - 1) * 100;
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
