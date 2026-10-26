// ETFs that really work: what a fund is (TradingView's fund columns), how it
// replicates, whether it fits a PEA, where it is domiciled and what that means
// for withholding and PRIIPs, what it holds (iShares, Amundi, SEC N-PORT), how
// its NAV tracks the other funds on the same index, and the multiples of its
// top holdings (crible). `analyze` writes it all to ETF.md; `etf compare`,
// `etf overlap` and `etf find` reuse the same pieces.
//
// Three decisions are made here, each with its basis, never guessed:
//   replication  the issuer's field (Amundi) → "Swap" in the name → unknown.
//                A swap ETF's lines are a substitute basket: no look-through.
//   PEA          the issuer's flag (Amundi FUND_PEA) → "PEA" in the name, as a
//                hint only → unknown (check the KID or the broker). NEVER from
//                the domicile: CW8 is domiciled in Luxembourg and PEA-eligible.
//   domicile     TradingView's country_code_fund → the ISIN's country prefix →
//                "US" for a US listing.
// Names, index labels and issuer strings are external text: untrusted points.
import { join } from "node:path";
import { simpleReturns } from "../analytics/performance.js";
import { correlation } from "../analytics/stats.js";
import { type Dataset, formatDatasets, type Point, type Registered, registerDatasets } from "../core/datasets.js";
import { EvidenceStore, formatEvidence, formatNumber } from "../core/evidence.js";
import { ruleStatus } from "../core/jurisdiction.js";
import { clockNow, netMode } from "../core/net.js";
import { loadProfile } from "../core/profile.js";
import { mapLimit, writeArtifact } from "../engine.js";
import { cribleAvailable, cribleBootstrapped, cribleScreen } from "../providers/external/crible.js";
import { type AmundiFacts, amundiFacts, amundiHoldings } from "../providers/funds/amundi.js";
import { compositionDataset, type FundComposition, type FundLine } from "../providers/funds/common.js";
import { ISHARES_PRODUCTS, isharesHoldings } from "../providers/funds/ishares.js";
import { nportHoldings } from "../providers/funds/nport.js";
import { toTradingViewTicker, TV_ETF_COLUMNS, type TvFilter, tradingviewScan } from "../providers/markets/tradingview.js";
import { getHistory, resolveSymbol } from "../providers/router.js";
import type { Bar, Instrument } from "../providers/types.js";
import { scanMatches, type TvMatch } from "./screen/tradingview.js";

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

// ─── index names ────────────────────────────────────────────────────────────

const CURRENCIES = new Set(["usd", "eur", "gbp", "chf", "jpy", "cad", "aud", "sek", "nok", "dkk", "hkd", "sgd", "cny", "inr", "krw", "brl", "mxn", "zar"]);
const TRAILING = new Set(["index", "tr", "nr", "net", "gross", "benchmark", "return", "returns", "total", "price", "variant", "net_return", "pr", "gr"]);

/**
 * An index name reduced to what identifies the index, so the same index read
 * from two funds compares equal: lower case, without the currency, the
 * TR/NR/Net/Gross/Benchmark suffixes, "Index" and TradingView's "DUPE - <id>"
 * prefixes. "MSCI World Index - EUR - Benchmark TR Net" → "msci world";
 * "Nasdaq-100 Index" → "nasdaq 100". A hedge stays: "… 100% Hedged to EUR" keeps "eur".
 */
export function normalizeIndexName(raw: string): string {
  let s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:dupe\s*-\s*)+/, "");
  s = s
    .split(/\s+-\s+/)
    .map((x) => x.trim())
    .filter((seg) => seg && !CURRENCIES.has(seg) && !/^[a-z]{1,4}\d{4,}$/.test(seg) && seg !== "dupe")
    .join(" ");
  s = s.replace(/\((?:nr|tr|net|gross|usd|eur|gbp|chf|jpy|net return|total return|price return|net tr)\)/g, " ");
  s = s.replace(/\bbenchmark(?:\s+(?:tr|nr))?(?:\s+(?:net|gross))?\b/g, " ");
  s = s.replace(/\b(?:(?:net|gross|price)\s+)?total\s+return\b|\b(?:net|gross|price)\s+return\b|\bnet_return\b|\btr\s+(?:net|gross)\b/g, " ");
  s = s.replace(/\bindex\b/g, " ");
  s = s.replace(/([a-z0-9&])-(?=[a-z0-9])/g, "$1 ");
  s = s.replace(/[,;:]+/g, " ");
  const words = s.split(" ").filter(Boolean);
  while (words.length > 1) {
    const last = words[words.length - 1]!;
    const before = words[words.length - 2];
    if (TRAILING.has(last) || (CURRENCIES.has(last) && before !== "to" && before !== "hedged" && before !== "in")) words.pop();
    else break;
  }
  return words.join(" ");
}

// ─── decisions ──────────────────────────────────────────────────────────────

export interface Decision {
  value: string;
  /** What the value rests on, in words — the evidence's formula. */
  basis: string;
}

/** Replication: the issuer's field, then "Swap" in the name, else unknown. */
export function etfReplication(input: { issuer?: string; name?: string }): Decision & { synthetic: boolean } {
  const issuer = input.issuer?.trim();
  if (issuer) {
    if (/indirect|swap|synthetic/i.test(issuer))
      return { value: "synthetic (swap)", synthetic: true, basis: "the issuer's replication field (Amundi REPLICATION_METHODOLOGY) says indirect / swap" };
    if (/direct|physical/i.test(issuer))
      return {
        value: /sampl|optimi/i.test(issuer) ? "physical (sampling)" : "physical",
        synthetic: false,
        basis: "the issuer's replication field (Amundi REPLICATION_METHODOLOGY) says direct / physical",
      };
  }
  if (input.name && /\bswap\b/i.test(input.name))
    return { value: "synthetic (swap)", synthetic: true, basis: 'the fund\'s name contains "Swap" (no issuer field read)' };
  return { value: "unknown", synthetic: false, basis: "no source read here states it (the issuer field is read for Amundi funds only)" };
}

export const PEA_UNKNOWN = "unknown — check the KID or the broker";

/** PEA: the issuer's flag, then "PEA" in the name as a hint, else unknown. Never from the domicile. */
export function etfPeaStatus(input: { issuerFlag?: boolean; name?: string }): Decision & { eligible?: boolean; hint?: boolean } {
  if (input.issuerFlag === true) return { value: "eligible (issuer flag)", eligible: true, basis: "the issuer's PEA flag (Amundi FUND_PEA = true)" };
  if (input.issuerFlag === false) return { value: "not eligible (issuer flag)", eligible: false, basis: "the issuer's PEA flag (Amundi FUND_PEA = false)" };
  if (input.name && /\bPEA\b/i.test(input.name))
    return {
      value: "hint: the name says PEA — confirm with the KID or the broker",
      hint: true,
      basis: 'the fund\'s name contains "PEA" — a marketing name, not proof of eligibility',
    };
  return { value: PEA_UNKNOWN, basis: "no issuer flag read (Amundi funds only) and no hint in the name; the domicile says nothing about PEA eligibility" };
}

/** Domicile: TradingView's fund country, then the ISIN prefix, then "US" for a US listing. */
export function etfDomicile(input: { fundCountry?: string; isin?: string; market?: string }): { code?: string; basis: string } {
  const fc = input.fundCountry?.trim().toUpperCase();
  if (fc && /^[A-Z]{2}$/.test(fc)) return { code: fc, basis: "TradingView's fund domicile (country_code_fund)" };
  const isin = input.isin?.trim().toUpperCase();
  if (isin && ISIN_RE.test(isin) && isin.slice(0, 2) !== "XS")
    return { code: isin.slice(0, 2), basis: "the ISIN's country prefix (a fund's ISIN is issued in its domicile)" };
  if (input.market === "us") return { code: "US", basis: "a US listing with no fund domicile read — US-listed ETFs are US-domiciled" };
  return { basis: "no fund domicile, ISIN or US listing to read it from" };
}

