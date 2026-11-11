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
import { dateSpans, datesIn, extractDates, holdsDate, type WrittenDate } from "./core/dates.js";
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

/**
 * A "[" still open when the next "[" opens is not a bracket: it is blanked, so
 * "[see [E1]" cites E1 and a line of 50 000 "[" is one pass, not one scan to
 * the end of the line per "[" (here and in the engine's citation reader).
 */
export function unnestBrackets(text: string): string {
  const chars = text.split("");
  let open = -1;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "[") {
      if (open >= 0) chars[open] = " ";
      open = i;
    } else if (c === "]" || c === "\n") open = -1;
  }
  return chars.join("");
}

/**
 * Citation tokens ([E3]), footnote markers ([^3], and a number glued to its
 * word: "revenue[12]") and link targets out; a link's text and a bracketed
 * phrase stay — "target [450]" and "on [2026-12-01]" are claims like any
 * other. No pattern spans a "[" or a "(", so each runs in one pass.
 */
const unbracket = (text: string): string =>
  unnestBrackets(text)
    .replace(/!?\[([^[\]]*)\]\([^()]*\)/g, " $1 ")
    .replace(/(?<=[\p{L}\p{N}.,;:)\]])\[\d{1,3}\]/gu, " ")
    .replace(/\[(?:E\d+|\^[^\s[\]]+)\]/g, " ")
    .replace(/\[([^[\]]*)\]/g, " $1 ");

/** Moving averages and the periods they are set to: "SMA 200" is a setting, "SMA 412" a level. */
const AVERAGE_NAMES = "SMA|EMA|WMA|HMA|MA|MM|DMA";
const AVERAGE_PERIODS = "5|7|8|9|10|12|13|20|21|26|30|34|40|50|55|60|89|100|120|144|150|200|250";
/** Index names with the number that is part of the name — a fixed list, so "the Nasdaq 21000 level" is a figure. */
const INDEX_NAMES = [
  "S&P\\s?(?:100|400|500|600|1500)",
  "\\b(?:Euro\\s?)?(?:STOXX|Stoxx|stoxx)\\s?(?:50|600)",
  "\\bCAC\\s?(?:40|Next\\s?20|Mid\\s?60|Mid\\s?&\\s?Small|Small)",
  "\\bSBF\\s?(?:120|250)",
  "\\b(?:Nasdaq|NASDAQ)[-\\s]?100",
  "\\bRussell\\s?(?:1000|2000|3000)",
  "\\b(?:Tec)?DAX\\s?(?:30|40)",
  "\\bMDAX\\s?50",
  "\\bSDAX\\s?70",
  "\\bFTSE\\s?(?:100|250|350|MIB(?:\\s?40)?)",
  "\\bAEX\\s?25",
  "\\bBEL\\s?20",
  "\\bIBEX\\s?35",
  "\\bPSI\\s?20",
  "\\bOBX\\s?25",
  "\\bOMXS\\s?30",
  "\\bISEQ\\s?20",
  "\\bSMI\\s?20",
  "\\bNikkei\\s?225",
  "\\bKOSPI\\s?200",
  "\\bASX\\s?200",
  "\\bTSX\\s?60",
  "\\bNifty\\s?50",
  "\\bSensex\\s?30",
  "\\bDow\\s?Jones\\s?30",
  "\\b[Tt]op\\s?\\d{1,3}",
].join("|");
/** What a label's number is not followed by: a decimal or a unit would make it a value. */
const NOT_A_VALUE = "(?![\\p{N}]|[.,]\\d|\\s?(?:%|[$€£]|pts?\\b|bps\\b))";

const INDICATOR_NAMES = "SMA|EMA|WMA|HMA|MA|MM|RSI|ATR|ADX|MACD|BB|ROC|CCI|MFI|DMA|VWAP|OBV|Stoch|Stochastic|Bollinger|Ichimoku|Supertrend";

