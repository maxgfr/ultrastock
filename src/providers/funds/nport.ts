// US-registered fund holdings from SEC Form N-PORT — keyless and official (the
// fund's own filing with its regulator):
//
//   https://www.sec.gov/files/company_tickers_mf.json                       fund ticker → CIK, series, class (cached a week)
//   https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<series>&type=NPORT-P&count=5&output=atom
//                                                                            the series' NPORT-P filings, newest first
//   https://www.sec.gov/Archives/edgar/data/<cik>/<accession>/primary_doc.xml every holding (<invstOrSec>)
//
// Monthly reports are made public for the quarter's last month only, 60 days
// after its end — the holdings are a quarter old or more, and said so. N-PORT
// has no sector field (only the issuer category), so the breakdowns are by
// country (invCountry, an ISO code) and asset category. A unit investment trust
// (SPY, DIA) does not file N-PORT: "unavailable", never guessed. EDGAR asks for
// an identified client and at most 10 requests a second (sec.ts paces them).
import { cachedJson, TTL } from "../../core/cache.js";
import { secJson, secText } from "../fundamentals/sec.js";
import { xmlBlocks, xmlNumber, xmlValue } from "../fundamentals/xml.js";
import { ProviderError } from "../types.js";
import type { FundComposition, FundLine } from "./common.js";

export const NPORT_SOURCE = "sec-edgar";

/** company_tickers_mf.json ({fields, data: [[cik, seriesId, classId, symbol]…]}) → by upper-case ticker. */
export function parseMfTickers(json: unknown): Record<string, { cik: number; series: string; class: string }> {
  const out: Record<string, { cik: number; series: string; class: string }> = {};
  const data = (json as { data?: unknown[][] })?.data;
  if (!Array.isArray(data)) return out;
  for (const r of data) {
    const [cik, series, cls, sym] = r as [number, string, string, string];
    if (typeof cik === "number" && typeof series === "string" && typeof sym === "string") out[sym.toUpperCase()] = { cik, series, class: String(cls ?? "") };
  }
  return out;
}

/** The NPORT-P filings in a browse-edgar atom feed: accession, filing date and index URL, newest first. */
export function parseNportFeed(atom: string): Array<{ accession: string; filed: string; href: string }> {
  return xmlBlocks(atom, "entry")
    .map((e) => ({
      accession: xmlValue(e, "accession-number") ?? "",
      filed: xmlValue(e, "filing-date") ?? "",
      href: xmlValue(e, "filing-href") ?? "",
      type: xmlValue(e, "filing-type"),
    }))
    .filter((x) => x.accession && x.type === "NPORT-P")
    .map(({ accession, filed, href }) => ({ accession, filed, href }))
    .sort((a, b) => b.filed.localeCompare(a.filed));
}

/** An N-PORT primary document → the report date, the series, and every long line (pctVal is already in %). */
export function parseNport(xml: string): { seriesId?: string; periodDate?: string; lines: FundLine[] } {
  const lines: FundLine[] = xmlBlocks(xml, "invstOrSec").flatMap((b) => {
    const pct = xmlNumber(b, "pctVal");
    const name = xmlValue(b, "name") ?? xmlValue(b, "title");
    if (pct === undefined || !name) return [];
    if ((xmlValue(b, "payoffProfile") ?? "Long") === "Short") return [];
    const isin = /<isin\s+value="([A-Z0-9]{12})"/.exec(b)?.[1];
    const country = xmlValue(b, "invCountry");
    const cat = xmlValue(b, "assetCat");
    return [{ name, weightPct: pct, ...(isin ? { isin } : {}), ...(country ? { country } : {}), ...(cat ? { assetClass: cat } : {}) }];
  });
  lines.sort((a, b) => b.weightPct - a.weightPct);
  return { seriesId: xmlValue(xml, "seriesId"), periodDate: xmlValue(xml, "repPdDate"), lines };
}

/** The latest N-PORT holdings of a US fund by ticker (VOO, QQQ, IVV…). */
export async function nportHoldings(ticker: string): Promise<FundComposition> {
  const T = ticker.trim().toUpperCase().replace(/\.US$/, "");
  const map = await cachedJson("sec:company_tickers_mf", TTL.reference, async () =>
    parseMfTickers((await secJson("https://www.sec.gov/files/company_tickers_mf.json")).data),
  );
  const fund = map?.[T];
  if (!fund) throw new ProviderError(NPORT_SOURCE, `${T} is not a registered fund ticker in EDGAR (a unit investment trust such as SPY files no N-PORT)`, 404);
  const feedUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${fund.series}&type=NPORT-P&dateb=&owner=include&count=5&output=atom`;
  const feed = parseNportFeed((await secText(feedUrl)).body);
  const latest = feed[0];
  if (!latest) throw new ProviderError(NPORT_SOURCE, `no NPORT-P filing for ${T} (series ${fund.series})`, 404);
  const url = `https://www.sec.gov/Archives/edgar/data/${fund.cik}/${latest.accession.replace(/-/g, "")}/primary_doc.xml`;
  const doc = await secText(url);
  const parsed = parseNport(doc.body);
  if (parsed.seriesId && parsed.seriesId !== fund.series)
    throw new ProviderError(NPORT_SOURCE, `filing ${latest.accession} is for series ${parsed.seriesId}, not ${fund.series}`, 404);
  if (!parsed.lines.length) throw new ProviderError(NPORT_SOURCE, `filing ${latest.accession} lists no holdings`);
  return {
    fund: T,
    source: NPORT_SOURCE,
    url,
    fetchedAt: doc.fetchedAt,
    asOf: parsed.periodDate,
    lines: parsed.lines,
    synthetic: false,
    official: true,
    notes: [
      `Form NPORT-P ${latest.accession}, filed ${latest.filed}, holdings as of ${parsed.periodDate ?? "?"} (public N-PORT holdings lag by 60 days or more); country = invCountry, no sector in N-PORT`,
    ],
  };
}
