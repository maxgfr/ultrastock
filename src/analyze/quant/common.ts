// Small shared pieces of the quant analysis commands: a point list that drops
// what is not a finite number (evidence refuses NaN and Infinity, and a
// missing estimate must be absent, not zero), and a dataset whose provenance
// is the series or chain the figures were computed from.
import type { Dataset, Point } from "../../core/datasets.js";

/** A point collector: numbers that are not finite are skipped, never registered. */
export class PointList {
  readonly points: Point[] = [];

  /** Add a point; returns false (and adds nothing) when its value is a non-finite number. */
  add(p: Point): boolean {
    if (typeof p.value === "number" && !Number.isFinite(p.value)) return false;
    this.points.push(p);
    return true;
  }

  num(key: string, label: string, value: number | undefined, unit: string | undefined, formula?: string, asOf?: string): boolean {
    if (value === undefined) return false;
    return this.add({ key, label, value, ...(unit ? { unit } : {}), ...(formula ? { formula } : {}), ...(asOf ? { asOf } : {}) });
  }

  text(key: string, label: string, value: string | boolean, formula?: string, asOf?: string): void {
    this.add({ key, label, value, ...(formula ? { formula } : {}), ...(asOf ? { asOf } : {}) });
  }
}

/** Provenance of figures computed from several datasets: the least official, oldest read, sources joined. */
export function mergedProvenance(provs: ReadonlyArray<Dataset["provenance"]>, asOf?: string): Dataset["provenance"] {
  const first = provs[0];
  if (!first) throw new Error("no provenance to merge");
  const sources = [...new Set(provs.map((p) => p.source))];
  const oldest = provs.reduce((a, b) => (Date.parse(b.fetchedAt) < Date.parse(a.fetchedAt) ? b : a));
  const delays = [...new Set(provs.map((p) => p.delay).filter((d): d is string => !!d))];
  return {
    source: sources.join("+"),
    ...(sources.length === 1 && first.url ? { url: first.url } : {}),
    fetchedAt: oldest.fetchedAt,
    ...(delays.length ? { delay: delays.join("/") } : {}),
    official: provs.every((p) => p.official),
    ...(asOf ? { asOf } : {}),
  };
}

/** Round for labels only (values keep their precision). */
export const fmt = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : String(x));

/** A key segment for a signed percentage move: 0.1 → "+10", −0.05 → "-5". */
export const moveKey = (m: number): string => `${m >= 0 ? "+" : ""}${Number((m * 100).toFixed(2))}`;
