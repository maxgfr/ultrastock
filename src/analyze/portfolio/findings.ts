// How the portfolio analytics hand their figures to the agent: the data they
// read (ledger, quotes, FX, price windows, fund holdings) are input datasets,
// registered as they came; every figure computed from them is DERIVED evidence
// — `addDerived` with the ids of the inputs it used and the formula — so a
// portfolio VaR cites the quotes, rates and series behind it, and `check` can
// follow a number back to its sources.
//
// Derived points name their inputs by KEY (an input point's key or an earlier
// derived key): ids are only known once the run's store assigns them.
import { type Dataset, formatDatasets, registerDatasets } from "../../core/datasets.js";
import { type EvidenceItem, EvidenceStore, formatEvidence } from "../../core/evidence.js";

export interface DerivedPoint {
  /** The section it prints under ("weights", "risk", "VaR"…). */
  section: string;
  key: string;
  label: string;
  value: number | string | boolean;
  unit?: string;
  /** Keys of the input or earlier derived points it is computed from. */
  from: string[];
  formula: string;
}

/** The input datasets and derived figures of one analysis, in the order they were made. */
export class Findings {
  readonly inputs: Dataset[] = [];
  readonly derived: DerivedPoint[] = [];
  readonly notes: string[] = [];
  private readonly known = new Set<string>();

  /** Add an input dataset; its point keys become citable by derived points. */
  input(ds: Dataset): void {
    if (!ds.points.length || ds.points.every((p) => this.known.has(p.key))) return;
    this.inputs.push(ds);
    for (const p of ds.points) this.known.add(p.key);
  }

  has(key: string): boolean {
    return this.known.has(key);
  }

  /**
   * Record a derived figure and return its key (to cite it further), or
   * undefined when the value is not a finite number — said in the notes, never
   * stored as 0 or NaN.
   */
  derive(section: string, key: string, label: string, value: number | string | boolean, unit: string | undefined, from: readonly string[], formula: string) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      this.notes.push(`${label}: not computable from the data read (${formula})`);
      return undefined;
    }
    const inputs = [...new Set(from.filter((k) => this.known.has(k)))];
    if (!inputs.length) throw new Error(`derived ${key} has no registered input among ${from.join(", ") || "(none)"}`);
    this.derived.push({ section, key, label, value: typeof value === "number" ? Number(value.toPrecision(12)) : value, unit, from: inputs, formula });
    this.known.add(key);
    return key;
  }

  note(...lines: string[]): void {
    for (const l of lines) if (l && !this.notes.includes(l)) this.notes.push(l);
  }
}

export interface EmittedFindings {
  dir: string;
  inputs: Array<Dataset & { ids: string[] }>;
  derived: EvidenceItem[];
  notes: string[];
}

/** Register the findings in the run at `dir` (inputs first, then the derived figures, in order). */
export function registerFindings(dir: string, f: Findings, subject: string, now: Date): { store: EvidenceStore; result: EmittedFindings } {
  const store = EvidenceStore.open(dir, { run: dir, subject, createdAt: now.toISOString() });
  const registered = registerDatasets(store, f.inputs);
  const ids = new Map<string, string>();
  for (const r of registered) r.items.forEach((it) => ids.set(it.key, it.id));
  const derived: EvidenceItem[] = [];
  for (const d of f.derived) {
    const inputIds = d.from.map((k) => ids.get(k)).filter((x): x is string => !!x);
    const id = store.addDerived(d.key, d.label, d.value, d.unit, inputIds, d.formula);
    ids.set(d.key, id);
    derived.push(store.get(id)!);
  }
  store.save();
  return {
    store,
    result: { dir, inputs: registered.map((r) => ({ ...r.dataset, ids: r.ids })), derived, notes: f.notes },
  };
}

/** The text an analysis prints: the derived figures by section, the notes, then the inputs they cite. */
export function formatFindings(title: string, f: Findings, emitted: EmittedFindings, store: EvidenceStore): string {
  const lines = [`# ${title}`, ""];
  const bySection = new Map<string, EvidenceItem[]>();
  emitted.derived.forEach((item, i) => {
    const s = f.derived[i]!.section;
    bySection.set(s, [...(bySection.get(s) ?? []), item]);
  });
  for (const [section, items] of bySection) {
    lines.push(`## ${section}`);
    for (const i of items) lines.push(`- ${formatEvidence(i)}`);
    lines.push("");
  }
  if (f.notes.length) {
    lines.push("## notes");
    for (const n of f.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  lines.push("## inputs", "");
  const inputs = formatDatasets(
    emitted.inputs.map((ds) => ({ dataset: ds, ids: ds.ids, items: ds.ids.map((id) => store.get(id)).filter((x): x is EvidenceItem => !!x) })),
  );
  return `${lines.join("\n")}${inputs}run: ${emitted.dir}\n`;
}
