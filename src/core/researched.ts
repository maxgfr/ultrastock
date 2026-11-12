// Researched facts: what changes over time (tax rules today; jurisdiction
// rules, envelope ceilings, venue fees and market closures next) is not built
// into ultrastock. The agent looks each fact up on official sources and stores
// it with its sources and the date it checked it; this module is the one place
// that declares, validates, stores and reads such facts.
//
// - A DOMAIN (`defineDomain`) registers its keys per country: name, label, type,
//   unit, a search query and the kind of official source to prefer.
// - A FILE holds one domain's facts for one country and one period (a year or a
//   date): <home>/facts/<domain>/<CC>-<period>.json, written atomically.
// - VALIDATION is strict: every fact has a value of its key's type, at least
//   one source URL, a verifiedAt date and a confidence; a domain may refuse
//   keys it does not know. A fact past its `expiresAt`, or older than its key's
//   `maxAgeDays`, reads as unknown (listed as stale), never as current.
// - A TEMPLATE is generated from the registry with every value null, for the
//   agent to fill.
//
// API: defineDomain, factsPath, validateFacts, loadFacts, saveFacts,
// factsTemplate, factsChecklist, storedPeriods, factValue.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, UsageError, writeFileAtomic } from "../engine.js";
import { clockNow } from "./net.js";
import { homeDir } from "./paths.js";

export type FactType = "rate" | "amount" | "number" | "date" | "text" | "boolean" | "rates" | "amounts" | "any";
export type Confidence = "high" | "medium" | "low";

export interface FactSpec {
  key: string;
  label: string;
  type: FactType;
  /** What the value is in: "fraction of 1", "tax currency", "days", an ISO date… */
  unit: string;
  /** For `rates` / `amounts`: the fields the object holds, all of them and only them. */
  fields?: readonly string[];
  /** A web search to start from; `{period}` and `{country}` are filled in. */
  query: string;
  /** The kind of official source to prefer. */
  prefer: string;
  /** A verified value older than this reads as unknown. */
  maxAgeDays?: number;
  note?: string;
}

export interface Fact {
  value: unknown;
  label: string;
  sources: string[];
  verifiedAt: string;
  confidence: Confidence;
  /** After this date the value reads as unknown. */
  expiresAt?: string;
  note?: string;
}

export interface FactFile {
  domain: string;
  country: string;
  /** The year (a number) or the date (YYYY-MM-DD) the facts hold for. */
  period: number | string;
  researchedAt: string;
  note?: string;
  /** Domain metadata (tax: the currency amounts are in). */
  meta: Record<string, string>;
  facts: Record<string, Fact>;
}

export interface DomainDef<S extends FactSpec = FactSpec> {
  /** The directory under <home>/facts/. */
  name: string;
  /** What a file is keyed by besides the country, and the field naming it in the file. */
  period: "year" | "date";
  keysFor(country: string): readonly S[];
  /** Whether a key outside `keysFor` is refused (an engine reads a fixed list), or kept (free research). */
  strict(country: string): boolean;
  /** Extra top-level fields the file must hold, each with its check (a problem, or undefined) and its template value. */
  meta?: Record<string, { check(value: unknown, country: string): string | undefined; template(country: string): unknown }>;
  /** The command that prints the template, and the one that stores a file (named in errors). */
  templateCommand(country: string, period: number | string): string;
  setCommand: string;
  /** A paragraph at the top of the template; extra template fields (e.g. form lines to check). */
  about(country: string, period: number | string): string;
  templateExtras?(country: string, period: number | string): Record<string, unknown>;
}

export type Domain<S extends FactSpec = FactSpec> = Readonly<DomainDef<S>>;

export const defineDomain = <S extends FactSpec>(def: DomainDef<S>): Domain<S> => Object.freeze(def);

export function countryCode(raw: string): string {
  const c = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw new UsageError(`a country is an ISO 3166 alpha-2 code such as FR, US or DE, not "${raw}"`);
  return c;
}

