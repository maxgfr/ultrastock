// What the stock did after its past results — "has this happened before, and
// what came next" for the one event every company repeats.
//
// The results dates are the company's own: the 8-Ks it filed with item 2.02
// ("Results of Operations and Financial Condition", SEC submissions — official).
// A results release lands before the open or after the close, and the filing
// date alone does not say which, so each reaction runs from the last close
// BEFORE the filing day to the first close AFTER it (a [−1, +1] window that
// holds either case), then 5 sessions on, and the drift over the next 20
// sessions from that close. Each is also set against SPY over the same days.
// US registrants only: no keyless source dates the results of other issuers
// years back.
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow } from "../../core/net.js";
import { type SecFiling, secCompany, secSubmissions } from "../../providers/fundamentals/sec.js";
import { getHistory, resolveSymbol } from "../../providers/router.js";
import { type Close, eventReaction, reactionStats } from "./study.js";

/** Results dates read at most (three years of quarters). */
export const MAX_RESULTS = 12;
/** Sessions of drift after the reaction. */
export const DRIFT_SESSIONS = 20;
export const BENCHMARK = "SPY";

export interface ResultsDate {
  /** The 8-K's filing date. */
  date: string;
  accession: string;
  url: string;
}

/** The results dates: 8-Ks with item 2.02, newest first, an amendment or a second filing within 5 days folded into the first. */
export function resultsDates(filings: readonly SecFiling[], max = MAX_RESULTS): ResultsDate[] {
  const hits = filings
    .filter((f) => /^8-K/.test(f.form) && f.items.includes("2.02") && /^\d{4}-\d{2}-\d{2}$/.test(f.filingDate))
    .sort((a, b) => a.filingDate.localeCompare(b.filingDate));
  const kept: ResultsDate[] = [];
  for (const f of hits) {
    const last = kept[kept.length - 1];
    if (last && (Date.parse(f.filingDate) - Date.parse(last.date)) / 86_400_000 <= 5) continue;
    kept.push({ date: f.filingDate, accession: f.accession, url: f.url });
  }
  return kept.reverse().slice(0, max);
}

export interface ResultsReaction {
  date: string;
  /** Close before the filing day → first close after it, %. */
  move?: number;
  bench?: number;
  excess?: number;
  /** Close before → five sessions after the first close, %. */
  move5?: number;
  excess5?: number;
  /** First close after → DRIFT_SESSIONS later, in excess of the benchmark, %. */
  drift?: number;
}

const pct = (a: number, b: number) => (b / a - 1) * 100;

/** The drift from the first close after `date` to `sessions` closes later, %. */
function drift(closes: readonly Close[], date: string, sessions: number): number | undefined {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const i = closes.findIndex((c) => c.date >= next);
  if (i < 0 || i + sessions >= closes.length) return undefined;
  return pct(closes[i]!.close, closes[i + sessions]!.close);
}