/** Named entities a page or a model writes around figures; any numeric one is decoded too. */
const ENTITIES: Record<string, string> = {
  nbsp: " ",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  euro: "€",
  pound: "£",
  dollar: "$",
  percnt: "%",
  minus: "−",
  ndash: "–",
  mdash: "—",
  times: "×",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
};
/** A vulgar fraction after its whole part: "4½" is 4.5. */
const VULGAR: Record<string, string> = {
  "¼": ".25",
  "½": ".5",
  "¾": ".75",
  "⅛": ".125",
  "⅜": ".375",
  "⅝": ".625",
  "⅞": ".875",
  "⅓": ".33",
  "⅔": ".67",
  "⅕": ".2",
  "⅖": ".4",
  "⅗": ".6",
  "⅘": ".8",
  "⅙": ".17",
  "⅚": ".83",
};
const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);
const isDigit = (c: string) => /\d/.test(c);
const isLetter = (c: string) => /\p{L}/u.test(c);

/**
 * The text a reader sees: entities decoded ("&#x34;&#x35; %"), a vulgar
 * fraction as a decimal ("4½"), a superscript after a word or a figure taken
 * as the footnote mark it is ("84.7 bn²"), every other code point folded by
 * NFKC (full-width "４５ %", superscript "⁴⁵ %"), and emphasis markers out
 * ("_450_", "4**5** %") — a figure in markup is still a figure.
 */
export function plainText(text: string): string {
  return text
    .replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]\w{1,7}));/g, (m, dec?: string, hex?: string, name?: string) => {
      const cp = dec !== undefined ? Number(dec) : hex !== undefined ? Number.parseInt(hex, 16) : undefined;
      if (cp !== undefined) return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      return ENTITIES[name!] ?? m;
    })
    .replace(/(?<=[\p{L}\p{Nd}%$€£)\]])[⁰¹²³⁴-⁹]+/gu, " ")
    .replace(/(\d?)([¼½¾⅓-⅞])/gu, (m, whole: string, f: string) => (VULGAR[f] ? `${whole || "0"}${VULGAR[f]}` : m))
    .normalize("NFKC")
    .replace(/\*+|~~|_+/g, (m, at: number, s: string) => {
      const [a, b] = [s[at - 1] ?? " ", s[at + m.length] ?? " "];
      // An underscore inside a name ("t_close", "note_1") is part of it; between two digits it is emphasis ("4_5_ %").
      if (m[0] === "_" && isWordChar(a) && isWordChar(b) && !(isDigit(a) && isDigit(b))) return m;
      // Between a word and a figure a marker parts them: "up**45 %**" is "up 45 %", not "up45".
      return (isLetter(a) && isDigit(b)) || (isDigit(a) && isLetter(b)) ? " " : "";
    });
}

/**
 * A date the date reader accepts is no figure: "17 novembre", "Oct 23, 2026", "17.11.26". Only a valid one: "85 may
 * fall", "In May 45 %" and "en mars 12 % du CA" keep their figure.
 */
function blankDates(text: string): string {
  let out = "";
  let from = 0;
  for (const [at, end] of dateSpans(text)) {
    out += `${text.slice(from, at)} `;
    from = end;
  }
  return out + text.slice(from);
}

