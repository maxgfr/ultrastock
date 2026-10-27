// What to look for on the web about a subject — the worklist the host agent
// searches with its own web search, one angle per query, in French and in
// English. ultrastock never searches here: it writes the angles down
// (RESEARCH.todo.json), the agent runs them, and `research --web-results`
// reads back what it found.
//
// The angles follow the subject's kind: a listed company (business model,
// results, governance, controversies, short-sellers…), an ETF (factsheet and
// KID, holdings, replication, PEA, tracking difference), a crypto-asset
// (tokenomics, incidents, regulation) or a company with no listing, whose
// figures exist only in what it publishes and what the press reports.
// `--focus results` narrows to the latest publication; `--ask` turns one
// precise question into its own angles.
import { rankedKeywords } from "../engine.js";

export const RESEARCH_KINDS = ["equity", "etf", "crypto", "company"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];
export const RESEARCH_FOCUSES = ["general", "results"] as const;
export type ResearchFocus = (typeof RESEARCH_FOCUSES)[number];

export interface ResearchAngle {
  /** Stable id: "business-model", "results-release"… */
  id: string;
  title: string;
  /** One query per language: French first, then English. */
  queries: string[];
  /** Each query's language when the queries are not the French-then-English pair (a second round's rephrasings). */
  langs?: Array<string | null>;
}

export interface ResearchSubject {
  /** What the user named: a symbol, an ISIN or a company name. */
  subject: string;
  /** The name to search with: "LVMH", "Amundi MSCI World Swap UCITS ETF", "Anthropic". */
  name: string;
  symbol?: string;
  kind: ResearchKind;
  focus: ResearchFocus;
  /** One precise question, when the research answers it rather than surveys the subject. */
  ask?: string;
  /** The year the "latest" queries ask about. */
  year: number;
}

type Template = [id: string, title: string, fr: string, en: string];

const EQUITY: Template[] = [
  ["business-model", "Business model and moat", "{n} modèle économique avantage concurrentiel", "{n} business model competitive moat"],
  ["results-guidance", "Results and guidance", "{n} résultats {y} perspectives guidance", "{n} {y} results guidance outlook"],
  ["management", "Management", "{n} direction PDG gouvernance changement dirigeants", "{n} CEO management team track record"],
  [
    "capital-allocation",
    "Governance and capital allocation",
    "{n} allocation du capital rachat d'actions dividende acquisitions",
    "{n} capital allocation buybacks dividend acquisitions",
  ],
  ["risks", "Risks", "{n} risques principaux facteurs de risque", "{n} key risks risk factors"],
  ["litigation", "Litigation and controversies", "{n} litige enquête amende controverse", "{n} lawsuit investigation fine controversy"],
  ["short-sellers", "Short-sellers", "{n} vendeur à découvert rapport short", "{n} short seller report allegations"],
  ["sector", "Sector outlook", "{n} secteur perspectives concurrence part de marché", "{n} industry outlook competition market share"],
  ["analysts", "Analysts' views", "{n} analystes objectif de cours recommandation", "{n} analyst price target rating upgrade downgrade"],
];

const ETF: Template[] = [
  ["factsheet-kid", "Factsheet and KID", "{n} fiche produit DIC KID frais", "{n} factsheet KID fees"],
  ["holdings", "Holdings", "{n} composition principales lignes", "{n} holdings top constituents"],
  ["replication", "Replication", "{n} réplication physique synthétique swap", "{n} replication method physical synthetic swap"],
  ["pea", "PEA eligibility", "{n} éligible PEA", "{n} PEA eligible"],
  ["tracking", "Tracking difference", "{n} tracking difference écart de suivi", "{n} tracking difference tracking error"],
  ["distributions", "Distributions", "{n} distribution dividende capitalisation", "{n} distribution policy accumulating distributing"],
];

const CRYPTO: Template[] = [
  ["tokenomics", "Tokenomics and unlocks", "{n} tokenomics offre déblocage tokens", "{n} tokenomics supply token unlock schedule"],
  ["incidents", "Incidents", "{n} piratage faille incident", "{n} hack exploit incident"],
  ["regulation", "Regulation", "{n} réglementation MiCA SEC", "{n} regulation MiCA SEC"],
];