export const factsDir = (d: Domain): string => join(homeDir(), "facts", d.name);
export const factsPath = (d: Domain, country: string, period: number | string): string => join(factsDir(d), `${countryCode(country)}-${period}.json`);

export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const isUrl = (s: unknown): boolean => {
  if (typeof s !== "string" || !/^https?:\/\/\S+$/.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
};
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const FREE_KEY = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/;
const DAY_MS = 86_400_000;
const today = () => clockNow().toISOString().slice(0, 10);

/** Fields a template carries for the agent: accepted in a file and dropped when it is stored. */
const TEMPLATE_FACT_FIELDS = new Set(["type", "unit", "fields", "query", "prefer", "maxAgeDays", "usedBy"]);
const FACT_FIELDS = new Set(["value", "label", "sources", "verifiedAt", "confidence", "expiresAt", "note"]);
const TEMPLATE_TOP_FIELDS = new Set(["_about", "formLines"]);

/** Whether `v` is a value of `spec`'s type: a problem in words, or undefined. */
export function typeProblem(spec: Pick<FactSpec, "type" | "fields">, v: unknown): string | undefined {
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  switch (spec.type) {
    case "rate":
      return num(v) && v >= 0 && v <= 1 ? undefined : "a rate is a number between 0 and 1 (a fraction, not a percent)";
    case "amount":
    case "number":
      return num(v) && v >= 0 ? undefined : `a ${spec.type} is a number ≥ 0`;
    case "date":
      return isIsoDate(v) ? undefined : "a date is written YYYY-MM-DD";
    case "text":
      return typeof v === "string" && v.trim() ? undefined : "a text value is a non-empty string";
    case "boolean":
      return typeof v === "boolean" ? undefined : "the value is true or false";
    case "rates":
    case "amounts": {
      if (!isPlainObject(v)) return `the value is an object with the fields ${spec.fields?.join(", ")}`;
      const want = new Set(spec.fields ?? []);
      const missing = [...want].filter((f) => !(f in v));
      const extra = Object.keys(v).filter((f) => !want.has(f));
      const bad = Object.entries(v).filter(([, x]) => !num(x) || x < 0 || (spec.type === "rates" && x > 1));
      const parts = [
        missing.length ? `missing field(s) ${missing.join(", ")}` : "",
        extra.length ? `unknown field(s) ${extra.join(", ")}` : "",
        bad.length ? `field(s) ${bad.map(([k]) => k).join(", ")} must be ${spec.type === "rates" ? "rates between 0 and 1" : "numbers ≥ 0"}` : "",
      ].filter(Boolean);
      return parts.length ? parts.join("; ") : undefined;
    }
    case "any":
      return v === null || v === undefined ? "no value" : undefined;
  }
}

export interface ValidatedFacts {
  /** The file as stored: stale facts included (their sources say where to re-check). */
  file: FactFile;
  /** The facts that read as current: the file's, less the stale ones. */
  current: Record<string, Fact>;
  /** Registered keys the file does not hold, or holds stale. */
  missing: string[];
  /** Keys whose value expired or outlived its key's maxAgeDays: dropped from `file.facts`. */
  stale: Array<{ key: string; reason: string }>;
}

/**
 * A facts file checked strictly against its domain: metadata, every fact of its key's type with ≥ 1 source URL, a
 * verifiedAt date and a confidence; unknown keys refused when the domain is strict for that country. `expect` pins the
 * country and period the caller asked for. Every problem is listed in one usage error.
 */
export function validateFacts(d: Domain, raw: unknown, expect: { country?: string; period?: number | string } = {}): ValidatedFacts {
  const problems: string[] = [];
  const p = d.period;
  if (!isPlainObject(raw)) throw new UsageError(`a ${d.name} facts file is a JSON object {"country", "${p}", "researchedAt", "facts"}`);
  const now = today();
  const top = new Set(["country", p, "researchedAt", "note", "facts", ...Object.keys(d.meta ?? {})]);
  for (const k of Object.keys(raw)) if (!top.has(k) && !TEMPLATE_TOP_FIELDS.has(k)) problems.push(`unknown top-level field "${k}"`);
  const country = typeof raw.country === "string" ? raw.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(country)) problems.push('"country" is an ISO 3166 alpha-2 code such as "FR"');
  const period = raw[p];
  const periodOk = p === "year" ? typeof period === "number" && Number.isInteger(period) && period >= 1900 && period <= 2200 : isIsoDate(period);
  if (!periodOk) problems.push(p === "year" ? '"year" is an integer such as 2025' : '"date" is written YYYY-MM-DD');
  if (expect.country && country && country !== expect.country.toUpperCase()) problems.push(`the file is for ${country}, not ${expect.country.toUpperCase()}`);
  if (expect.period !== undefined && periodOk && period !== expect.period)
    problems.push(`the file is for ${p} ${String(period)}, not ${expect.period} — research ${expect.period}'s facts: another ${p}'s are not used`);
  if (!isIsoDate(raw.researchedAt)) problems.push('"researchedAt" is the date of the research, YYYY-MM-DD');
  else if (raw.researchedAt > now) problems.push(`"researchedAt" ${raw.researchedAt} is in the future`);
  if (raw.note !== undefined && typeof raw.note !== "string") problems.push('"note" is a string');
  const meta: Record<string, string> = {};
  for (const [k, m] of Object.entries(d.meta ?? {})) {
    const problem = m.check(raw[k], country);
    if (problem) problems.push(`"${k}": ${problem}`);
    else meta[k] = String(raw[k]).trim().toUpperCase();
  }
  const strict = country ? d.strict(country) : false;
  const specs = new Map(country ? d.keysFor(country).map((s) => [s.key, s]) : []);
  const facts: Record<string, Fact> = {};
  const stale: ValidatedFacts["stale"] = [];
  if (!isPlainObject(raw.facts) || !Object.keys(raw.facts).length) problems.push('"facts" is an object of researched facts, by key');
  else
    for (const [key, f] of Object.entries(raw.facts)) {
      const spec = specs.get(key);
      const at = `facts["${key}"]`;
      if (!spec && strict) {
        problems.push(`${at}: not a ${country} ${d.name} key (\`${d.templateCommand(country, periodOk ? (period as number | string) : "…")}\` lists them)`);
        continue;
      }
      if (!spec && !FREE_KEY.test(key)) problems.push(`${at}: a key is dotted words such as "capitalGains.rates"`);
      if (!isPlainObject(f)) {
        problems.push(`${at}: an object {value, label, sources, verifiedAt, confidence}`);
        continue;
      }
      for (const k of Object.keys(f)) if (!FACT_FIELDS.has(k) && !TEMPLATE_FACT_FIELDS.has(k)) problems.push(`${at}: unknown field "${k}"`);
      if (f.value === null || f.value === undefined) {
        problems.push(`${at}: not researched (value is null) — fill it or remove the key`);
        continue;
      }
      const tp = typeProblem(spec ?? { type: "any" }, f.value);
      if (tp) problems.push(`${at}.value: ${tp}`);
      if (spec && f.type !== undefined && f.type !== spec.type) problems.push(`${at}.type: "${String(f.type)}", the key is a ${spec.type}`);
      if (typeof f.label !== "string" || !f.label.trim()) problems.push(`${at}.label: a non-empty string`);
      if (!Array.isArray(f.sources) || !f.sources.length) problems.push(`${at}.sources: at least one URL of the text the value was read from`);
      else for (const s of f.sources) if (!isUrl(s)) problems.push(`${at}.sources: "${String(s)}" is not an http(s) URL`);
      if (!isIsoDate(f.verifiedAt)) problems.push(`${at}.verifiedAt: the date it was checked, YYYY-MM-DD`);
      else if (f.verifiedAt > now) problems.push(`${at}.verifiedAt: ${f.verifiedAt} is in the future`);
      if (f.confidence !== "high" && f.confidence !== "medium" && f.confidence !== "low") problems.push(`${at}.confidence: "high", "medium" or "low"`);
      if (f.expiresAt !== undefined && !isIsoDate(f.expiresAt)) problems.push(`${at}.expiresAt: YYYY-MM-DD`);
      if (f.note !== undefined && typeof f.note !== "string") problems.push(`${at}.note: a string`);
      const fact: Fact = {
        value: f.value,
        label: String(f.label ?? ""),
        sources: Array.isArray(f.sources) ? (f.sources as string[]) : [],
        verifiedAt: String(f.verifiedAt ?? ""),
        confidence: f.confidence as Confidence,
        ...(typeof f.expiresAt === "string" ? { expiresAt: f.expiresAt } : {}),
        ...(typeof f.note === "string" ? { note: f.note } : {}),
      };
      const expired = fact.expiresAt !== undefined && fact.expiresAt < now;
      const tooOld =
        spec?.maxAgeDays !== undefined &&
        isIsoDate(fact.verifiedAt) &&
        Date.parse(`${now}T00:00:00Z`) - Date.parse(`${fact.verifiedAt}T00:00:00Z`) > spec.maxAgeDays * DAY_MS;
      if (expired) stale.push({ key, reason: `expired on ${fact.expiresAt}` });
      else if (tooOld) stale.push({ key, reason: `verified ${fact.verifiedAt}, older than ${spec?.maxAgeDays} days` });
      // A stale fact is kept in the stored file (its sources are where to re-check) but never read as current.
      facts[key] = fact;
    }
  if (problems.length) throw new UsageError(`the ${d.name} facts file does not validate:\n  - ${problems.join("\n  - ")}`);
  const file: FactFile = {
    domain: d.name,
    country,
    period: period as number | string,
    researchedAt: raw.researchedAt as string,
    ...(typeof raw.note === "string" ? { note: raw.note } : {}),
    meta,
    facts,
  };
  const staleKeys = new Set(stale.map((s) => s.key));
  const current = Object.fromEntries(Object.entries(facts).filter(([k]) => !staleKeys.has(k)));
  const missing = d
    .keysFor(country)
    .filter((s) => !(s.key in current))
    .map((s) => s.key);
  return { file, current, missing, stale };
}

