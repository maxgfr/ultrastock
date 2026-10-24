// iShares (BlackRock) UCITS ETF holdings — keyless, from the issuer's product
// pages (the issuer publishing its own fund's holdings; a web download, not a
// regulatory filing, so marked unofficial):
//
//   https://www.ishares.com/uk/individual/en/products/<productId>/x/latest-holdings.csv
//
// The CSV opens with `Fund Holdings as of,"22/Oct/2026"`, a blank line, then a
// header (Ticker, Name, Sector, Asset Class, Market Value, Weight (%), …,
// Location, Exchange, Market Currency). The URL slug after the product id is
// ignored by the site. There is no keyless ISIN → product-id lookup (the old
// product screener is gone), so the ids are a table, each verified against the
// product page's title and ISIN on 2026-10-24; a fund missing from it is
// "unavailable", never guessed.
import { parseCsvText, parseLooseNumber } from "../../core/csv.js";
import { fetchText } from "../../core/net.js";
import { ProviderError } from "../types.js";
import type { FundComposition, FundLine } from "./common.js";

export const ISHARES_SOURCE = "ishares";

/** ISIN → iShares UK product id (one id per fund; other share classes of the same fund hold the same lines). */
export const ISHARES_PRODUCTS: Record<string, { id: string; name: string }> = {
  IE00B4L5Y983: { id: "251882", name: "iShares Core MSCI World UCITS ETF (SWDA/IWDA)" },
  IE00B5BMR087: { id: "253743", name: "iShares Core S&P 500 UCITS ETF (CSPX)" },
  IE00BKM4GZ66: { id: "264659", name: "iShares Core MSCI EM IMI UCITS ETF (EIMI)" },
  IE0008471009: { id: "251781", name: "iShares Core EURO STOXX 50 UCITS ETF (EUE)" },
  IE00B0M62S72: { id: "251787", name: "iShares Euro Dividend UCITS ETF (IDVY)" },
  IE0005042456: { id: "251795", name: "iShares Core FTSE 100 UCITS ETF (ISF)" },
  IE00B6R52259: { id: "251850", name: "iShares MSCI ACWI UCITS ETF (SSAC)" },
  IE00B0M63177: { id: "251857", name: "iShares MSCI EM UCITS ETF (IEEM)" },
  IE00BYXPSP02: { id: "287340", name: "iShares $ Treasury Bond 1-3yr UCITS ETF (IBTA)" },
  IE00BZCQB185: { id: "297617", name: "iShares MSCI India UCITS ETF (NDIA)" },
  IE00B53SZB19: { id: "253741", name: "iShares NASDAQ 100 UCITS ETF (CNDX)" },
  IE00B4K48X80: { id: "251861", name: "iShares Core MSCI Europe UCITS ETF (SMEA)" },
};

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  sept: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** "22/Oct/2026" → "2026-10-22". */
export function isharesDate(s: string | undefined): string | undefined {
  const m = /^(\d{1,2})\/([A-Za-z]{3,4})\/(\d{4})$/.exec((s ?? "").trim());
  const mm = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  return m && mm ? `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}` : undefined;
}

/**
 * The holdings CSV → lines, largest first. Weights are recomputed from market
 * values (the CSV's weight column is rounded to 0.01); derivative lines
 * (futures, with no market value) are dropped from the weights.
 */
export function parseIsharesHoldings(csv: string): { asOf?: string; lines: FundLine[] } {
  const rows = parseCsvText(csv, ",");
  const asOf = isharesDate(rows.find((r) => /holdings as of/i.test(r[0] ?? ""))?.[1]);
  const h = rows.findIndex((r) => r[0]?.trim() === "Ticker" && r.includes("Name"));
  if (h < 0) return { asOf, lines: [] };
  const header = rows[h]!.map((c) => c.trim());
  const col = (name: string) => header.indexOf(name);
  const [iName, iTicker, iSector, iClass, iMv, iW, iLoc] = ["Name", "Ticker", "Sector", "Asset Class", "Market Value", "Weight (%)", "Location"].map(col);
  const raw = rows.slice(h + 1).flatMap((r) => {
    if (r.length < header.length - 1) return [];
    const mv = iMv! >= 0 ? parseLooseNumber(r[iMv!]) : undefined;
    const w = iW! >= 0 ? parseLooseNumber(r[iW!]) : undefined;
    const name = (r[iName!] ?? "").trim();
    if (!name || (mv === undefined && w === undefined)) return [];
    return [{ name, ticker: r[iTicker!]?.trim(), sector: r[iSector!]?.trim(), assetClass: r[iClass!]?.trim(), country: r[iLoc!]?.trim(), mv, w }];
  });
  const total = raw.reduce((s, x) => s + (x.mv && x.mv > 0 ? x.mv : 0), 0);
  const lines = raw
    .map((x) => ({
      name: x.name,
      ...(x.ticker ? { ticker: x.ticker } : {}),
      ...(x.sector ? { sector: x.sector } : {}),
      ...(x.assetClass ? { assetClass: x.assetClass } : {}),
      ...(x.country && x.country !== "-" ? { country: x.country } : {}),
      weightPct: total > 0 ? ((x.mv && x.mv > 0 ? x.mv : 0) / total) * 100 : (x.w ?? 0),
    }))
    .filter((l) => l.weightPct > 0)
    .sort((a, b) => b.weightPct - a.weightPct);
  return { asOf, lines };
}

/** The latest holdings of an iShares fund by ISIN (only the funds in ISHARES_PRODUCTS). */
export async function isharesHoldings(isin: string): Promise<FundComposition> {
  const p = ISHARES_PRODUCTS[isin.toUpperCase()];
  if (!p) throw new ProviderError(ISHARES_SOURCE, `${isin} is not in the iShares product table (no keyless ISIN lookup exists)`, 404);
  const url = `https://www.ishares.com/uk/individual/en/products/${p.id}/x/latest-holdings.csv`;
  const res = await fetchText(url, { accept: "text/csv,text/plain,*/*" });
  if (!res.ok) throw new ProviderError(ISHARES_SOURCE, `holdings of ${isin} unavailable (HTTP ${res.status})`, res.status);
  const { asOf, lines } = parseIsharesHoldings(res.body);
  if (!lines.length) throw new ProviderError(ISHARES_SOURCE, `the holdings file of ${isin} has no lines (format changed?)`);
  return {
    fund: isin.toUpperCase(),
    source: ISHARES_SOURCE,
    url,
    fetchedAt: res.fetchedAt,
    asOf,
    lines,
    synthetic: false,
    official: false,
    notes: [`${p.name}: the issuer's daily holdings file; weights recomputed from market values (cash and derivatives included, futures excluded)`],
  };
}