/** What the domicile means for withholding tax — qualitative, no rates: they depend on the treaty and the investor. */
export function withholdingNote(code: string | undefined): string {
  switch (code) {
    case "IE":
      return "Ireland (UCITS): Ireland's tax treaty with the US generally lets an Irish fund suffer a reduced US withholding tax on US dividends, and Ireland does not withhold on distributions to non-resident investors who qualify; foreign dividends from other countries are withheld under each country's own treaty with Ireland.";
    case "LU":
      return "Luxembourg (UCITS): a Luxembourg fund holding US shares directly usually cannot claim the US treaty rate, so the full US withholding tends to apply at the fund level; a swap ETF receives the index's net return from its counterparty (the index methodology sets the withholding assumed).";
    case "FR":
      return "France (UCITS): a French fund is taxed on foreign dividends under France's treaties; a swap fund receives the index's net return through the swap. For a French resident, the PEA / CTO envelope decides the investor-level tax, not the domicile.";
    case "US":
      return "United States: a non-US investor's distributions from a US fund are subject to US withholding at the treaty rate (form W-8BEN), on top of the withholding the fund itself suffers abroad; US-situs assets can also raise US estate-tax questions for non-residents. In the EU, US-domiciled ETFs have no PRIIPs KID.";
    case "DE":
      return "Germany: a German fund is subject to the German investment tax regime (Investmentsteuergesetz) at the fund level; foreign investors should check the treaty treatment of its distributions.";
    case undefined:
      return "domicile unknown: the withholding tax a fund suffers (and passes on) depends on its domicile — read it in the KID or prospectus.";
    default:
      return `domicile ${code}: the withholding the fund suffers on foreign dividends depends on ${code}'s tax treaties — read the prospectus; no rule is recorded here for this domicile.`;
  }
}

// ─── overlap ────────────────────────────────────────────────────────────────

const SUFFIXES =
  /\b(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|sa|nv|ag|se|spa|asa|ab|oyj|holdings?|group|class [a-z]|cl [a-z]|common stock|ord|reg|registered|shs|adr)\b/g;

