// US House of Representatives financial disclosures (official: the Clerk of
// the House), keyless:
//
//   index    https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<YEAR>FD.zip
//            (<YEAR>FD.xml inside: member, filing type, date, DocID — rebuilt daily)
//   PTRs     https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/<YEAR>/<DocID>.pdf
//
// Filing type P is the Periodic Transaction Report the STOCK Act requires
// within 45 days of a trade — the "congress trades" signal, late by design.
// The PTR PDFs are generated forms whose text layer uses fonts the engine's
// built-in PDF reader cannot decode; the engine's extraction ladder reads them
// when an external rung (pdftotext, anydoc…) is installed, and the row parser
// below is best-effort over that text. Amounts are disclosed as RANGES only.
// Member names are external text; scanned (handwritten) PTRs have no text.
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow } from "../../core/net.js";
import { extractPdf } from "../../engine.js";
import { ProviderError } from "../types.js";
import { fetchBinary } from "./binary.js";
import { mdyToIso } from "./util.js";
import { xmlBlocks, xmlValue } from "./xml.js";
import { zipEntries, zipRead } from "./zip.js";

export const HOUSE_SOURCE = "house-clerk";
const BASE = "https://disclosures-clerk.house.gov/public_disc";

export interface HouseFiling {
  docId: string;
  /** "Last, First" — external text. */
  member: string;
  stateDistrict: string;
  filingType: string;
  date: string;
  year: number;
  pdfUrl: string;
}

