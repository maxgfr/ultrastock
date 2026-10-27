// National elections and referendums, by date, from Wikipedia's yearly
// "national electoral calendar" (keyless, public, community-maintained — so
// unofficial: a date can move, and the page says when it is provisional).
//
//   GET https://en.wikipedia.org/w/api.php?action=parse&page=2026_national_electoral_calendar&prop=wikitext&format=json&formatversion=2
//
// The page lists, month by month, `* 25 October: [[Elections in Brazil|Brazil]],
// [[2026 Brazilian general election|President (2nd round)]]` — one line per
// date, or a date line with nested `**` entries. Dependent territories are in
// italics and left out. Offices are the page's own words: kept as labels, never
// as instructions, and classified into a few kinds for the event study.
import { fetchJson, politeUa } from "../../core/net.js";
import { ProviderError } from "../types.js";

export const SOURCE = "wikipedia-elections";

export type ElectionKind = "presidential" | "legislative" | "general" | "referendum" | "local" | "other";

export interface ElectionEvent {
  /** First day of voting (ISO date). */
  date: string;
  /** Last day, when voting spans several days. */
  endDate?: string;
  country: string;
  /** ISO 3166-1 alpha-2, when the name maps to one. */
  iso?: string;
  /** The page's own label: "President (2nd round), Chamber of Deputies and Senate". */
  office: string;
  kind: ElectionKind;
  /** 1 or 2 when the label names a round. */
  round?: number;
  /** The election's Wikipedia article. */
  article?: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// Names the region display names spell differently from the calendar page.
const ALIASES: Record<string, string> = {
  "czech republic": "CZ",
  "bosnia and herzegovina": "BA",
  "united states": "US",
  "united kingdom": "GB",
  "south korea": "KR",
  "north korea": "KP",
  "ivory coast": "CI",
  "democratic republic of the congo": "CD",
  "republic of the congo": "CG",
  turkey: "TR",
  "the gambia": "GM",
  "the bahamas": "BS",
  "east timor": "TL",
  "cape verde": "CV",
  "north macedonia": "MK",
  "federated states of micronesia": "FM",
  palestine: "PS",
  taiwan: "TW",
  kosovo: "XK",
  russia: "RU",
  "hong kong": "HK",
  myanmar: "MM",
  "saint kitts and nevis": "KN",
  "saint lucia": "LC",
  "saint vincent and the grenadines": "VC",
  "republic of macedonia": "MK",
  macedonia: "MK",
  "sao tome and principe": "ST",
  "vatican city": "VA",
};

let names: Map<string, string> | undefined;

/** ISO alpha-2 for an English country name — through the runtime's region names, plus a few aliases. */
export function countryIso(name: string): string | undefined {
  const key = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/&/g, "and")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (ALIASES[key]) return ALIASES[key];
  if (!names) {
    names = new Map();
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        let n: string | undefined;
        try {
          n = dn.of(code);
        } catch {
          n = undefined;
        }
        if (n && n !== code)
          names.set(
            n
              .toLowerCase()
              .normalize("NFD")
              .replace(/\p{M}/gu, "")
              .replace(/&/g, "and")
              .replace(/[^a-z ]+/g, " ")
              .replace(/\s+/g, " ")
              .trim(),
            code,
          );
      }
  }
  return names.get(key);
}

/** The kind of an office label, for comparing like with like. */
export function electionKind(office: string): ElectionKind {
  const o = office.toLowerCase();
  if (/referend|plebiscit/.test(o)) return "referendum";
  if (/\b(?:municipal|local|regional|provincial|gubernatorial|governor|mayor)/.test(o) && !/presiden|parliament|national/.test(o)) return "local";
  if (/presiden/.test(o) && /(?:parliament|chamber|house|assembly|congress|senate|deputies|legislat)/.test(o)) return "general";
  if (/presiden/.test(o)) return "presidential";
  if (/general/.test(o)) return "general";
  if (/parliament|chamber|house|assembly|congress|senate|deputies|legislat|knesset|duma|bundestag|diet|lok sabha|cortes|sejm|riksdag/.test(o))
    return "legislative";
  return "other";
}

const LINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const plain = (s: string) =>
  s
    .replace(LINK, (_m, target: string, label?: string) => label ?? target)
    .replace(/'{2,}/g, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();

function parseDay(text: string, month: number, year: number): { date: string; endDate?: string } | undefined {
  // "25 October", "9–10 October", "30 September – 1 October"
  const m = /^(\d{1,2})(?:\s*[–-]\s*(\d{1,2}))?\s+([A-Za-z]+)(?:\s*[–-]\s*(\d{1,2})\s+([A-Za-z]+))?/.exec(text.trim());
  if (!m) return undefined;
  const iso = (d: number, mo: number) => `${year}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const mo = MONTHS.indexOf(m[3]!.toLowerCase());
  const start = mo >= 0 ? mo : month;
  if (m[4] && m[5]) {
    const mo2 = MONTHS.indexOf(m[5].toLowerCase());
    return { date: iso(Number(m[1]), start), endDate: iso(Number(m[4]), mo2 >= 0 ? mo2 : start) };
  }
  return { date: iso(Number(m[1]), start), ...(m[2] ? { endDate: iso(Number(m[2]), start) } : {}) };
}

function entry(raw: string, when: { date: string; endDate?: string }): ElectionEvent | undefined {
  const text = raw.trim();
  // Dependent territories are written in italics.
  if (/^''/.test(text.replace(/^\[\[[^\]]*\|/, ""))) return undefined;
  const links = [...text.matchAll(LINK)];
  const first = links[0];
  if (!first) return undefined;
  const country = plain(first[0]).replace(/,$/, "");
  if (/^''/.test(first[2] ?? "")) return undefined;
  const rest = text.slice((first.index ?? 0) + first[0].length).replace(/^\s*,\s*/, "");
  const office = plain(rest);
  if (!office) return undefined;
  const round = /\b(1st|first)\s+round/i.test(office) ? 1 : /\b(2nd|second)\s+round|run-?off/i.test(office) ? 2 : undefined;
  const article = links.find((l) => /\d{4}.*(?:election|referendum)/i.test(l[1]!))?.[1];
  return { ...when, country, iso: countryIso(country), office, kind: electionKind(office), ...(round ? { round } : {}), ...(article ? { article } : {}) };
}

/** Parse one year's calendar wikitext into dated national events, in page order. */
export function parseElectionCalendar(wikitext: string, year: number): ElectionEvent[] {
  const text = wikitext.replace(/<ref[^>]*\/>|<ref[\s\S]*?<\/ref>|<!--[\s\S]*?-->/g, "");
  const out: ElectionEvent[] = [];
  let month = -1;
  let current: { date: string; endDate?: string } | undefined;
  for (const line of text.split("\n")) {
    const h = /^==\s*([A-Za-z]+)\s*==\s*$/.exec(line.trim());
    if (h) {
      month = MONTHS.indexOf(h[1]!.toLowerCase());
      current = undefined;
      continue;
    }
    if (month < 0) continue;
    const top = /^\*(?!\*)\s*(.*)$/.exec(line);
    const nested = /^\*\*\s*(.*)$/.exec(line);
    if (top) {
      const body = top[1]!;
      const colon = body.indexOf(":");
      const when = colon > 0 ? parseDay(body.slice(0, colon), month, year) : undefined;
      current = when;
      if (!when) continue;
      const after = body.slice(colon + 1).trim();
      if (after) {
        const e = entry(after, when);
        if (e) out.push(e);
      }
    } else if (nested && current) {
      const e = entry(nested[1]!, current);
      if (e) out.push(e);
    }
  }
  return out;
}

/** One year's national elections and referendums. */
export async function electionCalendar(year: number): Promise<{ events: ElectionEvent[]; url: string; fetchedAt: string }> {
  const page = `${year}_national_electoral_calendar`;
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${page}&prop=wikitext&format=json&formatversion=2`;
  const res = await fetchJson<{ parse?: { wikitext?: string }; error?: { info?: string } }>(url, { userAgent: politeUa(), hostIntervalMs: 500 });
  const wikitext = res.data?.parse?.wikitext;
  if (!res.ok || !wikitext) throw new ProviderError(SOURCE, `no electoral calendar for ${year} (${res.data?.error?.info ?? res.status})`, res.status);
  return { events: parseElectionCalendar(wikitext, year), url: `https://en.wikipedia.org/wiki/${page}`, fetchedAt: res.fetchedAt };
}