// A company with no listing: no exchange, no filing — what it says and what the press reports.
const COMPANY: Template[] = [
  ["business-model", "Business model", "{n} modèle économique produits clients", "{n} business model products customers"],
  ["revenue", "Revenue and growth", "{n} chiffre d'affaires {y} croissance", "{n} revenue {y} run-rate growth"],
  ["funding", "Funding and valuation", "{n} levée de fonds valorisation {y}", "{n} funding round valuation {y}"],
  ["management", "Leadership", "{n} dirigeants fondateurs", "{n} founders leadership executives"],
  ["competition", "Competition", "{n} concurrents part de marché", "{n} competitors market share"],
  ["risks", "Risks and controversies", "{n} risques controverse litige", "{n} risks controversy lawsuit"],
];

// The latest publication, whatever the kind: the release, the deck, the filing, the call.
const RESULTS: Template[] = [
  [
    "results-latest",
    "The latest publication",
    "{n} dernière publication chiffre d'affaires trimestriel {y}",
    "{n} latest quarterly results trading update {y}",
  ],
  ["results-release", "Results release", "{n} communiqué résultats {y}", "{n} {y} results press release"],
  ["results-presentation", "Results presentation", "{n} présentation investisseurs résultats {y} pdf", "{n} {y} investor presentation earnings slides pdf"],
  ["results-filing", "The filing itself", "{n} rapport financier {y} document d'enregistrement universel pdf", "{n} {y} annual report 10-K 10-Q filing pdf"],
  ["results-call", "Earnings call", "{n} conférence résultats {y} transcription", "{n} {y} earnings call transcript"],
  ["results-guidance", "Guidance", "{n} prévisions {y} objectifs relevés abaissés", "{n} {y} guidance raised lowered outlook"],
  ["results-segments", "Segments", "{n} résultats par division segment {y}", "{n} {y} segment results by division"],
  ["results-reaction", "Market and analysts' reaction", "{n} résultats {y} réaction marché analystes", "{n} {y} earnings reaction analysts"],
];

// A private company publishes no filing: its own reports and the press stand in.
const COMPANY_RESULTS: Template[] = [
  ["results-release", "What it published", "{n} rapport {y} annonce chiffres", "{n} {y} report announcement figures"],
  ["results-revenue", "Revenue reported", "{n} chiffre d'affaires annualisé {y}", "{n} {y} annualized revenue run-rate reported"],
  ["results-funding", "Funding and valuation", "{n} levée {y} valorisation", "{n} {y} funding valuation"],
  ["results-press", "Press coverage", "{n} {y} résultats selon la presse", "{n} {y} financials according to reports"],
];

const fill = (t: string, s: ResearchSubject) => t.replace(/\{n\}/g, s.name).replace(/\{y\}/g, String(s.year)).replace(/\s+/g, " ").trim();
const angle = ([id, title, fr, en]: Template, s: ResearchSubject): ResearchAngle => ({ id, title, queries: [fill(fr, s), fill(en, s)] });

/** The angles a subject is searched along, in the order the dossier presents them. */
export function researchAngles(s: ResearchSubject): ResearchAngle[] {
  if (s.ask) {
    // The question's own words, minus the name's: the name already leads every query.
    const fold = (w: string) => w.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    const named = new Set(
      s.name
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .map(fold),
    );
    const terms = rankedKeywords(s.ask)
      .filter((t) => !named.has(fold(t)))
      .slice(0, 6)
      .join(" ");
    const out: ResearchAngle[] = [{ id: "ask", title: "The question", queries: [s.ask] }];
    if (terms && terms.toLowerCase() !== s.ask.toLowerCase())
      out.push({ id: "ask-terms", title: "The question's key terms", queries: [`${s.name} ${terms}`.replace(/\s+/g, " ").trim()] });
    out.push({
      id: "ask-primary",
      title: "Primary sources on it",
      queries: [`${s.name} ${terms || s.ask} communiqué rapport pdf`.trim(), `${s.name} ${terms || s.ask} official report pdf`.trim()],
    });
    return out;
  }
  if (s.focus === "results") return (s.kind === "company" ? COMPANY_RESULTS : RESULTS).map((t) => angle(t, s));
  const table = s.kind === "etf" ? ETF : s.kind === "crypto" ? CRYPTO : s.kind === "company" ? COMPANY : EQUITY;
  return table.map((t) => angle(t, s));
}

