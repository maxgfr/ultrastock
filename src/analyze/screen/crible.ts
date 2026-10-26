// `screen --engine crible`: maxgfr/crible's fundamental screener (a local
// Python tool over a published dataset of audited filings, run through uvx).
// A query that names one of crible's presets runs that preset's DSL; anything
// else is passed to crible as DSL (`piotroski_f >= 7 AND country IN ('FR','DE')`).
// Presets come from crible itself (its MCP `presets` tool), never copied here,
// so `--list` shows exactly the DSL crible will run.
//
// Rows become points `<SYMBOL>.crible.<field>`: the identity (name, sector and
// industry untrusted), every field the query filters on, and the preset's
// columns. crible's ratios are fractions (0.15 = 15 %), kept as crible gives them.
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow } from "../../core/net.js";
import { type CribleScreen, cribleMcpCall, SOURCE } from "../../providers/external/crible.js";

export const CRIBLE_REPO_URL = "https://github.com/maxgfr/crible";

export interface CriblePreset {
  id: string;
  name: string;
  description: string;
  dsl: string;
  columns?: string[] | null;
}

/** crible's published presets, through its MCP server (no dataset needed). */
export async function criblePresets(): Promise<CriblePreset[]> {
  const r = await cribleMcpCall("presets", {});
  if (!Array.isArray(r)) return [];
  return r.filter(
    (p): p is CriblePreset => !!p && typeof p === "object" && typeof (p as CriblePreset).id === "string" && typeof (p as CriblePreset).dsl === "string",
  );
}

/** A query that can only be a preset id (no spaces, no operators). */
export const looksLikePresetId = (q: string) => /^[a-z0-9][a-z0-9-]*$/i.test(q.trim());

const KEYWORDS = new Set(["AND", "OR", "NOT", "IN", "TRUE", "FALSE"]);

/** The field names a DSL query filters on, in order (quoted strings and keywords skipped). */
export function dslFields(dsl: string): string[] {
  const bare = dsl.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, " ");
  const out: string[] = [];
  for (const m of bare.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) if (!KEYWORDS.has(m[0].toUpperCase()) && !out.includes(m[0])) out.push(m[0]);
  return out;
}

// crible holds one row per listing: an issuer also comes back on German regional
// exchanges, Vienna, the LSE order book and as an OTC ADR. A screen counts issuers,
// so the query keeps primary listings unless it already names which listings it wants.

/** The query restricted to primary listings, unless it already filters on listings or one symbol. */
export function primaryListingsOnly(dsl: string): string {
  if (/\bprimary_listing\b|\bsymbol\b/i.test(dsl)) return dsl;
  return dsl.trim() ? `(${dsl}) AND primary_listing = 1` : "primary_listing = 1";
}

/** crible's codes for the US over-the-counter markets. */
export const OTC_VENUES: ReadonlySet<string> = new Set(["PNK", "OQB", "OQX", "OTC", "OBB", "OEM"]);
/** US exchanges in crible's codes, OTC included: a US issuer's line anywhere else trades away from home. */
export const US_VENUES: ReadonlySet<string> = new Set(["NYQ", "NMS", "NGM", "NCM", "ASE", "PCX", "BTS", "NAS", "NYS", ...OTC_VENUES]);
const LEGAL =
  /\b(sponsored|unsponsored|adrs?|ads|[bcg]drs?|american depositary shares?|reg|shs|sa|se|nv|ag|plc|ltd|limited|inc|corp|corporation|co|company|group|holdings?|spa|oyj|asa|ab)\b/g;

