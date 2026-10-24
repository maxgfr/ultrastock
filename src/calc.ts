// Derived figures, computed by the tool and never by the model.
//
// `ultrastock calc <run> "(E3 / E7 - 1) * 100" --label "LVMH vs 52-week high" --unit %`
// evaluates the formula over the run's evidence and registers the result as a
// new [E#] that records what it was computed from. An answer can then state
// the figure and cite it, and `check` accepts it like any read value. A
// formula over a missing or non-numeric id is refused, not guessed.
import { type EvidenceItem, EvidenceStore } from "./core/evidence.js";
import { compileExpr, evaluateExpr, exprVariables } from "./core/expr.js";

export interface CalcResult {
  id: string;
  value: number;
  item: EvidenceItem;
}

export function calcEvidence(dir: string, formula: string, opts: { label: string; unit?: string; key?: string }): CalcResult {
  const store = EvidenceStore.load(dir);
  if (!store) throw new Error(`${dir} holds no evidence.json — gather evidence first (analyze, quote, history with --out)`);
  const ast = compileExpr(formula);
  const vars = exprVariables(ast);
  const inputs: EvidenceItem[] = [];
  for (const v of vars) {
    if (!/^E\d+$/.test(v)) throw new Error(`"${v}" is not an evidence id — a calc reads only [E#] ids of the run (E1, E2…)`);
    const item = store.get(v);
    if (!item) throw new Error(`${v} is not in this run's evidence`);
    if (typeof item.value !== "number") throw new Error(`${v} (${item.label}) is not a number`);
    inputs.push(item);
  }
  if (!inputs.length) throw new Error("a calc must read at least one evidence id — a bare constant is not evidence");
  const value = evaluateExpr(ast, { get: (name, offset) => (offset === 0 ? (store.get(name)?.value as number | undefined) : undefined) });
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${formula}" does not evaluate to a finite number`);
  // Conservative provenance: as fresh as its stalest input, as official as its least official one.
  const oldest = inputs.reduce((a, b) => (Date.parse(a.fetchedAt) <= Date.parse(b.fetchedAt) ? a : b));
  const asOfs = inputs
    .map((i) => i.asOf)
    .filter((x): x is string => !!x)
    .sort();
  const id = store.add({
    key: opts.key ?? `calc:${formula.replace(/\s+/g, "")}`,
    label: opts.label,
    value: Number(value.toPrecision(12)),
    unit: opts.unit,
    source: "calc",
    fetchedAt: oldest.fetchedAt,
    asOf: asOfs[0],
    official: inputs.every((i) => i.official),
    derivedFrom: inputs.map((i) => i.id),
    formula,
  });
  store.save();
  return { id, value, item: store.get(id)! };
}