/** A security name reduced for matching across issuers' files: "NVIDIA CORP" ≈ "Nvidia Corporation". */
export function holdingNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'’()&/-]/g, " ")
    .replace(SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOT_A_SECURITY = /cash|money market|future|forward|derivative|swap|currency|fx |margin|collateral/i;

/** The lines that are securities (cash, futures and currency lines dropped). */
function securityLines(lines: readonly FundLine[]): FundLine[] {
  return lines.filter((l) => l.weightPct > 0 && !(l.assetClass && NOT_A_SECURITY.test(l.assetClass)) && !/^(?:[a-z]{3} )?cash\b/i.test(l.name));
}

export interface OverlapResult {
  /** Σ min(weight in A, weight in B), in %. */
  overlapPct: number;
  /** Common lines, largest shared weight first. */
  common: Array<{ name: string; isin?: string; ticker?: string; a: number; b: number; min: number }>;
  aLines: number;
  bLines: number;
}

/**
 * The overlap of two funds: the sum over common lines of the smaller weight
 * (the share of A's money that sits in what B also holds). Lines match by
 * ISIN, then ticker, then a normalised name; each line is matched once.
 */
export function etfOverlap(a: readonly FundLine[], b: readonly FundLine[]): OverlapResult {
  const A = securityLines(a);
  const B = securityLines(b);
  const used = new Set<number>();
  const byIsin = new Map<string, number>();
  const byTicker = new Map<string, number>();
  const byName = new Map<string, number>();
  B.forEach((l, i) => {
    if (l.isin && !byIsin.has(l.isin.toUpperCase())) byIsin.set(l.isin.toUpperCase(), i);
    if (l.ticker && !byTicker.has(l.ticker.toUpperCase())) byTicker.set(l.ticker.toUpperCase(), i);
    const n = holdingNameKey(l.name);
    if (n && !byName.has(n)) byName.set(n, i);
  });
  const common: OverlapResult["common"] = [];
  for (const l of A) {
    const cands = [
      l.isin ? byIsin.get(l.isin.toUpperCase()) : undefined,
      l.ticker ? byTicker.get(l.ticker.toUpperCase()) : undefined,
      byName.get(holdingNameKey(l.name)),
    ];
    const j = cands.find((x): x is number => x !== undefined && !used.has(x));
    if (j === undefined) continue;
    used.add(j);
    const m = B[j]!;
    common.push({
      name: l.name,
      ...(l.isin || m.isin ? { isin: l.isin ?? m.isin } : {}),
      ...(l.ticker || m.ticker ? { ticker: l.ticker ?? m.ticker } : {}),
      a: l.weightPct,
      b: m.weightPct,
      min: Math.min(l.weightPct, m.weightPct),
    });
  }
  common.sort((x, y) => y.min - x.min);
  return { overlapPct: common.reduce((s, c) => s + c.min, 0), common, aLines: A.length, bLines: B.length };
}

// ─── TradingView ────────────────────────────────────────────────────────────

const US_EXCHANGES = ["AMEX", "NASDAQ", "NYSE", "CBOE"];

/** The TradingView tickers a symbol may be: a mapped one, or a bare US ticker on each US exchange. */
export function etfTvTickers(symbol: string): string[] {
  const t = toTradingViewTicker(symbol);
  if (t) return [t];
  const s = symbol.trim().toUpperCase().replace(/\.US$/, "");
  if (/^[A-Z][A-Z0-9.]{0,6}$/.test(s) && !ISIN_RE.test(s)) return US_EXCHANGES.map((e) => `${e}:${s}`);
  return [];
}

/** Listing preference when several listings of one fund come back (European venues first, then US). */
const EXCHANGE_RANK = ["EURONEXT", "XETR", "MIL", "SIX", "LSE", "AMEX", "NASDAQ", "NYSE", "CBOE"];
const exchangeRank = (ticker: string) => {
  const ex = ticker.split(":")[0]!;
  const i = EXCHANGE_RANK.indexOf(ex);
  return (i < 0 ? EXCHANGE_RANK.length : i) * 2 + (/[-./]/.test(ticker.split(":")[1] ?? "") ? 1 : 0);
};

/**
 * One row per ISIN, keeping the preferred listing (in `currency` when given,
 * then by venue); rows without an ISIN pass. Order of first appearance.
 */
export function dedupeListings(rows: readonly TvMatch[], currency?: string): TvMatch[] {
  const rank = (m: TvMatch) => (currency && tvStr(m, "currency") !== currency ? 100 : 0) + exchangeRank(m.ticker);
  const best = new Map<string, TvMatch>();
  const order: string[] = [];
  const loose: TvMatch[] = [];
  for (const m of rows) {
    const isin = m.points.get("isin")?.value;
    if (typeof isin !== "string") {
      loose.push(m);
      continue;
    }
    const cur = best.get(isin);
    if (!cur) {
      best.set(isin, m);
      order.push(isin);
    } else if (rank(m) < rank(cur)) best.set(isin, m);
  }
  return [...order.map((i) => best.get(i)!), ...loose];
}

export const tvNum = (m: TvMatch | undefined, col: string): number | undefined => {
  const v = m?.points.get(col)?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};
export const tvStr = (m: TvMatch | undefined, col: string): string | undefined => {
  const v = m?.points.get(col)?.value;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** A dataset of one scanned row: the row's points under the scan's provenance. */
function rowDataset(m: TvMatch, scan: Dataset, title: string, subject: string): Dataset {
  return {
    kind: "etf",
    title,
    subject,
    points: [...m.points.values(), ...m.derived],
    provenance: scan.provenance,
    notes: ["unofficial endpoint (TradingView's screener backend); delayed snapshot — AUM, NAV and flows are in the reporting currency it states"],
  };
}

export interface EtfListing {
  /** The symbol as asked. */
  symbol: string;
  /** The TradingView row, when one answered. */
  tv?: TvMatch;
  /** The scan dataset it came from (provenance). */
  scan?: Dataset;
  error?: string;
}

/**
 * The fund columns of several ETFs, in one TradingView call (an ISIN, or a
 * symbol TradingView cannot map, gets a second call filtering on the ISIN).
 */
export async function etfListings(symbols: readonly string[], isins: Record<string, string | undefined> = {}): Promise<EtfListing[]> {
  const cands = symbols.map((s) => etfTvTickers(s));
  const tickers = [...new Set(cands.flat())];
  const out: EtfListing[] = symbols.map((symbol) => ({ symbol }));
  if (tickers.length) {
    const scan = await tradingviewScan("global", { tickers, columns: TV_ETF_COLUMNS, range: [0, tickers.length] });
    const rows = new Map(scanMatches(scan, "global").map((m) => [m.ticker, m]));
    symbols.forEach((_, i) => {
      const hit = cands[i]!.map((t) => rows.get(t)).find((m) => m);
      if (hit) Object.assign(out[i]!, { tv: hit, scan });
    });
  }
  for (const [i, l] of out.entries()) {
    if (l.tv) continue;
    const isin = (ISIN_RE.test(l.symbol.toUpperCase()) ? l.symbol.toUpperCase() : undefined) ?? isins[symbols[i]!];
    if (!isin) {
      l.error = `TradingView has no listing for ${l.symbol}`;
      continue;
    }
    try {
      const scan = await tradingviewScan("global", {
        filter: [{ left: "isin", operation: "equal", right: isin }],
        columns: TV_ETF_COLUMNS,
        sort: { sortBy: "aum", sortOrder: "desc" },
        range: [0, 20],
      });
      const best = dedupeListings(scanMatches(scan, "global"))[0];
      if (best) Object.assign(l, { tv: best, scan });
      else l.error = `TradingView has no listing with ISIN ${isin}`;
    } catch (e) {
      l.error = (e as Error).message;
    }
  }
  return out;
}

const PEER_COLUMNS = [
  "description",
  "currency",
  "fundamental_currency_code",
  "isin",
  "index_tracked",
  "etf_fund_currency",
  "expense_ratio",
  "aum",
  "nav_total_return.1Y",
  "nav_total_return.3Y",
  "ucits_compliant_flag",
  "country_code_fund",
  "dividend_treatment",
] as const;

/**
 * Listings of the funds on the same index (normalised name), largest first —
 * every listing, to be deduplicated by the caller in the currency it needs:
 * TradingView's NAV returns are in each LISTING's currency (IWDA: 17.7 % in
 * EUR on Euronext, 13.6 % in USD in London, same fund, same day). Its
 * is_primary is not used: some funds have no listing flagged primary (EWLD).
 */
export async function sameIndexFunds(indexName: string): Promise<{ scan: Dataset; rows: TvMatch[]; target: string }> {
  const target = normalizeIndexName(indexName);
  if (!target) throw new Error("no index name to search for");
  const scan = await tradingviewScan("global", {
    filter: [
      { left: "typespecs", operation: "has", right: ["etf"] },
      { left: "index_tracked", operation: "match", right: target },
    ],
    columns: PEER_COLUMNS,
    sort: { sortBy: "aum", sortOrder: "desc" },
    range: [0, 500],
  });
  const rows = scanMatches(scan, "global").filter((m) => {
    const idx = tvStr(m, "index_tracked");
    return idx !== undefined && normalizeIndexName(idx) === target;
  });
  return { scan, rows, target };
}

/** UCITS funds first by TER (ascending), then AUM (descending). */
export function rankTwins(rows: readonly TvMatch[]): TvMatch[] {
  return rows
    .filter((m) => tvStr(m, "ucits_compliant_flag") === "1")
    .slice()
    .sort((a, b) => (tvNum(a, "expense_ratio") ?? 99) - (tvNum(b, "expense_ratio") ?? 99) || (tvNum(b, "aum") ?? 0) - (tvNum(a, "aum") ?? 0));
}

// ─── holdings ───────────────────────────────────────────────────────────────

/** The issuer/regulator source for a fund: iShares table → Amundi (an Amundi product) → SEC N-PORT (US listings). */
export async function etfComposition(f: { isin?: string; symbol: string; us: boolean; amundi: boolean }): Promise<FundComposition> {
  const isin = f.isin?.toUpperCase();
  if (isin && ISHARES_PRODUCTS[isin]) return isharesHoldings(isin);
  if (isin && f.amundi) return amundiHoldings(isin);
  if (f.us) return nportHoldings(f.symbol);
  throw new Error(
    `no keyless holdings source covers ${isin ?? f.symbol} (the iShares table, Amundi's own funds, SEC N-PORT for US funds) — read the issuer's factsheet`,
  );
}

// ─── the facts of one or several ETFs ───────────────────────────────────────

export interface EtfProfile {
  symbol: string;
  listing: EtfListing;
  isin?: string;
  name?: string;
  amundi?: AmundiFacts;
  replication: ReturnType<typeof etfReplication>;
  pea: ReturnType<typeof etfPeaStatus>;
  domicile: ReturnType<typeof etfDomicile>;
}

const AMUNDI_BRANDS = /amundi|lyxor/i;

/** The facts and the three decisions for several ETFs: one TradingView call, one Amundi call. */
export async function etfProfiles(
  symbols: readonly string[],
  opts: { isins?: Record<string, string | undefined>; markets?: Record<string, string | undefined> } = {},
): Promise<{ profiles: EtfProfile[]; amundi?: { url: string; fetchedAt: string }; notes: string[] }> {
  const notes: string[] = [];
  let listings: EtfListing[];
  try {
    listings = await etfListings(symbols, opts.isins);
  } catch (e) {
    notes.push(`TradingView unavailable (${(e as Error).message}) — no fund columns`);
    listings = symbols.map((symbol) => ({ symbol, error: (e as Error).message }));
  }
  const isinOf = (l: EtfListing) => tvStr(l.tv, "isin") ?? opts.isins?.[l.symbol];
  const askAmundi = listings
    .filter((l) => {
      const isin = isinOf(l);
      const brand = tvStr(l.tv, "brand");
      return isin && !isin.startsWith("US") && (!brand || AMUNDI_BRANDS.test(brand));
    })
    .map((l) => isinOf(l)!);
  let facts = new Map<string, AmundiFacts>();
  let amundi: { url: string; fetchedAt: string } | undefined;
  if (askAmundi.length)
    try {
      const r = await amundiFacts(askAmundi);
      facts = r.facts;
      amundi = { url: r.url, fetchedAt: r.fetchedAt };
    } catch (e) {
      notes.push(`Amundi product data unavailable (${(e as Error).message}) — no issuer PEA flag or replication field`);
    }
  const profiles = listings.map((l) => {
    const isin = isinOf(l);
    const name = tvStr(l.tv, "description");
    const af = isin ? facts.get(isin) : undefined;
    return {
      symbol: l.symbol,
      listing: l,
      isin,
      name,
      amundi: af,
      replication: etfReplication({ issuer: af?.replication, name: af?.name ?? name }),
      pea: etfPeaStatus({ issuerFlag: af?.pea, name: af?.name ?? name }),
      domicile: etfDomicile({ fundCountry: tvStr(l.tv, "country_code_fund"), isin, market: opts.markets?.[l.symbol] }),
    };
  });
  return { profiles, amundi, notes };
}

/** The datasets of a profile: its TradingView row, the issuer's facts, the three decisions. */
export function profileDatasets(p: EtfProfile, amundi: { url: string; fetchedAt: string } | undefined, now: Date): Dataset[] {
  const S = p.symbol;
  const out: Dataset[] = [];
  if (p.listing.tv && p.listing.scan) out.push(rowDataset(p.listing.tv, p.listing.scan, `${p.listing.tv.ticker} — fund facts (TradingView)`, S));
  if (p.amundi && amundi) {
    const k = `${p.amundi.isin}.amundi`;
    const points: Point[] = [];
    if (p.amundi.pea !== undefined) points.push({ key: `${k}.pea`, label: `${S} PEA-eligible per the issuer (Amundi FUND_PEA)`, value: p.amundi.pea });
    if (p.amundi.replication)
      points.push({ key: `${k}.replication`, label: `${S} replication per the issuer (Amundi)`, value: p.amundi.replication, untrusted: true });
    if (p.amundi.name) points.push({ key: `${k}.name`, label: `${S} name per the issuer (Amundi)`, value: p.amundi.name, untrusted: true });
    out.push({
      kind: "etf",
      title: `${S} — the issuer's own data (Amundi)`,
      subject: S,
      points,
      provenance: { source: "amundi", url: amundi.url, fetchedAt: amundi.fetchedAt, official: false, asOf: amundi.fetchedAt.slice(0, 10) },
      notes: ["the issuer's product API (amundietf.fr, undocumented)"],
    });
  }
  const at = now.toISOString();
  out.push({
    kind: "etf",
    title: `${S} — replication, PEA, domicile`,
    subject: S,
    points: [
      { key: `${S}.etf.replication`, label: `${S} replication`, value: p.replication.value, formula: p.replication.basis },
      { key: `${S}.etf.pea`, label: `${S} PEA eligibility`, value: p.pea.value, formula: p.pea.basis },
      { key: `${S}.etf.domicile`, label: `${S} fund domicile`, value: p.domicile.code ?? "unknown", formula: p.domicile.basis },
    ],
    provenance: { source: "ultrastock", fetchedAt: p.listing.scan?.provenance.fetchedAt ?? amundi?.fetchedAt ?? at, official: false, asOf: at.slice(0, 10) },
    notes: [],
  });
  return out;
}

// ─── crible: multiples of the top holdings ──────────────────────────────────

const SAFE_TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;

/**
 * The top holdings' earnings yield and price-to-book from crible, then the
 * fund's weighted multiples over the lines crible covers, with the coverage.
 * Never throws: an unavailable crible is a note.
 */
export async function topHoldingMultiples(
  S: string,
  lines: readonly FundLine[],
  now: Date,
): Promise<{ datasets: Dataset[]; notes: string[]; coveragePct?: number; pe?: number }> {
  const notes: string[] = [];
  if (netMode().kind === "fixture")
    return { datasets: [], notes: ["multiples of the top holdings: crible not consulted while replaying a fixture (it reads a local dataset)"] };
  if (!cribleAvailable() || !cribleBootstrapped())
    return {
      datasets: [],
      notes: [
        `multiples of the top holdings unavailable: crible ${cribleAvailable() ? "has no dataset — run `ultrastock screen --engine crible --bootstrap` once" : "needs uvx (install uv)"}`,
      ],
    };
  const top = lines.slice(0, 10);
  const isins = [...new Set(top.map((l) => l.isin?.toUpperCase()).filter((x): x is string => !!x && ISIN_RE.test(x)))];
  const tickers = [...new Set(top.map((l) => l.ticker?.toUpperCase()).filter((x): x is string => !!x && SAFE_TICKER.test(x)))];
  if (!isins.length && !tickers.length) return { datasets: [], notes: ["multiples of the top holdings: the holdings carry no ISIN or ticker to look up"] };
  const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");
  const cond = [isins.length ? `isin IN (${list(isins)})` : "", tickers.length ? `symbol IN (${list(tickers)})` : ""].filter(Boolean).join(" OR ");
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await cribleScreen(`primary_listing = 1 AND (${cond})`, { limit: 40 })).rows;
  } catch (e) {
    return { datasets: [], notes: [`multiples of the top holdings unavailable: ${(e as Error).message.split("\n")[0]}`] };
  }
  const byIsin = new Map(rows.filter((r) => typeof r.isin === "string").map((r) => [String(r.isin).toUpperCase(), r]));
  const bySym = new Map(rows.filter((r) => typeof r.symbol === "string").map((r) => [String(r.symbol).toUpperCase(), r]));
  const points: Point[] = [];
  const covered: Array<{ w: number; ey?: number; pb?: number; i: number }> = [];
  const topWeight = top.reduce((s, l) => s + l.weightPct, 0);
  let asOf: string | undefined;
  top.forEach((l, idx) => {
    const r = (l.isin && byIsin.get(l.isin.toUpperCase())) || (l.ticker && bySym.get(l.ticker.toUpperCase())) || undefined;
    if (!r) return;
    const ey = typeof r.earnings_yield === "number" && Number.isFinite(r.earnings_yield) ? r.earnings_yield * 100 : undefined;
    const pb = typeof r.price_to_book_ratio === "number" && Number.isFinite(r.price_to_book_ratio) ? r.price_to_book_ratio : undefined;
    if (ey === undefined && pb === undefined) return;
    const at = typeof r.price_asof === "string" ? r.price_asof : undefined;
    if (at && (!asOf || at > asOf)) asOf = at;
    const k = `${S}.etf.top.${idx + 1}`;
    if (ey !== undefined)
      points.push({ key: `${k}.earningsYield`, label: `${S} holding #${idx + 1} earnings yield (crible)`, value: ey, unit: "%", ...(at ? { asOf: at } : {}) });
    if (pb !== undefined)
      points.push({ key: `${k}.priceToBook`, label: `${S} holding #${idx + 1} price to book (crible)`, value: pb, unit: "x", ...(at ? { asOf: at } : {}) });
    covered.push({ w: l.weightPct, ey, pb, i: idx + 1 });
  });
  if (!covered.length) return { datasets: [], notes: ["multiples of the top holdings: crible covers none of the top 10 lines"] };
  const derived: Point[] = [];
  const wCov = covered.reduce((s, c) => s + c.w, 0);
  const coveragePct = topWeight > 0 ? (wCov / topWeight) * 100 : 0;
  derived.push(
    {
      key: `${S}.etf.multiples.coverage`,
      label: `${S} share of the top-10 weight crible covers`,
      value: coveragePct,
      unit: "%",
      formula: `Σ weights of the ${covered.length} covered top-10 lines / Σ weights of the top 10 × 100`,
    },
    {
      key: `${S}.etf.multiples.coverageOfFund`,
      label: `${S} share of the whole fund the multiples cover`,
      value: wCov,
      unit: "%",
      formula: "Σ weights (in % of the fund) of the covered top-10 lines",
    },
  );
  const eyc = covered.filter((c) => c.ey !== undefined);
  let pe: number | undefined;
  if (eyc.length) {
    const w = eyc.reduce((s, c) => s + c.w, 0);
    const ey = eyc.reduce((s, c) => s + c.w * c.ey!, 0) / w;
    derived.push({
      key: `${S}.etf.multiples.earningsYield`,
      label: `${S} weighted earnings yield of the covered top holdings`,
      value: ey,
      unit: "%",
      formula: `Σ w·EY / Σ w over holdings #${eyc.map((c) => c.i).join(", #")}`,
    });
    if (ey > 0) {
      pe = 100 / ey;
      derived.push({
        key: `${S}.etf.multiples.pe`,
        label: `${S} weighted P/E of the covered top holdings (harmonic)`,
        value: pe,
        unit: "x",
        formula: "100 / weighted earnings yield (%) — the harmonic mean, which a loss-maker cannot blow up",
      });
    }
  }
  const pbc = covered.filter((c) => c.pb !== undefined && c.pb > 0);
  if (pbc.length) {
    const w = pbc.reduce((s, c) => s + c.w, 0);
    derived.push({
      key: `${S}.etf.multiples.pb`,
      label: `${S} weighted price to book of the covered top holdings (harmonic)`,
      value: w / pbc.reduce((s, c) => s + c.w / c.pb!, 0),
      unit: "x",
      formula: `Σ w / Σ (w / P/B) over holdings #${pbc.map((c) => c.i).join(", #")} (negative book values left out)`,
    });
  }
  const at = now.toISOString();
  notes.push(
    `multiples cover ${covered.length} of the top ${top.length} lines; the rest of the fund is not included — a top-holdings reading, not the fund's own P/E`,
  );
  return {
    datasets: [
      {
        kind: "etf",
        title: `${S} — multiples of the top holdings (crible)`,
        subject: S,
        points: [...points, ...derived],
        provenance: { source: "crible", fetchedAt: at, delay: "filing", official: false, ...(asOf ? { asOf } : {}) },
        notes: ["crible: audited statements and prices it aggregates (unofficial)"],
      },
    ],
    notes,
    coveragePct,
    pe,
  };
}

