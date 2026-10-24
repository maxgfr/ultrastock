// AMF BDIF — French managers' transaction declarations ("déclarations des
// dirigeants", MAR article 19), published by the regulator (official) through
// the API behind bdif.amf-france.org (keyless, undocumented — it is what the
// site's own search calls):
//
//   search    /back/api/v1/informations?RechercheTexte=<name|ISIN>&TypesInformation=DD&From=0&Size=<n>
//             (or Jetons=<RS…> for an exact issuer id, as returned in `societes`)
//   document  /back/api/v1/documents/<path>   (the declaration, a generated PDF)
//
// The search answer carries only metadata; the declarant, the nature of the
// operation, the date, the price and the volume are in the PDF. Those PDFs are
// machine-generated from the AMF's form with a text layer, read here by the
// engine's PDF text extraction. Declarations reach the AMF within three
// business days of the trade. Names and free-text fields are external text.
import type { Dataset, Point } from "../../core/datasets.js";
import { parseLooseNumber } from "../../core/csv.js";
import { fetchJson } from "../../core/net.js";
import { pdfToText } from "../../engine.js";
import { ProviderError } from "../types.js";
import { fetchBinary } from "./binary.js";

export const AMF_SOURCE = "amf-bdif";
const BASE = "https://bdif.amf-france.org/back/api/v1";

export interface AmfDeclarationRef {
  numero: string;
  date: string;
  published: string;
  /** Issuer names as the AMF records them — external text. */
  issuers: string[];
  issuerIds: string[];
  pdfUrl?: string;
}

type BdifJson = {
  result?: Array<{
    numero?: string;
    dateInformation?: string;
    datePublication?: string;
    documents?: Array<{ path?: string; accessible?: boolean; nomFichier?: string }>;
    societes?: Array<{ jeton?: string; raisonSociale?: string }>;
  }>;
};

/** The search answer → declaration references (newest first). */
export function parseBdifSearch(json: BdifJson): AmfDeclarationRef[] {
  return (json.result ?? [])
    .flatMap((r) => {
      if (!r.numero) return [];
      const doc = r.documents?.find((d) => d.accessible !== false && d.path?.toLowerCase().endsWith(".pdf"));
      return [
        {
          numero: r.numero,
          date: (r.dateInformation ?? "").slice(0, 10),
          published: (r.datePublication ?? "").slice(0, 10),
          issuers: (r.societes ?? []).map((s) => s.raisonSociale ?? "").filter(Boolean),
          issuerIds: (r.societes ?? []).map((s) => s.jeton ?? "").filter(Boolean),
          ...(doc?.path ? { pdfUrl: `${BASE}/documents/${doc.path}` } : {}),
        },
      ];
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.numero.localeCompare(a.numero));
}

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
/** "22 juin 2026" → "2026-06-22". */
export function frenchDate(s: string | undefined): string | undefined {
  const m = /(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})/i.exec(s ?? "");
  const month = m ? MOIS.indexOf(m[2]!.toLowerCase().replace("fevrier", "février").replace("aout", "août").replace("decembre", "décembre")) : -1;
  return m && month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : undefined;
}

export type DdSide = "buy" | "sell" | "subscription" | "exercise" | "grant" | "pledge" | "other";

/** The operation's direction, from the declared nature (French or English form). */
export function classifyNature(nature: string): DdSide {
  const n = nature.toLowerCase();
  if (/nantissement|pledge/.test(n)) return "pledge";
  if (/souscription|subscription/.test(n)) return "subscription";
  if (/exercice|exercise/.test(n)) return "exercise";
  if (/attribution|gratuite|grant|award/.test(n)) return "grant";
  if (/cession|vente|disposal|sale/.test(n)) return "sell";
  if (/acquisition|achat|purchase/.test(n)) return "buy";
  return "other";
}

export interface AmfTransaction {
  date?: string;
  /** As declared — external text. */
  nature: string;
  side: DdSide;
  venue?: string;
  isin?: string;
  price?: number;
  currency?: string;
  volume?: number;
}

export interface AmfDeclaration {
  /** Name and function of the declarant — external text. */
  declarant?: string;
  transactions: AmfTransaction[];
}

