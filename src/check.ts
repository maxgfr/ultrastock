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
//
// A cited [E#] can be a document — a web page or a filing compiled by
// `research`. Its text is read from the run and passed through the same figure
// reader as the answer: a figure the claim states must be in the document as
// written ("4,2 Md€" against "4.2 billion"), and a figure the document holds
// only far from the claim's words is noted as distant.
//
// A calendar date in a claim that cites evidence is held to it the same way:
// it must be a date one of the cited items holds (its value, label, key or
// as-of day) or that a cited document writes — in any usual form, so "le 17
// novembre" stands for 2026-11-17. A results date copied wrong is refused.
import { bm25Tokenize, citationTokensIn, collectCitations, EVIDENCE_TOKEN, extractClaimUnits, unitTexts } from "./engine.js";
import { datesIn, extractDates, holdsDate, type WrittenDate } from "./core/dates.js";
import { type EvidenceItem, EvidenceStore, readDocText } from "./core/evidence.js";

export interface CheckProblem {
  line?: number;
  /** `inert`, `unsourced` and `distant` are notes: they do not fail the check. */
  kind: "empty" | "uncited" | "dangling" | "unsupported" | "stale" | "inert" | "unsourced" | "distant";
  message: string;
}

export interface CheckReport {
  claims: number;
  figures: number;
  citations: number;
  evidence: number;
  problems: CheckProblem[];
}

export const NOTE_KINDS: ReadonlySet<CheckProblem["kind"]> = new Set(["inert", "unsourced", "distant"]);

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

/** A document's figures as evidence-shaped values, so `figureMatches` reads them like any other. */
export function documentFigures(doc: EvidenceItem, text: string): EvidenceItem[] {
  return extractFigures(text).map((f) => ({ ...doc, value: f.value, unit: f.percent ? "%" : undefined, doc: undefined }));
}

/** Lines either side of a line sharing a word with the claim that still count as near it. */
const NEAR_LINES = 3;

/**
 * The lines of a document near the WORDS of a claim — where its figure should
 * sit: every line within NEAR_LINES of a line that shares a word with the
 * claim. The claim's own figures and citations are taken out first (their
 * digits would make every line holding the figure "near"). When no line shares
 * a word — an English page under a French claim — the whole text is returned:
 * nearness cannot be judged, so no note is raised.
 */
