// Funds that trade on no exchange — the mutual funds (OPCVM, SICAV, FCP) of an
// assurance-vie or a bank account — priced from the Financial Times' fund pages,
// keyless and unofficial:
//
//   searchapi/searchsecurities?query=<ISIN>      → the FT id (xid) and price currency
//   funds/tearsheet/summary?s=<ISIN>:<CCY>        → charges, category, style, size
//   equities/ajax/get-historical-prices?symbol=<xid>&startDate&endDate → daily NAVs
//
// A fund has one price a day, its net asset value: a bar's open, high, low and
// close are that NAV. The charges are the share class's as the FT prints them
// (the KID's ongoing charge); an insurer's own contract fee comes on top.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson, fetchText } from "../../core/net.js";
import { decodeEntities } from "../../engine.js";
import { type Bar, type Instrument, type PriceSeries, ProviderError } from "../types.js";

export const SOURCE = "ft";
const BASE = "https://markets.ft.com/data";
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

interface FtSecurity {
  name?: string;
  symbol?: string;
  xid?: string;
  assetClass?: string;
  isPrimary?: boolean;
}

/** The FT's fund listing for an ISIN: its id, name and price currency (the primary listing first). */
export async function resolveFtFund(isin: string): Promise<Instrument> {
  const id = isin.trim().toUpperCase();
  if (!ISIN.test(id)) throw new ProviderError(SOURCE, `${isin} is not an ISIN`);
  const url = `${BASE}/searchapi/searchsecurities?query=${encodeURIComponent(id)}`;
  const res = await fetchJson<{ data?: { security?: FtSecurity[] } }>(url);
  if (!res.ok) throw new ProviderError(SOURCE, `fund search unavailable (HTTP ${res.status})`, res.status);
  const hits = (res.data?.data?.security ?? []).filter((s) => s.assetClass === "Funds" && s.symbol?.toUpperCase().startsWith(`${id}:`) && s.xid);
  const pick = hits.find((s) => s.isPrimary) ?? hits[0];
  if (!pick) throw new ProviderError(SOURCE, `no fund priced by the FT for ${id}`);
  return {
    symbol: id,
    market: "fund",
    kind: "fund",
    name: pick.name ? decodeEntities(pick.name) : undefined,
    isin: id,
    currency: pick.symbol!.split(":")[1] ?? "EUR",
    venueId: pick.xid!,
  };
}

const cellText = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** The tearsheet's label → value table (Fund type, Ongoing charge, Morningstar category…). */
export function parseFtTearsheet(html: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const m of html.matchAll(/<th[^>]*>([^<]{2,60})<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const label = cellText(m[1]!);
    if (label && !rows.has(label)) rows.set(label, cellText(m[2]!));
  }
  return rows;
}

/** "1.83%" → 1.83; "--" or text → undefined. */
export function percentOf(s: string | undefined): number | undefined {
  const m = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(s?.trim() ?? "");
  return m ? Number(m[1]) : undefined;
}

const CHARGES: Array<[string, string, string]> = [
  ["Ongoing charge", "ongoingCharge", "ongoing charge (KID, yearly, taken from the NAV)"],
  ["Max annual charge", "maxAnnualCharge", "maximum annual management charge"],
  ["Initial charge", "initialCharge", "maximum entry charge"],
  ["Exit charge", "exitCharge", "maximum exit charge"],
];

const FACTS: Array<[string, string]> = [
  ["Fund type", "type"],
  ["Morningstar category", "category"],
  ["Investment style (stocks)", "style.stocks"],
  ["Investment style (bonds)", "style.bonds"],
  ["Income treatment", "income"],
  ["Domicile", "domicile"],
  ["Launch date", "launch"],
  ["Pricing frequency", "pricing"],
  ["Fund size", "size.fund"],
  ["Share class size", "size.class"],
  ["Manager & start date", "manager"],
];

/**
 * A fund's charges and identity card from the FT tearsheet. With `wrapperFeePct`
 * (an assurance-vie's yearly fee on unit-linked funds, e.g. 0.96), the total
 * yearly cost of holding it in the contract is added as a computed point.
 */