const LABELS = [
  "NOM /FONCTION",
  "NOTIFICATION INITIALE",
  "COORDONNEES DE L",
  "DETAIL DE LA TRANSACTION",
  "DATE DE LA TRANSACTION",
  "LIEU DE LA TRANSACTION",
  "NATURE DE LA TRANSACTION",
  "DESCRIPTION DE L",
  "CODE D",
  "INFORMATION DETAILLEE",
  "PRIX UNITAIRE",
  "VOLUME",
  "INFORMATIONS AGREGEES",
  "PRIX :",
  "TRANSACTION LIEE",
  "DATE DE RECEPTION",
  "COMMENTAIRES",
];
const NEXT = `(?=\\s*(?:${LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})|$)`;
const field = (text: string, label: string) => new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)${NEXT}`).exec(text)?.[1]?.trim();

const CURRENCIES: Record<string, string> = {
  euro: "EUR",
  eur: "EUR",
  "dollar us": "USD",
  usd: "USD",
  "livre sterling": "GBP",
  gbp: "GBP",
  "franc suisse": "CHF",
  chf: "CHF",
};
function money(raw: string | undefined): { value?: number; currency?: string } {
  const m = /^([\d\s.,-]+)\s*(.*)$/.exec(raw?.trim() ?? "");
  if (!m) return {};
  const value = parseLooseNumber(m[1]!.replace(/\s/g, ""));
  const currency = CURRENCIES[m[2]!.trim().toLowerCase()];
  return { ...(value !== undefined ? { value } : {}), ...(currency ? { currency } : {}) };
}
const volumeOf = (raw: string | undefined) => (raw ? parseLooseNumber(raw.replace(/\s/g, "")) : undefined);

/** The text of a declaration PDF → declarant and transactions (aggregated price and volume per transaction). */
export function parseAmfDeclaration(text: string): AmfDeclaration {
  const t = text.replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  const declarant = /PERSONNE ETROITEMENT LIEE\s*:\s*([\s\S]*?)(?=\s*NOTIFICATION INITIALE|$)/.exec(t)?.[1]?.trim();
  const blocks = t.split(/DETAIL DE LA TRANSACTION/).slice(1);
  const transactions: AmfTransaction[] = blocks.map((b) => {
    const nature = field(b, "NATURE DE LA TRANSACTION") ?? "";
    const aggregated = b.split(/INFORMATIONS AGREGEES/)[1] ?? "";
    const detailed = b.split(/INFORMATIONS AGREGEES/)[0] ?? b;
    const price = money(field(aggregated, "PRIX") ?? field(detailed, "PRIX UNITAIRE"));
    const volume = volumeOf(field(aggregated, "VOLUME") ?? field(detailed, "VOLUME"));
    const date = frenchDate(field(b, "DATE DE LA TRANSACTION"));
    const venue = field(b, "LIEU DE LA TRANSACTION");
    const isin = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/.exec(field(b, "CODE D'IDENTIFICATION DE L'INSTRUMENT FINANCIER") ?? "")?.[1];
    return {
      ...(date ? { date } : {}),
      nature,
      side: classifyNature(nature),
      ...(venue ? { venue } : {}),
      ...(isin ? { isin } : {}),
      ...(price.value !== undefined ? { price: price.value } : {}),
      ...(price.currency ? { currency: price.currency } : {}),
      ...(volume !== undefined ? { volume } : {}),
    };
  });
  return { ...(declarant ? { declarant } : {}), transactions };
}

/**
 * Recent managers' transaction declarations for an issuer (name, ISIN, or an
 * AMF issuer id "RS…"), newest first, each PDF read for the details unless
 * `details` is false (then: links only).
 */
export async function amfInsiderDeclarations(issuer: string, opts: { limit?: number; details?: boolean; subject?: string } = {}): Promise<Dataset> {
  const q = issuer.trim();
  const size = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const by = /^RS\d+$/i.test(q) ? `Jetons=${encodeURIComponent(q.toUpperCase())}` : `RechercheTexte=${encodeURIComponent(q)}`;
  const url = `${BASE}/informations?${by}&TypesInformation=DD&From=0&Size=${size}`;
  const res = await fetchJson<BdifJson>(url, { headers: { referer: "https://bdif.amf-france.org/" } });
  if (!res.ok || !res.data) throw new ProviderError(AMF_SOURCE, `search failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const refs = parseBdifSearch(res.data);
  if (!refs.length) throw new ProviderError(AMF_SOURCE, `no managers' transaction declaration found for "${q}"`, 404);
  const subject = opts.subject ?? q.toUpperCase();
  const points: Point[] = [];
  const notes: string[] = [];
  const totals = { buy: 0, sell: 0, buys: 0, sells: 0 };
  const currencies = new Set<string>();
  let unread = 0;
  for (const r of refs) {
    const k = `${subject}.amf.dd.${r.numero}`;
    points.push({
      key: `${k}.issuer`,
      label: `${subject} AMF declaration ${r.numero} issuer (declared ${r.date})`,
      value: r.issuers.join("; "),
      untrusted: true,
      asOf: r.date,
      ...(r.pdfUrl ? { url: r.pdfUrl } : {}),
    });
    let decl: AmfDeclaration | undefined;
    if (opts.details !== false && r.pdfUrl) {
      const pdf = await fetchBinary(r.pdfUrl, { accept: "application/pdf,*/*", headers: { referer: "https://bdif.amf-france.org/" } });
      if (!pdf.ok && (pdf.status === 0 || pdf.status === 429 || pdf.status >= 500))
        throw new ProviderError(AMF_SOURCE, `declaration ${r.numero} PDF unavailable (${pdf.status}${pdf.error ? `, ${pdf.error}` : ""})`, pdf.status);
      if (pdf.ok) decl = parseAmfDeclaration(pdfToText(pdf.bytes));
    }
    if (!decl?.transactions.length) {
      unread++;
      continue;
    }
    if (decl.declarant)
      points.push({ key: `${k}.declarant`, label: `${subject} AMF declaration ${r.numero} declarant`, value: decl.declarant, untrusted: true, asOf: r.date });
    decl.transactions.forEach((t, i) => {
      const tk = `${k}.${i + 1}`;
      const what = `${subject} AMF declaration ${r.numero} transaction ${i + 1}${t.date ? ` on ${t.date}` : ""}`;
      const asOf = t.date ?? r.date;
      points.push(
        { key: `${tk}.side`, label: `${what} direction (classified from the declared nature)`, value: t.side, asOf },
        { key: `${tk}.nature`, label: `${what} nature as declared`, value: t.nature, untrusted: true, asOf },
      );
      if (t.volume !== undefined) points.push({ key: `${tk}.volume`, label: `${what} volume`, value: t.volume, unit: "shares", asOf });
      if (t.price !== undefined) points.push({ key: `${tk}.price`, label: `${what} price`, value: t.price, ...(t.currency ? { unit: t.currency } : {}), asOf });
      if (t.price !== undefined && t.volume !== undefined) {
        const amount = t.price * t.volume;
        points.push({
          key: `${tk}.amount`,
          label: `${what} amount`,
          value: amount,
          ...(t.currency ? { unit: t.currency } : {}),
          asOf,
          formula: "price × volume",
        });
        currencies.add(t.currency ?? "?");
        if (t.side === "buy") {
          totals.buy += amount;
          totals.buys++;
        } else if (t.side === "sell") {
          totals.sell += amount;
          totals.sells++;
        }
      }
    });
  }
  if (refs.length > unread) {
    points.push(
      { key: `${subject}.amf.dd.buys.count`, label: `${subject} declared purchases in these ${refs.length} declarations`, value: totals.buys, unit: "count" },
      { key: `${subject}.amf.dd.sells.count`, label: `${subject} declared sales in these ${refs.length} declarations`, value: totals.sells, unit: "count" },
      {
        key: `${subject}.amf.dd.net.amount`,
        label: `${subject} declared purchases − sales (amount) in these declarations`,
        value: totals.buy - totals.sell,
        ...(currencies.size === 1 && !currencies.has("?") ? { unit: [...currencies][0] } : {}),
        formula: currencies.size > 1 ? "Σ buy amounts − Σ sell amounts (several currencies, not converted)" : "Σ buy amounts − Σ sell amounts",
      },
    );
  }
  if (unread) notes.push(`${unread} declaration(s): details unavailable (PDF not read or not parsable) — open the linked PDF`);
  notes.push("declarations are filed within 3 business days of the trade; pledges, grants and exercises are not market purchases");
  return {
    kind: "insiders",
    title: `${subject} managers' transactions (AMF declarations)`,
    subject,
    points,
    provenance: { source: AMF_SOURCE, url, fetchedAt: res.fetchedAt, delay: "filing", official: true, asOf: refs[0]!.date },
    notes,
  };
}
