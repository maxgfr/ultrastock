// Settling decisions: did the call work? Once 5, 20 and 60 sessions have
// passed after a decision, its symbol's return and its alpha against a
// benchmark are measured and appended to journal/settlements.jsonl — never
// edited, never re-scored. A buy or overweight is right when the alpha is
// positive, a sell or underweight when it is negative; a hold is judged
// neutral (|alpha| under 2 % a month) — the hit rates by rating come from here.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Decision, journalDir } from "../analyze/decision.js";
import { defaultBenchmark } from "../analyze/technicals.js";
import { addSessions, calendarFor } from "../core/calendar.js";
import { clockNow } from "../core/net.js";
import { getHistory, resolveSymbol } from "../providers/router.js";
import type { Bar } from "../providers/types.js";

export const HORIZONS = [5, 20, 60] as const;

export interface Settlement {
  decisionId: string;
  symbol: string;
  rating: Decision["rating"];
  horizon: number;
  decidedAt: string;
  /** Close on the decision day (the last close at or before it). */
  startClose: number;
  endDate: string;
  endClose: number;
  returnPct: number;
  benchmark?: string;
  benchmarkReturnPct?: number;
  alphaPct?: number;
  hit?: boolean;
  settledAt: string;
}

export function readDecisions(): Array<Decision & { id: string }> {
  const f = join(journalDir(), "decisions.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((d) => d.id);
}

export function readSettlements(): Settlement[] {
  const f = join(journalDir(), "settlements.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Settlement);
}

const closeAtOrBefore = (bars: readonly Bar[], date: string) => {
  let v: Bar | undefined;
  for (const b of bars) {
    if (b.date.slice(0, 10) <= date) v = b;
    else break;
  }
  return v;
};

/** Is the call right at this horizon? Monthly-scaled 2 % band for holds. */
export function judge(rating: Decision["rating"], alphaPct: number, horizon: number): boolean {
  if (rating === "buy" || rating === "overweight") return alphaPct > 0;
  if (rating === "sell" || rating === "underweight") return alphaPct < 0;
  return Math.abs(alphaPct) < 2 * Math.max(1, horizon / 21);
}

/** Settle every decision horizon that has matured and is not settled yet. */
export async function settleDecisions(now = clockNow()): Promise<{ settled: Settlement[]; pending: number; errors: string[] }> {
  const done = new Set(readSettlements().map((s) => `${s.decisionId}|${s.horizon}`));
  const settled: Settlement[] = [];
  const errors: string[] = [];
  let pending = 0;
  const today = now.toISOString().slice(0, 10);
  for (const d of readDecisions()) {
    const due = HORIZONS.filter((h) => !done.has(`${d.id}|${h}`));
    if (!due.length) continue;
    try {
      const r = await resolveSymbol(d.symbol);
      // No calendar for the venue (Xetra, Tokyo…): horizons are counted in weekdays, holidays unknown.
      const market = calendarFor(r.instrument);
      const start = d.decidedAt.slice(0, 10);
      const matured = due.filter(
        (h) => (market === "CRYPTO" ? new Date(Date.parse(start) + h * 86_400_000).toISOString().slice(0, 10) : addSessions(market, start, h)) <= today,
      );
      pending += due.length - matured.length;
      if (!matured.length) continue;
      const from = new Date(Date.parse(start) - 10 * 86_400_000);
      const series = await getHistory(r, { from, to: now });
      const benchSym = defaultBenchmark(r.instrument.market, r.instrument.mic);
      const bench = benchSym ? await getHistory(await resolveSymbol(benchSym), { from, to: now }).catch(() => undefined) : undefined;
      for (const h of matured) {
        const endDate = market === "CRYPTO" ? new Date(Date.parse(start) + h * 86_400_000).toISOString().slice(0, 10) : addSessions(market, start, h);
        const s0 = closeAtOrBefore(series.bars, start);
        const s1 = closeAtOrBefore(series.bars, endDate);
        if (!s0 || !s1) {
          errors.push(`${d.symbol} ${h}: no close around ${start} or ${endDate}`);
          continue;
        }
        const ret = (s1.close / s0.close - 1) * 100;
        const b0 = bench && closeAtOrBefore(bench.bars, start);
        const b1 = bench && closeAtOrBefore(bench.bars, endDate);
        const bRet = b0 && b1 ? (b1.close / b0.close - 1) * 100 : undefined;
        const alpha = bRet === undefined ? undefined : ret - bRet;
        const st: Settlement = {
          decisionId: d.id,
          symbol: d.symbol,
          rating: d.rating,
          horizon: h,
          decidedAt: d.decidedAt,
          startClose: s0.close,
          endDate: s1.date.slice(0, 10),
          endClose: s1.close,
          returnPct: Number(ret.toFixed(4)),
          benchmark: benchSym,
          benchmarkReturnPct: bRet === undefined ? undefined : Number(bRet.toFixed(4)),
          alphaPct: alpha === undefined ? undefined : Number(alpha.toFixed(4)),
          hit: judge(d.rating, alpha ?? ret, h),
          settledAt: now.toISOString(),
        };
        settled.push(st);
      }
    } catch (e) {
      errors.push(`${d.symbol}: ${(e as Error).message}`);
    }
  }
  if (settled.length) {
    mkdirSync(journalDir(), { recursive: true });
    appendFileSync(join(journalDir(), "settlements.jsonl"), settled.map((s) => `${JSON.stringify(s)}\n`).join(""), { mode: 0o600 });
    appendFileSync(
      join(journalDir(), "decisions.md"),
      settled
        .map(
          (s) =>
            `SETTLED [${s.decisionId} | ${s.symbol} | ${s.rating} | +${s.horizon} sessions → ${s.endDate}]: return ${s.returnPct} %${s.alphaPct !== undefined ? `, alpha ${s.alphaPct} % vs ${s.benchmark}` : ""} — ${s.hit ? "right" : "wrong"}\n`,
        )
        .join(""),
    );
  }
  return { settled, pending, errors };
}

/** Hit rate and mean alpha by rating and horizon — how good the calls have been. */
export function hitRates(settlements: readonly Settlement[]): Array<{ rating: string; horizon: number; n: number; hitRate: number; meanAlphaPct?: number }> {
  const groups = new Map<string, Settlement[]>();
  for (const s of settlements) groups.set(`${s.rating}|${s.horizon}`, [...(groups.get(`${s.rating}|${s.horizon}`) ?? []), s]);
  return [...groups.entries()]
    .map(([k, xs]) => {
      const [rating, h] = k.split("|") as [string, string];
      const alphas = xs.map((x) => x.alphaPct).filter((x): x is number => x !== undefined);
      return {
        rating,
        horizon: Number(h),
        n: xs.length,
        hitRate: xs.filter((x) => x.hit).length / xs.length,
        meanAlphaPct: alphas.length ? alphas.reduce((a, b) => a + b, 0) / alphas.length : undefined,
      };
    })
    .sort((a, b) => a.rating.localeCompare(b.rating) || a.horizon - b.horizon);
}