// ─── correlation ────────────────────────────────────────────────────────────

/** Pearson correlation of daily simple returns on the dates both series trade. */
export function returnCorrelation(a: readonly Bar[], b: readonly Bar[]): { rho?: number; n: number; from?: string; to?: string } {
  const mb = new Map(b.map((x) => [x.date, x.close]));
  const shared = a.filter((x) => mb.has(x.date));
  if (shared.length < 30) return { n: Math.max(0, shared.length - 1) };
  const ra = simpleReturns(shared.map((x) => x.close));
  const rb = simpleReturns(shared.map((x) => mb.get(x.date)!));
  const rho = correlation(ra, rb);
  return { rho: Number.isFinite(rho) ? rho : undefined, n: ra.length, from: shared[0]!.date, to: shared[shared.length - 1]!.date };
}

/** One year of daily bars for a symbol (or the ISIN TradingView gave, when the symbol does not resolve). */
export async function etfBars(symbol: string, isin: string | undefined, now: Date): Promise<{ bars: Bar[]; provenance: Dataset["provenance"]; sym: string }> {
  const from = new Date(now.getTime() - 366 * 86_400_000);
  let r: Awaited<ReturnType<typeof resolveSymbol>>;
  try {
    r = await resolveSymbol(symbol);
  } catch (e) {
    if (!isin || isin.startsWith("US")) throw e;
    r = await resolveSymbol(isin);
  }
  const s = await getHistory(r, { from, to: now });
  return { bars: s.bars, provenance: s.provenance, sym: r.instrument.symbol };
}

// ─── the analyze slice ──────────────────────────────────────────────────────

