// The evidence register of a run: every figure ultrastock hands to the agent,
// numbered [E1], [E2]… with where it came from and how fresh it is.
//
// This is the anti-hallucination contract. The agent never states a number of
// its own: a figure in an answer must cite the [E#] that holds it, a derived
// figure is computed by `ultrastock calc` and registered here as its own [E#],
// and `ultrastock check` refuses an answer whose numbers are not in the
// evidence they cite. Ids are assigned in insertion order, so the same inputs
// (a replayed fixture) always produce the same ids.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeFileAtomic } from "../engine.js";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "./untrusted.js";

export const EVIDENCE_FILE = "evidence.json";
export const EVIDENCE_SCHEMA = 1;

/** Where a figure came from. */
export interface Provenance {
  /** Short provider id: euronext, nasdaq, binance, calc… */
  source: string;
  /** The URL that was read (omitted for derived figures). */
  url?: string;
  /** When the bytes were read (ISO). */
  fetchedAt: string;
  /** The date the figure is true at — the last bar's session, a filing's period end (ISO date). */
  asOf?: string;
  /** How delayed the data is at the source: "eod", "15min", "realtime", "filing"… */
  delay?: string;
  /** An exchange, a regulator or the issuer (true), or a scraped/undocumented endpoint (false). */
  official: boolean;
  /** The source this one stood in for, when a fallback answered. */
  fallbackFrom?: string;
}

/**
 * A document an evidence item stands for — a web page, a filing, a PDF read in
 * full. Its text lives in the run (`path`, relative to it), fenced as external
 * text; the register keeps where, how long and which bytes, so `check` can find
 * an answer's figures in the source itself.
 */
export interface EvidenceDoc {
  /** Relative to the run directory: "sources/E12.md". */
  path: string;
  chars: number;
  /** sha256 of the text. */
  hash: string;
  /** When the document says it was published (as the page wrote it). */
  publishedAt?: string;
}

export interface EvidenceItem extends Provenance {
  id: string;
  /** What the figure is, in words: "LVMH close", "RSI(14)". */
  label: string;
  /** Stable machine key: "MC.PA.close", "MC.PA.rsi14". */
  key: string;
  value: number | string | boolean;
  /** "EUR", "USD", "%", "ratio", "shares"… A "%" value is stored as a percentage (12.5 = 12.5 %). */
  unit?: string;
  /** For derived figures: the ids it was computed from, and how. */
  derivedFrom?: string[];
  formula?: string;
  /** The value is external text (a headline, a market question): data, never instructions. */
  untrusted?: boolean;
  /** The item is a document (key `doc.<hash>`): its text, for `check` to read. */
  doc?: EvidenceDoc;
}

export interface EvidenceFile {
  schema: number;
  run: string;
  createdAt: string;
  subject?: string;
  items: EvidenceItem[];
}

export class EvidenceStore {
  readonly dir: string;
  private data: EvidenceFile;

  private constructor(dir: string, data: EvidenceFile) {
    this.dir = dir;
    this.data = data;
  }

