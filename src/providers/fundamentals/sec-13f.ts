// SEC Form 13F-HR — what an institutional manager held at a quarter's end
// (official, filed by the manager):
//
//   the list         data.sec.gov/submissions/CIK##########.json (form 13F-HR)
//   the filing       www.sec.gov/Archives/edgar/data/<cik>/<accession>/index.json
//   the holdings     the information-table XML listed there (not primary_doc.xml)
//
// A 13F is due 45 days after the quarter: the latest one describes a portfolio
// six to twenty weeks old, long US equities and listed options only (no shorts,
// no cash, no non-US lines). Values are in US dollars since January 2023 (in
// thousands before). Rows are summed per CUSIP and put/call, since managers
// split one position across sub-managers. Amendments (13F-HR/A) are ignored:
// they may restate or merely add rows, and nothing in the list says which.
// A manager named rather than given by CIK is found through EDGAR's name search.
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { openfigiMap, preferredFigi } from "./openfigi.js";
import { archiveBase, SEC_SOURCE, type SecFiling, type SecSubmissions, searchEdgarEntities, secJson, secSubmissions, secText } from "./sec.js";
import { daysBetween, isoDayOf } from "./util.js";
import { xmlBlocks, xmlNumber, xmlValue } from "./xml.js";

export interface Holding {
  /** Issuer name as filed — external text. */
  issuer: string;
  cusip: string;
  titleOfClass: string;
  value: number;
  shares: number;
  shareType: string;
  putCall?: string;
}

/** An information table → one row per CUSIP and put/call, values summed. `thousands` for pre-2023 filings. */
export function parse13fTable(xml: string, opts: { thousands?: boolean } = {}): Holding[] {
  const byKey = new Map<string, Holding>();
  for (const row of xmlBlocks(xml, "infoTable")) {
    const cusip = xmlValue(row, "cusip")?.toUpperCase();
    const value = xmlNumber(row, "value");
    if (!cusip || value === undefined) continue;
    const putCall = xmlValue(row, "putCall")?.toUpperCase();
    const key = `${cusip}|${putCall ?? ""}`;
    const shares = xmlNumber(row, "shrsOrPrnAmt", "sshPrnamt") ?? 0;
    const h = byKey.get(key);
    const v = opts.thousands ? value * 1000 : value;
    if (h) {
      h.value += v;
      h.shares += shares;
    } else
      byKey.set(key, {
        issuer: xmlValue(row, "nameOfIssuer") ?? "",
        cusip,
        titleOfClass: xmlValue(row, "titleOfClass") ?? "",
        value: v,
        shares,
        shareType: xmlValue(row, "shrsOrPrnAmt", "sshPrnamtType") ?? "SH",
        ...(putCall ? { putCall } : {}),
      });
  }
  return [...byKey.values()].sort((a, b) => b.value - a.value);
}

export type HoldingChange = "new" | "added" | "trimmed" | "sold" | "unchanged";

export interface HoldingDiff {
  holding: Holding;
  change: HoldingChange;
  sharesChange: number;
  previousShares: number;
}

const keyOf = (h: Holding) => `${h.cusip}|${h.putCall ?? ""}`;

/** Compare two quarters by shares (not value: prices move): new, added, trimmed, sold, unchanged. */
export function diff13f(current: Holding[], previous: Holding[]): HoldingDiff[] {
  const prev = new Map(previous.map((h) => [keyOf(h), h]));
  const out: HoldingDiff[] = current.map((h) => {
    const p = prev.get(keyOf(h));
    const before = p?.shares ?? 0;
    const change: HoldingChange = !p ? "new" : h.shares > before ? "added" : h.shares < before ? "trimmed" : "unchanged";
    return { holding: h, change, sharesChange: h.shares - before, previousShares: before };
  });
  const now = new Set(current.map(keyOf));
  for (const p of previous)
    if (!now.has(keyOf(p))) out.push({ holding: { ...p, value: 0, shares: 0 }, change: "sold", sharesChange: -p.shares, previousShares: p.shares });
  return out;
}

export interface Manager13f {
  cik: number;
  /** As EDGAR records it — external text. */
  name?: string;
  /** Other 13F filers the name also matched, best first. */
  others: Array<{ cik: number; name: string }>;
  sub: SecSubmissions & { url: string; fetchedAt: string };
}

/** How many of EDGAR's name matches are read to find the ones that file 13F reports. */
const SEARCH_DEPTH = 6;

