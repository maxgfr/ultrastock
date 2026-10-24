// Does an answer about money say only what the evidence says, and say where?
//
// Every figure an answer states — a price, a percentage, a ratio, an amount —
// must sit in a claim that cites an [E#] of the run, and must be found among
// the values those [E#] hold (rounding allowed: 383.0 for 383.00, 12.3 % for
// 12.34 %, "188.6 bn" for 188 576 644 501). A figure no cited evidence holds is
// a figure the model made up, whatever it looks like. Derived figures are
// legitimate only once `ultrastock calc` has registered them as their own [E#].
//
// The engine finds the claims and the citation tokens; the numbers are read
// here, because the engine's numeral reader is built for prose (it drops signs,
// single digits and anything past the eighth number of a paragraph) and a
// financial table breaks all three.
import { citationTokensIn, collectCitations, EVIDENCE_TOKEN, extractClaimUnits, unitTexts } from "./engine.js";
import { type EvidenceItem, EvidenceStore } from "./core/evidence.js";

export interface CheckProblem {
  line?: number;
  /** `inert` and `unsourced` are notes: they do not fail the check. */
  kind: "empty" | "uncited" | "dangling" | "unsupported" | "stale" | "inert" | "unsourced";
  message: string;
}

export interface CheckReport {
  claims: number;
  figures: number;
  citations: number;
  evidence: number;
  problems: CheckProblem[];
}

export const NOTE_KINDS: ReadonlySet<CheckProblem["kind"]> = new Set(["inert", "unsourced"]);

export function isEvidenceCitation(token: string): boolean {
  return EVIDENCE_TOKEN.test(`[${token}]`) || /^E\d+$/.test(token);
}

/** `[E3, E5]` and `[E3; E5]` read as `[E3] [E5]`; a citation made a link drops its URL. */
export function normalizeEvidenceCitations(answer: string): string {
  return answer.replace(/\[((?:E\d+)(?:\s*[,;]\s*E\d+)+|E\d+)\](\([^)\s]*\))?/g, (_whole, inner: string) =>
    inner
      .split(/[,;]/)
      .map((p) => `[${p.trim()}]`)
      .join(" "),
  );
}

/** A figure as written in an answer. */
export interface Figure {
  raw: string;
  /** The number as written, scaled (1.2 bn → 1.2e9), signed. */
  value: number;
  percent: boolean;
  /** Decimals as written, for the rounding tolerance. */
  decimals: number;
  scale: number;
}

const SCALES: Array<[RegExp, number]> = [
  [/^(?:k|K|mille)$/, 1e3],
  [/^(?:M|m|mn|Mn|mio|million|millions)$/, 1e6],
  [/^(?:Md|Mds|md|mds|bn|Bn|B|billion|billions|milliard|milliards)$/, 1e9],
  [/^(?:T|tn|trillion|trillions)$/, 1e12],
];
const MONTHS = "jan|janv|feb|févr|fev|mar|mars|apr|avr|may|mai|jun|juin|jul|juil|aug|août|aout|sep|sept|oct|nov|dec|déc";

