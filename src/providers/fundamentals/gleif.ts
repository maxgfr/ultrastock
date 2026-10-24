// GLEIF — the Global Legal Entity Identifier Foundation's golden copy of LEI
// records (official: the registry the regulators' Oversight Committee runs),
// keyless JSON:API:
//
//   by ISIN    https://api.gleif.org/api/v1/lei-records?filter[isin]=FR0000121014
//   by name    https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=…&page[size]=…
//
// The LEI is what EU filings are keyed by: ESEF reports on filings.xbrl.org are
// found by LEI, and an ISIN is how a user names a European share. Name search
// is a substring match and returns funds and vehicles too (LVMH → "ACTIONS
// LVMH", a fund): candidates, not an answer. LEI records change rarely —
// cached a week.
import { cachedJson, TTL } from "../../core/cache.js";
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";

export const GLEIF_SOURCE = "gleif";
const BASE = "https://api.gleif.org/api/v1/lei-records";

export interface LeiRecord {
  lei: string;
  /** Legal name as registered — external text. */
  legalName: string;
  country: string;
  jurisdiction: string;
  entityStatus: string;
  registrationStatus: string;
  lastUpdate: string;
}

type GleifJson = {
  data?: Array<{
    id?: string;
    attributes?: {
      entity?: { legalName?: { name?: string }; legalAddress?: { country?: string }; jurisdiction?: string; status?: string };
      registration?: { status?: string; lastUpdateDate?: string };
    };
  }>;
  meta?: { pagination?: { total?: number } };
};

/** A lei-records answer → records. */
export function parseLeiRecords(json: GleifJson): LeiRecord[] {
  return (json.data ?? []).flatMap((d) => {
    const a = d.attributes;
    if (!d.id || !a) return [];
    return [
      {
        lei: d.id,
        legalName: a.entity?.legalName?.name ?? "",
        country: a.entity?.legalAddress?.country ?? "",
        jurisdiction: a.entity?.jurisdiction ?? "",
        entityStatus: a.entity?.status ?? "",
        registrationStatus: a.registration?.status ?? "",
        lastUpdate: (a.registration?.lastUpdateDate ?? "").slice(0, 10),
      },
    ];
  });
}

export const isIsin = (s: string) => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s.trim().toUpperCase());

async function query(url: string): Promise<{ records: LeiRecord[]; url: string; fetchedAt: string }> {
  const res = await fetchJson<GleifJson>(url, { accept: "application/vnd.api+json, application/json" });
  if (!res.ok || !res.data) throw new ProviderError(GLEIF_SOURCE, `lookup failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  return { records: parseLeiRecords(res.data), url, fetchedAt: res.fetchedAt };
}

/** The LEI record of the issuer of an ISIN. */
export async function leiForIsin(isin: string): Promise<{ record: LeiRecord; url: string; fetchedAt: string }> {
  const v = isin.trim().toUpperCase();
  if (!isIsin(v)) throw new ProviderError(GLEIF_SOURCE, `"${isin}" is not an ISIN`, 400);
  const got = await cachedJson(`gleif:isin:${v}`, TTL.reference, async () => {
    const r = await query(`${BASE}?filter[isin]=${v}`);
    return r.records[0] ? { record: r.records[0], url: r.url, fetchedAt: r.fetchedAt } : undefined;
  });
  if (!got) throw new ProviderError(GLEIF_SOURCE, `no LEI linked to ISIN ${v}`, 404);
  return got;
}

const recordPoints = (r: LeiRecord, subject: string, i?: number): Point[] => {
  const k = i === undefined ? subject : `${subject}.${i + 1}`;
  return [
    {
      key: `${k}.lei`,
      label: `${subject} LEI${i === undefined ? "" : ` candidate ${i + 1}`} (${r.country}, ${r.registrationStatus})`,
      value: r.lei,
      asOf: r.lastUpdate || undefined,
    },
    { key: `${k}.legalName`, label: `${subject} legal name${i === undefined ? "" : ` candidate ${i + 1}`}`, value: r.legalName, untrusted: true },
  ];
};

/** `<ISIN>.lei` and the legal name for an ISIN. */
export async function gleifByIsin(isin: string): Promise<Dataset> {
  const { record, url, fetchedAt } = await leiForIsin(isin);
  const subject = isin.trim().toUpperCase();
  return {
    kind: "identifiers",
    title: `${subject} legal entity (GLEIF)`,
    subject,
    points: recordPoints(record, subject),
    provenance: { source: GLEIF_SOURCE, url, fetchedAt, official: true },
    notes: record.entityStatus === "ACTIVE" ? [] : [`entity status ${record.entityStatus || "unknown"}`],
  };
}

/** Candidate LEIs whose legal name contains `name` (issued registrations first). */
export async function gleifSearch(name: string, opts: { limit?: number } = {}): Promise<Dataset> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const r = await query(`${BASE}?filter[entity.legalName]=${encodeURIComponent(name.trim())}&page[size]=${limit}`);
  if (!r.records.length) throw new ProviderError(GLEIF_SOURCE, `no LEI record whose legal name contains "${name}"`, 404);
  const sorted = [...r.records].sort((a, b) => Number(b.registrationStatus === "ISSUED") - Number(a.registrationStatus === "ISSUED"));
  return {
    kind: "identifiers",
    title: "LEI candidates by legal name (GLEIF)",
    subject: "GLEIF",
    points: sorted.flatMap((rec, i) => recordPoints(rec, "GLEIF.search", i)),
    provenance: { source: GLEIF_SOURCE, url: r.url, fetchedAt: r.fetchedAt, official: true },
    notes: [
      "substring match on the legal name: funds and vehicles named after a company are listed too — pick by country and name, or look up the ISIN instead",
    ],
  };
}
