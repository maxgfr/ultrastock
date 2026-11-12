// facts research|template|set|show <domain> — the researched-facts store from
// the command line, for every domain of core/domains.ts:
//
//   tax            a country's tax rules for a year (`tax rules …` is the
//                  same, and stays)
//   jurisdiction   what a country allows (Polymarket, Kalshi, US-domiciled
//                  ETFs, crypto platforms and their register…), per country
//   funds          what a fund domicile means for withholding, per domicile
//   venues         venue and broker fees, for the country of residence
//   geo            EU, EEA and euro-area membership (country EU)
//   calendar       exchange hours and one-off closures, per exchange country
//                  and year
//
// `research` gathers the official documents for each key (the engine's keyless
// search, or the agent's --web-results) into a run as evidence [E#] and writes
// the worklist and the JSON to fill; `template` prints the JSON skeleton;
// `set` stores a filled file, strictly validated; `show` says what is stored,
// current or stale. The gates read the stored conclusions; nothing else.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FACT_DOMAIN_NAMES, type FactDomain, factDomain, factsCountry, factsPeriod } from "../core/domains.js";
import { JURISDICTION, rulesFor } from "../core/jurisdiction.js";
import { runDirFor } from "../core/paths.js";
import { loadProfile } from "../core/profile.js";
import {
  countryCode,
  type Fact,
  factsChecklist,
  factsTemplate,
  factsTemplateCommand,
  loadLatestFacts,
  researchCommand,
  saveFacts,
  specsFor,
} from "../core/researched.js";
import { argBool, argInt, argList, argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";
import { researchFacts } from "../research/facts.js";
import { parseWebResults, type WebHit } from "../research/ingest.js";
import { TAX } from "../tax/rules.js";
import { printResult as out } from "./emit.js";
import { readWebResults } from "./research.js";
import { taxCommand } from "./tax.js";

export const FACTS_USAGE = `usage: ultrastock facts research|template|set|show <${FACT_DOMAIN_NAMES.join("|")}> [--country CC] [--key k,…] [--year YYYY] [--file <facts.json>] [--web-results <file|->] [--engine-search] [--limit <n>] [--browser] [--no-wayback] --out <run> [--json]`;

const SUBS = ["research", "template", "set", "show"] as const;

export interface FactsInvocation {
  sub: (typeof SUBS)[number];
  fd: FactDomain;
  /** The country and period the command is for, and the keys asked (`set` reads them from the file instead). */
  country?: string;
  period?: number | string;
  keys: string[];
}

/**
 * What a `facts` command line asks, checked before anything runs: the action, a registered domain, and — but for
 * `set` (whose file names them) and tax's own commands — the country, the period and the keys, each a usage error
 * when the domain does not keep it.
 */
export function factsInvocation(args: CommandArgs): FactsInvocation {
  const [sub, name] = args.positional;
  if (!sub || !(SUBS as readonly string[]).includes(sub)) throw new UsageError(FACTS_USAGE);
  const fd = factDomain(name, FACTS_USAGE);
  const keys = argList(args, "key");
  const s = sub as FactsInvocation["sub"];
  if (s === "set") {
    if (!argValue(args, "file"))
      throw new UsageError(
        `facts set ${fd.domain.name} needs --file <facts.json>: fill the JSON that \`${researchCommand(fd.domain.name, "CC")}\` writes, or that \`${factsTemplateCommand(fd.domain.name, "CC")}\` prints`,
      );
    return { sub: s, fd, keys };
  }
  // Tax keeps its own commands (their engine checks, currency and form lines): `tax rules` reads its flags itself.
  if (fd.domain === TAX && s !== "research") return { sub: s, fd, keys };
  const country = factsCountry(fd, argValue(args, "country"), () => loadProfile());
  const period = factsPeriod(fd, argValue(args, "year"));
  if (keys.length) specsFor(fd.domain, country, keys);
  return { sub: s, fd, country, period, keys };
}

function readJson(file: string): unknown {
  const path = resolve(file);
  if (!existsSync(path)) throw new UsageError(`no such file: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

export async function factsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const inv = factsInvocation(args);
  const { sub, fd, keys } = inv;
  const d = fd.domain;
  // facts template|set|show tax is `tax rules template|set|show`.
  if (d === TAX && sub !== "research") return taxCommand({ ...args, positional: ["rules", sub] }, asJson);
  const c = inv.country ?? "";
  const period = inv.period ?? "";

  if (sub === "research") {
    const lists: WebHit[][] = [];
    const notes: string[] = [];
    const web = argValue(args, "web-results");
    if (web) {
      const { lists: got, skipped } = parseWebResults(readWebResults(web));
      if (skipped) notes.push(`${skipped} entr${skipped === 1 ? "y" : "ies"} of ${web === "-" ? "stdin" : web} without an http(s) url skipped`);
      lists.push(...got);
    }
    const dir = runDirFor(argValue(args, "out"), `facts-${d.name}-${c}-${runId()}`);
    const w = await researchFacts({
      domain: d,
      country: c,
      period,
      keys,
      dir,
      lists,
      // The engine's keyless search runs unless the agent brought its own hits (then only with --engine-search).
      engines: lists.length ? argBool(args, "engine-search") : true,
      limit: argInt(args, "limit", { min: 1, max: 60 }),
      read: { wayback: !argBool(args, "no-wayback"), browser: argBool(args, "browser") },
      setCommand: d.setCommand,
    });
    w.notes.unshift(...notes);
    if (asJson) return void process.stdout.write(jsonLine(w));
    return void process.stdout.write(`${readFileSync(w.markdown, "utf8").trimEnd()}\n\nWorklist: ${w.markdown}\nFill: ${w.file}\nThen: ${w.setCommand}\n`);
  }

  if (sub === "template") {
    const t = factsTemplate(d, c, period, { keys });
    return void process.stdout.write(`${JSON.stringify(t, null, asJson ? undefined : 2)}\n`);
  }

  if (sub === "set") {
    const f = argValue(args, "file") ?? "";
    const pin = argValue(args, "country");
    const raw = readJson(f);
    // A domain kept for a few countries only (geo: EU; calendar: the exchanges' countries) refuses a file for another.
    const named =
      pin ?? (raw && typeof raw === "object" && typeof (raw as { country?: unknown }).country === "string" ? (raw as { country: string }).country : undefined);
    if (fd.countries && named) factsCountry(fd, named, () => undefined);
    const v = saveFacts(d, raw, { country: pin ? countryCode(pin) : undefined });
    const lines = [
      `stored ${v.path} — ${Object.keys(v.file.facts).length} researched fact(s) for ${v.file.country} (${d.period} ${v.file.period})`,
      ...(v.missing.length ? [`not researched yet (they read as unknown and fail closed): ${v.missing.join(", ")}`] : []),
      ...v.stale.map((s) => `stale: ${s.key} (${s.reason})`),
    ];
    return out(
      asJson,
      { path: v.path, country: v.file.country, period: v.file.period, facts: Object.keys(v.file.facts), missing: v.missing, stale: v.stale },
      lines.join("\n"),
    );
  }

  // show
  if (d === JURISDICTION) {
    const r = rulesFor(c);
    if (keys.length) specsFor(d, c, keys);
    const rules = keys.length ? r.rules.filter((x) => keys.includes(x.id)) : r.rules;
    return out(
      asJson,
      { ...r, rules },
      [
        `# ${r.name} (${c}) — researched jurisdiction rules`,
        ...rules.map((x) =>
          x.researched
            ? `- ${x.id}: ${x.status.toUpperCase()} — ${x.summary} (researched ${x.verifiedAt}: ${x.sources.map((s) => s.url).join(" ")})`
            : `- ${x.id}: UNKNOWN — ${x.summary}`,
        ),
      ].join("\n"),
    );
  }
  const specs = specsFor(d, c, keys);
  const year = d.period === "year" ? (period as number) : undefined;
  const { paths, facts, stale } = storedFor(fd, c, year);
  const items = specs.map((s) => {
    const f = facts[s.key];
    return { key: s.key, label: s.label, status: !f ? "missing" : stale.has(s.key) ? "stale" : "researched", ...(f ? { fact: f } : {}) };
  });
  return out(
    asJson,
    { domain: d.name, country: c, ...(year !== undefined ? { year } : {}), paths, items },
    [
      `# ${d.name} facts — ${c}${year !== undefined ? ` ${year}` : ""}${paths.length ? "" : " (none stored)"}`,
      ...items.map((i) =>
        i.fact
          ? `- ${i.key}: ${i.status === "stale" ? `STALE (${stale.get(i.key)}) — ` : ""}${JSON.stringify(i.fact.value)} — ${i.fact.note ?? i.label} (researched ${i.fact.verifiedAt}: ${i.fact.sources.join(" ")})`
          : `- ${i.key}: not researched — \`${researchCommand(d.name, c, { key: i.key, year })}\``,
      ),
    ].join("\n"),
  );
}

/** What `show` reads: a `year` domain's file for the year, a `date` domain's newest fact per key across its files. */
function storedFor(fd: FactDomain, c: string, year: number | undefined) {
  const d = fd.domain;
  if (year === undefined) {
    const l = loadLatestFacts(d, c);
    return { paths: l.paths, facts: l.facts as Record<string, Fact>, stale: new Map(l.stale.map((s) => [s.key, s.reason])) };
  }
  const k = factsChecklist(d, c, year);
  const facts: Record<string, Fact> = {};
  const stale = new Map<string, string>();
  for (const i of k.items) {
    if (i.status === "missing") continue;
    facts[i.key] = {
      value: i.value,
      label: i.label,
      sources: i.sources ?? [],
      verifiedAt: i.verifiedAt ?? "",
      confidence: i.confidence ?? "low",
      ...(i.note && i.status !== "stale" ? { note: i.note } : {}),
    };
    if (i.status === "stale") stale.set(i.key, i.note ?? "stale");
  }
  return { paths: k.stored ? [k.path] : [], facts, stale };
}
