// Settling decisions: did the call work? Once 5, 20 and 60 sessions have
// passed after a decision, and the price histories reach that far, its
// symbol's return and its alpha against a benchmark are measured and appended
// to journal/settlements.jsonl — never edited, never re-scored. A buy or
// overweight is right when the alpha is positive, a sell or underweight when it
// is negative; a hold is judged neutral (|alpha| under 2 % a month) — the hit
// rates by rating come from here.
//
// A history that stops short of a horizon's end (a name delisted or renamed, a
// benchmark that cannot be read) is waited for SETTLE_GRACE_SESSIONS sessions
// past that end; then the horizon settles on the last close there is, marked
// `partial` — the symbol's last close when its own history stops, the raw
// return when the benchmark's does. A symbol with no close after the decision
// day (or none at all) has nothing to measure: UNRESOLVED_AFTER_DAYS calendar
// days past the horizon's end, the horizon is recorded `unresolved` with the
// reason, once, and stays out of the hit rates and every reader of settled calls.
import { appendFileSync, mkdirSync } from "node:fs";
import { withFileLockSync } from "../core/lock.js";
import { readJsonl, sealJsonlTail, type Warn } from "../portfolio/jsonl.js";
import { join } from "node:path";
import { type Decision, journalDir } from "../analyze/decision.js";
import { defaultBenchmark } from "../analyze/technicals.js";
import { addSessions, type CalendarMarket, calendarFor } from "../core/calendar.js";
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
  /**
   * Settled on what history there was, the grace past the horizon's end over:
   * `endDate` is the close used (before the horizon's end when the symbol's
   * history stops short), and there is no benchmark return when the
   * benchmark's history does not reach that close.
   */
  partial?: true;
  settledAt: string;
}

/** Sessions a short history is waited for past a horizon's end, before the horizon settles on its last close. */
export const SETTLE_GRACE_SESSIONS = 10;

/** Calendar days past a horizon's end after which a horizon with nothing to measure is recorded unresolved. */
export const UNRESOLVED_AFTER_DAYS = 30;

/**
 * A horizon that could not be measured: the symbol has no close after the
 * decision day, or none on or before it, UNRESOLVED_AFTER_DAYS days past the
 * horizon's end. Written to settlements.jsonl so it is not tried again; never
 * scored, so no hit rate counts it.
 */
export interface Unresolved {
  decisionId: string;
  symbol: string;
  rating: Decision["rating"];
  horizon: number;
  decidedAt: string;
  /** The horizon's end. */
  endDate: string;
  unresolved: true;
  reason: string;
  settledAt: string;
}

const isUnresolved = (s: Settlement | Unresolved): s is Unresolved => (s as Unresolved).unresolved === true;
const settlementKey = (s: { decisionId: string; horizon: number }) => `${s.decisionId}|${s.horizon}`;

/** The journal's decisions; a last line cut short by a crash is skipped with a warning (see portfolio/jsonl.ts). */
export function readDecisions(warn?: Warn): Array<Decision & { id: string }> {
  return readJsonl<Decision & { id: string }>(join(journalDir(), "decisions.jsonl"), warn).filter((d) => d.id);
}

const readSettlementLines = (warn?: Warn) => readJsonl<Settlement | Unresolved>(join(journalDir(), "settlements.jsonl"), warn);

/** The measured settlements: the unresolved horizons are left out. */
export function readSettlements(warn?: Warn): Settlement[] {
  return readSettlementLines(warn).filter((s): s is Settlement => !isUnresolved(s));
}

