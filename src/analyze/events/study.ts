// What an event of this kind did before: an event study on the country's
// benchmark index and its currency against the user's base currency.
//
// For each past event: the last close BEFORE the event (or before its first
// voting day), the first close AFTER it (the result: an election held on a
// Sunday is priced Monday; a rate decision on its own day), and five sessions
// later. The index move is translated into the base currency with the FX move
// over the same days, because that is what a holder in that base saw. Pure:
// the caller hands the daily closes in.

export interface Close {
  date: string;
  close: number;
}

export interface EventReaction {
  date: string;
  label: string;
  /** Index move to the first close after the event, %. */
  index1d?: number;
  index5d?: number;
  /** Currency move against the base (+ = the currency gained), %. */
  fx1d?: number;
  fx5d?: number;
  /** The index move as a holder in the base currency saw it, %. */
  base1d?: number;
  base5d?: number;
}

export interface ReactionStats {
  n: number;
  median?: number;
  mean?: number;
  worst?: number;
  best?: number;
  meanAbs?: number;
}

const pct = (a: number, b: number) => (b / a - 1) * 100;

/** Index of the last close strictly before `date`, and of the first close on or after `after`. */
function around(closes: readonly Close[], before: string, after: string): { pre?: number; post?: number } {
  let pre: number | undefined;
  let post: number | undefined;
  for (let i = 0; i < closes.length; i++) {
    const d = closes[i]!.date;
    if (d < before) pre = i;
    if (post === undefined && d >= after) post = i;
  }
  return { pre, post };
}

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * The reaction to one event. `sameDay` (a rate decision announced during the
 * session) prices the result at that day's close; otherwise (a vote) at the
 * first close after the last voting day. `fxPerBase` is the currency per one
 * unit of base (EURBRL: BRL per EUR) — it rising is the currency weakening.
 */
export function eventReaction(
  event: { date: string; endDate?: string; label: string },
  index: readonly Close[],
  fxPerBase: readonly Close[] | undefined,
  opts: { sameDay?: boolean } = {},
): EventReaction {
  const resultDay = opts.sameDay ? event.date : nextDay(event.endDate ?? event.date);
  const out: EventReaction = { date: event.date, label: event.label };
  const ix = around(index, event.date, resultDay);
  if (ix.pre !== undefined && ix.post !== undefined) {
    const p0 = index[ix.pre]!.close;
    out.index1d = pct(p0, index[ix.post]!.close);
    const i5 = ix.post + 4;
    if (i5 < index.length) out.index5d = pct(p0, index[i5]!.close);
  }
  if (fxPerBase?.length) {
    const fx = around(fxPerBase, event.date, resultDay);
    if (fx.pre !== undefined && fx.post !== undefined) {
      const f0 = fxPerBase[fx.pre]!.close;
      // currency per base up 2 % → the currency lost ~2 % against the base
      out.fx1d = (f0 / fxPerBase[fx.post]!.close - 1) * 100;
      const f5 = fx.post + 4;
      if (f5 < fxPerBase.length) out.fx5d = (f0 / fxPerBase[f5]!.close - 1) * 100;
    }
  } else if (fxPerBase === undefined) {
    // Same currency as the base: no FX leg.
    out.fx1d = 0;
    out.fx5d = 0;
  }
  const inBase = (i?: number, f?: number) => (i === undefined || f === undefined ? undefined : ((1 + i / 100) * (1 + f / 100) - 1) * 100);
  out.base1d = inBase(out.index1d, out.fx1d);
  out.base5d = inBase(out.index5d, out.fx5d);
  return out;
}

export function reactionStats(values: ReadonlyArray<number | undefined>): ReactionStats {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0 };
  const m = Math.floor(xs.length / 2);
  return {
    n: xs.length,
    median: xs.length % 2 ? xs[m] : (xs[m - 1]! + xs[m]!) / 2,
    mean: xs.reduce((s, x) => s + x, 0) / xs.length,
    worst: xs[0],
    best: xs[xs.length - 1],
    meanAbs: xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length,
  };
}
