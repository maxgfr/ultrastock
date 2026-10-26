// Derived figures, computed by the tool and never by the model.
//
// `ultrastock calc <run> "(E3 / E7 - 1) * 100" --label "LVMH vs 52-week high" --unit %`
// evaluates the formula over the run's evidence and registers the result as a
// new [E#] that records what it was computed from. An answer can then state
// the figure and cite it, and `check` accepts it like any read value. A
// formula over a missing or non-numeric id is refused, not guessed.
//
// `ultrastock calc <run> --from E12 "4,2 Md€" --label "LVMH H1 net income"`
// promotes a figure a document states into a number a formula can use: it is
// registered only if the document [E12] holds it, and it records where it was
// read.
import { documentFigures, extractFigures, figureMatches } from "./check.js";
import { type EvidenceItem, EvidenceStore, readDocText } from "./core/evidence.js";
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

const CURRENCY_MARKS: Array<[RegExp, string]> = [
  [/€|\bEUR\b|\beuros?\b/i, "EUR"],
  [/\$|\bUSD\b|\bdollars?\b/i, "USD"],
  [/£|\bGBP\b|\bpounds?\b/i, "GBP"],
  [/\bCHF\b/, "CHF"],
];

/** Register a figure read in a document [E#] as a number of its own, refused when the document does not state it. */
export function calcFromDocument(dir: string, docId: string, written: string, opts: { label: string; unit?: string; key?: string }): CalcResult {
  const store = EvidenceStore.load(dir);
  if (!store) throw new Error(`${dir} holds no evidence.json — run \`ultrastock research\` with --out ${dir} first`);
  const doc = store.get(docId);
  if (!doc) throw new Error(`${docId} is not in this run's evidence`);
  if (!doc.doc) throw new Error(`${docId} (${doc.label}) is not a document — --from reads a figure out of a document [E#]`);
  const text = readDocText(dir, doc);
  if (text === undefined) throw new Error(`${docId}: its text (${doc.doc.path}) is missing from the run`);
  const figs = extractFigures(written);
  if (figs.length !== 1) throw new Error(`give exactly one figure as the document writes it ("4,2 Md€", "12.5 %"), not "${written}"`);
  const f = figs[0]!;
  if (!figureMatches(f, documentFigures(doc, text)))
    throw new Error(`${f.raw} is not in ${docId}${doc.url ? ` (${doc.url})` : ""} — copy the figure as the document states it`);
  const unit = opts.unit ?? (f.percent ? "%" : CURRENCY_MARKS.find(([re]) => re.test(written))?.[1]);
  const value = Number(f.value.toPrecision(12));
  const id = store.add({
    key: opts.key ?? `${doc.key}.fig.${value}`,
    label: opts.label,
    value,
    unit,
    source: doc.source,
    url: doc.url,
    fetchedAt: doc.fetchedAt,
    asOf: doc.asOf ?? doc.doc.publishedAt?.slice(0, 10),
    official: doc.official,
    derivedFrom: [docId],
    formula: `read from ${docId}: "${f.raw}"`,
  });
  store.save();
  return { id, value, item: store.get(id)! };
}
