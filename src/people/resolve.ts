// A name → the public figures it may mean, asked of each source live: the
// House Clerk's index (members who filed a PTR this year or last), OGE's index
// (executive-branch filers), and EDGAR's name search (funds, holders above 5%,
// Form 4 filers). A source that fails is said in the notes, never fatal.
import { clockNow } from "../core/net.js";
import { houseIndex, houseMembersMatching } from "../providers/fundamentals/house.js";
import { ogeFilings } from "../providers/fundamentals/oge.js";
import { type SecSubmissions, searchEdgarEntities, secSubmissions } from "../providers/fundamentals/sec.js";
import { senateStatus } from "../providers/fundamentals/senate.js";
import type { PersonRef, PersonSource, SecRole } from "./types.js";
import { parseRefString } from "./types.js";

/** How many of EDGAR's name matches are looked at (each costs one request). */
const SEC_DEPTH = 6;

const SEC_ROLE_NAMES: Record<SecRole, string> = { "13f": "13F filer", form4: "Form 4 reporting owner", "13dg": "13D/13G holder" };

/** What an SEC filer files, from its recent submissions; a company with tickers files Form 4 about its insiders, not as one. */
export function secRolesOf(sub: Pick<SecSubmissions, "filings" | "tickers">): SecRole[] {
  const forms = new Set(sub.filings.map((f) => f.form));
  const roles: SecRole[] = [];
  if (forms.has("13F-HR")) roles.push("13f");
  if (!sub.tickers.length && (forms.has("4") || forms.has("4/A"))) roles.push("form4");
  if ([...forms].some((f) => /^SCHEDULE 13[DG]/.test(f))) roles.push("13dg");
  return roles;
}

export const secRoleText = (roles: readonly SecRole[]) => roles.map((r) => SEC_ROLE_NAMES[r]).join(" · ");

async function houseCandidates(query: string, now: Date): Promise<PersonRef[]> {
  const year = now.getUTCFullYear();
  const seen = new Map<string, PersonRef>();
  for (const y of [year, year - 1]) {
    const idx = await houseIndex(y).catch((e) => {
      if (y === year) throw e;
      return undefined;
    });
    for (const m of houseMembersMatching(idx?.filings.filter((f) => f.filingType === "P") ?? [], query))
      if (!seen.has(m.member)) seen.set(m.member, { source: "house", id: m.member, name: m.member, role: `US House member, ${m.stateDistrict}` });
    if (seen.size) break;
  }
  return [...seen.values()];
}

async function ogeCandidates(query: string): Promise<PersonRef[]> {
  const { filings } = await ogeFilings(query);
  const seen = new Map<string, PersonRef>();
  for (const f of filings)
    if ((f.kind === "278-T" || f.kind === "annual") && !seen.has(f.name))
      seen.set(f.name, { source: "oge", id: f.name, name: f.name, role: [f.title, f.agency].filter(Boolean).join(", ") });
  return [...seen.values()];
}

async function secCandidates(query: string): Promise<PersonRef[]> {
  const out: PersonRef[] = [];
  for (const e of (await searchEdgarEntities(query)).slice(0, SEC_DEPTH)) {
    const sub = await secSubmissions(e.cik);
    const roles = secRolesOf(sub);
    if (roles.length) out.push({ source: "sec", id: String(e.cik), name: sub.name || e.name, role: secRoleText(roles), roles });
  }
  return out;
}

/** Everyone `query` may mean, by source, best first within a source; `source` asks one source only. */
export async function searchPeople(
  query: string,
  opts: { source?: PersonSource; now?: Date; senate?: boolean } = {},
): Promise<{ candidates: PersonRef[]; notes: string[] }> {
  const now = opts.now ?? clockNow();
  const asks: Array<[PersonSource, () => Promise<PersonRef[]>]> = [
    ["house", () => houseCandidates(query, now)],
    ["oge", () => ogeCandidates(query)],
    ["sec", () => secCandidates(query)],
  ];
  const chosen = asks.filter(([s]) => !opts.source || s === opts.source);
  const got = await Promise.allSettled(chosen.map(([, run]) => run()));
  const candidates: PersonRef[] = [];
  const notes: string[] = [];
  got.forEach((g, i) => {
    if (g.status === "fulfilled") candidates.push(...g.value);
    else notes.push(`${chosen[i]![0]} not searched: ${(g.reason as Error).message}`);
  });
  if (opts.senate !== false && (!opts.source || opts.source === "house")) notes.push((await senateStatus()).note);
  return { candidates, notes };
}

/** A ref given as "source:id", completed from its source (name, roles). */
export async function refFromString(s: string): Promise<PersonRef | undefined> {
  const r = parseRefString(s);
  if (!r) return undefined;
  if (r.source !== "sec") return { ...r, name: r.id };
  const sub = await secSubmissions(Number(r.id));
  const roles = secRolesOf(sub);
  return { ...r, name: sub.name || `CIK ${r.id}`, role: secRoleText(roles), roles };
}

export class AmbiguousPerson extends Error {
  constructor(
    readonly query: string,
    readonly candidates: PersonRef[],
    readonly notes: string[],
  ) {
    super(
      candidates.length
        ? `"${query}" matches ${candidates.length} filers — name one by its ref (source:id), shown by \`ultrastock people search\``
        : `nobody matches "${query}" at the House Clerk, OGE or EDGAR${notes.length ? ` (${notes.join("; ")})` : ""}`,
    );
  }
}

/** The one person `query` means: a ref as is, else the only candidate (or the only exact name match); else AmbiguousPerson. */
export async function pickPerson(query: string, opts: { source?: PersonSource; now?: Date } = {}): Promise<PersonRef> {
  const direct = await refFromString(query);
  if (direct) return direct;
  const { candidates, notes } = await searchPeople(query, { ...opts, senate: false });
  if (candidates.length === 1) return candidates[0]!;
  const exact = candidates.filter((c) => c.name.trim().toLowerCase() === query.trim().toLowerCase());
  if (exact.length === 1) return exact[0]!;
  throw new AmbiguousPerson(query, candidates, notes);
}