export async function ftFundProfile(isin: string, opts: { wrapperFeePct?: number } = {}): Promise<Dataset> {
  const inst = await resolveFtFund(isin);
  const url = `${BASE}/funds/tearsheet/summary?s=${encodeURIComponent(`${inst.isin}:${inst.currency}`)}`;
  const res = await fetchText(url, { accept: "text/html" });
  if (!res.ok) throw new ProviderError(SOURCE, `tearsheet unavailable (HTTP ${res.status})`, res.status);
  const rows = parseFtTearsheet(res.body);
  if (!rows.size) throw new ProviderError(SOURCE, `no fund data on the FT tearsheet for ${inst.isin}`);
  const id = inst.isin!;
  const points: Point[] = [];
  if (inst.name) points.push({ key: `${id}.fund.name`, label: `${id} fund name`, value: inst.name, untrusted: true });
  points.push({ key: `${id}.fund.currency`, label: `${id} price currency`, value: inst.currency });
  for (const [label, key, desc] of CHARGES) {
    const v = percentOf(rows.get(label));
    if (v !== undefined) points.push({ key: `${id}.fund.${key}`, label: `${id} ${desc}`, value: v, unit: "%" });
  }
  for (const [label, key] of FACTS) {
    const v = rows.get(label);
    if (v && v !== "--") points.push({ key: `${id}.fund.${key}`, label: `${id} ${label.toLowerCase()}`, value: v, untrusted: true });
  }
  const notes = ["FT fund pages are unofficial: the KID (DIC) on the manager's site is the reference for the charges."];
  const ongoing = percentOf(rows.get("Ongoing charge"));
  if (opts.wrapperFeePct !== undefined) {
    points.push({ key: `${id}.fund.wrapperFee`, label: `${id} contract fee on unit-linked funds (given)`, value: opts.wrapperFeePct, unit: "%" });
    if (ongoing !== undefined)
      points.push({
        key: `${id}.fund.totalYearlyCost`,
        label: `${id} total yearly cost in the contract (ongoing charge + contract fee)`,
        value: Number((ongoing + opts.wrapperFeePct).toFixed(4)),
        unit: "%",
        formula: `${id}.fund.ongoingCharge + ${id}.fund.wrapperFee`,
      });
    notes.push("Entry and exit charges are the prospectus maxima; inside an assurance-vie the insurer's own terms apply (usually none on switches).");
  }
  return {
    kind: "fund",
    title: `${inst.name ?? id} — charges and profile (FT)`,
    subject: id,
    points,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, official: false },
    notes,
  };
}

const MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

/** The historical-prices table (rows newest first) as bars oldest first; a fund's close is its NAV. */
export function parseFtHistory(html: string): Bar[] {
  const bars = new Map<string, Bar>();
  for (const row of html.split(/<tr[^>]*>/).slice(1)) {
    // Each date is printed twice ("Thursday, November 05, 2026" and "Thu, Nov 05, 2026"): read the short form.
    const d = /\b[A-Z][a-z]{2}, ([A-Z][a-z]{2}) (\d{2}), (\d{4})</.exec(row);
    const cells = [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((c) => Number(c[1]!.replace(/,/g, "")));
    const month = d ? MONTHS[d[1]!] : undefined;
    if (!d || !month || cells.length < 4 || !cells.slice(0, 4).every((n) => Number.isFinite(n) && n > 0)) continue;
    const [open, high, low, close] = cells as [number, number, number, number];
    const date = `${d[3]}-${month}-${d[2]}`;
    bars.set(date, { date, open, high, low, close });
  }
  return [...bars.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const ftDay = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "/");

/** Daily NAVs between two dates (the FT answers several years in one call). */
export async function ftFundHistory(instrument: Instrument, from: Date, to: Date): Promise<PriceSeries> {
  const url = `${BASE}/equities/ajax/get-historical-prices?startDate=${encodeURIComponent(ftDay(from))}&endDate=${encodeURIComponent(ftDay(to))}&symbol=${encodeURIComponent(instrument.venueId)}`;
  const res = await fetchJson<{ html?: string }>(url);
  if (!res.ok) throw new ProviderError(SOURCE, `historical prices unavailable (HTTP ${res.status})`, res.status);
  const bars = parseFtHistory(res.data?.html ?? "");
  if (!bars.length) throw new ProviderError(SOURCE, `no NAV for ${instrument.symbol} between ${ftDay(from)} and ${ftDay(to)}`);
  return {
    instrument,
    interval: "1d",
    bars,
    adjusted: false,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "eod", official: false },
    notes: ["a fund's net asset value, one price a day (open = high = low = close); income is reinvested in accumulating share classes"],
  };
}
