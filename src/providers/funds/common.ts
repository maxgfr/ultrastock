// The shape every fund look-through source reduces to — a dated list of a
// fund's lines with their weights — and the dataset built from it: the
// number of lines, the top holdings, and the sector and country breakdowns.
// Security names, sector and country labels are the issuer's text: they are
// untrusted points (fenced when printed), never keys or labels.
import type { Dataset, Point } from "../../core/datasets.js";

export interface FundLine {
  name: string;
  ticker?: string;
  isin?: string;
  /** Share of the fund, in % (sums to ~100 over all lines). */
  weightPct: number;
  sector?: string;
  /** A country name or an ISO code, as the source writes it. */
  country?: string;
  assetClass?: string;
}

export interface FundComposition {
  /** The fund as asked for: an ISIN or a ticker. */
  fund: string;
  source: string;
  url: string;
  fetchedAt: string;
  /** The date the holdings are as of. */
  asOf?: string;
  /** Lines, largest first. */
  lines: FundLine[];
  /** True when the lines are a swap's substitute basket rather than the index exposure. */
  synthetic: boolean;
  official: boolean;
  notes: string[];
}

/** Sum the weights by a field ("sector", "country"), largest first; lines without it are "unclassified". */
export function breakdown(lines: readonly FundLine[], field: "sector" | "country" | "assetClass"): Array<{ label: string; weightPct: number }> {
  const m = new Map<string, number>();
  for (const l of lines) {
    const k = (l[field] ?? "").trim() || "unclassified";
    m.set(k, (m.get(k) ?? 0) + l.weightPct);
  }
  return [...m.entries()].map(([label, weightPct]) => ({ label, weightPct })).sort((a, b) => b.weightPct - a.weightPct);
}

const r = (x: number) => Number(x.toFixed(4));

/**
 * Points for a composition, keyed `<SUBJECT>.lt.*`: the line count, the top
 * `top` holdings (name untrusted, weight), and — unless the lines are a swap's
 * basket — the top sector and country weights (label untrusted, weight).
 */
export function compositionDataset(subject: string, c: FundComposition, top = 10): Dataset {
  const k = `${subject}.lt`;
  const points: Point[] = [{ key: `${k}.lines`, label: `${subject} look-through: lines held by the fund`, value: c.lines.length, unit: "count", asOf: c.asOf }];
  c.lines.slice(0, top).forEach((l, i) => {
    points.push({
      key: `${k}.holding.${i + 1}.name`,
      label: `${subject} look-through holding #${i + 1}`,
      value: l.isin ? `${l.name} (${l.isin})` : l.name,
      untrusted: true,
      asOf: c.asOf,
    });
    points.push({
      key: `${k}.holding.${i + 1}.weight`,
      label: `${subject} look-through holding #${i + 1} weight in the fund`,
      value: r(l.weightPct),
      unit: "%",
      asOf: c.asOf,
    });
  });
  if (!c.synthetic)
    for (const field of ["sector", "country"] as const) {
      if (!c.lines.some((l) => l[field])) continue;
      breakdown(c.lines, field)
        .slice(0, top)
        .forEach((b, i) => {
          points.push({
            key: `${k}.${field}.${i + 1}.name`,
            label: `${subject} look-through ${field} #${i + 1}`,
            value: b.label,
            untrusted: true,
            asOf: c.asOf,
          });
          points.push({
            key: `${k}.${field}.${i + 1}.weight`,
            label: `${subject} look-through ${field} #${i + 1} weight in the fund`,
            value: r(b.weightPct),
            unit: "%",
            asOf: c.asOf,
            formula: `Σ weights of the fund's lines in that ${field}`,
          });
        });
    }
  return {
    kind: "fund-holdings",
    title: `${subject} look-through (${c.source})`,
    subject,
    points,
    provenance: { source: c.source, url: c.url, fetchedAt: c.fetchedAt, official: c.official, asOf: c.asOf },
    notes: [
      ...c.notes,
      ...(c.synthetic
        ? [
            "synthetic (swap) replication: these lines are the fund's substitute basket, not its exposure — the exposure is the index; no sector or country breakdown is drawn from them",
          ]
        : []),
    ],
  };
}
