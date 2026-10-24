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
import type { Dataset, Point } from "../../core/datasets.js";
import { ProviderError } from "../types.js";
import { openfigiMap, preferredFigi } from "./openfigi.js";
import { archiveBase, SEC_SOURCE, type SecFiling, secJson, secSubmissions, secText } from "./sec.js";
import { xmlBlocks, xmlNumber, xmlValue } from "./xml.js";

/** Well-known 13F filers (CIKs verified against EDGAR's submissions, October 2026). */
export const NOTABLE_13F_MANAGERS: ReadonlyArray<{ slug: string; cik: number; name: string; note?: string }> = [
  { slug: "berkshire", cik: 1067983, name: "Berkshire Hathaway" },
  { slug: "pershing-square", cik: 1336528, name: "Pershing Square Capital Management" },
  { slug: "scion", cik: 1649339, name: "Scion Asset Management", note: "no 13F-HR since November 2025 (deregistered)" },
  { slug: "bridgewater", cik: 1350694, name: "Bridgewater Associates" },
  { slug: "renaissance", cik: 1037389, name: "Renaissance Technologies" },
  { slug: "baupost", cik: 1061768, name: "Baupost Group" },
  { slug: "soros", cik: 1029160, name: "Soros Fund Management" },
  { slug: "appaloosa", cik: 1656456, name: "Appaloosa" },
  { slug: "icahn", cik: 921669, name: "Carl Icahn" },
  { slug: "duquesne", cik: 1536411, name: "Duquesne Family Office (Druckenmiller)" },
  { slug: "third-point", cik: 1040273, name: "Third Point" },
  { slug: "valueact", cik: 1418814, name: "ValueAct Holdings" },
  { slug: "tiger-global", cik: 1167483, name: "Tiger Global Management" },
  { slug: "citadel", cik: 1423053, name: "Citadel Advisors" },
];

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

/** A manager by slug ("berkshire") or CIK. */
export function managerFor(manager: string | number): { cik: number; name?: string; note?: string } {
  const s = String(manager).trim().toLowerCase().replace(/^cik/, "");
  if (/^\d{1,10}$/.test(s)) {
    const known = NOTABLE_13F_MANAGERS.find((m) => m.cik === Number(s));
    return { cik: Number(s), ...(known ? { name: known.name, ...(known.note ? { note: known.note } : {}) } : {}) };
  }
  const m = NOTABLE_13F_MANAGERS.find((x) => x.slug === s || x.name.toLowerCase().includes(s));
  if (!m)
    throw new ProviderError(SEC_SOURCE, `unknown 13F manager "${manager}" — pass a CIK, or one of: ${NOTABLE_13F_MANAGERS.map((x) => x.slug).join(", ")}`, 404);
  return { cik: m.cik, name: m.name, ...(m.note ? { note: m.note } : {}) };
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
  const mgr = managerFor(manager);
  const sub = await secSubmissions(mgr.cik);
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
  if (mgr.note) notes.push(mgr.note);

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
    title: `${mgr.name ?? subject} 13F holdings, quarter ended ${period}`,
    subject,
    points,
    provenance: { source: SEC_SOURCE, url: cur.url, fetchedAt: sub.fetchedAt, delay: "filing", official: true, asOf: period },
    notes,
  };
}