/** The FD index XML → filings (all types), newest first. */
export function parseHouseIndex(xml: string): HouseFiling[] {
  return xmlBlocks(xml, "Member")
    .flatMap((m) => {
      const docId = xmlValue(m, "DocID");
      const date = mdyToIso(xmlValue(m, "FilingDate"));
      const year = Number(xmlValue(m, "Year"));
      const filingType = xmlValue(m, "FilingType") ?? "";
      if (!docId || !date || !Number.isFinite(year)) return [];
      const name = [xmlValue(m, "Prefix"), xmlValue(m, "First"), xmlValue(m, "Last"), xmlValue(m, "Suffix")].filter(Boolean).join(" ");
      const folder = filingType === "P" ? "ptr-pdfs" : "financial-pdfs";
      return [{ docId, member: name, stateDistrict: xmlValue(m, "StateDst") ?? "", filingType, date, year, pdfUrl: `${BASE}/${folder}/${year}/${docId}.pdf` }];
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.docId.localeCompare(a.docId));
}

/** The <YEAR>FD.xml text out of the <YEAR>FD.zip bytes. */
export function houseIndexXml(zip: Buffer): string {
  const entry = zipEntries(zip).find((e) => /FD\.xml$/i.test(e.name));
  if (!entry) throw new Error("no FD.xml in the archive");
  return zipRead(zip, entry).toString("utf8").replace(/^﻿/, "");
}

/** Recent Periodic Transaction Reports (filing type P), optionally of one member (name substring), with PDF links. */
export async function housePtrFilings(opts: { year?: number; limit?: number; member?: string; now?: Date } = {}): Promise<Dataset> {
  const year = opts.year ?? (opts.now ?? clockNow()).getUTCFullYear();
  const url = `${BASE}/financial-pdfs/${year}FD.zip`;
  const res = await fetchBinary(url, { accept: "application/zip,*/*" });
  if (!res.ok) throw new ProviderError(HOUSE_SOURCE, `${url} (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  let filings: HouseFiling[];
  try {
    filings = parseHouseIndex(houseIndexXml(res.bytes));
  } catch (e) {
    throw new ProviderError(HOUSE_SOURCE, `${url}: ${(e as Error).message}`, 502);
  }
  const who = opts.member?.trim().toLowerCase();
  const ptrs = filings.filter((f) => f.filingType === "P" && (!who || f.member.toLowerCase().includes(who))).slice(0, opts.limit ?? 20);
  if (!ptrs.length) throw new ProviderError(HOUSE_SOURCE, `no periodic transaction report in ${year}${who ? " for that member" : ""}`, 404);
  const points: Point[] = ptrs.map((f) => ({
    key: `US.house.ptr.${f.docId}`,
    label: `House periodic transaction report ${f.docId} (${f.stateDistrict}) filed ${f.date}`,
    value: f.member,
    untrusted: true,
    asOf: f.date,
    url: f.pdfUrl,
  }));
  return {
    kind: "disclosures",
    title: `US House periodic transaction reports, ${year}`,
    subject: "US.house",
    points,
    provenance: { source: HOUSE_SOURCE, url, fetchedAt: res.fetchedAt, delay: "filing", official: true, asOf: ptrs[0]!.date },
    notes: [
      "a PTR is due within 45 days of the trade (often later): the filing date is not the trade date",
      "transactions are in the linked PDFs — housePtrTransactions(docId) reads one; amounts are ranges",
    ],
  };
}

export interface PtrTransaction {
  ticker?: string;
  /** P purchase, S sale, S (partial), E exchange. */
  type: string;
  date: string;
  notified?: string;
  amountLow?: number;
  amountHigh?: number;
}

const TYPE_NAMES: Record<string, string> = { P: "purchase", S: "sale", "S (partial)": "partial sale", E: "exchange" };
const ROW = /\b(P|S \(partial\)|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\$[\d,]+(?:\s*-\s*\$[\d,]+)?|Over \$[\d,]+)/g;
const dollars = (s: string) => Number(s.replace(/[$,\s]/g, ""));

const TICKER = /\(([A-Z][A-Z0-9.]{0,6})\)\s*\[[A-Z]{2}\]/;

/**
 * Transactions from a PTR's extracted text: each row is a type, the trade and
 * notification dates and an amount range; the ticker is the "(XYZ) [ST]" of
 * the same transaction block. Blocks end at the "Filing Status:" line every
 * e-filed PTR prints after each transaction (extracted as "F S:"), which keeps
 * a wrapped asset name — ticker before or after the row, depending on the
 * tool — with its own row. Best effort; a row without a ticker (Treasuries,
 * funds) keeps none.
 */
export function parsePtrText(text: string): PtrTransaction[] {
  const out: PtrTransaction[] = [];
  for (const block of text.replace(/\s+/g, " ").split(/\bF\s*S\s*:/)) {
    const rows = [...block.matchAll(ROW)];
    rows.forEach((m, i) => {
      // Several rows in one block means the markers were lost: only the text after each row is its own.
      const own = rows.length === 1 ? block : block.slice(m.index! + m[0].length, rows[i + 1]?.index ?? block.length);
      const ticker = TICKER.exec(own)?.[1];
      const range = /\$([\d,]+)\s*-\s*\$([\d,]+)/.exec(m[4]!);
      const over = /Over \$([\d,]+)/.exec(m[4]!);
      const notified = mdyToIso(m[3]);
      out.push({
        ...(ticker ? { ticker } : {}),
        type: m[1]!,
        date: mdyToIso(m[2]) ?? m[2]!,
        ...(notified ? { notified } : {}),
        ...(range ? { amountLow: dollars(range[1]!), amountHigh: dollars(range[2]!) } : over ? { amountLow: dollars(over[1]!) } : {}),
      });
    });
  }
  return out;
}

/** One PTR's transactions (ticker, type, date, amount range), read from its PDF; links only when the text cannot be read. */
export async function housePtrTransactions(docId: string, opts: { year?: number; now?: Date } = {}): Promise<Dataset> {
  const id = docId.trim();
  if (!/^\d{4,12}$/.test(id)) throw new ProviderError(HOUSE_SOURCE, `"${docId}" is not a House DocID`, 400);
  const year = opts.year ?? (opts.now ?? clockNow()).getUTCFullYear();
  const url = `${BASE}/ptr-pdfs/${year}/${id}.pdf`;
  const res = await fetchBinary(url, { accept: "application/pdf,*/*" });
  if (!res.ok) throw new ProviderError(HOUSE_SOURCE, `${url} (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const text = await extractPdf(res.bytes);
  const rows = text.text ? parsePtrText(text.text) : [];
  const base: Point = { key: `US.house.ptr.${id}.document`, label: `House periodic transaction report ${id}`, value: url, url };
  const notes: string[] = [];
  if (!rows.length) notes.push(`transactions not readable from the PDF (${text.reason ?? "no row recognized"}) — open the link; scanned PTRs need OCR`);
  else notes.push(`rows parsed from text extracted by ${text.via ?? "the engine"} — best effort, check against the PDF; amounts are disclosed ranges`);
  const points: Point[] = [base];
  rows.forEach((r, i) => {
    const k = `US.house.ptr.${id}.${i + 1}`;
    const what = `House PTR ${id} row ${i + 1}: ${TYPE_NAMES[r.type] ?? r.type} on ${r.date}`;
    points.push({ key: `${k}.ticker`, label: `${what}, ticker`, value: r.ticker ?? "none", asOf: r.date, url });
    if (r.amountLow !== undefined) points.push({ key: `${k}.amountLow`, label: `${what}, amount range low`, value: r.amountLow, unit: "USD", asOf: r.date });
    if (r.amountHigh !== undefined)
      points.push({ key: `${k}.amountHigh`, label: `${what}, amount range high`, value: r.amountHigh, unit: "USD", asOf: r.date });
  });
  return {
    kind: "disclosures",
    title: `US House periodic transaction report ${id}`,
    subject: "US.house",
    points,
    provenance: { source: HOUSE_SOURCE, url, fetchedAt: res.fetchedAt, delay: "filing", official: true },
    notes,
  };
}
