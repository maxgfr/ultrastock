// Amundi ETF data — keyless, the JSON API behind amundietf.fr's product pages
// (the issuer's own data; undocumented, so marked unofficial):
//
//   POST https://www.amundietf.fr/mapi/ProductAPI/getProductsData
//        {"context":{"countryCode":"FRA","languageCode":"fr","userProfileName":"RETAIL"},
//         "productIds":["LU1681043599"],"productType":"PRODUCT",
//         "characteristics":["SHARE_MARKETING_NAME","REPLICATION_METHODOLOGY","FUND_PEA"],
//         "composition":{"compositionFields":["date","isin","name","weight","sector","countryOfRisk","type"]}}
//
// One call returns the fund's characteristics (its PEA flag, replication
// method) and its composition. A non-Amundi ISIN comes back as no product.
// Swap ETFs (CW8, the PEA world trackers) hold a SUBSTITUTE BASKET of
// European shares and receive the index through the swap: their composition
// is the basket, so it is flagged synthetic and no exposure is drawn from it.
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import type { FundComposition, FundLine } from "./common.js";

export const AMUNDI_SOURCE = "amundi";
const AMUNDI_URL = "https://www.amundietf.fr/mapi/ProductAPI/getProductsData";

export interface AmundiProduct {
  productId: string;
  characteristics?: Record<string, unknown>;
  composition?: {
    totalNumberOfInstruments?: number;
    compositionData?: Array<{ compositionCharacteristics?: Record<string, unknown>; weight?: number }>;
  } | null;
}

/** The request body for one ISIN, with or without the composition. */
export function amundiRequest(isin: string, composition: boolean): Record<string, unknown> {
  return {
    context: { countryCode: "FRA", languageCode: "fr", userProfileName: "RETAIL" },
    productIds: [isin.toUpperCase()],
    productType: "PRODUCT",
    characteristics: ["SHARE_MARKETING_NAME", "REPLICATION_METHODOLOGY", "FUND_PEA", "ASSET_CLASS"],
    ...(composition ? { composition: { compositionFields: ["date", "isin", "name", "weight", "sector", "countryOfRisk", "type"] } } : {}),
  };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** One product → its PEA flag, replication, and lines (weights converted from fractions to %), largest first. */
export function parseAmundiProduct(p: AmundiProduct): {
  name?: string;
  pea?: boolean;
  replication?: string;
  synthetic: boolean;
  asOf?: string;
  lines: FundLine[];
} {
  const c = p.characteristics ?? {};
  const replication = str(c.REPLICATION_METHODOLOGY);
  const rows = p.composition?.compositionData ?? [];
  let asOf: string | undefined;
  const lines: FundLine[] = rows.flatMap((r) => {
    const cc = r.compositionCharacteristics ?? {};
    const w = typeof r.weight === "number" ? r.weight : typeof cc.weight === "number" ? cc.weight : undefined;
    const name = str(cc.name);
    if (!name || w === undefined) return [];
    const d = str(cc.date);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && (!asOf || d > asOf)) asOf = d;
    const isin = str(cc.isin);
    const sector = str(cc.sector);
    const country = str(cc.countryOfRisk);
    const assetClass = str(cc.type);
    return [
      {
        name,
        weightPct: w * 100,
        ...(isin ? { isin } : {}),
        ...(sector ? { sector } : {}),
        ...(country ? { country } : {}),
        ...(assetClass ? { assetClass } : {}),
      },
    ];
  });
  lines.sort((a, b) => b.weightPct - a.weightPct);
  return {
    name: str(c.SHARE_MARKETING_NAME),
    pea: typeof c.FUND_PEA === "boolean" ? c.FUND_PEA : undefined,
    replication,
    synthetic: /indirect|swap/i.test(replication ?? ""),
    asOf,
    lines,
  };
}

async function product(isin: string, composition: boolean) {
  const res = await fetchJson<{ products?: AmundiProduct[] }>(AMUNDI_URL, {
    method: "POST",
    json: amundiRequest(isin, composition),
    userAgent: "browser",
    hostIntervalMs: 500,
  });
  if (!res.ok || !res.data) throw new ProviderError(AMUNDI_SOURCE, `product data for ${isin} unavailable (HTTP ${res.status})`, res.status);
  const p = res.data.products?.find((x) => x.productId?.toUpperCase() === isin.toUpperCase());
  if (!p) throw new ProviderError(AMUNDI_SOURCE, `${isin} is not an Amundi product`, 404);
  return { p, url: res.url, fetchedAt: res.fetchedAt };
}

/** The issuer's PEA flag for an Amundi fund (FUND_PEA), with its name. */
export async function amundiPeaFlag(isin: string): Promise<{ pea?: boolean; name?: string; url: string; fetchedAt: string }> {
  const { p, url, fetchedAt } = await product(isin, false);
  const parsed = parseAmundiProduct(p);
  return { pea: parsed.pea, name: parsed.name, url, fetchedAt };
}

/** The composition of an Amundi fund, flagged synthetic for swap replication. */
export async function amundiHoldings(isin: string): Promise<FundComposition> {
  const { p, url, fetchedAt } = await product(isin, true);
  const parsed = parseAmundiProduct(p);
  if (!parsed.lines.length) throw new ProviderError(AMUNDI_SOURCE, `no composition published for ${isin}`, 404);
  return {
    fund: isin.toUpperCase(),
    source: AMUNDI_SOURCE,
    url,
    fetchedAt,
    asOf: parsed.asOf,
    lines: parsed.lines,
    synthetic: parsed.synthetic,
    official: false,
    notes: [
      `replication: ${parsed.replication ?? "not stated"}${parsed.pea !== undefined ? `; the issuer flags it ${parsed.pea ? "" : "NOT "}PEA-eligible` : ""}`,
      ...(p.composition?.totalNumberOfInstruments && p.composition.totalNumberOfInstruments > parsed.lines.length
        ? [`${parsed.lines.length} of ${p.composition.totalNumberOfInstruments} lines returned`]
        : []),
    ],
  };
}