function nearClaim(text: string, claim: string): string {
  const words = claim.replace(/\[[^\]]*\]/g, " ").replace(/[+\-−–]?[$€£]?\d[\d\s.,'  ]*%?/g, " ");
  const terms = new Set(bm25Tokenize(words).filter((t) => t.length > 2 && !/^\d+$/.test(t)));
  const lines = text.split("\n");
  const hits = lines.map((l) => bm25Tokenize(l).some((t) => terms.has(t)));
  if (!hits.some(Boolean)) return text;
  return lines.filter((_, i) => hits.slice(Math.max(0, i - NEAR_LINES), i + NEAR_LINES + 1).some(Boolean)).join("\n");
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

/** A written date after `today` (YYYY-MM-DD); one without its year is not judged. */
const isAhead = (d: WrittenDate, today: string) =>
  d.year !== undefined && d.readings.every(([m, day]) => `${d.year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}` > today);

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
  const today = new Date(now).toISOString().slice(0, 10);
  let claims = 0;
  let figures = 0;
  const staleReported = new Set<string>();
  // Each cited document is read once: its text and its figures.
  const docs = new Map<string, { text: string; figures: EvidenceItem[]; dates?: Set<string> } | null>();
  const docOf = (item: EvidenceItem) => {
    if (!docs.has(item.id)) {
      const text = readDocText(dir, item);
      docs.set(item.id, text === undefined ? null : { text, figures: documentFigures(item, text) });
    }
    return docs.get(item.id) ?? undefined;
  };
  // The dates an item holds: a data point's value, label, key and days; a document's text.
  const itemDates = new Map<string, Set<string>>();
  const datesOf = (item: EvidenceItem): Set<string> => {
    if (item.doc) {
      const d = docOf(item);
      if (!d) return new Set();
      d.dates ??= datesIn(d.text);
      return d.dates;
    }
    if (!itemDates.has(item.id))
      itemDates.set(item.id, datesIn([String(item.value), item.label, item.key, item.asOf ?? "", item.fetchedAt.slice(0, 10)].join(" ")));
    return itemDates.get(item.id)!;
  };

  for (const unit of extractClaimUnits(answer, unitOpts)) {
    for (const text of unitTexts(unit)) {
      const tokens = citationTokensIn(text, isEvidenceCitation);
      const figs = extractFigures(text);
      const dates = extractDates(text.replace(/`[^`]*`/g, " ").replace(/\[[^\]]*\]/g, " "));
      const line = lineOf(text);
      if (!figs.length && !tokens.length) {
        // A date ahead is one the user acts on (results, a decision): it needs its [E#]. A past one is context (an as-of day).
        const ahead = dates.filter((d) => isAhead(d, today));
        if (ahead.length) {
          claims++;
          problems.push({
            line,
            kind: "uncited",
            message: `${ahead.map((d) => d.raw).join(", ")} stated without an [E#] — a date ahead cites the evidence that holds it: "${quote(text)}"`,
          });
        } else if (words(text) >= 12)
          problems.push({ line, kind: "unsourced", message: `a claim with no evidence cited — fine for reasoning, not for a fact: "${quote(text)}"` });
        continue;
      }
      claims++;
      figures += figs.length;
      for (const t of tokens) cited.add(t);
      const known: EvidenceItem[] = [];
      const citedDocs: EvidenceItem[] = [];
      for (const t of tokens) {
        const item = store.get(t);
        if (!item) problems.push({ line, kind: "dangling", message: `[${t}] is not in this run's evidence (it holds E1…E${store.items.length})` });
        else if (item.doc && !docOf(item))
          problems.push({
            line,
            kind: "dangling",
            message: `[${t}] is a document whose text (${item.doc.path}) is missing from the run — re-run \`ultrastock research\``,
          });
        else {
          if (item.doc) citedDocs.push(item);
          else known.push(item);
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
      const cites = [...known, ...citedDocs];
      if (cites.length)
        for (const d of dates) {
          if (cites.some((it) => holdsDate(datesOf(it), d))) continue;
          problems.push({
            line,
            kind: "unsupported",
            message: `the date ${d.raw} is in none of ${cites.map((c) => `[${c.id}]`).join(" ")} — cite the evidence that holds it (any usual form is read: 2026-11-17, 17/11/2026, 17 novembre 2026)`,
          });
        }
      for (const f of figs) {
        if (figureMatches(f, known)) continue;
        const holder = citedDocs.find((d) => figureMatches(f, docOf(d)!.figures));
        if (holder) {
          const doc = docOf(holder)!;
          if (!figureMatches(f, documentFigures(holder, nearClaim(doc.text, text))))
            problems.push({
              line,
              kind: "distant",
              message: `${f.raw} is in [${holder.id}] but far from the words of the claim — check it is the figure the claim means: "${quote(text)}"`,
            });
          continue;
        }
        if (citedDocs.length) {
          const where = citedDocs.map((d) => `[${d.id}]${d.url ? ` (${d.url})` : ""}`).join(" ");
          problems.push({
            line,
            kind: "unsupported",
            message: `${f.raw} is not in the document${citedDocs.length > 1 ? "s" : ""} ${where}${known.length ? ` nor in ${known.map((k) => `[${k.id}]`).join(" ")}` : ""} — state the figure as the source writes it, or cite the evidence that holds it`,
          });
          continue;
        }
        problems.push({
          line,
          kind: "unsupported",
          message: `${f.raw} is in none of ${tokens.map((t) => `[${t}]`).join(" ")} — cite the evidence that holds it, or compute it with \`ultrastock calc\``,
        });
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
