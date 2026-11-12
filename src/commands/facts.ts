// facts research|template|set|show <domain> — the researched-facts store from
// the command line, for every domain (core/researched.ts):
//
//   jurisdiction   what a country allows (Polymarket, Kalshi, US-domiciled
//                  ETFs, crypto platforms and their register…), per country
//   funds          what a fund domicile means for withholding, per domicile
//   tax            a country's tax rules for a year (`tax rules …` is the
//                  same, and stays)
//
// `research` gathers the official documents for each key (the engine's keyless
// search, or the agent's --web-results) into a run as evidence [E#] and writes
// the worklist and the JSON to fill; `template` prints the JSON skeleton;
// `set` stores a filled file, strictly validated; `show` says what is stored,
// current or stale. The gates read the stored conclusions; nothing else.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNDS } from "../core/fund-facts.js";
import { JURISDICTION, rulesFor } from "../core/jurisdiction.js";
import { clockNow } from "../core/net.js";
import { runDirFor } from "../core/paths.js";
import { loadProfile } from "../core/profile.js";
import { countryCode, type Domain, factsTemplate, loadLatestFacts, saveFacts, specsFor } from "../core/researched.js";
import { argBool, argInt, argList, argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";
import { researchFacts } from "../research/facts.js";
import { parseWebResults, type WebHit } from "../research/ingest.js";
import { TAX } from "../tax/rules.js";
import { printResult as out } from "./emit.js";
import { readWebResults } from "./research.js";
import { taxCommand } from "./tax.js";

export const FACT_DOMAINS: Readonly<Record<string, Domain>> = { jurisdiction: JURISDICTION, funds: FUNDS, tax: TAX };

const USAGE =
  "usage: ultrastock facts research|template|set|show <jurisdiction|funds|tax> [--country CC] [--key k,…] [--year YYYY] [--file <facts.json>] [--web-results <file|->] [--engine-search] [--limit <n>] [--browser] [--no-wayback] --out <run> [--json]";

function domainOf(name: string | undefined): Domain {
  const d = name ? FACT_DOMAINS[name] : undefined;
  if (!d) throw new UsageError(`${name ? `"${name}" is not a facts domain` : "which domain?"} — one of ${Object.keys(FACT_DOMAINS).join(", ")}. ${USAGE}`);
  return d;
}

/** The country a domain's facts are for: --country, else the profile's (residence for jurisdiction, tax residence for tax). */
function countryOf(d: Domain, args: CommandArgs): string {
  const c = argValue(args, "country");
  if (c) return countryCode(c);
  const p = loadProfile();
  const fromProfile = d === TAX ? p?.taxResidence : d === JURISDICTION ? p?.jurisdiction : undefined;
  if (fromProfile) return countryCode(fromProfile);
  throw new UsageError(
    d === FUNDS
      ? "funds facts are kept per fund domicile: pass --country CC (IE, LU, US…)"
      : "no country in the profile: pass --country CC (an ISO 3166 code such as FR, US, DE), or run `ultrastock profile init`",
  );
}

/** The period a domain's facts are for: a tax year (--year, default last year), else today's date. */
function periodOf(d: Domain, args: CommandArgs): number | string {
  const now = clockNow();
  if (d.period === "date") {
    if (argValue(args, "year")) throw new UsageError(`${d.name} facts are dated by the day they were researched: --year does not apply`);
    return now.toISOString().slice(0, 10);
  }
  const y = Number(argValue(args, "year") ?? now.getUTCFullYear() - 1);
  if (!Number.isInteger(y) || y < 2000 || y > now.getUTCFullYear()) throw new UsageError(`--year ${argValue(args, "year")} is not a tax year`);
  return y;
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
  const [sub, name] = args.positional;
  if (!sub || !["research", "template", "set", "show"].includes(sub)) throw new UsageError(USAGE);
  const d = domainOf(name);
  // Tax keeps its own commands (their engine checks, currency and form lines): facts template|set|show tax is the same.
  if (d === TAX && sub !== "research") return taxCommand({ ...args, positional: ["rules", sub] }, asJson);
  const keys = argList(args, "key");

  if (sub === "research") {
    const c = countryOf(d, args);
    const period = periodOf(d, args);
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
      setCommand: d === TAX ? TAX.setCommand : d.setCommand,
    });
    w.notes.unshift(...notes);
    if (asJson) return void process.stdout.write(jsonLine(w));
    return void process.stdout.write(`${readFileSync(w.markdown, "utf8").trimEnd()}\n\nWorklist: ${w.markdown}\nFill: ${w.file}\nThen: ${w.setCommand}\n`);
  }

  if (sub === "template") {
    const c = countryOf(d, args);
    const t = factsTemplate(d, c, periodOf(d, args), { keys });
    return void process.stdout.write(`${JSON.stringify(t, null, asJson ? undefined : 2)}\n`);
  }

  if (sub === "set") {
    const f = argValue(args, "file");
    if (!f)
      throw new UsageError(`facts set ${d.name} needs --file <facts.json> (fill the JSON of \`facts research ${d.name}\` or \`facts template ${d.name}\`)`);
    const pin = argValue(args, "country");
    const v = saveFacts(d, readJson(f), { country: pin ? countryCode(pin) : undefined });
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
  const c = countryOf(d, args);
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
  const l = loadLatestFacts(d, c);
  const stale = new Map(l.stale.map((s) => [s.key, s.reason]));
  const items = specs.map((s) => {
    const f = l.facts[s.key];
    return { key: s.key, label: s.label, status: !f ? "missing" : stale.has(s.key) ? "stale" : "researched", ...(f ? { fact: f } : {}) };
  });
  return out(
    asJson,
    { domain: d.name, country: c, paths: l.paths, items },
    [
      `# ${d.name} facts — ${c}${l.paths.length ? "" : " (none stored)"}`,
      ...items.map((i) =>
        i.fact
          ? `- ${i.key}: ${i.status === "stale" ? `STALE (${stale.get(i.key)}) — ` : ""}${JSON.stringify(i.fact.value)} — ${i.fact.note ?? i.label} (researched ${i.fact.verifiedAt}: ${i.fact.sources.join(" ")})`
          : `- ${i.key}: not researched — \`ultrastock facts research ${d.name} --country ${c} --key ${i.key} --out <run>\``,
      ),
    ].join("\n"),
  );
}
