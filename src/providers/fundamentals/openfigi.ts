// OpenFIGI — identifier mapping (CUSIP, ISIN → ticker, exchange, FIGI) from the
// FIGI registration authority's documented public API, keyless:
//
//   POST https://api.openfigi.com/v3/mapping   [{idType, idValue, exchCode?}, …]
//
// Without an API key: at most 10 jobs per request and 25 requests a minute
// (paced at 2.5 s here). A documented API, but neither an exchange nor a
// regulator — marked unofficial. Used to put tickers on 13F CUSIPs.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson, politeUa } from "../../core/net.js";
import { ProviderError } from "../types.js";

export const FIGI_SOURCE = "openfigi";
const MAPPING_URL = "https://api.openfigi.com/v3/mapping";
const BATCH = 10;

export interface FigiJob {
  idType: "ID_CUSIP" | "ID_ISIN" | "TICKER" | "ID_BB_GLOBAL";
  idValue: string;
  exchCode?: string;
}

export interface FigiMatch {
  figi: string;
  ticker: string;
  exchCode: string;
  name: string;
  securityType: string;
  marketSector: string;
  compositeFIGI?: string;
}

/** "037833100" → ID_CUSIP (with exchCode US: the composite listing), "FR0000121014" → ID_ISIN. */
export function figiJobFor(id: string, exchCode?: string): FigiJob {
  const v = id.trim().toUpperCase();
  if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(v)) return { idType: "ID_ISIN", idValue: v, ...(exchCode ? { exchCode } : {}) };
  if (/^[0-9A-Z]{8}\d$/.test(v)) return { idType: "ID_CUSIP", idValue: v, exchCode: exchCode ?? "US" };
  if (/^BBG[0-9A-Z]{9}$/.test(v)) return { idType: "ID_BB_GLOBAL", idValue: v };
  return { idType: "TICKER", idValue: v, exchCode: exchCode ?? "US" };
}

/** The mapping answer, aligned with the jobs: the matches, or undefined for "No identifier found". */
export function parseFigiResponse(json: unknown): Array<FigiMatch[] | undefined> {
  if (!Array.isArray(json)) return [];
  return json.map((r) => {
    const data = (r as { data?: unknown[] })?.data;
    if (!Array.isArray(data)) return undefined;
    return data.map((d) => {
      const m = d as Record<string, string | undefined>;
      return {
        figi: m.figi ?? "",
        ticker: m.ticker ?? "",
        exchCode: m.exchCode ?? "",
        name: m.name ?? "",
        securityType: m.securityType ?? "",
        marketSector: m.marketSector ?? "",
        ...(m.compositeFIGI ? { compositeFIGI: m.compositeFIGI } : {}),
      };
    });
  });
}

/** Bloomberg exchange codes of an ISIN country's main market, to prefer the home listing. */
const HOME_EXCHANGE: Record<string, string> = {
  US: "US",
  FR: "FP",
  NL: "NA",
  BE: "BB",
  PT: "PL",
  IT: "IM",
  DE: "GY",
  ES: "SQ",
  GB: "LN",
  IE: "ID",
  CH: "SW",
  SE: "SS",
  DK: "DC",
  FI: "FH",
  NO: "NO",
  AT: "AV",
};

/** The listing to quote: the home market's (for an ISIN), else the composite one (figi = compositeFIGI), else the first. */
export function preferredFigi(ms: FigiMatch[] | undefined, isin?: string): FigiMatch | undefined {
  const home = isin ? HOME_EXCHANGE[isin.slice(0, 2).toUpperCase()] : undefined;
  return (home ? ms?.find((m) => m.exchCode === home) : undefined) ?? ms?.find((m) => m.figi === m.compositeFIGI) ?? ms?.[0];
}

/** Map jobs in batches of 10; one entry per job, undefined where OpenFIGI found nothing. */
export async function openfigiMap(jobs: FigiJob[]): Promise<{ results: Array<FigiMatch[] | undefined>; fetchedAt: string }> {
  const results: Array<FigiMatch[] | undefined> = [];
  let fetchedAt = "";
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    const res = await fetchJson<unknown>(MAPPING_URL, { method: "POST", json: batch, hostIntervalMs: 2500, userAgent: politeUa() });
    if (!res.ok || res.data === undefined)
      throw new ProviderError(FIGI_SOURCE, `mapping failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status === 429 ? 429 : res.status);
    const parsed = parseFigiResponse(res.data);
    for (let j = 0; j < batch.length; j++) results.push(parsed[j]);
    fetchedAt = res.fetchedAt;
  }
  return { results, fetchedAt };
}

const TICKER_RE = /^[A-Z0-9][A-Z0-9./ -]{0,19}$/;

/** Tickers for CUSIPs/ISINs: `<ID>.figi.ticker` (and the exchange code); the security name is external text. */
export async function openfigiIdentifiers(ids: string[], opts: { exchCode?: string } = {}): Promise<Dataset> {
  if (!ids.length) throw new ProviderError(FIGI_SOURCE, "no identifiers to map", 400);
  const jobs = ids.map((id) => figiJobFor(id, opts.exchCode));
  const { results, fetchedAt } = await openfigiMap(jobs);
  const points: Point[] = [];
  const missing: string[] = [];
  jobs.forEach((job, i) => {
    const m = preferredFigi(results[i], job.idType === "ID_ISIN" ? job.idValue : undefined);
    if (!m) {
      missing.push(job.idValue);
      return;
    }
    const id = job.idValue;
    points.push(
      {
        key: `${id}.figi.ticker`,
        label: `${id} ticker (${m.exchCode || "?"} listing)`,
        value: m.ticker,
        ...(TICKER_RE.test(m.ticker) ? {} : { untrusted: true }),
      },
      { key: `${id}.figi.figi`, label: `${id} FIGI`, value: m.figi },
      { key: `${id}.figi.name`, label: `${id} security name`, value: `${m.name} (${m.securityType})`, untrusted: true },
    );
  });
  if (!points.length) throw new ProviderError(FIGI_SOURCE, `no FIGI found for ${ids.join(", ")}`, 404);
  return {
    kind: "identifiers",
    title: "OpenFIGI identifier mapping",
    points,
    provenance: { source: FIGI_SOURCE, url: MAPPING_URL, fetchedAt, official: false },
    notes: [
      ...(missing.length ? [`no FIGI for ${missing.join(", ")}`] : []),
      "CUSIPs map to the US composite listing; ISINs to the home-market listing, else the composite one",
    ],
  };
}