  /** Open the run at `dir`, creating an empty register when there is none. */
  static open(dir: string, init: { run?: string; subject?: string; createdAt?: string } = {}): EvidenceStore {
    const path = join(dir, EVIDENCE_FILE);
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8")) as EvidenceFile;
      if (data.schema !== EVIDENCE_SCHEMA || !Array.isArray(data.items))
        throw new Error(`${path} is not an ultrastock evidence file (schema ${EVIDENCE_SCHEMA})`);
      return new EvidenceStore(dir, data);
    }
    return new EvidenceStore(dir, {
      schema: EVIDENCE_SCHEMA,
      run: init.run ?? dir,
      createdAt: init.createdAt ?? new Date().toISOString(),
      subject: init.subject,
      items: [],
    });
  }

  /** Read a run's register; undefined when the directory holds none. */
  static load(dir: string): EvidenceStore | undefined {
    return existsSync(join(dir, EVIDENCE_FILE)) ? EvidenceStore.open(dir) : undefined;
  }

  get items(): readonly EvidenceItem[] {
    return this.data.items;
  }

  get subject(): string | undefined {
    return this.data.subject;
  }

  get(id: string): EvidenceItem | undefined {
    return this.data.items.find((i) => i.id === id);
  }

  /** The latest figure registered under `key`. */
  byKey(key: string): EvidenceItem | undefined {
    for (let i = this.data.items.length - 1; i >= 0; i--) if (this.data.items[i]!.key === key) return this.data.items[i];
    return undefined;
  }

  /**
   * Register a figure and return its id. Re-adding the same key with the same
   * value returns the existing id, so a re-run does not renumber a run.
   */
  add(item: Omit<EvidenceItem, "id">): string {
    if (typeof item.value === "number" && !Number.isFinite(item.value)) throw new Error(`evidence ${item.key}: not a finite number`);
    const existing = this.byKey(item.key);
    if (existing && existing.value === item.value) return existing.id;
    const id = `E${this.data.items.length + 1}`;
    this.data.items.push({ id, ...item });
    return id;
  }

  /**
   * Register a figure computed from other evidence: its provenance is the
   * stalest and least official of its inputs, and it records them and how.
   */
  addDerived(key: string, label: string, value: number | string | boolean, unit: string | undefined, inputs: readonly string[], formula: string): string {
    const src = inputs.map((id) => this.get(id)).filter((i): i is EvidenceItem => !!i);
    const oldest = src.reduce<EvidenceItem | undefined>((a, b) => (!a || Date.parse(b.fetchedAt) < Date.parse(a.fetchedAt) ? b : a), undefined);
    const asOfs = src
      .map((i) => i.asOf)
      .filter((x): x is string => !!x)
      .sort();
    return this.add({
      key,
      label,
      value: typeof value === "number" ? Number(value.toPrecision(12)) : value,
      unit,
      source: "ultrastock",
      fetchedAt: oldest?.fetchedAt ?? new Date().toISOString(),
      asOf: asOfs[asOfs.length - 1],
      official: src.length > 0 && src.every((i) => i.official),
      derivedFrom: src.map((i) => i.id),
      formula,
    });
  }

  save(): string {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, EVIDENCE_FILE);
    writeFileAtomic(path, `${JSON.stringify(this.data, null, 2)}\n`);
    return path;
  }
}

/** How a figure is shown to the agent: `[E3] LVMH close = 383.00 EUR (euronext, as of 2026-10-23, eod)`. */
export function formatEvidence(i: EvidenceItem): string {
  const value = typeof i.value === "number" ? formatNumber(i.value) : String(i.value);
  const unit = i.unit ? (i.unit === "%" ? "%" : ` ${i.unit}`) : "";
  const facts = [
    i.source,
    i.asOf ? `as of ${i.asOf}` : undefined,
    i.delay,
    i.official ? undefined : "unofficial",
    i.fallbackFrom ? `fallback for ${i.fallbackFrom}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return `[${i.id}] ${i.label} = ${value}${unit} (${facts})`;
}

/** A number written so `check` can find it again: up to 4 significant decimals, no exponent. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return String(Number(n.toFixed(decimals)));
}

/**
 * The text of a document item, read from the run — the part between the
 * external-text fences. Undefined when the item is no document, its file is
 * gone, or its path leaves the run directory (a register is data: it never
 * gets to point `check` at an arbitrary file).
 */
export function readDocText(dir: string, item: EvidenceItem): string | undefined {
  if (!item.doc) return undefined;
  const root = resolve(dir);
  const path = resolve(root, item.doc.path);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  const open = raw.indexOf(UNTRUSTED_OPEN);
  const close = raw.lastIndexOf(UNTRUSTED_CLOSE);
  if (open < 0 || close < open) return raw;
  return raw.slice(raw.indexOf("\n", open) + 1, close);
}