/** Pure: each results date's reaction in the stock and the benchmark (closes oldest first). */
export function resultsReactions(dates: readonly ResultsDate[], stock: readonly Close[], bench: readonly Close[]): ResultsReaction[] {
  return dates.map((d) => {
    const ev = { date: d.date, label: "results" };
    const s = eventReaction(ev, stock, undefined);
    const b = eventReaction(ev, bench, undefined);
    const out: ResultsReaction = { date: d.date };
    // A results day with no close before it (the series starts later) has no reaction.
    if (s.index1d !== undefined) {
      out.move = s.index1d;
      if (b.index1d !== undefined) {
        out.bench = b.index1d;
        out.excess = s.index1d - b.index1d;
      }
    }
    if (s.index5d !== undefined) {
      out.move5 = s.index5d;
      if (b.index5d !== undefined) out.excess5 = s.index5d - b.index5d;
    }
    if (out.move === undefined) return out; // the series starts after the date: nothing to follow from
    const sd = drift(stock, d.date, DRIFT_SESSIONS);
    const bd = drift(bench, d.date, DRIFT_SESSIONS);
    if (sd !== undefined && bd !== undefined) out.drift = sd - bd;
    return out;
  });
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** The reactions and their summary as points. */
export function reactionPoints(sym: string, dates: readonly ResultsDate[], rs: readonly ResultsReaction[]): Point[] {
  const k = `${sym}.results`;
  const points: Point[] = [];
  rs.forEach((r, i) => {
    const d = dates[i]!;
    const on = `results 8-K filed ${r.date}`;
    if (r.move !== undefined)
      points.push({
        key: `${k}.${r.date}.move`,
        label: `${sym} move around the ${on} (close before → first close after)`,
        value: r2(r.move),
        unit: "%",
        asOf: r.date,
        url: d.url,
      });
    if (r.excess !== undefined)
      points.push({ key: `${k}.${r.date}.excess`, label: `${sym} move around the ${on}, minus ${BENCHMARK}'s`, value: r2(r.excess), unit: "%", asOf: r.date });
    if (r.move5 !== undefined)
      points.push({
        key: `${k}.${r.date}.move5`,
        label: `${sym} move from the close before the ${on} to 5 sessions after`,
        value: r2(r.move5),
        unit: "%",
        asOf: r.date,
      });
    if (r.drift !== undefined)
      points.push({
        key: `${k}.${r.date}.drift`,
        label: `${sym} drift over the ${DRIFT_SESSIONS} sessions after the ${on}, minus ${BENCHMARK}'s`,
        value: r2(r.drift),
        unit: "%",
        asOf: r.date,
      });
  });
  const moves = rs.map((r) => r.move);
  const st = reactionStats(moves);
  const n = st.n;
  if (!n) return points;
  const over = `over the last ${n} results`;
  points.push({ key: `${k}.n`, label: `${sym} past results with a measured reaction`, value: n, unit: "count" });
  const add = (key: string, label: string, v: number | undefined, formula: string) => {
    if (v !== undefined) points.push({ key: `${k}.${key}`, label: `${sym} ${label} ${over}`, value: r2(v), unit: "%", formula });
  };
  add(
    "absMedian",
    "median absolute move around results",
    reactionStats(moves.map((m) => (m === undefined ? undefined : Math.abs(m)))).median,
    "median of |move|",
  );
  add("median", "median move around results", st.median, "median of the moves");
  add("worst", "worst move around results", st.worst, "minimum of the moves");
  add("best", "best move around results", st.best, "maximum of the moves");
  add("excessMedian", `median move around results minus ${BENCHMARK}'s`, reactionStats(rs.map((r) => r.excess)).median, `median of (move − ${BENCHMARK} move)`);
  const dr = reactionStats(rs.map((r) => r.drift));
  if (dr.n) {
    add("driftMedian", `median ${DRIFT_SESSIONS}-session drift after results, minus ${BENCHMARK}'s`, dr.median, "median of the excess drifts");
    points.push({
      key: `${k}.driftUp`,
      label: `${sym} results followed by a ${DRIFT_SESSIONS}-session drift above ${BENCHMARK}'s ${over}`,
      value: rs.filter((r) => r.drift !== undefined && r.drift > 0).length,
      unit: "count",
      formula: `count of drift > 0 among ${dr.n}`,
    });
  }
  return points;
}

/** The dataset for a US registrant: its results dates from EDGAR, its closes and SPY's. */
export async function resultsReactionsDataset(sym: string, now: Date = clockNow()): Promise<Dataset> {
  const co = await secCompany(sym.split("|")[0]!);
  const sub = await secSubmissions(co.cik);
  const dates = resultsDates(sub.filings);
  if (!dates.length) throw new Error(`no 8-K with item 2.02 (results) among ${sub.name || sym}'s recent filings`);
  const oldest = dates[dates.length - 1]!.date;
  const from = new Date(Date.parse(`${oldest}T00:00:00Z`) - 15 * 86_400_000);
  const closes = async (s: string) => {
    const h = await getHistory(await resolveSymbol(s), { from, to: now });
    return { closes: h.bars.map((b) => ({ date: b.date.slice(0, 10), close: b.close })), source: h.provenance.source };
  };
  const stock = await closes(sym);
  const bench = await closes(BENCHMARK);
  const rs = resultsReactions(dates, stock.closes, bench.closes);
  const points = reactionPoints(sym, dates, rs);
  const unmeasured = rs.filter((r) => r.move === undefined).length;
  return {
    kind: "events",
    title: `${sym} — what past results did to the stock (SEC 8-K item 2.02, ${stock.source} closes)`,
    subject: sym,
    points,
    provenance: { source: `sec-edgar+${stock.source}`, url: sub.url, fetchedAt: sub.fetchedAt, official: true, delay: "eod", asOf: dates[0]!.date },
    notes: [
      "each reaction runs from the close before the 8-K's filing day to the first close after it: a release before the open or after the close both fall inside",
      `${BENCHMARK} over the same days is the market's share of the move; the drift runs ${DRIFT_SESSIONS} sessions from the first close after`,
      "past reactions are a base rate, not a forecast: the options' implied move is the market's price of the next one",
      ...(unmeasured ? [`${unmeasured} results date(s) before the price series starts are left out`] : []),
    ],
  };
}
