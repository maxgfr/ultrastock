// The researched-facts domains are one registry (core/domains.ts), and every
// command a message or a doc names for them is one the CLI takes: each domain's
// `facts template` runs, and each `facts …` / `tax rules …` string written in
// src/ or the docs parses, names a registered domain and the flags it keeps.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseCommandLine } from "../src/cli.js";
import { factsInvocation } from "../src/commands/facts.js";
import { FACT_DOMAIN_NAMES, FACT_DOMAINS, factsPeriod } from "../src/core/domains.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { factsSetCommand, factsTemplateCommand, researchCommand } from "../src/core/researched.js";
import type { CommandArgs } from "../src/engine.js";
import { TOOLS } from "../src/mcp.js";

const ROOT = join(import.meta.dirname, "..");

/** A country each domain keeps facts for, to fill a `--country` placeholder with. */
const SAMPLE: Record<string, string> = { tax: "FR", jurisdiction: "DE", funds: "IE", venues: "FR", geo: "EU", calendar: "US" };

async function cli(argv: string[]): Promise<{ out: string; err: string; code?: number }> {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    err += String(c);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw Object.assign(new Error("exit"), { exitCode: code });
  }) as never);
  try {
    await main(argv);
    return { out, err };
  } catch (e) {
    return { out, err, code: (e as { exitCode?: number }).exitCode ?? 99 };
  } finally {
    vi.restoreAllMocks();
  }
}

const isPlaceholder = (t: string) => /^<.*>$/.test(t) || t.includes("${") || /^(CC|Y|YYYY|<CC>)$/.test(t);

/**
 * The concrete command lines a written command stands for: placeholders filled (a domain placeholder by every domain,
 * a flag's by a value the domain takes), `a|b` alternatives of the action or the domain expanded. Undefined for a usage
 * synopsis (brackets, an ellipsis), which is not a command.
 */
function concrete(written: string): string[][] | undefined {
  const text = written
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^ultrastock /, "");
  if (/[[\]…]|\.\.\./.test(text)) return undefined;
  const tokens = text.split(" ");
  const out: string[][] = [];
  const isTax = tokens[0] === "tax";
  const subs = (tokens[isTax ? 2 : 1] ?? "").split(/[|/]/);
  const domainTok = isTax ? "tax" : (tokens[2] ?? "");
  // `facts show` alone names the action: no domain to fill in.
  const domains = isTax ? ["tax"] : !domainTok ? [""] : isPlaceholder(domainTok) ? [...FACT_DOMAIN_NAMES] : domainTok.split("|");
  const dir = mkdtempSync(join(tmpdir(), "us-facts-cmd-"));
  for (const sub of subs)
    for (const domain of domains) {
      const fd = FACT_DOMAINS[domain];
      const argv = isTax ? ["tax", "rules", sub] : domain ? ["facts", sub, domain] : ["facts", sub];
      const rest = tokens.slice(3);
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i]!;
        const flag = rest[i - 1];
        if (!t.startsWith("--") && flag?.startsWith("--") && (isPlaceholder(t) || t.includes("|"))) {
          const c = SAMPLE[domain] ?? "FR";
          const value =
            flag === "--country"
              ? t.includes("|") && !isPlaceholder(t)
                ? t.split("|")[0]!
                : c
              : flag === "--year"
                ? String(fd ? factsPeriod(fd, undefined) : new Date().getUTCFullYear() - 1)
                : flag === "--key"
                  ? (fd?.domain.keysFor(c)[0]?.key ?? "x")
                  : flag === "--file"
                    ? join(dir, "facts.json")
                    : dir;
          argv.push(value);
        } else argv.push(t);
      }
      out.push(argv);
    }
  return out;
}

/**
 * Why a command line is not one the CLI takes, or undefined. A `reference` (a command named in prose, without
 * `ultrastock` and without flags, such as `facts set funds`) must name a real action and domain; an invocation must
 * also carry what the command needs (a country the domain keeps, --file for set).
 */
function problem(argv: string[], reference = false): string | undefined {
  try {
    const parsed = parseCommandLine(argv);
    if (parsed.kind === "help" || parsed.kind === "version") return "not a command";
    const args = parsed as CommandArgs;
    if (args.command === "facts") {
      if (!reference) factsInvocation(args);
      else if (!["research", "template", "set", "show"].includes(args.positional[0] ?? "")) return `facts ${args.positional[0]} is not an action`;
      else if (args.positional[1] !== undefined && !FACT_DOMAINS[args.positional[1]]) return `"${args.positional[1]}" is not a facts domain`;
    } else if (args.command === "tax") {
      const [rules, sub] = args.positional;
      if (rules !== "rules" || !["template", "set", "show"].includes(sub ?? "")) return `tax ${args.positional.join(" ")} is not tax rules template|set|show`;
      if (sub === "set" && !args.values.file && !reference) return "tax rules set without --file";
    } else return `not a facts command: ${args.command}`;
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

const COMMAND = String.raw`(?:ultrastock )?(?:facts (?:research|template|set|show)\b|tax rules (?:template|set|show)\b)`;

/**
 * Every `facts …` / `tax rules …` code span of a file. In TypeScript a span inside a template literal is written \`…\`;
 * a bare backtick that opens a span with an interpolation is the template literal itself (a helper such as
 * researchCommand, checked by building its commands), not a span.
 */
function writtenCommands(file: string): string[] {
  const s = readFileSync(file, "utf8");
  const found: string[] = [];
  if (!file.endsWith(".ts")) {
    for (const m of s.matchAll(new RegExp(`\`(${COMMAND}[^\`]*)\``, "g"))) found.push(m[1]!);
    return found;
  }
  for (const m of s.matchAll(new RegExp(String.raw`\\\`(${COMMAND}(?:[^\`\\]|\$\{[^}]*\})*)\\\``, "g"))) found.push(m[1]!);
  for (const m of s.matchAll(new RegExp(String.raw`(?<!\\)\`(${COMMAND}[^\`\\$\n]*)\``, "g"))) found.push(m[1]!);
  return found;
}

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "vendor" || n === "node_modules" || n === "scripts") return [];
    return statSync(p).isDirectory() ? filesUnder(p, ext) : ext.test(n) ? [p] : [];
  });
}

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("DE", "EUR"));
});
afterEach(() => vi.restoreAllMocks());

