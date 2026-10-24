// Index constituents from Wikipedia's API — keyless, identified with the polite
// User-Agent Wikimedia asks for, and unofficial (community-edited; index
// providers license their member lists). Good enough to build a screening
// universe, never a source of truth for a membership change.
//
//   https://<en|fr>.wikipedia.org/w/api.php?action=parse&page=<title>&prop=wikitext&format=json&formatversion=2[&section=N]
//
// The page's wikitext is parsed here: tables split into rows and cells, then
// templates ({{NyseSymbol|MMM}}, {{FWB link|ADS.DE}}, {{ISIN|…}}), links and
// references reduced to their text. The constituents table is the one whose
// header has a ticker and a company column. The Dow Jones (a names-only table
// on the "Historical components" page) and the SBF 120 (a names-only list on
// fr.wikipedia) carry no tickers.
//
// SURVIVORSHIP: these are TODAY's members. A backtest over this list ignores
// every company that left the index (acquired, bankrupt, demoted) — its results
// are biased upward.
import { cachedJson, TTL } from "../../core/cache.js";
import type { Dataset, Point } from "../../core/datasets.js";
import { decodeEntities } from "../../engine.js";
import { fetchJson, politeUa } from "../../core/net.js";
import { ProviderError } from "../types.js";

export const SOURCE = "wikipedia";

export interface IndexSpec {
  name: string;
  wiki: "en" | "fr";
  page: string;
  section?: number;
  /** "table" (ticker + name [+ sector]), "names-table" (a grid of names), "names-list" (a # list). */
  shape: "table" | "names-table" | "names-list";
  /** The expected member count, to flag a parse that went wrong. */
  expected: number;
  /** How the table's tickers are written. */
  tickerNote?: string;
}

export const INDICES: Record<string, IndexSpec> = {
  SPX: {
    name: "S&P 500",
    wiki: "en",
    page: "List_of_S&P_500_companies",
    shape: "table",
    expected: 503,
    tickerNote: "US tickers (class shares with a dot: BRK.B)",
  },
  NDX: { name: "Nasdaq-100", wiki: "en", page: "List_of_NASDAQ-100_companies", shape: "table", expected: 101, tickerNote: "US tickers" },
  DJI: {
    name: "Dow Jones Industrial Average",
    wiki: "en",
    page: "Historical_components_of_the_Dow_Jones_Industrial_Average",
    section: 2,
    shape: "names-table",
    expected: 30,
  },
  CAC40: { name: "CAC 40", wiki: "en", page: "CAC_40", shape: "table", expected: 40, tickerNote: "Yahoo-style tickers (AI.PA)" },
  SBF120: { name: "SBF 120", wiki: "fr", page: "SBF_120", shape: "names-list", expected: 120 },
  DAX: { name: "DAX", wiki: "en", page: "DAX", shape: "table", expected: 40, tickerNote: "Yahoo-style tickers (ADS.DE)" },
  SX5E: { name: "Euro Stoxx 50", wiki: "en", page: "EURO_STOXX_50", shape: "table", expected: 50, tickerNote: "Yahoo-style tickers (ADS.DE)" },
  AEX: { name: "AEX", wiki: "en", page: "AEX_index", shape: "table", expected: 30, tickerNote: "Yahoo-style tickers (ASML.AS)" },
  UKX: {
    name: "FTSE 100",
    wiki: "en",
    page: "FTSE_100_Index",
    shape: "table",
    expected: 100,
    tickerNote: "London Stock Exchange EPIC codes (add .L for Yahoo)",
  },
};
const INDEX_ALIASES: Record<string, string> = {
  SP500: "SPX",
  "S&P500": "SPX",
  "S&P 500": "SPX",
  NASDAQ100: "NDX",
  "NASDAQ-100": "NDX",
  DOW: "DJI",
  DJIA: "DJI",
  CAC: "CAC40",
  "CAC 40": "CAC40",
  "SBF 120": "SBF120",
  DAX40: "DAX",
  EUROSTOXX50: "SX5E",
  "EURO STOXX 50": "SX5E",
  STOXX50: "SX5E",
  FTSE100: "UKX",
  "FTSE 100": "UKX",
  FTSE: "UKX",
};

/** The index id for a name or alias (SPX, "S&P 500", CAC40…). */
export function indexId(name: string): string | undefined {
  const n = name.trim().toUpperCase();
  return INDICES[n] ? n : INDEX_ALIASES[n];
}

