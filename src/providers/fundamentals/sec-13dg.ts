// SEC Schedules 13D and 13G — a stake above 5% of a class of shares, reported
// by whoever holds it (official, filed by the holder):
//
//   the list      data.sec.gov/submissions/CIK##########.json (SCHEDULE 13D, SCHEDULE 13G and their /A)
//   each filing   www.sec.gov/Archives/edgar/data/<cik>/<accession>/primary_doc.xml
//
// Since December 2024 both schedules are filed as structured XML; the older
// "SC 13D"/"SC 13G" filings are free text and are not read. A 13D (an active
// holder: an activist, a buyer of control) is due within 5 business days of
// crossing 5% and of any material change; a 13G (a passive holder) within 45
// days of the quarter's end, or sooner for large stakes. The holder's own
// submissions also list schedules filed ABOUT it when it is itself an issuer —
// those name another filer and are left out.
import { ProviderError } from "../types.js";
import { archiveBase, type SecFiling, secSubmissions, secText } from "./sec.js";
import { mdyToIso } from "./util.js";
import { xmlBlocks, xmlNumber, xmlValue } from "./xml.js";

export interface Stake {
  schedule: "13D" | "13G";
  amendment: boolean;
  /** CIKs of the filer and of the reporting persons that have one. */
  filerCiks: number[];
  issuerCik?: number;
  /** As filed — external text. */
  issuerName: string;
  cusip?: string;
  /** The event that required the filing (13D: date of event; 13G: the event date). */
  eventDate?: string;
  /** Beneficially owned, the largest among the reporting persons (a fund, its adviser and its partner report the same shares). */
  shares?: number;
  percent?: number;
}

const cikNum = (s: string | undefined) => {
  const n = Number((s ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** A Schedule 13D or 13G XML document → the stake it reports. */
export function parseSchedule13(xml: string): Stake {
  const type = xmlValue(xml, "headerData", "submissionType") ?? "";
  const schedule = /13G/i.test(type) ? "13G" : "13D";
  const filerCiks = new Set<number>();
  const filer = cikNum(xmlValue(xml, "headerData", "filerInfo", "filer", "filerCredentials", "cik"));
  if (filer) filerCiks.add(filer);
  const people = [...xmlBlocks(xml, "reportingPersonInfo"), ...xmlBlocks(xml, "coverPageHeaderReportingPersonDetails")];
  let shares: number | undefined;
  let percent: number | undefined;
  for (const p of people) {
    const cik = cikNum(xmlValue(p, "reportingPersonCIK") ?? xmlValue(p, "reportingPersonCik"));
    if (cik) filerCiks.add(cik);
    const owned = xmlNumber(p, "aggregateAmountOwned") ?? xmlNumber(p, "reportingPersonBeneficiallyOwnedAggregateNumberOfShares");
    const pct = xmlNumber(p, "percentOfClass") ?? xmlNumber(p, "classPercent");
    if (owned !== undefined && (shares === undefined || owned > shares)) shares = owned;
    if (pct !== undefined && (percent === undefined || pct > percent)) percent = pct;
  }
  const issuer = xmlBlocks(xml, "issuerInfo")[0] ?? "";
  const event = xmlValue(xml, "coverPageHeader", "dateOfEvent") ?? xmlValue(xml, "coverPageHeader", "eventDateRequiresFilingThisStatement");
  const issuerCik = cikNum(xmlValue(issuer, "issuerCIK") ?? xmlValue(issuer, "issuerCik"));
  const cusip = xmlValue(issuer, "issuerCusipNumber");
  const eventDate = mdyToIso(event);
  return {
    schedule,
    amendment: /\/A$/i.test(type),
    filerCiks: [...filerCiks],
    ...(issuerCik ? { issuerCik } : {}),
    issuerName: xmlValue(issuer, "issuerName") ?? "",
    ...(cusip ? { cusip } : {}),
    ...(eventDate ? { eventDate } : {}),
    ...(shares !== undefined ? { shares } : {}),
    ...(percent !== undefined ? { percent } : {}),
  };
}

export interface FiledStake extends Stake {
  accession: string;
  filed: string;
  url: string;
}

const isXmlSchedule = (f: SecFiling) => /^SCHEDULE 13[DG](\/A)?$/.test(f.form);

/** The schedules a holder filed about its stakes (structured ones, newest first), each with the stake it reports. */
export async function sec13dgStakes(
  holderCik: number,
  opts: { limit?: number; since?: string; skip?: ReadonlySet<string> } = {},
): Promise<{ name: string; stakes: FiledStake[]; notes: string[]; url: string; fetchedAt: string }> {
  const sub = await secSubmissions(holderCik);
  const list = sub.filings
    .filter((f) => isXmlSchedule(f) && (!opts.since || f.filingDate >= opts.since) && !opts.skip?.has(f.accession))
    .slice(0, opts.limit ?? 10);
  const stakes: FiledStake[] = [];
  const notes: string[] = [];
  for (const f of list) {
    const url = `${archiveBase(holderCik, f.accession)}/${f.primaryDocument.replace(/^xsl[^/]*\//, "")}`;
    try {
      const stake = parseSchedule13((await secText(url)).body);
      if (!stake.filerCiks.includes(holderCik)) continue;
      stakes.push({ ...stake, accession: f.accession, filed: f.filingDate, url });
    } catch (e) {
      if (!(e instanceof ProviderError) || e.transient) throw e;
      notes.push(`schedule ${f.accession} unreadable: ${e.message}`);
    }
  }
  if (sub.filings.some((f) => /^SC 13[DG]/.test(f.form)) && !opts.since)
    notes.push("schedules filed before December 2024 (SC 13D/SC 13G) are free text and are not read");
  return { name: sub.name, stakes, notes, url: sub.url, fetchedAt: sub.fetchedAt };
}