/** What is not a figure: dates, times, citation tokens, inline code, link targets. */
function stripNonFigures(text: string): string {
  return (
    text
      .replace(/`[^`]*`/g, " ")
      .replace(/\]\([^)]*\)/g, "] ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, " ")
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ")
      .replace(new RegExp(`\\b\\d{1,2}(?:er)?\\s+(?:${MONTHS})[a-zéû]*\\.?(?:\\s+\\d{4})?`, "gi"), " ")
      .replace(new RegExp(`\\b(?:${MONTHS})[a-zéû]*\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?`, "gi"), " ")
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
      // Indicator parameters and index names are labels, not claims: RSI(14), MACD(12,26,9), SMA 200, MM50, CAC 40, S&P 500.
      .replace(/\b[A-Za-z]{2,}\(\s*\d+(?:[.,]\d+)?(?:\s*,\s*\d+(?:[.,]\d+)?)*\s*\)/g, " ")
      .replace(/\b(?:SMA|EMA|WMA|HMA|MA|MM|RSI|ATR|ADX|MACD|BB|ROC|CCI|MFI|DMA)\s?\d+\b/gi, " ")
      .replace(/(?:S&P|\b(?:CAC|SBF|STOXX|Stoxx|Nasdaq|NASDAQ|Russell|DAX|MDAX|FTSE|AEX|BEL|IBEX|MIB|PSI|OBX|ISEQ|Nikkei|Top|top|Dow Jones))\s?\d+\b/g, " ")
  );
}

const FIGURE_RE =
  /(?<![\p{L}\p{N}_.,])([+\-−–]?)\s?([$€£]\s?)?(\d{1,3}(?:[ ,.  ']\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s?(?:%|pts?|bps|x|×)|\s?(?:k|K|M|m|mn|Mn|mio|Md|Mds|md|mds|bn|Bn|B|T|tn|million|millions|milliard|milliards|billion|billions|trillion|trillions|mille)\b)?(\s?(?:[$€£]|EUR|USD|USDT|USDC|GBP|CHF|NOK|BTC|ETH)\b|\s?[$€£])?/gu;
const PARAMETER_AFTER =
  /^[-\s]?(?:days?|d|jours?|j|weeks?|wks?|w|semaines?|months?|mo|mois|years?|yrs?|y|ans?|années?|bars?|séances?|sessions?|hours?|h|heures?|min|minutes?|périodes?|periods?|ème|e|er|re|st|nd|rd|th)\b/iu;

/** Every figure a piece of text states. */
export function extractFigures(text: string): Figure[] {
  const src = stripNonFigures(text);
  const out: Figure[] = [];
  for (const m of src.matchAll(FIGURE_RE)) {
    const [raw, sign, curPre, digits, suffixRaw, curPost] = m;
    const suffix = (suffixRaw ?? "").trim();
    const after = src.slice((m.index ?? 0) + raw.length);
    if (!suffix && !curPre && !curPost && PARAMETER_AFTER.test(after)) continue; // "5-day", "52 weeks", "3e"
    if (!suffix && /^[\p{L}]/u.test(after)) continue; // glued to a word: an identifier
    const { value, decimals } = parseDigits(digits!);
    const percent = suffix === "%" || /^pts?$/.test(suffix);
    const scale = SCALES.find(([re]) => re.test(suffix))?.[1] ?? (suffix === "bps" ? 0.01 : 1);
    const plain = !suffix && !curPre && !curPost && decimals === 0;
    if (plain && Math.abs(value) < 10) continue; // "3 positions": too weak to check anything with
    if (plain && !sign && value >= 1900 && value <= 2100) continue; // a year
    const signed = /[-−–]/.test(sign ?? "") ? -value : value;
    out.push({ raw: raw.trim(), value: signed * scale, percent, decimals, scale });
  }
  return out;
}

/** "1 234,5", "1,234.5", "0,25", "12.34" → value and written decimals. */
function parseDigits(d: string): { value: number; decimals: number } {
  let s = d.replace(/[  ' ]/g, "");
  // "1,234" and "1,234.5": commas group thousands. "1.234.567" and "1.234,5": dots do.
  // A lone "1.234" stays a decimal — the English reading, and the one a source would print.
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d{1,3}(?:\.\d{3}){2,}(?:,\d+)?$/.test(s) || /^\d{1,3}(?:\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, "");
  s = s.replace(",", ".");
  const decimals = s.includes(".") ? s.split(".")[1]!.length : 0;
  return { value: Number(s), decimals };
}

/** Is the written figure one of the values these evidence items hold? */
export function figureMatches(f: Figure, items: readonly EvidenceItem[]): boolean {
  const tol = 0.5 * 10 ** -f.decimals * f.scale;
  for (const it of items) {
    if (typeof it.value !== "number") continue;
    const candidates = [it.value];
    // A fraction stored as a ratio can be written as a percentage, and back.
    if (f.percent && it.unit !== "%") candidates.push(it.value * 100);
    if (!f.percent && it.unit === "%") candidates.push(it.value / 100);
    for (const v of candidates) {
      for (const target of [f.value, Math.abs(f.value)]) {
        const a = Math.abs(v) === Math.abs(target) ? 0 : Math.abs(Math.abs(v) - Math.abs(target));
        if (a <= tol + 1e-9 * Math.max(1, Math.abs(v))) return true;
        if (Math.abs(v) > 0 && a / Math.abs(v) <= 0.001) return true;
      }
    }
  }
  return false;
}

const SOURCES_HEADING = /^#{1,6}\s+(?:sources?|references?|citations?|évidences?|evidence|preuves|références?|annexe|appendix)\b/i;

/** A closing sources/evidence list, from its heading to the end, when no heading follows it. */
function closingSourcesMask(lines: readonly string[]): boolean[] {
  const mask = lines.map(() => false);
  const headings = lines.map((l, i) => (/^#{1,6}\s/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  const last = headings[headings.length - 1];
  if (last !== undefined && SOURCES_HEADING.test(lines[last]!.trim())) for (let i = last; i < lines.length; i++) mask[i] = true;
  return mask;
}

/** The line each claim starts on, moving forward through the answer. */
function lineFinder(lines: string[]) {
  const flat = lines.map((l) =>
    l
      .replace(/`/g, "")
      .replace(/^\s*(?:[-*+]|\d+\.|>)\s+/, "")
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  let cursor = 0;
  return (text: string): number | undefined => {
    const probe = text.replace(/`/g, "").replace(/\s+/g, " ").trim().slice(0, 30);
    if (!probe) return undefined;
    for (const from of [cursor, 0]) {
      for (let i = from; i < flat.length; i++) {
        const l = flat[i]!;
        if (l && (l.includes(probe) || (l.length >= 10 && probe.startsWith(l.slice(0, 30))))) {
          cursor = i + 1;
          return i + 1;
        }
      }
    }
    return undefined;
  };
}

const words = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const quote = (t: string) => (t.length > 70 ? `${t.slice(0, 67)}…` : t);

export interface CheckOptions {
  /** Fail any cited figure read longer ago than this. */
  maxAgeMs?: number;
  now?: Date;
}

/** Check an answer against the evidence register of its run. */
export function checkAnswer(dir: string, rawAnswer: string, opts: CheckOptions = {}): CheckReport | { error: string } {
  const store = EvidenceStore.load(dir);
  if (!store) return { error: `${dir} holds no evidence.json — run \`ultrastock analyze\`, \`quote\` or \`history\` with --out ${dir} first` };
  const answer = normalizeEvidenceCitations(rawAnswer);
  const lines = answer.split(/\r?\n/);
  const lineOf = lineFinder(lines);
  const unitOpts = { exclude: closingSourcesMask };
  const problems: CheckProblem[] = [];
  const cited = new Set<string>();
  const now = (opts.now ?? new Date()).getTime();
  let claims = 0;
  let figures = 0;
  const staleReported = new Set<string>();

  for (const unit of extractClaimUnits(answer, unitOpts)) {
    for (const text of unitTexts(unit)) {
      const tokens = citationTokensIn(text, isEvidenceCitation);
      const figs = extractFigures(text);
      const line = lineOf(text);
      if (!figs.length && !tokens.length) {
        if (words(text) >= 12)
          problems.push({ line, kind: "unsourced", message: `a claim with no evidence cited — fine for reasoning, not for a fact: "${quote(text)}"` });
        continue;
      }
      claims++;
      figures += figs.length;
      for (const t of tokens) cited.add(t);
      const known: EvidenceItem[] = [];
      for (const t of tokens) {
        const item = store.get(t);
        if (!item) problems.push({ line, kind: "dangling", message: `[${t}] is not in this run's evidence (it holds E1…E${store.items.length})` });
        else {
          known.push(item);
          if (opts.maxAgeMs !== undefined && !staleReported.has(t) && now - Date.parse(item.fetchedAt) > opts.maxAgeMs) {
            staleReported.add(t);
            problems.push({
              line,
              kind: "stale",
              message: `[${t}] ${item.label} was read ${item.fetchedAt.slice(0, 16).replace("T", " ")} — older than --max-age; refresh the run`,
            });
          }
        }
      }
      if (figs.length && !tokens.length) {
        problems.push({ line, kind: "uncited", message: `${figs.map((f) => f.raw).join(", ")} stated without an [E#] — "${quote(text)}"` });
        continue;
      }
      for (const f of figs) {
        if (!figureMatches(f, known)) {
          problems.push({
            line,
            kind: "unsupported",
            message: `${f.raw} is in none of ${tokens.map((t) => `[${t}]`).join(" ")} — cite the evidence that holds it, or compute it with \`ultrastock calc\``,
          });
        }
      }
    }
  }
  if (!claims) problems.push({ kind: "empty", message: "the answer states no figure and cites no evidence — nothing to check" });
  const { inertOnly } = collectCitations(answer, isEvidenceCitation, unitOpts);
  for (const tok of inertOnly)
    problems.push({ kind: "inert", message: `[${tok}] appears only in code or in a closing sources list, where it grounds no claim` });
  problems.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
  return { claims, figures, citations: cited.size, evidence: store.items.length, problems };
}
