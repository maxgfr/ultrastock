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
    const terms = rankedKeywords(s.ask).slice(0, 6).join(" ");
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

/** Second-round queries for the terms the first round's sources barely mention. */
export function followUpAngles(s: ResearchSubject, underCoveredTerms: readonly string[]): ResearchAngle[] {
  return underCoveredTerms.slice(0, 6).map((term) => ({ id: `gap-${term}`, title: `Under-covered: ${term}`, queries: [`${s.name} ${term}`] }));
}