/** The file as stored: the domain's own field names (`year` or `date`, its metadata), facts last. */
function serialise(d: Domain, f: FactFile): string {
  const out = { country: f.country, [d.period]: f.period, ...f.meta, researchedAt: f.researchedAt, ...(f.note ? { note: f.note } : {}), facts: f.facts };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The periods a country has a file for, oldest first. */
export function storedPeriods(d: Domain, country: string): Array<number | string> {
  const dir = factsDir(d);
  if (!existsSync(dir)) return [];
  const c = countryCode(country);
  const re = d.period === "year" ? new RegExp(`^${c}-(\\d{4})\\.json$`) : new RegExp(`^${c}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  return readdirSync(dir)
    .map((f) => re.exec(f)?.[1])
    .filter((x): x is string => !!x)
    .map((x) => (d.period === "year" ? Number(x) : x))
    .sort((a, b) => String(a).localeCompare(String(b)));
}

const researchHint = (d: Domain, country: string, period: number | string) =>
  `ultrastock holds no built-in value for these facts: run \`${d.templateCommand(country, period)}\`, research each key on official sources, fill its value, sources, verifiedAt and confidence, and store the file with \`${d.setCommand}\``;

/** A country's facts for a period — a usage error naming the file and what to research when there is none. */
export function loadFacts(d: Domain, country: string, period: number | string): ValidatedFacts & { path: string } {
  const c = countryCode(country);
  const path = factsPath(d, c, period);
  if (!existsSync(path)) {
    const others = storedPeriods(d, c).filter((x) => x !== period);
    throw new UsageError(
      `no ${c} ${d.name} facts for ${period}: ${path} does not exist — ${researchHint(d, c, period)}${others.length ? ` (files are stored for ${others.join(", ")}: they are not used for ${period})` : ""}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`${path} is not valid JSON (${(e as Error).message}) — store it again with \`${d.setCommand}\``);
  }
  try {
    return { ...validateFacts(d, raw, { country: c, period }), path };
  } catch (e) {
    throw new UsageError(`${path}: ${(e as Error).message}`);
  }
}

/** Validate and store a facts file (atomically); returns where it went and what is still missing or stale. */
export function saveFacts(d: Domain, raw: unknown, expect: { country?: string; period?: number | string } = {}): ValidatedFacts & { path: string } {
  const v = validateFacts(d, raw, expect);
  const path = factsPath(d, v.file.country, v.file.period);
  ensureDir(factsDir(d));
  writeFileAtomic(path, serialise(d, v.file), 0o600);
  return { ...v, path };
}

/** A fact's value from the current facts of `f` (pass `{ ...file, facts: current }`); a usage error when it is not there. */
export function factValue<T>(d: Domain, f: FactFile, key: string): T {
  const fact = f.facts[key];
  if (!fact) throw new UsageError(`${key} is not in the ${f.country} ${d.name} facts for ${f.period} — ${researchHint(d, f.country, f.period)}`);
  return fact.value as T;
}

const fill = (s: string, country: string, period: number | string) => s.replaceAll("{period}", String(period)).replaceAll("{country}", country);
const queryOf = (s: FactSpec, country: string, period: number | string) => fill(s.query || `{country} {period} ${s.label}`, country, period);

/** The JSON skeleton to research and fill: every registered key with `value: null`, what it is, a search query, the source to prefer. */
export function factsTemplate(d: Domain, country: string, period: number | string): Record<string, unknown> {
  const c = countryCode(country);
  return {
    _about: d.about(c, period),
    country: c,
    [d.period]: period,
    ...Object.fromEntries(Object.entries(d.meta ?? {}).map(([k, m]) => [k, m.template(c)])),
    researchedAt: null,
    facts: Object.fromEntries(
      d.keysFor(c).map((s) => {
        const { key: _key, query: _query, note, ...rest } = s;
        return [
          s.key,
          {
            value: null,
            ...rest,
            ...(rest.fields ? { fields: [...rest.fields] } : {}),
            query: queryOf(s, c, period),
            prefer: rest.prefer || "the official source of the country",
            sources: [],
            verifiedAt: null,
            confidence: null,
            ...(note ? { note } : {}),
          },
        ];
      }),
    ),
    ...(d.templateExtras?.(c, period) ?? {}),
  };
}

export interface ChecklistItem {
  key: string;
  label: string;
  type: FactType;
  unit: string;
  query: string;
  prefer: string;
  status: "missing" | "stale" | "researched";
  value?: unknown;
  verifiedAt?: string;
  confidence?: Confidence;
  sources?: string[];
  note?: string;
}

/** What to (re-)research for a country and a period: each registered key (and any extra one stored), with its status. */
export function factsChecklist(d: Domain, country: string, period: number | string): { path: string; stored: boolean; items: ChecklistItem[] } {
  const c = countryCode(country);
  const path = factsPath(d, c, period);
  const v = existsSync(path) ? loadFacts(d, c, period) : undefined;
  const keys: FactSpec[] = [...d.keysFor(c)];
  for (const [k, f] of Object.entries(v?.file.facts ?? {}))
    if (!keys.some((s) => s.key === k)) keys.push({ key: k, label: f.label, type: "any", unit: "", query: "", prefer: "" });
  const stale = new Map((v?.stale ?? []).map((s) => [s.key, s.reason]));
  const items = keys.map((s): ChecklistItem => {
    const f = v?.file.facts[s.key];
    return {
      key: s.key,
      label: s.label,
      type: s.type,
      unit: s.unit,
      query: queryOf(s, c, period),
      prefer: s.prefer || "the official source of the country",
      status: !f ? "missing" : stale.has(s.key) ? "stale" : "researched",
      ...(f ? { value: f.value, verifiedAt: f.verifiedAt, confidence: f.confidence, sources: f.sources, note: stale.get(s.key) ?? f.note } : {}),
    };
  });
  return { path, stored: !!v, items };
}