/** The horizons recorded unresolved, with their reasons. */
export function readUnresolved(warn?: Warn): Unresolved[] {
  return readSettlementLines(warn).filter(isUnresolved);
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

/** The day a horizon ends: `h` sessions after the decision day — calendar days for crypto, which never closes. */
export function horizonEnd(market: CalendarMarket | undefined, start: string, h: number): string {
  return market === "CRYPTO" ? new Date(Date.parse(start) + h * 86_400_000).toISOString().slice(0, 10) : addSessions(market, start, h);
}

/**
 * The horizons whose last close exists: those ending before `today` (UTC). On
 * the end date itself the session is still open, or its daily bar still
 * forming — settling then would score the call on the close of the day before,
 * and a settlement is never re-scored.
 */
export function maturedHorizons(market: CalendarMarket | undefined, start: string, due: readonly number[], today: string): number[] {
  return due.filter((h) => horizonEnd(market, start, h) < today);
}

/** A matured horizon left pending because a price history stops before its end (within the grace, or with no bar after the decision). */
export interface Waiting {
  decisionId: string;
  symbol: string;
  horizon: number;
  endDate: string;
  /** The history that falls short: the symbol's or its benchmark's. */
  series: string;
  /** Its last bar's day; none when it has no history at all. */
  lastBar?: string;
  /**
   * What happens once the wait is over: `partial` settles on the last close
   * there is (SETTLE_GRACE_SESSIONS past the end); `unresolved` records the
   * horizon unmeasured (UNRESOLVED_AFTER_DAYS past the end), the symbol having
   * no close after the decision day.
   */
  then: "partial" | "unresolved";
}

/** Settle every decision horizon that has matured and is not settled yet. */
export async function settleDecisions(
  now = clockNow(),
): Promise<{ settled: Settlement[]; unresolved: Unresolved[]; pending: number; waiting: Waiting[]; errors: string[] }> {
  const done = new Set(readSettlementLines().map(settlementKey));
  let settled: Settlement[] = [];
  let unresolved: Unresolved[] = [];
  const waiting: Waiting[] = [];
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
      const matured = maturedHorizons(market, start, due, today);
      pending += due.length - matured.length;
      if (!matured.length) continue;
      const from = new Date(Date.parse(start) - 10 * 86_400_000);
      const series = await getHistory(r, { from, to: now });
      const benchSym = defaultBenchmark(r.instrument.market, r.instrument.mic);
      const bench = benchSym ? await getHistory(await resolveSymbol(benchSym), { from, to: now }).catch(() => undefined) : undefined;
      for (const h of matured) {
        const endDate = horizonEnd(market, start, h);
        const unresolvable = new Date(Date.parse(endDate) + UNRESOLVED_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10) < today;
        const giveUp = (reason: string) =>
          unresolved.push({
            decisionId: d.id,
            symbol: d.symbol,
            rating: d.rating,
            horizon: h,
            decidedAt: d.decidedAt,
            endDate,
            unresolved: true,
            reason,
            settledAt: now.toISOString(),
          });
        // A history that stops before the end session — stale, lagging, or a name no longer quoted — would score the call
        // on an earlier close, and a settlement is never re-scored: the horizon waits for a bar on or after its end.
        const histories: Array<[string, readonly Bar[]]> = [[d.symbol, series.bars]];
        if (benchSym) histories.push([benchSym, bench?.bars ?? []]);
        const lastDay = (bars: readonly Bar[]) => bars.at(-1)?.date.slice(0, 10) ?? "";
        const short = histories.find(([, bars]) => lastDay(bars) < endDate);
        let used = endDate;
        let partial = false;
        if (short) {
          // Past the grace, the last close settles it — unless the symbol has none after the decision: a 0 % return
          // would be no measure at all, and a hold scored right on it for good.
          // Nothing after the decision day is no measure: UNRESOLVED_AFTER_DAYS past the end, it is recorded unresolved.
          const symbolLast = lastDay(series.bars);
          if (symbolLast <= start && unresolvable) {
            giveUp(
              symbolLast
                ? `${d.symbol}'s history stops at ${symbolLast}, ${symbolLast === start ? "the decision day" : "before the decision day"}: no close after it to measure`
                : `${d.symbol} has no price history`,
            );
            continue;
          }
          if (!(horizonEnd(market, endDate, SETTLE_GRACE_SESSIONS) < today) || symbolLast <= start) {
            waiting.push({
              decisionId: d.id,
              symbol: d.symbol,
              horizon: h,
              endDate,
              series: short[0],
              lastBar: short[1].at(-1)?.date.slice(0, 10),
              then: symbolLast <= start ? "unresolved" : "partial",
            });
            continue;
          }
          partial = true;
          if (symbolLast < endDate) used = symbolLast;
        }
        // The benchmark over the very same span, or none.
        const benchUsable = bench !== undefined && lastDay(bench.bars) >= used;
        const s0 = closeAtOrBefore(series.bars, start);
        const s1 = closeAtOrBefore(series.bars, used);
        if (!s0 || !s1) {
          // A history that starts after the decision (a name quoted again under a new listing) has no starting close.
          if (unresolvable) giveUp(`${d.symbol} has no close on or before the decision day ${start}`);
          else errors.push(`${d.symbol} ${h}: no close around ${start} or ${endDate}`);
          continue;
        }
        const ret = (s1.close / s0.close - 1) * 100;
        const b0 = benchUsable ? closeAtOrBefore(bench.bars, start) : undefined;
        const b1 = benchUsable ? closeAtOrBefore(bench.bars, used) : undefined;
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
          ...(partial ? { partial: true as const } : {}),
          settledAt: now.toISOString(),
        };
        settled.push(st);
      }
    } catch (e) {
      errors.push(`${d.symbol}: ${(e as Error).message}`);
    }
  }
  if (settled.length || unresolved.length) {
    mkdirSync(journalDir(), { recursive: true });
    const file = join(journalDir(), "settlements.jsonl");
    // Under the file's lock, a line a crashed append cut short is set aside first, so it never sits mid-file. The
    // settlements are read again there: another settle that ran meanwhile (a scheduled one and one typed by hand) may
    // have settled the same horizons, and a settlement is written once, never twice.
    [settled, unresolved] = withFileLockSync(`${file}.lock`, () => {
      sealJsonlTail(file);
      const already = new Set(readSettlementLines().map(settlementKey));
      const fresh = settled.filter((s) => !already.has(settlementKey(s)));
      const freshUnresolved = unresolved.filter((s) => !already.has(settlementKey(s)));
      const lines = [...fresh, ...freshUnresolved];
      if (!lines.length) return [fresh, freshUnresolved] as const;
      appendFileSync(file, lines.map((s) => `${JSON.stringify(s)}\n`).join(""), { mode: 0o600 });
      appendFileSync(
        join(journalDir(), "decisions.md"),
        [
          ...fresh.map(
            (s) =>
              `SETTLED [${s.decisionId} | ${s.symbol} | ${s.rating} | +${s.horizon} sessions → ${s.endDate}]: return ${s.returnPct} %${s.alphaPct !== undefined ? `, alpha ${s.alphaPct} % vs ${s.benchmark}` : ""} — ${s.hit ? "right" : "wrong"}${s.partial ? " (partial: the history stops short)" : ""}\n`,
          ),
          ...freshUnresolved.map(
            (s) => `UNRESOLVED [${s.decisionId} | ${s.symbol} | ${s.rating} | +${s.horizon} sessions → ${s.endDate}]: ${s.reason} — not scored\n`,
          ),
        ].join(""),
      );
      return [fresh, freshUnresolved] as const;
    });
  }
  return { settled, unresolved, pending, waiting, errors };
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
