// Re-running an analysis should say what CHANGED, not repeat everything: the
// figures that moved past a threshold, the states that flipped (trend, a
// score's verdict, a pattern), and what is new or gone. Keys are stable across
// runs, which is what makes this a diff.
import { EvidenceStore, type EvidenceItem } from "../core/evidence.js";

export interface DeltaRow {
  key: string;
  label: string;
  before?: number | string | boolean;
  after?: number | string | boolean;
  /** Relative change for numbers, in %. */
  changePct?: number;
  kind: "moved" | "flipped" | "new" | "gone";
}

/** Compare two runs: numbers that moved more than `thresholdPct`, non-numbers that changed, keys that appeared or vanished. */
export function deltaRuns(beforeDir: string, afterDir: string, thresholdPct = 5): { rows: DeltaRow[]; before: number; after: number } {
  const a = EvidenceStore.load(beforeDir);
  const b = EvidenceStore.load(afterDir);
  if (!a || !b) throw new Error(`both runs need evidence (${!a ? beforeDir : afterDir} has none)`);
  // Latest value per key (a run can hold several registrations of one key).
  const latest = (s: EvidenceStore) => {
    const m = new Map<string, EvidenceItem>();
    for (const i of s.items) m.set(i.key, i);
    return m;
  };
  const ma = latest(a);
  const mb = latest(b);
  const rows: DeltaRow[] = [];
  for (const [key, ib] of mb) {
    const ia = ma.get(key);
    if (!ia) {
      if (typeof ib.value !== "number") rows.push({ key, label: ib.label, after: ib.value, kind: "new" });
      continue;
    }
    if (typeof ia.value === "number" && typeof ib.value === "number") {
      const base = Math.abs(ia.value) > 1e-12 ? Math.abs(ia.value) : 1;
      const ch = ((ib.value - ia.value) / base) * 100;
      if (Math.abs(ch) >= thresholdPct) rows.push({ key, label: ib.label, before: ia.value, after: ib.value, changePct: Number(ch.toFixed(2)), kind: "moved" });
    } else if (ia.value !== ib.value) rows.push({ key, label: ib.label, before: ia.value, after: ib.value, kind: "flipped" });
  }
  for (const [key, ia] of ma) if (!mb.has(key) && typeof ia.value !== "number") rows.push({ key, label: ia.label, before: ia.value, kind: "gone" });
  const order = { flipped: 0, moved: 1, new: 2, gone: 3 };
  rows.sort((x, y) => order[x.kind] - order[y.kind] || Math.abs(y.changePct ?? 0) - Math.abs(x.changePct ?? 0));
  return { rows, before: a.items.length, after: b.items.length };
}

export function deltaMarkdown(r: ReturnType<typeof deltaRuns>, beforeDir: string, afterDir: string): string {
  const fmt = (v: unknown) => (v === undefined ? "—" : String(v));
  const lines = [
    `# What changed`,
    "",
    `From ${beforeDir} (${r.before} evidence) to ${afterDir} (${r.after}). States that flipped first, then figures that moved, then what appeared or disappeared.`,
    "",
    "| Kind | What | Before | After | Change |",
    "|---|---|---|---|---|",
    ...r.rows.map(
      (x) =>
        `| ${x.kind} | ${x.label} | ${fmt(x.before)} | ${fmt(x.after)} | ${x.changePct === undefined ? "" : `${x.changePct > 0 ? "+" : ""}${x.changePct} %`} |`,
    ),
  ];
  if (!r.rows.length) lines.push("| — | nothing moved past the threshold | | | |");
  return `${lines.join("\n")}\n`;
}