/**
 * A 13F filer by CIK, or by name through EDGAR's own name search: of the
 * entities the name matches, the best-ranked one that has filed a 13F-HR
 * (the others are kept, to be listed). No list of managers is kept here —
 * who files 13Fs, and under which name, changes.
 */
export async function managerFor(manager: string | number): Promise<Manager13f> {
  const s = String(manager).trim().replace(/^cik/i, "");
  if (/^\d{1,10}$/.test(s)) {
    const sub = await secSubmissions(Number(s));
    return { cik: Number(s), ...(sub.name ? { name: sub.name } : {}), others: [], sub };
  }
  const query = s.replace(/[-_]+/g, " ");
  const found: Array<Omit<Manager13f, "others">> = [];
  for (const e of (await searchEdgarEntities(query)).slice(0, SEARCH_DEPTH)) {
    const sub = await secSubmissions(e.cik);
    if (sub.filings.some((f) => f.form === "13F-HR")) found.push({ cik: e.cik, name: sub.name || e.name, sub });
  }
  const [best, ...rest] = found;
  if (!best) throw new ProviderError(SEC_SOURCE, `no 13F filer among EDGAR's matches for "${manager}" — pass the manager's CIK`, 404);
  return { ...best, others: rest.map((m) => ({ cik: m.cik, name: m.name ?? "" })) };
}

async function holdingsOf(cik: number, f: SecFiling): Promise<{ holdings: Holding[]; url: string }> {
  const base = archiveBase(cik, f.accession);
  const index = await secJson<{ directory?: { item?: Array<{ name?: string }> } }>(`${base}/index.json`);
  const xmls = (index.data.directory?.item ?? [])
    .map((i) => i.name ?? "")
    .filter((n) => n.toLowerCase().endsWith(".xml") && n.toLowerCase() !== "primary_doc.xml");
  for (const name of xmls) {
    const res = await secText(`${base}/${name}`);
    if (/informationTable/i.test(res.body)) return { holdings: parse13fTable(res.body, { thousands: f.filingDate < "2023-01-03" }), url: `${base}/${name}` };
  }
  throw new ProviderError(SEC_SOURCE, `no information table in 13F filing ${f.accession}`, 404);
}

/**
 * A manager's latest 13F-HR: top holdings by value with portfolio weights, and
 * the change against the previous 13F-HR. `tickers` maps the top CUSIPs through
 * OpenFIGI (one extra request per 10 holdings).
 */
