// Euronext — Paris, Amsterdam, Brussels, Lisbon, Milan, Oslo, Dublin — read from
// the exchange's own site, keyless:
//
//   instrument search   /en/instrumentSearch/searchJSON?q=<ticker|isin|name>
//   historical prices   /en/ajax/AwlHistoricalPrice/getFullDownloadAjax/<ISIN>-<MIC>?format=csv…
//
// The historical CSV is the official end-of-day record (open, high, low, last,
// close, shares, trades, turnover, VWAP), adjusted for corporate actions, and
// covers about the last two years: older windows come back empty.
import { cachedJson, TTL } from "../core/cache.js";
import { decodeEntities, stripTags } from "../engine.js";
import { parseCsvText, parseLooseNumber } from "../core/csv.js";
import { fetchJson, fetchText } from "../core/net.js";
import { type AssetKind, type Bar, type Instrument, type PriceSeries, ProviderError } from "./types.js";

const BASE = "https://live.euronext.com";
export const SOURCE = "euronext";

/** The listing venues a Yahoo-style suffix stands for, preferred first. */
export const SUFFIX_MICS: Record<string, string[]> = {
  PA: ["XPAR", "ALXP", "XMLI"],
  AS: ["XAMS", "TNLA"],
  BR: ["XBRU", "ALXB"],
  LS: ["XLIS", "ALXL"],
  MI: ["MTAA", "EXGM"],
  OL: ["XOSL", "MERK", "XOAS"],
  IR: ["XMSM", "XESM"],
};

const MIC_CURRENCY: Record<string, string> = { XOSL: "NOK", MERK: "NOK", XOAS: "NOK" };

export interface EuronextListing {
  isin: string;
  mic: string;
  symbol: string;
  name: string;
  kind: AssetKind;
}

function kindFromLink(link: string): AssetKind | undefined {
  if (link.includes("/equities/")) return "equity";
  if (link.includes("/etfs/") || link.includes("/etvs/") || link.includes("/trackers/")) return "etf";
  if (link.includes("/indices/")) return "index";
  if (link.includes("/funds/")) return "fund";
  return undefined; // options, futures, bonds, warrants: not instruments this tool prices
}