/** Split on `sep` outside [[…]] and {{…}}. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (two === "[[" || two === "{{") {
      depth++;
      cur += two;
      i++;
    } else if ((two === "]]" || two === "}}") && depth > 0) {
      depth--;
      cur += two;
      i++;
    } else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(cur);
      cur = "";
      i += sep.length - 1;
    } else cur += s[i];
  }
  out.push(cur);
  return out;
}

const VALUE_TEMPLATES = /symbol|link|isin|fwb|euronext|nyse|nasdaq|lse|ticker|xetra|nowrap|nobr/i;

/** A wikitext cell reduced to plain text: references, comments, templates, links and markup removed. */
export function cleanWikitext(raw: string): string {
  let s = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<br\s*\/?>/gi, " ");
  // Templates, innermost first: value-carrying ones keep their first positional argument.
  for (let guard = 0; guard < 20 && /\{\{[^{}]*\}\}/.test(s); guard++)
    s = s.replace(/\{\{([^{}]*)\}\}/g, (_, body: string) => {
      const parts = splitTop(body, "|").map((p) => p.trim());
      const name = parts[0] ?? "";
      if (!VALUE_TEMPLATES.test(name)) return "";
      return parts.slice(1).find((p) => !/^[\w-]+\s*=/.test(p)) ?? "";
    });
  s = s
    .replace(/\[\[(?:File|Image|Fichier):[^\]]*\]\]/gi, "")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)
    .replace(/[↑↓†‡*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop a cell's attribute prefix (`style="…" | text`): the part before a top-level single pipe. */
function cellContent(cell: string): string {
  const parts = splitTop(cell, "|");
  return parts.length > 1 ? parts.slice(1).join("|") : cell;
}

/** Every `{| … |}` table in the wikitext as rows of cleaned cells; `header` marks rows made of `!` cells. */
export function wikiTables(wikitext: string): Array<Array<{ header: boolean; cells: string[] }>> {
  const tables: Array<Array<{ header: boolean; cells: string[] }>> = [];
  for (const m of wikitext.matchAll(/^\{\|[^\n]*\n([\s\S]*?)^\|\}/gm)) {
    const rows: Array<{ header: boolean; raw: string[] }> = [];
    let row: { header: boolean; raw: string[] } | undefined;
    for (const line of m[1]!.split("\n")) {
      const t = line.trim();
      if (t.startsWith("|-")) {
        if (row?.raw.length) rows.push(row);
        row = undefined;
        continue;
      }
      if (t.startsWith("|+")) continue;
      if (t.startsWith("!") || t.startsWith("|")) {
        row ??= { header: t.startsWith("!"), raw: [] };
        const body = t.slice(1);
        const cells = t.startsWith("!") ? splitTop(body, "!!").flatMap((c) => splitTop(c, "||")) : splitTop(body, "||");
        row.raw.push(...cells.map(cellContent));
      } else if (row?.raw.length && t) row.raw[row.raw.length - 1] += ` ${t}`;
    }
    if (row?.raw.length) rows.push(row);
    tables.push(rows.map((r) => ({ header: r.header, cells: r.raw.map(cleanWikitext) })));
  }
  return tables;
}

export interface Constituent {
  ticker?: string;
  name: string;
  sector?: string;
}

const TICKER_COL = /^(ticker|symbol|ticker symbol|epic|code)\b/i;
const NAME_COL = /company|security|^name|constituent/i;

/** The constituents table of a page: the first table with a ticker and a company column (sector when present). */
export function parseConstituentTable(wikitext: string): Constituent[] {
  for (const table of wikiTables(wikitext)) {
    const head = table.find((r) => r.header);
    if (!head) continue;
    const ti = head.cells.findIndex((c) => TICKER_COL.test(c));
    const ni = head.cells.findIndex((c, i) => i !== ti && NAME_COL.test(c));
    if (ti < 0 || ni < 0) continue;
    let si = head.cells.findIndex((c) => /sector/i.test(c) && !/sub/i.test(c));
    if (si < 0) si = head.cells.findIndex((c) => /industry/i.test(c) && !/sub/i.test(c));
    const out: Constituent[] = [];
    for (const r of table) {
      if (r.header) continue;
      const ticker = r.cells[ti]?.replace(/\s+/g, "");
      const name = r.cells[ni];
      if (!ticker || !name) continue;
      out.push({ ticker, name, ...(si >= 0 && r.cells[si] ? { sector: r.cells[si] } : {}) });
    }
    if (out.length >= 10) return out;
  }
  return [];
}

/** A grid of names (the Dow's current-components table), stopping at the "Dropped from Average" row. */
export function parseNamesTable(wikitext: string): Constituent[] {
  const table = wikiTables(wikitext)[0] ?? [];
  const out: Constituent[] = [];
  for (const r of table) {
    if (r.cells.some((c) => /dropped|removed/i.test(c))) break;
    for (const c of r.cells) {
      const name = c.replace(/\(formerly[^)]*\)/i, "").trim();
      if (name) out.push({ name });
    }
  }
  return out;
}

/** A `#`-numbered list of names inside {{colonnes|…}} (fr.wikipedia's SBF 120). */
export function parseNamesList(wikitext: string): Constituent[] {
  const at = wikitext.search(/\{\{colonnes/i);
  if (at < 0) return [];
  const out: Constituent[] = [];
  for (const line of wikitext.slice(at).split("\n").slice(1)) {
    if (line.trim().startsWith("}}")) break;
    if (!line.startsWith("#")) continue;
    const name = cleanWikitext(line.slice(1));
    if (name) out.push({ name });
  }
  return out;
}

export interface ConstituentList {
  index: string;
  name: string;
  constituents: Constituent[];
  url: string;
  fetchedAt: string;
  notes: string[];
}

/** Today's members of an index, parsed from Wikipedia (cached a week). */
export async function fetchConstituents(index: string): Promise<ConstituentList> {
  const id = indexId(index);
  const spec = id ? INDICES[id] : undefined;
  if (!id || !spec) throw new ProviderError(SOURCE, `unknown index "${index}" (known: ${Object.keys(INDICES).join(", ")})`);
  const list = await cachedJson(`wikipedia:constituents:${id}`, TTL.reference, async () => {
    const api = `https://${spec.wiki}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(spec.page)}&prop=wikitext&format=json&formatversion=2&redirects=1${spec.section !== undefined ? `&section=${spec.section}` : ""}`;
    const res = await fetchJson<{ parse?: { wikitext?: string; revid?: number }; error?: { info?: string } }>(api, { userAgent: politeUa() });
    if (!res.ok) throw new ProviderError(SOURCE, `page ${spec.page} unavailable (HTTP ${res.status})`, res.status);
    const text = res.data?.parse?.wikitext;
    if (!text) throw new ProviderError(SOURCE, `page ${spec.page}: ${res.data?.error?.info ?? "no wikitext"}`, 404);
    const constituents = spec.shape === "table" ? parseConstituentTable(text) : spec.shape === "names-table" ? parseNamesTable(text) : parseNamesList(text);
    if (!constituents.length) throw new ProviderError(SOURCE, `no constituents table found on ${spec.page} — the page layout changed`);
    const notes = [
      "SURVIVORSHIP: current members only — a backtest over this list ignores every company that left the index, and is biased upward.",
      "Community-edited (Wikipedia), not the index provider's licensed list; check a recent membership change against the provider.",
    ];
    if (spec.tickerNote) notes.push(`Tickers: ${spec.tickerNote}.`);
    if (spec.shape !== "table") notes.push("This page lists names only, no tickers: resolve each name before quoting it.");
    if (Math.abs(constituents.length - spec.expected) > Math.max(3, spec.expected * 0.05))
      notes.push(`parsed ${constituents.length} members where about ${spec.expected} were expected — the page may have changed`);
    return {
      index: id,
      name: spec.name,
      constituents,
      url: `https://${spec.wiki}.wikipedia.org/wiki/${encodeURIComponent(spec.page)}`,
      fetchedAt: res.fetchedAt,
      notes,
    } satisfies ConstituentList;
  });
  if (!list) throw new ProviderError(SOURCE, `constituents of ${id} unavailable offline`);
  return list;
}

/** A constituent list as a dataset: the count, then one untrusted point per member ("TICKER | Name | Sector"). */
export function constituentsToDataset(list: ConstituentList): Dataset {
  const points: Point[] = [{ key: `${list.index}.universe.count`, label: `${list.name} members listed`, value: list.constituents.length, unit: "count" }];
  list.constituents.forEach((c, i) =>
    points.push({
      key: `${list.index}.universe.${i + 1}`,
      label: `${list.name} member ${i + 1}`,
      value: [c.ticker, c.name, c.sector].filter(Boolean).join(" | "),
      untrusted: true,
    }),
  );
  return {
    kind: "universe",
    title: `${list.name} constituents (Wikipedia)`,
    subject: list.index,
    points,
    provenance: { source: SOURCE, url: list.url, fetchedAt: list.fetchedAt, official: false, asOf: list.fetchedAt.slice(0, 10) },
    notes: list.notes,
  };
}

/** Today's members of an index as a dataset. */
export async function indexUniverse(index: string): Promise<Dataset> {
  return constituentsToDataset(await fetchConstituents(index));
}