export async function sec13f(manager: string | number, opts: { top?: number; tickers?: boolean } = {}): Promise<Dataset> {
  const mgr = await managerFor(manager);
  const sub = mgr.sub;
  const list = sub.filings.filter((f) => f.form === "13F-HR").slice(0, 2);
  const latest = list[0];
  if (!latest) throw new ProviderError(SEC_SOURCE, `no 13F-HR among the recent filings of CIK ${mgr.cik}`, 404);
  const cur = await holdingsOf(mgr.cik, latest);
  const prev = list[1] ? await holdingsOf(mgr.cik, list[1]) : undefined;
  const total = cur.holdings.reduce((s, h) => s + h.value, 0);
  const subject = `CIK${mgr.cik}`;
  const period = latest.reportDate ?? latest.filingDate;
  const top = cur.holdings.slice(0, opts.top ?? 10);
  const diffs = prev ? diff13f(cur.holdings, prev.holdings) : undefined;
  const diffOf = new Map(diffs?.map((d) => [keyOf(d.holding), d]));
  const notes: string[] = [
    `13F-HR for the quarter ended ${period}, filed ${latest.filingDate}: filed up to 45 days after the quarter — the positions may have changed since`,
    "long US-listed equities and options only; no shorts, cash or non-US holdings",
  ];
  if (mgr.others.length) notes.push(`other 13F filers match the name: ${mgr.others.map((m) => `CIK ${m.cik}`).join(", ")} — pass a CIK to read one of them`);
  if (daysBetween(latest.filingDate, isoDayOf(clockNow())) > 200)
    notes.push(`the latest 13F-HR was filed ${latest.filingDate}: the manager may have stopped filing, these positions are old`);

  let tickers: Array<string | undefined> = [];
  if (opts.tickers && top.length) {
    try {
      const mapped = await openfigiMap(top.map((h) => ({ idType: "ID_CUSIP" as const, idValue: h.cusip, exchCode: "US" })));
      tickers = mapped.results.map((r) => preferredFigi(r)?.ticker);
      notes.push("tickers mapped from CUSIPs by OpenFIGI (unofficial)");
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      notes.push(`tickers unavailable: ${e.message}`);
    }
  }

  const points: Point[] = [
    ...(mgr.name ? [{ key: `${subject}.13f.manager`, label: `${subject} 13F filer name (EDGAR)`, value: mgr.name, untrusted: true, url: sub.url }] : []),
    { key: `${subject}.13f.total.value`, label: `${subject} 13F reported portfolio value`, value: total, unit: "USD", asOf: period, url: cur.url },
    {
      key: `${subject}.13f.positions.count`,
      label: `${subject} 13F positions (per CUSIP and put/call)`,
      value: cur.holdings.length,
      unit: "count",
      asOf: period,
    },
  ];
  top.forEach((h, i) => {
    const k = `${subject}.13f.${h.cusip}${h.putCall ? `.${h.putCall.toLowerCase()}` : ""}`;
    const what = `${subject} 13F #${i + 1} (CUSIP ${h.cusip}${h.putCall ? ` ${h.putCall}` : ""})`;
    points.push(
      { key: `${k}.issuer`, label: `${what} issuer`, value: `${h.issuer} — ${h.titleOfClass}`, untrusted: true, asOf: period },
      { key: `${k}.value`, label: `${what} value`, value: h.value, unit: "USD", asOf: period },
      {
        key: `${k}.weight`,
        label: `${what} weight`,
        value: total ? (h.value / total) * 100 : 0,
        unit: "%",
        asOf: period,
        formula: "value / total reported value",
      },
      {
        key: `${k}.shares`,
        label: `${what} ${h.shareType === "PRN" ? "principal" : "shares"}`,
        value: h.shares,
        unit: h.shareType === "PRN" ? "USD" : "shares",
        asOf: period,
      },
    );
    const t = tickers[i];
    if (t) points.push({ key: `${k}.ticker`, label: `${what} ticker (OpenFIGI)`, value: t, asOf: period });
    const d = diffOf.get(keyOf(h));
    if (d)
      points.push({
        key: `${k}.change`,
        label: `${what} change vs previous 13F (${d.sharesChange >= 0 ? "+" : ""}${d.sharesChange} shares)`,
        value: d.change,
        asOf: period,
      });
  });
  if (diffs) {
    const counts = { new: 0, added: 0, trimmed: 0, sold: 0, unchanged: 0 };
    for (const d of diffs) counts[d.change]++;
    for (const [c, n] of Object.entries(counts))
      points.push({
        key: `${subject}.13f.changes.${c}.count`,
        label: `${subject} 13F positions ${c} vs previous quarter`,
        value: n,
        unit: "count",
        asOf: period,
      });
    const sold = diffs
      .filter((d) => d.change === "sold")
      .sort((a, b) => b.previousShares - a.previousShares)
      .slice(0, 5);
    for (const d of sold)
      points.push({
        key: `${subject}.13f.${d.holding.cusip}${d.holding.putCall ? `.${d.holding.putCall.toLowerCase()}` : ""}.sold`,
        label: `${subject} 13F position exited since the previous quarter (CUSIP ${d.holding.cusip}), issuer`,
        value: d.holding.issuer,
        untrusted: true,
        asOf: period,
      });
  } else notes.push("no previous 13F-HR in the recent filings: no quarter-on-quarter change");
  return {
    kind: "holdings",
    title: `${subject} 13F holdings, quarter ended ${period}`,
    subject,
    points,
    provenance: { source: SEC_SOURCE, url: cur.url, fetchedAt: sub.fetchedAt, delay: "filing", official: true, asOf: period },
    notes,
  };
}

/** A manager's latest 13F-HR as data: the holdings, and the changes against the previous 13F-HR when there is one. */
export async function latest13f(cik: number): Promise<
  | {
      filing: SecFiling;
      period: string;
      holdings: Holding[];
      diffs?: HoldingDiff[];
      url: string;
      fetchedAt: string;
    }
  | undefined
> {
  const sub = await secSubmissions(cik);
  const [latest, previous] = sub.filings.filter((f) => f.form === "13F-HR");
  if (!latest) return undefined;
  const cur = await holdingsOf(cik, latest);
  const prev = previous ? await holdingsOf(cik, previous) : undefined;
  return {
    filing: latest,
    period: latest.reportDate ?? latest.filingDate,
    holdings: cur.holdings,
    ...(prev ? { diffs: diff13f(cur.holdings, prev.holdings) } : {}),
    url: cur.url,
    fetchedAt: sub.fetchedAt,
  };
}