/** An issuer name stripped of punctuation, legal forms and depositary wording. */
export function issuerKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\./g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(LEGAL, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A line traded away from the issuer's home market: for a non-US issuer an OTC
 * line or a US-ISIN depositary receipt; for a US issuer any line off the US
 * exchanges (a BDR in São Paulo, a CDR in Toronto, a Frankfurt or Mexico line).
 */
export function isForeignLine(row: Record<string, unknown>): boolean {
  const exchange = typeof row.exchange === "string" ? row.exchange : "";
  if (row.country === "US") return exchange !== "" && !US_VENUES.has(exchange);
  return OTC_VENUES.has(exchange) || String(row.isin ?? "").startsWith("US");
}

const RECEIPT_WORDING = /\b(?:ADRs?|ADS|GDRs?|CDRs?|BDRs?)\b(?!-)/;

/**
 * A depositary receipt: crible's `depositary_receipt` flag when the dataset has
 * it (crible ≥ 0.16), else a US ISIN on a non-US issuer or receipt wording in
 * the name ("Sponsored ADR", "… ADS", "CDR (CAD Hedged)").
 */
export function isDepositaryReceipt(row: Record<string, unknown>): boolean {
  const flag = row.depositary_receipt;
  if (typeof flag === "boolean") return flag;
  if (typeof flag === "number") return flag === 1;
  if (typeof row.country === "string" && row.country !== "US" && String(row.isin ?? "").startsWith("US")) return true;
  return RECEIPT_WORDING.test(String(row.name ?? ""));
}

/**
 * Drop the foreign lines (ADRs, OTC; a US issuer's lines off the US exchanges) of issuers whose home listing is in the same rows.
 * Share classes on their own market (A/B, preferred) are distinct instruments and stay.
 */
export function collapseForeignLines(rows: CribleScreen["rows"]): { rows: CribleScreen["rows"]; dropped: number } {
  const home = new Set(rows.filter((r) => typeof r.name === "string" && !isForeignLine(r)).map((r) => issuerKey(r.name as string)));
  const kept = rows.filter((r) => !(typeof r.name === "string" && isForeignLine(r) && home.has(issuerKey(r.name))));
  return { rows: kept, dropped: rows.length - kept.length };
}

const IDENTITY = ["name", "country", "sector", "industry", "currency"];
const CODE_FIELDS = new Set(["country", "currency", "exchange", "region", "symbol", "period", "price_asof"]);
const MONEY =
  /^(market_cap|enterprise_value|revenue|net_income|ebitda|ebit|free_cash_flow|operating_cashflow|total_assets|total_debt|total_equity|cash_and_equivalents|ncav|graham_number|dividends_paid|gross_profit|operating_income|close|price)$/;

/** The unit of a crible field: the row's currency for money, "rank", "score", "years", "shares", else "ratio". */
export function cribleUnitOf(field: string, currency: unknown): string | undefined {
  if (MONEY.test(field)) return typeof currency === "string" ? currency : undefined;
  if (/_rank$/.test(field)) return "rank";
  if (/^(piotroski_f|altman_z|altman_z_double_prime|beneish_m|montier_c|mohanram_g|zmijewski_score|ohlson_o|dechow_f)$/.test(field)) return "score";
  if (/_years_/.test(field)) return "years";
  if (/^shares/.test(field)) return "shares";
  // Everything else crible computes is a ratio or a fraction (0.15 = 15 %).
  return "ratio";
}

/** A crible screen result as one dataset: a match count, then one block of points per row. */
export function cribleRowsToDataset(
  r: CribleScreen,
  opts: { query: string; preset?: CriblePreset; fetchedAt?: string; offset?: number; dsl?: string; dropped?: number },
): Dataset {
  const fields = [...new Set([...IDENTITY, ...dslFields(opts.query), ...(opts.preset?.columns ?? []), "market_cap"])];
  const fetchedAt = opts.fetchedAt ?? clockNow().toISOString();
  const pid = opts.preset?.id.replace(/[^a-z0-9-]/gi, "");
  const label = pid ? `preset ${pid}` : "query";
  const day = fetchedAt.slice(0, 10);
  // The DSL and the preset's description are crible's text (or the user's): data, fenced as untrusted.
  const points: Point[] = [
    {
      key: "CRIBLE.screen.query",
      label: `crible DSL run for the ${label}`,
      value: opts.dsl ?? opts.preset?.dsl ?? (opts.query || "(no filter)"),
      untrusted: true,
      asOf: day,
    },
    ...(opts.preset ? [{ key: "CRIBLE.screen.preset", label: "crible preset description", value: opts.preset.description, untrusted: true, asOf: day }] : []),
    { key: "CRIBLE.screen.matches", label: `crible matches for the ${label}`, value: r.total, unit: "count", asOf: day },
  ];
  let latest = "";
  r.rows.forEach((row, i) => {
    const sym = typeof row.symbol === "string" ? row.symbol : undefined;
    if (!sym) return;
    const period = typeof row.period === "string" ? row.period.slice(0, 10) : undefined;
    const priced = typeof row.price_asof === "string" ? row.price_asof.slice(0, 10) : undefined;
    // A period may be a bare fiscal year ("2025"): only a full date is an asOf.
    const isDay = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
    const asOf = isDay(period) ?? isDay(priced);
    if (asOf && asOf > latest) latest = asOf;
    const at = asOf ? { asOf } : {};
    points.push({ key: `${sym}.crible.rank`, label: `${sym} position in the crible ${label}`, value: (opts.offset ?? 0) + i + 1, unit: "rank", ...at });
    for (const f of fields) {
      const v = row[f];
      if (v === null || v === undefined || f === "symbol") continue;
      const key = `${sym}.crible.${f}`;
      const lbl = `${sym} ${f.replace(/_/g, " ")}${period && !IDENTITY.includes(f) ? ` (period ${period})` : ""}`;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) continue;
        const unit = cribleUnitOf(f, row.currency);
        points.push({ key, label: lbl, value: v, ...(unit ? { unit } : {}), ...at });
      } else if (typeof v === "string") points.push({ key, label: lbl, value: v, ...(CODE_FIELDS.has(f) ? {} : { untrusted: true }), ...at });
      else if (typeof v === "boolean") points.push({ key, label: lbl, value: v, ...at });
    }
  });
  const notes = [
    `showing ${r.rows.length} of ${r.total} matches`,
    ...(opts.dsl && opts.dsl !== (opts.preset?.dsl ?? opts.query)
      ? ["primary listings only (one row per listing otherwise): --all-listings keeps the regional, order-book and OTC lines"]
      : []),
    ...(opts.dropped ? [`${opts.dropped} ADR / OTC line(s) dropped: the issuer's home listing is in the results`] : []),
    "crible aggregates audited filings (SEC, ESEF, registers) and market data; ratios are fractions (0.15 = 15 %); check a figure that matters against the filing",
  ];
  return {
    kind: "screen",
    title: `Screen — crible ${pid ? `preset ${pid}` : "DSL query"}`,
    subject: pid ?? "crible",
    points,
    provenance: { source: SOURCE, url: CRIBLE_REPO_URL, fetchedAt, official: false, delay: "filing", ...(latest ? { asOf: latest } : {}) },
    notes,
  };
}