describe("the facts domain registry", () => {
  it("holds every domain, and the MCP facts tool offers the same", () => {
    expect(FACT_DOMAIN_NAMES).toEqual(["tax", "jurisdiction", "funds", "venues", "geo", "calendar"]);
    for (const [name, fd] of Object.entries(FACT_DOMAINS)) expect(fd.domain.name).toBe(name);
    const tool = TOOLS.find((t) => t.name === "facts")!;
    expect(tool.params.domain?.enum).toEqual(FACT_DOMAIN_NAMES);
  });

  it.each(FACT_DOMAIN_NAMES.map((n) => [n]))("runs facts template %s", async (name) => {
    const r = await cli(["facts", "template", name, "--country", SAMPLE[name]!, "--json"]);
    expect(r.code, r.err).toBeUndefined();
    const t = JSON.parse(r.out) as { country: string; facts: Record<string, { value: unknown }> };
    expect(t.country).toBe(SAMPLE[name]);
    expect(Object.keys(t.facts).length).toBeGreaterThan(0);
    expect(Object.values(t.facts).every((f) => f.value === null)).toBe(true);
  });

  it("refuses a country a domain does not keep, and names the ones it does", async () => {
    expect((await cli(["facts", "template", "geo", "--country", "DE"])).err).toMatch(/geo facts are kept for the area code EU: --country EU, not DE/);
    expect((await cli(["facts", "template", "calendar", "--country", "DE"])).err).toMatch(/--country US or FR or IT or NO, not DE/);
    expect((await cli(["facts", "template", "funds"])).err).toMatch(/funds facts are kept per a fund domicile/);
    expect((await cli(["facts", "template", "nope"])).err).toMatch(/"nope" is not a facts domain — one of tax, jurisdiction, funds, venues, geo, calendar/);
    // Without --country, the profile's residence (DE here) for the domains read for it; geo is always EU.
    expect(JSON.parse((await cli(["facts", "template", "venues", "--json"])).out).country).toBe("DE");
    expect(JSON.parse((await cli(["facts", "template", "geo", "--json"])).out).country).toBe("EU");
  });

  it("builds, for every domain, research, template and store commands the CLI takes", async () => {
    for (const [name, fd] of Object.entries(FACT_DOMAINS)) {
      const c = SAMPLE[name]!;
      const period = factsPeriod(fd, undefined);
      const key = fd.domain.keysFor(c)[0]!.key;
      const year = fd.domain.period === "year" ? (period as number) : undefined;
      for (const cmd of [
        researchCommand(name, c, { key, year }),
        researchCommand(name, c),
        factsTemplateCommand(name, c, { year }),
        fd.domain.templateCommand(c, period),
        fd.domain.setCommand,
        factsSetCommand(name),
      ]) {
        const lines = concrete(cmd);
        expect(lines, cmd).toBeDefined();
        for (const argv of lines!) expect(problem(argv), `${cmd} → ${argv.join(" ")}`).toBeUndefined();
      }
      // A domain's own template command runs.
      const t = concrete(fd.domain.templateCommand(c, period))![0]!;
      expect((await cli(t)).code, t.join(" ")).toBeUndefined();
    }
  });

  it("every facts / tax rules command written in src and the docs parses", async () => {
    const files = [
      ...filesUnder(join(ROOT, "src"), /\.ts$/),
      ...filesUnder(join(ROOT, "skills", "ultrastock"), /\.md$/),
      join(ROOT, "DOCUMENTATION.md"),
      join(ROOT, "README.md"),
    ];
    const bad: string[] = [];
    let checked = 0;
    for (const file of files)
      for (const written of writtenCommands(file)) {
        const lines = concrete(written);
        if (!lines) continue;
        for (const argv of lines) {
          checked++;
          const reference = !written.startsWith("ultrastock ") && !written.includes("--");
          const p = problem(argv, reference);
          if (p) bad.push(`${relative(ROOT, file)}: \`${written}\` → ${argv.join(" ")}: ${p}`);
          else if (!reference && (argv[1] === "template" || argv[2] === "template")) {
            const r = await cli(argv);
            if (r.code !== undefined) bad.push(`${relative(ROOT, file)}: \`${written}\` → ${argv.join(" ")} fails: ${r.err.trim()}`);
          }
        }
      }
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThan(30);
  });
});