// ── The second round ───────────────────────────────────────────────────────
// An angle whose search kept fewer than MIN_ANGLE_SOURCES sources is
// under-covered. Its second round searches the angle's OWN queries again,
// rephrased the way a researcher would: "pdf" for a document (results, filing,
// factsheet), restricted to the issuer's official site when a page of it was
// kept, and the English query alone with the exact name quoted. Generic words
// of the templates ("call", "transcription", "universel") are never searched
// on their own: they name no topic.

/** Sources an angle needs before its search counts as covered. */
export const MIN_ANGLE_SOURCES = 2;

/** At most this many under-covered angles get a second round, and this many queries each. */
const MAX_FOLLOW_UPS = 6;
const MAX_REPHRASINGS = 3;

/** The id of an angle's second round, and back. */
export const followUpId = (angleId: string) => `more-${angleId}`;
export const followedAngle = (id: string) => (id.startsWith("more-") ? id.slice(5) : undefined);

/** Angles after a document — a release, a filing, a deck, a factsheet: their second round asks for the PDF. */
const DOCUMENT_ANGLE = /^(?:results-(?:latest|release|presentation|filing|call|guidance|segments|revenue)|factsheet-kid|holdings|tracking|ask-primary)$/;

export interface UnderCoveredAngle {
  angle: ResearchAngle;
  /** Sources the angle kept (its own and its second round's). */
  sources: number;
}

/** The angle's English query: the second of a French-then-English pair, else its only one. */
const englishQuery = (a: ResearchAngle) => (a.queries.length === 2 && !a.langs ? a.queries[1]! : a.queries[a.queries.length - 1]!);

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A query without the subject's name (a `site:` query names the issuer by its domain already). */
function withoutName(q: string, name: string): string {
  return q
    .replace(new RegExp(escapeRe(name), "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Second-round angles for the under-covered ones: each angle's own queries,
 * rephrased — with "pdf" for a document angle, `site:<issuer domain>` when one
 * of the issuer's pages was kept, and the English query with the name quoted.
 * A rephrasing already searched (any query of `todo`) is not asked again.
 */
export function followUpAngles(
  s: ResearchSubject,
  under: readonly UnderCoveredAngle[],
  opts: { issuerDomain?: string; asked?: ReadonlySet<string> } = {},
): ResearchAngle[] {
  const asked = new Set([...(opts.asked ?? [])].map((q) => q.toLowerCase()));
  const out: ResearchAngle[] = [];
  for (const { angle: a } of under) {
    if (out.length >= MAX_FOLLOW_UPS) break;
    if (followedAngle(a.id) || a.id.startsWith("gap-")) continue;
    const qs: Array<{ q: string; lang: string | null }> = [];
    const add = (q: string, lang: string | null) => {
      const t = q.replace(/\s+/g, " ").trim();
      if (t && !asked.has(t.toLowerCase()) && !qs.some((x) => x.q.toLowerCase() === t.toLowerCase())) qs.push({ q: t, lang });
    };
    const en = englishQuery(a);
    const pair = a.queries.length === 2 && !a.langs;
    if (DOCUMENT_ANGLE.test(a.id))
      a.queries.forEach((q, i) => {
        if (!/\bpdf\b/i.test(q)) add(`${q} pdf`, pair ? (i === 0 ? "fr-FR" : "en-US") : null);
      });
    if (opts.issuerDomain) add(`${withoutName(en, s.name) || s.name} site:${opts.issuerDomain}`, pair ? "en-US" : null);
    // The English query alone, the name quoted: an exact-name search, in the language most filings are in.
    if (!en.includes('"') && en.toLowerCase().includes(s.name.toLowerCase()))
      add(en.replace(new RegExp(escapeRe(s.name), "i"), `"${s.name}"`), pair ? "en-US" : null);
    const picked = qs.slice(0, MAX_REPHRASINGS);
    if (!picked.length) continue;
    out.push({ id: followUpId(a.id), title: `More on: ${a.title}`, queries: picked.map((x) => x.q), langs: picked.map((x) => x.lang) });
  }
  return out;
}
