// `value`: the composite score. Every component is ranked against the other
// candidates of the SAME sector in the filtered universe — recomputed here,
// because crible's own ranks are region × sector over its whole dataset (shown
// for display only) and a bank's P/B means nothing next to a software house's.
// A sector with too few candidates ranks against the whole universe instead.
// The score is the weighted mean of the component percentiles; a missing
// component counts as the peer median (50), so a row cannot top the list on
// the one or two figures it happens to have. Every component is exposed.
import type { CribleRow } from "./gates.js";
import { componentValue, type ValueComponent, type ValueStyle } from "./styles.js";

/** Below this many candidates a sector's percentiles are noise: its rows rank against the whole universe. */
export const MIN_SECTOR_PEERS = 5;
/** A row needs components carrying at least this share of the weight to be scored. */
export const MIN_WEIGHT_SHARE = 0.5;
/** The percentile a missing component counts as: the peer median, neither reward nor penalty. */
export const MISSING_PERCENTILE = 50;

export const sectorOf = (row: CribleRow): string => (typeof row.sector === "string" && row.sector.trim() ? row.sector : "Unclassified");

/**
 * Mid-rank percentiles (0–100) of `values`, where 100 is best: (below + ½ ties) / n.
 * Undefined values get no percentile and do not count in n.
 */
export function midrankPercentiles(values: ReadonlyArray<number | undefined>, better: "high" | "low"): Array<number | undefined> {
  const present = values.filter((v): v is number => v !== undefined);
  const n = present.length;
  return values.map((v) => {
    if (v === undefined || n === 0) return undefined;
    if (n === 1) return 50;
    let worse = 0;
    let ties = 0;
    for (const o of present) {
      if (o === v) ties++;
      else if (better === "high" ? o < v : o > v) worse++;
    }
    // ties includes the value itself: count the others as half.
    return ((worse + (ties - 1) / 2) / (n - 1)) * 100;
  });
}

export interface ComponentScore extends ValueComponent {
  value?: number;
  percentile?: number;
  /** The peer group the percentile is against: the sector, or "universe" when the sector is too small. */
  peers: string;
  /** How many candidates had this component in that peer group. */
  peerCount: number;
}

export interface ScoredRow {
  row: CribleRow;
  symbol: string;
  sector: string;
  score?: number;
  components: ComponentScore[];
  /** Share of the style's weight the row's components carry. */
  coverage: number;
}

/** Score every row of the universe on the style's components, sector by sector. */
export function scoreValueUniverse(rows: readonly CribleRow[], style: ValueStyle): ScoredRow[] {
  const bySector = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const s = sectorOf(r);
    bySector.set(s, [...(bySector.get(s) ?? []), i]);
  });
  const all = rows.map((_, i) => i);
  // percentile[componentIndex][rowIndex]
  const pcts = style.components.map((c) => {
    const values = rows.map((r) => componentValue(r, c.field));
    const out: Array<{ p?: number; peers: string; count: number }> = rows.map(() => ({ peers: "", count: 0 }));
    const universeP = midrankPercentiles(values, c.better);
    const universeCount = values.filter((v) => v !== undefined).length;
    for (const [sector, idx] of bySector) {
      const sv = idx.map((i) => values[i]);
      const count = sv.filter((v) => v !== undefined).length;
      if (count >= MIN_SECTOR_PEERS) {
        const p = midrankPercentiles(sv, c.better);
        idx.forEach((i, k) => {
          out[i] = { p: p[k], peers: sector, count };
        });
      } else
        idx.forEach((i) => {
          out[i] = { p: universeP[i], peers: "universe", count: universeCount };
        });
    }
    return { values, out };
  });
  return all.map((i) => {
    const row = rows[i]!;
    const components: ComponentScore[] = style.components.map((c, k) => ({
      ...c,
      value: pcts[k]!.values[i],
      percentile: pcts[k]!.out[i]!.p,
      peers: pcts[k]!.out[i]!.peers,
      peerCount: pcts[k]!.out[i]!.count,
    }));
    const total = style.components.reduce((s, c) => s + c.weight, 0);
    const have = components.filter((c) => c.percentile !== undefined);
    const w = have.reduce((s, c) => s + c.weight, 0);
    const coverage = total ? w / total : 0;
    const score =
      coverage >= MIN_WEIGHT_SHARE && total > 0 ? components.reduce((s, c) => s + c.weight * (c.percentile ?? MISSING_PERCENTILE), 0) / total : undefined;
    return { row, symbol: String(row.symbol), sector: sectorOf(row), components, coverage, ...(score !== undefined ? { score } : {}) };
  });
}

/** Best first: by score, then by EUR cap (the larger, more liquid line), then by symbol for a stable order. */
export function rankValueRows(scored: readonly ScoredRow[]): ScoredRow[] {
  const cap = (r: ScoredRow) => (typeof r.row.cap_eur === "number" ? r.row.cap_eur : 0);
  return scored.filter((r) => r.score !== undefined).sort((a, b) => b.score! - a.score! || cap(b) - cap(a) || a.symbol.localeCompare(b.symbol));
}

/** At most this many names of one sector in a list of n: a ranking, not a sector bet. */
export const sectorCap = (n: number): number => Math.max(2, Math.ceil(n * 0.3));

/** The first n of a ranked list with at most `cap` per sector; the rest of a full sector waits its turn. */
export function selectValueRows(ranked: readonly ScoredRow[], n: number, cap = sectorCap(n)): ScoredRow[] {
  const out: ScoredRow[] = [];
  const count = new Map<string, number>();
  for (const r of ranked) {
    if (out.length >= n) break;
    const c = count.get(r.sector) ?? 0;
    if (c >= cap) continue;
    count.set(r.sector, c + 1);
    out.push(r);
  }
  return out;
}