/** What is not a figure: dates, times, citation tokens, inline code, link targets, labels. */
function stripNonFigures(text: string): string {
  return (
    blankDates(
      unbracket(plainText(text.replace(/`[^`]*`/g, " ")))
        .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, " ")
        .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " "),
    )
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
      // A chart timeframe before an indicator is its label: the 15m RSI, the 4h MACD — not 15 million.
      .replace(new RegExp(`\\b\\d{1,2}[mhdwM]\\s?(?=(?:${INDICATOR_NAMES})(?![A-Za-z]))`, "gi"), " ")
      // Indicator settings and index names are labels, not claims: RSI(14), MACD(12,26,9), SMA 200, MM50, CAC 40, S&P 500.
      // Only their settings form is: "RSI 85", "ADX 45", "SMA 412" and "the Nasdaq 21000 level" state a value.
      .replace(/\b[A-Za-z]{2,}\(\s*\d+(?:[.,]\d+)?(?:\s*,\s*\d+(?:[.,]\d+)?)*\s*\)/g, " ")
      .replace(new RegExp(`\\b(?:${AVERAGE_NAMES})\\s?(?:${AVERAGE_PERIODS})\\b${NOT_A_VALUE}`, "giu"), " ")
      .replace(new RegExp(`(?:${INDEX_NAMES})${NOT_A_VALUE}`, "gu"), " ")
      // A filing form names a document: the 10-K, a 6-K, the 20-F/A.
      .replace(/(?<![\p{L}\p{N}])(?:10-[KQ]|20-F|40-F|8-K|6-K)(?:\/A|405|T)?(?![\p{L}\p{N}])/giu, " ")
      // So is a week number ("Week 46", "semaine 46") and an allocation split summing to 100 ("60/40", "70/20/10").
      .replace(/\b(?:weeks?|wk|semaines?|sem\.)\s?\d{1,2}\b(?![.,]\d|\s?[%$€£])/gi, " ")
      .replace(/(?<![\p{N}.,/])\d{1,3}(?:\/\d{1,3})+(?![\p{N}/]|[.,]\d)/gu, (m) => (m.split("/").reduce((a, b) => a + Number(b), 0) === 100 ? " " : m))
  );
}

// A thousands group is exactly three digits: "0.775886" and "5,8741" are decimals, not "0.775" or "5,874" cut short.
const FIGURE_RE =
  /(?<![\p{L}\p{N}_.,])([+\-−–]?)\s?([$€£]\s?)?(\d{1,3}(?:[ ,.  ']\d{3})+(?!\d)(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s?(?:%|pts?|bps|x|×)|\s?(?:k|K|M|m|mn|Mn|mio|Md|Mds|md|mds|bn|Bn|B|T|tn|million|millions|milliard|milliards|billion|billions|trillion|trillions|mille|pc|pct|percent|per\s?cent|pour\s?cent)\b)?(\s?(?:[$€£]|EUR|USD|USDT|USDC|GBP|CHF|NOK|BTC|ETH)\b|\s?[$€£])?/gu;
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
    const percent = /^(?:%|pts?|pc|pct|percent|per\s?cent|pour\s?cent)$/.test(suffix);
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

/**
 * The units a fraction is stored under — none, or a ratio or multiple ("ratio",
 * "x"): only these can be written as a percentage. A price, a count or an index
 * of 0.45 is not 45 %.
 */
const FRACTION_UNITS: ReadonlySet<string | undefined> = new Set([undefined, "", "ratio", "x"]);

/**
 * Is the written figure one of the values these evidence items hold?
 *
 * Magnitudes are compared: prose carries the direction in words ("fell 12.3 %"
 * for −12.3). With `signed`, a minus sign written on the number itself is a
 * claim about the direction too, and "−12.3 %" is refused against +12.3. A
 * dash set apart by a space is punctuation, and a document says its direction
 * in words, so neither is held to it.
 */
export function figureMatches(f: Figure, items: readonly EvidenceItem[], opts: { signed?: boolean } = {}): boolean {
  const tol = 0.5 * 10 ** -f.decimals * f.scale;
  const writtenNegative = !!opts.signed && /^[-−](?:[$€£]\s?)?\d/.test(f.raw);
  for (const it of items) {
    if (typeof it.value !== "number") continue;
    const candidates = [it.value];
    // A fraction stored as a ratio can be written as a percentage, and back.
    if (f.percent && FRACTION_UNITS.has(it.unit)) candidates.push(it.value * 100);
    if (!f.percent && it.unit === "%") candidates.push(it.value / 100);
    for (const v of candidates) {
      const a = Math.abs(Math.abs(v) - Math.abs(f.value));
      const near = a <= tol + 1e-9 * Math.max(1, Math.abs(v)) || (Math.abs(v) > 0 && a / Math.abs(v) <= 0.001);
      if (!near) continue;
      // A positive value that rounds to the zero written ("-0.0 %") contradicts nothing.
      if (writtenNegative && v > tol) continue;
      return true;
    }
  }
  return false;
}

/** A document's figures as evidence-shaped values, so `figureMatches` reads them like any other. */
export function documentFigures(doc: EvidenceItem, text: string): EvidenceItem[] {
  return extractFigures(text).map((f) => ({ ...doc, value: f.value, unit: f.percent ? "%" : undefined, doc: undefined }));
}

/** A cited document as `check` reads it once: its text, its figures, and what is derived from them on demand. */
interface CitedDoc {
  text: string;
  figures: EvidenceItem[];
  dates?: Set<string>;
  /** The tokens of each line, for `nearClaim`. */
  lineTokens?: string[][];
  /** The figures near the words of each claim that found one of its figures here. */
  near?: Map<string, EvidenceItem[]>;
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
function nearClaim(doc: CitedDoc, claim: string): string {
  const words = claim.replace(/\[[^[\]]*\]/g, " ").replace(/[+\-−–]?[$€£]?\d[\d\s.,'  ]*%?/g, " ");
  const terms = new Set(bm25Tokenize(words).filter((t) => t.length > 2 && !/^\d+$/.test(t)));
  const { text } = doc;
  const lines = text.split("\n");
  // A document is tokenised once per check, not once per figure a claim finds in it.
  doc.lineTokens ??= lines.map((l) => bm25Tokenize(l));
  const hits = doc.lineTokens.map((toks) => toks.some((t) => terms.has(t)));
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

/**
 * A horizon or a period heading a column or a section labels it: "1M", "3M",
 * "12m", "1Y", "9M 2026", "H1 26", "Q3 '26". Only the glued form, and not
 * before a currency: "3 M€" and "12M €" there are still amounts. In prose, "12M
 * shares" is twelve million — this is for header cells and headings only.
 */
const PERIOD_LABEL = /(?<![\p{L}\p{N}.,])(?:\d{1,2}[MmYyWwDd](?![\p{L}\p{N}])(?!\s?(?:[$€£]|(?:EUR|USD|GBP|CHF)\b))|[HQST][1-4]\s?'?\d{2}(?![\p{N}.,]))/gu;
const withoutPeriodLabels = (text: string) => text.replace(PERIOD_LABEL, " ");

/**
 * A table's header row is read like any row, but its labels are blanked and
 * the rest of the row is checked (lines are kept one for one):
 * - whole numbers, where the row is plainly a row of labels — two or more of
 *   its cells are a whole number alone, a series of horizons or years (`+5`,
 *   `20`, `J+60`, `2026`). A key/value table's first row (`| Price target |
 *   450 |`) states a value;
 * - a horizon or a period label ("1M", "H1 26");
 * - the dates of a row that cites no [E#]: like a heading's, they label the
 *   columns (`| Metric | 2025-12-31 | 2026-12-31 |`).
 */
function withoutColumnLabels(answer: string): string {
  const separator = (l: string) => /\|/.test(l) && /^[\s:|-]+$/.test(l.trim()) && /-/.test(l);
  const wholeNumber = (c: string) => /^\s*(?:\p{L}?[+\-−–])?\d+\s*$/u.test(c);
  const lines = answer.split("\n");
  return lines
    .map((l, i) => {
      if (!(/\|/.test(l) && !separator(l) && separator(lines[i + 1] ?? ""))) return l;
      const cells = l.split("|");
      const labelRow = cells.filter(wholeNumber).length >= 2;
      const cites = /\[E\d+\]/.test(l);
      return cells.map((c) => (labelRow && wholeNumber(c) ? " " : withoutPeriodLabels(cites ? c : blankDates(c)))).join("|");
    })
    .join("\n");
}

/**
 * A heading's text; its section number ("1.", "2.3", "2.3.1", "10)") orders the
 * sections and is dropped, but "2.3 bn" or "12 %" opening it is a figure: the
 * number goes only when the figure reader reads it bare.
 */
function headingText(heading: string): string {
  const t = withoutPeriodLabels(heading.replace(/^#{1,6}\s+/, ""));
  const n = /^(\d+(?:\.\d+)+|\d+(?=[.)]))[.)]?\s/.exec(t);
  const first = n && extractFigures(t)[0];
  return n && (!first || n[1]!.startsWith(first.raw)) ? t.slice(n[0].length) : t;
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
  const answer = withoutColumnLabels(normalizeEvidenceCitations(unnestBrackets(rawAnswer)));
  const lines = answer.split(/\r?\n/);
  const lineOf = lineFinder(lines);
  // A table's header row states what it writes like any row ("| LVMH up 45 % |").
  const unitOpts = { exclude: closingSourcesMask, skipTableHeader: false };
  const problems: CheckProblem[] = [];
  const cited = new Set<string>();
  const now = (opts.now ?? new Date()).getTime();
  const today = new Date(now).toISOString().slice(0, 10);
  let claims = 0;
  let figures = 0;
  const staleReported = new Set<string>();
  // Each cited document is read once: its text and its figures.
  const docs = new Map<string, CitedDoc | null>();
  const docOf = (item: EvidenceItem) => {
    if (!docs.has(item.id)) {
      const text = readDocText(dir, item);
      docs.set(item.id, text === undefined ? null : { text, figures: documentFigures(item, text) });
    }
    return docs.get(item.id) ?? undefined;
  };
  // The dates an item holds: a data point's value, label, key and as-of day; a document's text. The day it was read
  // (fetchedAt) is not one: a close as of the 22nd fetched on the 23rd says nothing about the 23rd.
  const itemDates = new Map<string, Set<string>>();
  const datesOf = (item: EvidenceItem): Set<string> => {
    if (item.doc) {
      const d = docOf(item);
      if (!d) return new Set();
      d.dates ??= datesIn(d.text);
      return d.dates;
    }
    if (!itemDates.has(item.id)) itemDates.set(item.id, datesIn([String(item.value), item.label, item.key, item.asOf ?? ""].join(" ")));
    return itemDates.get(item.id)!;
  };

  // A heading states what it writes too ("## Buy, target 450 €"). The engine sets headings aside as structure, so each is
  // collected as the engine meets it — outside code and the closing sources list — and tagged on the units beneath it,
  // which keeps the answer's order.
  const headings: string[] = [];
  const units: Array<{ texts: string[]; heading?: boolean }> = [];
  let nextHeading = 0;
  const headingsTo = (n: number) => {
    for (; nextHeading <= n; nextHeading++) units.push({ texts: [headingText(headings[nextHeading]!)], heading: true });
  };
  for (const unit of extractClaimUnits(answer, { ...unitOpts, sectionTag: (h) => String(headings.push(h) - 1) })) {
    headingsTo(unit.section === undefined ? -1 : Number(unit.section));
    units.push({ texts: unitTexts(unit) });
  }
  headingsTo(headings.length - 1);

  for (const { texts, heading } of units) {
    for (const text of texts) {
      const tokens = citationTokensIn(text, isEvidenceCitation);
      const figs = extractFigures(text);
      const dates = extractDates(unbracket(plainText(text.replace(/`[^`]*`/g, " "))));
      const line = lineOf(text);
      // A heading with no figure and no [E#] is a title: a date in it ("Brief — 12 novembre") labels the section.
      if (heading && !figs.length && !tokens.length) continue;
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
        if (!item)
          problems.push({
            line,
            kind: "dangling",
            message: `[${t}] is not in this run's evidence (it holds E1…${store.items[store.items.length - 1]?.id ?? "nothing"})`,
          });
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
        if (figureMatches(f, known, { signed: true })) continue;
        const holder = citedDocs.find((d) => figureMatches(f, docOf(d)!.figures));
        if (holder) {
          const doc = docOf(holder)!;
          doc.near ??= new Map();
          if (!doc.near.has(text)) doc.near.set(text, documentFigures(holder, nearClaim(doc, text)));
          if (!figureMatches(f, doc.near.get(text)!))
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
  // The engine's parse leaves headings out: an [E#] a heading cites grounds it.
  for (const tok of inertOnly.filter((t) => !cited.has(t)))
    problems.push({ kind: "inert", message: `[${tok}] appears only in code or in a closing sources list, where it grounds no claim` });
  problems.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
  return { claims, figures, citations: cited.size, evidence: store.items.length, problems };
}