/** Every cash listing matching a ticker, an ISIN or a name. */
export async function searchEuronext(query: string): Promise<EuronextListing[]> {
  const url = `${BASE}/en/instrumentSearch/searchJSON?q=${encodeURIComponent(query)}`;
  const listings = await cachedJson(`euronext:search:${query.toUpperCase()}`, TTL.reference, async () => {
    const res = await fetchJson<Array<{ isin?: string; mic?: string; label?: string; link?: string; name?: string }>>(url);
    if (!res.ok || !Array.isArray(res.data))
      throw new ProviderError(SOURCE, `instrument search failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
    const out: EuronextListing[] = [];
    for (const r of res.data) {
      const kind = r.link ? kindFromLink(r.link) : undefined;
      if (!kind || !r.isin || !r.mic) continue;
      const symbol = /class=.symbol.>([^<]*)</.exec(r.label ?? "")?.[1] ?? "";
      const name = decodeEntities(stripTags(/class=.name.>(.*?)<\/span>/.exec(r.label ?? "")?.[1] ?? r.name ?? "")).trim();
      out.push({ isin: r.isin, mic: r.mic, symbol: symbol.trim(), name, kind });
    }
    return out;
  });
  return listings ?? [];
}

/**
 * The listing for `MC.PA` (ticker + suffix) or an ISIN. Picks the venue the
 * suffix names, its main market before its growth segment; for a bare ISIN,
 * Paris first, then the first cash listing found.
 */
export async function resolveEuronext(symbol: string): Promise<Instrument> {
  const m = /^([A-Z0-9-]+)\.([A-Z]{2})$/i.exec(symbol);
  const isIsin = /^[A-Z]{2}[A-Z0-9]{9}\d$/i.test(symbol);
  const query = m ? m[1]! : symbol;
  const listings = await searchEuronext(query);
  let pick: EuronextListing | undefined;
  if (m) {
    const mics = SUFFIX_MICS[m[2]!.toUpperCase()];
    if (!mics) throw new ProviderError(SOURCE, `".${m[2]}" is not a Euronext market suffix (${Object.keys(SUFFIX_MICS).join(", ")})`);
    for (const mic of mics) {
      pick = listings.find((l) => l.mic === mic && l.symbol.toUpperCase() === m[1]!.toUpperCase());
      if (pick) break;
    }
  } else if (isIsin) {
    const same = listings.filter((l) => l.isin.toUpperCase() === symbol.toUpperCase());
    pick = same.find((l) => l.mic === "XPAR") ?? same[0];
  }
  if (!pick) throw new ProviderError(SOURCE, `no Euronext listing for ${symbol}`);
  const suffix = Object.entries(SUFFIX_MICS).find(([, mics]) => mics.includes(pick!.mic))?.[0];
  return {
    symbol: m ? `${m[1]!.toUpperCase()}.${m[2]!.toUpperCase()}` : suffix ? `${pick.symbol}.${suffix}` : symbol.toUpperCase(),
    market: "euronext",
    kind: pick.kind,
    name: pick.name,
    isin: pick.isin,
    mic: pick.mic,
    currency: MIC_CURRENCY[pick.mic] ?? "EUR",
    venueId: `${pick.isin}-${pick.mic}`,
  };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Parse the historical-download CSV; rows come newest first and leave oldest first. */
export function parseEuronextHistory(csv: string): Bar[] {
  const rows = parseCsvText(csv, ";");
  const at = rows.findIndex((r) => r[0]?.trim() === "Date");
  if (at < 0) return [];
  const header = rows[at]!.map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [iDate, iOpen, iHigh, iLow, iClose, iShares, iTrades, iVwap] = [
    "date",
    "open",
    "high",
    "low",
    "close",
    "number of shares",
    "number of trades",
    "vwap",
  ].map(col);
  const bars: Bar[] = [];
  for (const r of rows.slice(at + 1)) {
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(r[iDate!]?.trim() ?? "");
    const close = parseLooseNumber(r[iClose!]);
    if (!dm || close === undefined) continue;
    const open = parseLooseNumber(r[iOpen!]) ?? close;
    const high = parseLooseNumber(r[iHigh!]) ?? Math.max(open, close);
    const low = parseLooseNumber(r[iLow!]) ?? Math.min(open, close);
    const bar: Bar = { date: `${dm[3]}-${dm[2]}-${dm[1]}`, open, high, low, close };
    const volume = iShares! >= 0 ? parseLooseNumber(r[iShares!]) : undefined;
    if (volume !== undefined) bar.volume = volume;
    const trades = iTrades! >= 0 ? parseLooseNumber(r[iTrades!]) : undefined;
    if (trades !== undefined) bar.trades = trades;
    // The CSV's last column is unlabelled on index rows and labelled `vwap` on cash rows.
    const vwap = iVwap! >= 0 ? parseLooseNumber(r[iVwap!]) : undefined;
    if (vwap !== undefined && vwap > 0) bar.vwap = vwap;
    bars.push(bar);
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

/** Daily bars between two dates (inclusive), official and adjusted. */
export async function euronextHistory(instrument: Instrument, from: Date, to: Date): Promise<PriceSeries> {
  const url =
    `${BASE}/en/ajax/AwlHistoricalPrice/getFullDownloadAjax/${instrument.venueId}` +
    `?format=csv&decimal_separator=.&date_form=d/m/Y&op=&adjusted=Y&base100=&startdate=${isoDay(from)}&enddate=${isoDay(to)}`;
  const res = await fetchText(url, { accept: "text/csv,*/*" });
  if (!res.ok)
    throw new ProviderError(SOURCE, `historical download failed for ${instrument.venueId} (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const bars = parseEuronextHistory(res.body);
  if (!bars.length)
    throw new ProviderError(SOURCE, `no bars for ${instrument.venueId} between ${isoDay(from)} and ${isoDay(to)} — Euronext serves about two years`);
  const notes: string[] = [];
  if (bars[0]!.date > isoDay(new Date(from.getTime() + 7 * 86400_000)))
    notes.push(`Euronext served history from ${bars[0]!.date} only (it keeps about two years)`);
  return {
    instrument,
    interval: "1d",
    bars,
    adjusted: true,
    provenance: { source: SOURCE, url: res.url, fetchedAt: res.fetchedAt, delay: "eod", official: true },
    notes,
  };
}