export interface EtfRunResult {
  dir: string;
  symbol: string;
  evidence: number;
  replication: string;
  pea: string;
  /** eligible, not eligible, hint or unknown. */
  peaShort: string;
  domicile?: string;
  notes: string[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** `analyze <etf>` at standard / deep depth: ETF.md and its evidence. */
export async function etfRun(raw: string, dir: string, opts: { now?: Date; instrument?: Instrument } = {}): Promise<EtfRunResult> {
  const now = opts.now ?? clockNow();
  const inst = opts.instrument ?? (await resolveSymbol(raw)).instrument;
  const S = inst.symbol;
  const store = EvidenceStore.open(dir, { subject: S, createdAt: now.toISOString() });
  const sections: string[] = [];
  const notes: string[] = [];
  const reg = (title: string | undefined, datasets: Dataset[]): Registered[] => {
    const r = registerDatasets(
      store,
      datasets.filter((d) => d.points.length),
    );
    if (r.length) sections.push(...(title ? [`## ${title}`, ""] : []), formatDatasets(r));
    return r;
  };
  const cite = (key: string) => {
    const id = store.byKey(key)?.id;
    return id ? ` [${id}]` : "";
  };
  /** "value unit [E#]" for a registered key, "n/a" otherwise. */
  const show = (key: string) => {
    const i = store.byKey(key);
    if (!i) return "n/a";
    const v = typeof i.value === "number" ? formatNumber(i.value) : String(i.value);
    return `${v}${i.unit ? (i.unit === "%" ? " %" : ` ${i.unit}`) : ""} [${i.id}]`;
  };

  // 1. The fund: TradingView's columns, the issuer's facts, the three decisions.
  const { profiles, amundi, notes: pn } = await etfProfiles([S], { isins: { [S]: inst.isin }, markets: { [S]: inst.market } });
  notes.push(...pn);
  const p = profiles[0]!;
  if (p.listing.error) notes.push(`TradingView: ${p.listing.error}`);
  if (!p.listing.tv && !p.amundi && !p.isin) throw new Error(`no fund data for ${S}: ${p.listing.error ?? "TradingView did not answer"}`);
  if (p.listing.tv && !p.amundi && p.isin && !p.isin.startsWith("US") && AMUNDI_BRANDS.test(tvStr(p.listing.tv, "brand") ?? ""))
    notes.push("Amundi did not list this fund: no issuer PEA flag or replication field");
  reg(undefined, profileDatasets(p, amundi, now));
  const tv = p.listing.tv;

  // 2. Domicile, withholding and PRIIPs.
  const profile = loadProfile();
  const j = profile?.jurisdiction;
  const priipsRestricted = !!j && ruleStatus(j, "us-domiciled-etf") === "restricted";
  const domicileUS = p.domicile.code === "US";
  const domLines = [`- Domicile: ${p.domicile.code ?? "unknown"}${cite(`${S}.etf.domicile`)} — ${withholdingNote(p.domicile.code)}`];
  if (domicileUS && priipsRestricted) {
    const id = store.addDerived(
      `${S}.etf.priips`,
      `${S} PRIIPs status for a retail investor resident in ${j}`,
      `blocked: a US-domiciled ETF has no PRIIPs KID — not sold to retail investors in ${j}; use a UCITS fund on the same index`,
      undefined,
      [store.byKey(`${S}.etf.domicile`)?.id].filter((x): x is string => !!x),
      `domicile US × jurisdiction rule us-domiciled-etf (${j}: restricted)`,
    );
    domLines.push(`- PRIIPs [${id}]: the risk gate blocks this ETF for a ${j} resident (code PRIIPS) — see the UCITS twins below.`);
  } else if (domicileUS && !profile)
    domLines.push("- PRIIPs: no profile — in the EU a US-domiciled ETF has no KID and is not sold to retail investors; UCITS twins are listed below.");
  else if (domicileUS) domLines.push(`- PRIIPs: the ${j} rules allow US-domiciled ETFs.`);

  // 3. Holdings: none from a swap's substitute basket.
  let comp: FundComposition | undefined;
  if (p.replication.synthetic)
    notes.push(
      "synthetic (swap) replication: the fund holds a substitute basket and receives the index through the swap — no look-through is drawn from the basket; the exposure is the index",
    );
  else
    try {
      comp = await etfComposition({ isin: p.isin, symbol: S, us: inst.market === "us", amundi: !!p.amundi });
      if (comp.synthetic) notes.push("the issuer's composition is a substitute basket (synthetic): not used as the exposure");
      else reg("Holdings — top 10, sectors, countries", [compositionDataset(S, comp)]);
    } catch (e) {
      notes.push(`holdings unavailable — ${(e as Error).message.split("\n")[0]}`);
    }

  // 4. Multiples of the top holdings (crible), with the coverage.
  if (comp && !comp.synthetic) {
    const m = await topHoldingMultiples(S, comp.lines, now);
    reg("Multiples of the top holdings", m.datasets);
    notes.push(...m.notes);
  }

  // 5. Funds on the same index: relative tracking (same fund currency only) and UCITS twins.
  const trackLines: string[] = [];
  const twinLines: string[] = [];
  const index = tvStr(tv, "index_tracked");
  const ccy = tvStr(tv, "etf_fund_currency");
  const wantTwins = domicileUS && (priipsRestricted || !profile);
  if (!index) notes.push("no index named by TradingView: relative tracking and twins not searched");
  else
    try {
      const { scan, rows } = await sameIndexFunds(index);
      const quote = tvStr(tv, "currency");
      const others = dedupeListings(rows, quote).filter((m) => tvStr(m, "isin") !== p.isin);
      // Comparable: same index, same fund currency, and a listing in the same quote currency (the NAV return's currency).
      const comparable = others.filter((m) => ccy && tvStr(m, "etf_fund_currency") === ccy && tvStr(m, "currency") === quote);
      const shown = comparable.slice(0, 5);
      const base = profile?.baseCurrency;
      const twins = wantTwins ? rankTwins(dedupeListings(rows, base).filter((m) => tvStr(m, "isin") !== p.isin)).slice(0, 3) : [];
      const day = scan.provenance.asOf;
      const points: Point[] = [
        {
          key: `${S}.etf.peers.sameIndex`,
          label: `${S} other ETFs found on the same index (normalised name, one listing per fund)`,
          value: others.length,
          unit: "count",
          formula: "TradingView screener: index_tracked matching, then equal after normalising the index name",
          asOf: day,
        },
        {
          key: `${S}.etf.peers.comparable`,
          label: `${S} of which comparable (same fund currency, a listing in the same quote currency)`,
          value: comparable.length,
          unit: "count",
          formula:
            "same normalised index, same etf_fund_currency, and a listing quoted in the same currency (TradingView's NAV returns are in the listing's currency)",
          asOf: day,
        },
      ];
      const add = (m: TvMatch) => points.push(...[...m.points.values()].filter((x) => !points.some((y) => y.key === x.key)));
      for (const m of shown) add(m);
      twins.forEach((m, i) => {
        add(m);
        points.push({
          key: `${S}.etf.ucitsTwin.${i + 1}`,
          label: `${S} UCITS twin #${i + 1}`,
          value: `${m.ticker} (${tvStr(m, "isin") ?? "no ISIN"})`,
          formula: "UCITS ETF on the same index (normalised name), ranked by TER then AUM",
          asOf: day,
        });
      });
      reg(undefined, [
        {
          kind: "etf",
          title: `${S} — ETFs on the same index (TradingView)`,
          subject: S,
          points,
          provenance: scan.provenance,
          notes: [
            `${comparable.length} comparable (fund currency ${ccy ?? "unknown"}, listing in ${quote ?? "unknown"}); ${others.length - comparable.length} in another fund currency or without a listing in ${quote ?? "that currency"}: not comparable`,
          ],
        },
      ]);
      // Relative tracking: NAV total return against the comparable funds.
      const mine = tvNum(tv, "nav_total_return.1Y");
      const tk = tv!.ticker;
      const track = trackLines;
      if (mine === undefined) track.push(`- Relative tracking: not comparable — TradingView gives no 1-year NAV total return for ${S}.`);
      else if (!shown.some((m) => tvNum(m, "nav_total_return.1Y") !== undefined)) {
        const id = store.addDerived(
          `${S}.etf.tracking`,
          `${S} relative tracking`,
          `not comparable: no other ETF on the same index in the same fund currency${ccy ? ` (${ccy})` : ""} with a listing in ${quote ?? "the same currency"}`,
          undefined,
          [store.byKey(`${S}.etf.peers.comparable`)?.id].filter((x): x is string => !!x),
          "a NAV return compares only across funds on the same index and in the same fund currency",
        );
        track.push(`- Relative tracking [${id}]: not comparable — no other fund on the same index in ${ccy ?? "the same currency"}.`);
      } else {
        const peers = shown.filter((m) => tvNum(m, "nav_total_return.1Y") !== undefined);
        for (const m of peers) {
          const id = store.addDerived(
            `${S}.etf.tracking.vs.${m.ticker}.1Y`,
            `${S} 1-year NAV total return minus ${m.ticker}'s`,
            mine - tvNum(m, "nav_total_return.1Y")!,
            "pts",
            [store.byKey(`${tk}.tv.nav_total_return.1Y`)?.id, store.byKey(`${m.ticker}.tv.nav_total_return.1Y`)?.id].filter((x): x is string => !!x),
            `${tk}.tv.nav_total_return.1Y − ${m.ticker}.tv.nav_total_return.1Y (same index, same fund currency, both listings in ${quote})`,
          );
          track.push(`- ${formatEvidence(store.get(id)!)}`);
        }
        const med = median(peers.map((m) => tvNum(m, "nav_total_return.1Y")!));
        const inputs = peers.map((m) => store.byKey(`${m.ticker}.tv.nav_total_return.1Y`)?.id).filter((x): x is string => !!x);
        const medId = store.addDerived(
          `${S}.etf.tracking.peerMedian.1Y`,
          `median 1-year NAV total return of ${peers.length} comparable ETFs`,
          med,
          "%",
          inputs,
          "median over the comparable funds shown",
        );
        const gapId = store.addDerived(
          `${S}.etf.tracking.vsMedian.1Y`,
          `${S} 1-year NAV total return minus the comparable median`,
          mine - med,
          "pts",
          [store.byKey(`${tk}.tv.nav_total_return.1Y`)?.id, medId].filter((x): x is string => !!x),
          `${tk}.tv.nav_total_return.1Y − ${S}.etf.tracking.peerMedian.1Y`,
        );
        track.unshift(
          `- 1-year NAV total return (distributions included) against the funds on the same index in the same fund currency (${ccy}), each read on a listing in ${quote} (TradingView's NAV returns are in the listing's currency). A negative gap is a cost (fees, withholding, tracking difference); NAV dates and distribution dates also move it a little.`,
          `- ${formatEvidence(store.get(medId)!)}`,
          `- ${formatEvidence(store.get(gapId)!)}`,
        );
      }
      if (wantTwins)
        twinLines.push(
          twins.length
            ? `${twins.map((m, i) => `- #${i + 1}: ${show(`${S}.etf.ucitsTwin.${i + 1}`)} — TER ${show(`${m.ticker}.tv.expense_ratio`)}, AUM ${show(`${m.ticker}.tv.aum`)}`).join("\n")}\n\nSearch the ISIN at the broker for a listing in the account's currency; confirm the KID exists before buying.`
            : "- none found on the same index (normalised name) among UCITS funds — search the index name with `ultrastock etf find`.",
        );
    } catch (e) {
      notes.push(`ETFs on the same index unavailable — ${(e as Error).message.split("\n")[0]}`);
    }

  store.save();
  const title = `# ${S}${inst.name ? ` — ${inst.name}` : ""} — ETF`;
  const summary = [
    `- Replication: ${p.replication.value}${cite(`${S}.etf.replication`)} (${p.replication.basis})`,
    `- PEA: ${p.pea.value}${cite(`${S}.etf.pea`)} (${p.pea.basis})`,
    `- Domicile: ${p.domicile.code ?? "unknown"}${cite(`${S}.etf.domicile`)} (${p.domicile.basis})`,
    ...(tv
      ? [
          `- TER ${show(`${tv.ticker}.tv.expense_ratio`)}, AUM ${show(`${tv.ticker}.tv.aum`)}, dividends ${show(`${tv.ticker}.tv.dividend_treatment`)}, UCITS flag ${show(`${tv.ticker}.tv.ucits_compliant_flag`)}, fund currency ${show(`${tv.ticker}.tv.etf_fund_currency`)}, holdings ${show(`${tv.ticker}.tv.etf_holdings_count`)}`,
        ]
      : []),
  ];
  const md = [
    title,
    "",
    "Every figure below is an [E#] of this run (BRIEF.md has the price and risk). Names and index labels are the sources' text, fenced as external.",
    "",
    ...summary,
    "",
    "## Domicile, withholding, PRIIPs",
    "",
    ...domLines,
    "",
    ...(twinLines.length ? ["## UCITS twins (same index, ranked by TER then AUM)", "", ...twinLines, ""] : []),
    ...(trackLines.length ? ["## Relative tracking", "", ...trackLines, ""] : []),
    ...sections,
    ...(notes.length ? ["## Notes", "", ...[...new Set(notes)].map((n) => `- ${n}`), ""] : []),
  ];
  writeArtifact(join(dir, "ETF.md"), `${md.join("\n")}\n`);
  return {
    dir,
    symbol: S,
    evidence: store.items.length,
    replication: p.replication.value,
    pea: p.pea.value,
    peaShort: p.pea.eligible === true ? "eligible" : p.pea.eligible === false ? "not eligible" : p.pea.hint ? "hint (name)" : "unknown",
    domicile: p.domicile.code,
    notes,
  };
}

// ─── find ───────────────────────────────────────────────────────────────────

export interface EtfFindOptions {
  pea?: boolean;
  distribution?: "acc" | "dist";
  ucits?: boolean;
  currency?: string;
  limit?: number;
}

const FIND_COLUMNS = [
  "description",
  "close",
  "currency",
  "fundamental_currency_code",
  "isin",
  "index_tracked",
  "expense_ratio",
  "aum",
  "nav_total_return.1Y",
  "dividend_treatment",
  "ucits_compliant_flag",
  "country_code_fund",
  "etf_fund_currency",
  "leveraged_flag",
  "currency_hedged_flag",
  "brand",
] as const;

/** `etf find`: ETFs on an index or a theme, filtered, one listing per fund, largest first. */
export async function etfFind(query: string, opts: EtfFindOptions = {}): Promise<{ datasets: Dataset[]; shown: number; total: number }> {
  const q = query.trim();
  if (!q) throw new Error("etf find needs an index or a theme");
  const limit = opts.limit ?? 10;
  const base: TvFilter[] = [{ left: "typespecs", operation: "has", right: ["etf"] }];
  if (opts.distribution) base.push({ left: "dividend_treatment", operation: "equal", right: opts.distribution === "acc" ? "Capitalizes" : "Distributes" });
  if (opts.ucits) base.push({ left: "ucits_compliant_flag", operation: "equal", right: "1" });
  if (opts.currency) base.push({ left: "currency", operation: "equal", right: opts.currency.toUpperCase() });
  const notes: string[] = [];
  // A PEA holds funds listed in Paris: --pea screens Euronext Paris ("france"), else every market.
  const market = opts.pea ? "france" : "global";
  const RANGE = 500;
  const run = (field: string) =>
    tradingviewScan(market, {
      filter: [...base, { left: field, operation: "match", right: q }],
      columns: FIND_COLUMNS,
      sort: { sortBy: "aum", sortOrder: "desc" },
      range: [0, RANGE],
    });
  let scan = await run("index_tracked");
  let field = "index tracked";
  if (!scanMatches(scan, market).length) {
    scan = await run("description");
    field = "name";
  }
  const listings = Number(scan.points.find((x) => x.key.endsWith(".scan.matches"))?.value ?? 0);
  if (listings > RANGE) notes.push(`${listings} listings match; the ${RANGE} largest by AUM were read`);
  // Funds whose index is the query itself (normalised) first, then the rest; each by AUM.
  const target = normalizeIndexName(q);
  const exact = (m: TvMatch) => normalizeIndexName(tvStr(m, "index_tracked") ?? "") === target;
  const deduped = dedupeListings(scanMatches(scan, market));
  let rows = [...deduped.filter(exact), ...deduped.filter((m) => !exact(m))];
  const total = rows.length;
  const exactCount = deduped.filter(exact).length;
  // The issuer's PEA flag and replication, one Amundi call for every non-US fund found.
  const isins = rows.map((m) => tvStr(m, "isin")).filter((i): i is string => !!i && !i.startsWith("US"));
  let facts = new Map<string, AmundiFacts>();
  let amundi: { url: string; fetchedAt: string } | undefined;
  if (isins.length)
    try {
      const r = await amundiFacts(isins.slice(0, 300));
      facts = r.facts;
      amundi = { url: r.url, fetchedAt: r.fetchedAt };
    } catch (e) {
      notes.push(`Amundi product data unavailable (${(e as Error).message}) — PEA flags unknown`);
    }
  const status = (m: TvMatch) => {
    const isin = tvStr(m, "isin");
    const af = isin ? facts.get(isin) : undefined;
    return {
      af,
      pea: etfPeaStatus({ issuerFlag: af?.pea, name: af?.name ?? tvStr(m, "description") }),
      rep: etfReplication({ issuer: af?.replication, name: af?.name ?? tvStr(m, "description") }),
    };
  };
  if (opts.pea) {
    const before = rows.length;
    const kept = rows.filter((m) => {
      const s = status(m).pea;
      return s.eligible === true || s.hint === true;
    });
    notes.push(
      `--pea: ${kept.length} of ${before} funds kept — the issuer's flag (Amundi FUND_PEA) or "PEA" in the name (a hint); funds of other issuers carry no flag here and are left out: check their KID or the broker`,
    );
    rows = kept;
  }
  const picked = rows.slice(0, limit);
  const day = scan.provenance.asOf;
  const points: Point[] = [
    { key: `ETF.find.matches`, label: `ETFs found (one listing per fund) whose ${field} matches the query`, value: total, unit: "count", asOf: day },
    {
      key: `ETF.find.sameIndex`,
      label: "of which tracking the queried index itself (normalised name)",
      value: exactCount,
      unit: "count",
      formula: "index_tracked equal to the query after normalising both",
      asOf: day,
    },
  ];
  const amundiPoints: Point[] = [];
  const decided: Point[] = [];
  picked.forEach((m, i) => {
    const s = status(m);
    points.push({
      key: `${m.ticker}.etf.find.rank`,
      label: `${m.ticker} position`,
      value: i + 1,
      unit: "rank",
      formula: "funds on the queried index itself first, then the other matches; each by AUM descending",
      asOf: day,
    });
    points.push(...m.points.values());
    decided.push(
      { key: `${m.ticker}.etf.pea`, label: `${m.ticker} PEA eligibility`, value: s.pea.value, formula: s.pea.basis },
      { key: `${m.ticker}.etf.replication`, label: `${m.ticker} replication`, value: s.rep.value, formula: s.rep.basis },
    );
    if (s.af?.pea !== undefined)
      amundiPoints.push({ key: `${s.af.isin}.amundi.pea`, label: `${m.ticker} PEA-eligible per the issuer (Amundi FUND_PEA)`, value: s.af.pea });
  });
  if (opts.currency) notes.push(`--currency ${opts.currency.toUpperCase()}: the listing's trading currency (the fund's base currency is etf_fund_currency)`);
  if (opts.pea) notes.push("--pea: Euronext Paris listings only (TradingView market france)");
  notes.push(`matched on the ${field}; ${picked.length} of ${rows.length} shown; AUM is in the reporting currency it states`);
  notes.push("unofficial endpoint (TradingView's screener backend); delayed snapshot");
  const datasets: Dataset[] = [
    { kind: "etf-find", title: `ETFs — ${field} matching the query`, subject: "ETF.find", points, provenance: scan.provenance, notes },
    {
      kind: "etf-find",
      title: "Replication and PEA — decided here, with the basis of each",
      subject: "ETF.find",
      points: decided,
      provenance: { source: "ultrastock", fetchedAt: amundi?.fetchedAt ?? scan.provenance.fetchedAt, official: false, asOf: day },
      notes: ["PEA: the issuer's flag (Amundi FUND_PEA), else a name hint, else unknown — never from the domicile"],
    },
  ];
  if (amundi && amundiPoints.length)
    datasets.push({
      kind: "etf-find",
      title: "PEA flags — the issuer's own data (Amundi)",
      subject: "ETF.find",
      points: amundiPoints,
      provenance: { source: "amundi", url: amundi.url, fetchedAt: amundi.fetchedAt, official: false, asOf: amundi.fetchedAt.slice(0, 10) },
      notes: [],
    });
  return { datasets, shown: picked.length, total };
}

// ─── compare / overlap ──────────────────────────────────────────────────────

export interface CompareResult {
  datasets: Dataset[];
  notes: string[];
  /** Rows of the comparison table: a label and, per ETF, the key of the point holding its value. */
  table: { symbols: string[]; rows: Array<{ label: string; keys: Array<string | undefined> }> };
}

const TABLE_COLUMNS: Array<[string, string]> = [
  ["expense_ratio", "TER"],
  ["aum", "AUM"],
  ["dividend_treatment", "dividends"],
  ["etf_fund_currency", "fund currency"],
  ["currency_hedged_flag", "hedged"],
  ["ucits_compliant_flag", "UCITS"],
  ["nav_total_return.1Y", "NAV total return 1Y"],
  ["nav_discount_premium", "premium / discount"],
  ["etf_holdings_count", "holdings"],
  ["weight_top_10", "top-10 weight"],
  ["launch_date", "launched"],
];

/** Holdings of the non-synthetic funds, fetched two at a time; a failure is a note. */
async function compositions(profiles: EtfProfile[], markets: Record<string, string | undefined>): Promise<Array<FundComposition | Error>> {
  return mapLimit(profiles, 2, async (p) => {
    if (p.replication.synthetic) return new Error(`${p.symbol}: synthetic (swap) — its lines are a substitute basket, not its exposure`);
    try {
      const c = await etfComposition({ isin: p.isin, symbol: p.symbol, us: markets[p.symbol] === "us" || p.domicile.code === "US", amundi: !!p.amundi });
      return c.synthetic ? new Error(`${p.symbol}: the issuer's composition is a substitute basket`) : c;
    } catch (e) {
      return new Error(`${p.symbol}: holdings unavailable — ${(e as Error).message.split("\n")[0]}`);
    }
  });
}

/** The overlap points of two compositions under `ETF.overlap.<A>.<B>`. */
function overlapPoints(a: string, b: string, ca: FundComposition, cb: FundComposition, top = 10): Point[] {
  const o = etfOverlap(ca.lines, cb.lines);
  const k = `ETF.overlap.${a}.${b}`;
  const asOf = [ca.asOf, cb.asOf].filter(Boolean).sort()[0];
  const pts: Point[] = [
    {
      key: k,
      label: `overlap of ${a} and ${b} (Σ of the smaller weight over common lines)`,
      value: Number(o.overlapPct.toFixed(4)),
      unit: "%",
      formula: "Σ over lines held by both of min(weight in A, weight in B); lines matched by ISIN, ticker, then name",
      ...(asOf ? { asOf } : {}),
    },
    { key: `${k}.common`, label: `lines ${a} and ${b} both hold`, value: o.common.length, unit: "count", ...(asOf ? { asOf } : {}) },
    { key: `${k}.lines.${a}`, label: `${a} security lines compared`, value: o.aLines, unit: "count" },
    { key: `${k}.lines.${b}`, label: `${b} security lines compared`, value: o.bLines, unit: "count" },
  ];
  o.common.slice(0, top).forEach((c, i) => {
    pts.push(
      { key: `${k}.top.${i + 1}.name`, label: `common line #${i + 1}`, value: c.isin ? `${c.name} (${c.isin})` : c.name, untrusted: true },
      { key: `${k}.top.${i + 1}.${a}`, label: `common line #${i + 1} weight in ${a}`, value: Number(c.a.toFixed(4)), unit: "%" },
      { key: `${k}.top.${i + 1}.${b}`, label: `common line #${i + 1} weight in ${b}`, value: Number(c.b.toFixed(4)), unit: "%" },
    );
  });
  return pts;
}

/** Why an overlap may read low: files without ISINs match on tickers and names only. */
const overlapNote = (ca: FundComposition, cb: FundComposition): string[] =>
  [ca, cb].some((c) => c.lines.length && !c.lines.some((l) => l.isin))
    ? [
        "one of the files carries no ISINs (iShares): lines match on tickers and normalised names, so a spelling the two issuers write differently is missed and the overlap reads lower than it is; the holdings dates also differ",
      ]
    : [];

const overlapProvenance = (ca: FundComposition, cb: FundComposition): Dataset["provenance"] => ({
  source: [...new Set([ca.source, cb.source])].join("+"),
  fetchedAt: [ca.fetchedAt, cb.fetchedAt].sort()[0]!,
  official: ca.official && cb.official,
  ...([ca.asOf, cb.asOf].filter(Boolean).length ? { asOf: [ca.asOf, cb.asOf].filter(Boolean).sort()[0] } : {}),
});

/** Resolve each symbol for its ISIN and market (failures tolerated: TradingView may still know it). */
async function instruments(symbols: readonly string[]): Promise<{ isins: Record<string, string | undefined>; markets: Record<string, string | undefined> }> {
  const isins: Record<string, string | undefined> = {};
  const markets: Record<string, string | undefined> = {};
  const got = await mapLimit(symbols, 3, async (s) => resolveSymbol(s).catch(() => undefined));
  symbols.forEach((s, i) => {
    isins[s] = got[i]?.instrument.isin;
    markets[s] = got[i]?.instrument.market;
  });
  return { isins, markets };
}

/** `etf compare A,B,C`: the fund facts side by side, the correlation of daily returns, the overlap of holdings. */
export async function etfCompare(symbols: readonly string[], now = clockNow()): Promise<CompareResult> {
  const { isins, markets } = await instruments(symbols);
  const { profiles, amundi, notes } = await etfProfiles(symbols, { isins, markets });
  const datasets: Dataset[] = [];
  for (const p of profiles) datasets.push(...profileDatasets(p, amundi, now));
  for (const p of profiles) if (p.listing.error) notes.push(`${p.symbol}: ${p.listing.error}`);
  // Holdings and overlap.
  const comps = await compositions(profiles, markets);
  profiles.forEach((p, i) => {
    const c = comps[i]!;
    if (c instanceof Error) notes.push(c.message);
    else datasets.push(compositionDataset(p.symbol, c));
  });
  // Correlation of daily returns, one year.
  const bars = await mapLimit(profiles, 3, async (p) => etfBars(p.symbol, p.isin, now).catch((e: Error) => e));
  const corr: Point[] = [];
  const provs: Dataset["provenance"][] = [];
  for (let i = 0; i < profiles.length; i++)
    for (let k = i + 1; k < profiles.length; k++) {
      const a = bars[i]!;
      const b = bars[k]!;
      const A = profiles[i]!.symbol;
      const B = profiles[k]!.symbol;
      if (a instanceof Error || b instanceof Error) {
        notes.push(`correlation ${A} / ${B} unavailable — ${(a instanceof Error ? a : (b as Error)).message.split("\n")[0]}`);
        continue;
      }
      const r = returnCorrelation(a.bars, b.bars);
      if (r.rho === undefined) {
        notes.push(`correlation ${A} / ${B}: only ${r.n} shared daily returns`);
        continue;
      }
      provs.push(a.provenance, b.provenance);
      corr.push({
        key: `ETF.corr.${A}.${B}`,
        label: `correlation of ${A} and ${B} daily returns (${r.from} → ${r.to}, ${r.n} returns)`,
        value: Number(r.rho.toFixed(6)),
        unit: "ratio",
        formula: "Pearson correlation of daily simple returns on the dates both trade, one year",
        asOf: r.to,
      });
    }
  if (corr.length) {
    const first = provs[0]!;
    datasets.push({
      kind: "etf",
      title: "Correlation of daily returns (one year)",
      subject: "ETF.compare",
      points: corr,
      provenance: {
        source: [...new Set(provs.map((x) => x.source))].join("+"),
        fetchedAt: provs.map((x) => x.fetchedAt).sort()[0]!,
        official: provs.every((x) => x.official),
        ...(first.delay ? { delay: first.delay } : {}),
        asOf: corr.map((c) => c.asOf!).sort()[0],
      },
      notes: ["closes in each listing's own currency; a currency move between listings shows up as lower correlation"],
    });
  }
  for (let i = 0; i < profiles.length; i++)
    for (let k = i + 1; k < profiles.length; k++) {
      const ca = comps[i]!;
      const cb = comps[k]!;
      const A = profiles[i]!.symbol;
      const B = profiles[k]!.symbol;
      const same =
        tvStr(profiles[i]!.listing.tv, "index_tracked") &&
        normalizeIndexName(tvStr(profiles[i]!.listing.tv, "index_tracked")!) === normalizeIndexName(tvStr(profiles[k]!.listing.tv, "index_tracked") ?? "");
      if (ca instanceof Error || cb instanceof Error) {
        notes.push(`overlap ${A} / ${B} unavailable${same ? " — both track the same index (normalised name): the exposure is the same by construction" : ""}`);
        continue;
      }
      datasets.push({
        kind: "etf",
        title: `Overlap — ${A} / ${B}`,
        subject: "ETF.compare",
        points: overlapPoints(A, B, ca, cb, 5),
        provenance: overlapProvenance(ca, cb),
        notes: overlapNote(ca, cb),
      });
    }
  notes.push("TER, AUM, NAV and flags: TradingView (unofficial, delayed); PEA and replication: the issuer's flag where Amundi answers, else the stated basis");
  notes.push("NAV returns are in each listing's quote currency (TradingView): compare them only between listings in the same currency");
  const keyOf = (p: EtfProfile, col: string) => (p.listing.tv ? `${p.listing.tv.ticker}.tv.${col}` : undefined);
  const rows: CompareResult["table"]["rows"] = [
    { label: "listing", keys: profiles.map((p) => keyOf(p, "isin")) },
    ...TABLE_COLUMNS.map(([col, label]) => ({ label, keys: profiles.map((p) => keyOf(p, col)) })),
    { label: "replication", keys: profiles.map((p) => `${p.symbol}.etf.replication`) },
    { label: "PEA", keys: profiles.map((p) => `${p.symbol}.etf.pea`) },
    { label: "domicile", keys: profiles.map((p) => `${p.symbol}.etf.domicile`) },
    { label: "lines (issuer file)", keys: profiles.map((p) => `${p.symbol}.lt.lines`) },
  ];
  return { datasets, notes, table: { symbols: profiles.map((p) => p.symbol), rows } };
}

/** `etf overlap A,B`: the sum of the smaller weights, and the common lines. */
export async function etfOverlapReport(a: string, b: string, now = clockNow()): Promise<Dataset[]> {
  const { isins, markets } = await instruments([a, b]);
  const { profiles, amundi, notes } = await etfProfiles([a, b], { isins, markets });
  const datasets: Dataset[] = profiles.flatMap((p) => profileDatasets(p, amundi, now).slice(-1));
  const comps = await compositions(profiles, markets);
  const [ca, cb] = comps as [FundComposition | Error, FundComposition | Error];
  const same =
    tvStr(profiles[0]!.listing.tv, "index_tracked") &&
    normalizeIndexName(tvStr(profiles[0]!.listing.tv, "index_tracked")!) === normalizeIndexName(tvStr(profiles[1]!.listing.tv, "index_tracked") ?? "");
  if (ca instanceof Error || cb instanceof Error) {
    const why = [ca, cb]
      .filter((x): x is Error => x instanceof Error)
      .map((e) => e.message)
      .join("; ");
    throw new Error(`overlap unavailable — ${why}${same ? " (both track the same index, normalised name: the exposure is the same by construction)" : ""}`);
  }
  datasets.push({
    kind: "etf",
    title: `Overlap — ${profiles[0]!.symbol} / ${profiles[1]!.symbol}`,
    subject: "ETF.overlap",
    points: overlapPoints(profiles[0]!.symbol, profiles[1]!.symbol, ca, cb, 15),
    provenance: overlapProvenance(ca, cb),
    notes: [
      ...notes,
      ...ca.notes.map((n) => `${profiles[0]!.symbol}: ${n}`),
      ...cb.notes.map((n) => `${profiles[1]!.symbol}: ${n}`),
      "security names are the issuers' text (fenced as external); the holdings are as of the date each source states",
      ...overlapNote(ca, cb),
    ],
  });
  return datasets;
}

/**
 * An ETF's domicile for the risk gate: TradingView's fund country when it
 * answers (one call), else the ISIN prefix, else "US" for a US listing.
 */
export async function etfFundDomicile(inst: Instrument): Promise<{ code?: string; basis: string }> {
  let fundCountry: string | undefined;
  try {
    const [l] = await etfListings([inst.symbol], { [inst.symbol]: inst.isin });
    fundCountry = tvStr(l?.tv, "country_code_fund");
  } catch {
    // TradingView is a convenience here: the ISIN and the listing still decide.
  }
  return etfDomicile({ fundCountry, isin: inst.isin, market: inst.market });
}
