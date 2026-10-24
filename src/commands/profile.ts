// `profile` and `jurisdiction`: who the investor is, and what their country allows.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerDatasets, formatDatasets, type Dataset } from "../core/datasets.js";
import { checkDnsBlock, checkMica, rulesFor, verifyChecklist } from "../core/jurisdiction.js";
import { defaultProfile, type EnvelopeType, loadProfile, profilePath, saveProfile, setProfileField, SETTABLE_PATHS, upsertEnvelope } from "../core/profile.js";
import { applySuitability, QUESTIONS, scoreSuitability } from "../core/suitability.js";
import { clockNow } from "../core/net.js";
import { argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";

const ENVELOPES: EnvelopeType[] = ["PEA", "PEA-PME", "CTO", "AV", "PER", "CRYPTO", "TAXABLE", "IRA", "ROTH-IRA", "401K", "OTHER"];

function out(asJson: boolean, value: unknown, text: string): void {
  process.stdout.write(asJson ? jsonLine(value) : text.endsWith("\n") ? text : `${text}\n`);
}

function requireProfile() {
  const p = loadProfile();
  if (!p) throw new Error(`no profile yet — run \`ultrastock profile init --jurisdiction FR --currency EUR\` (it lives in ${profilePath()})`);
  return p;
}

export async function profileCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "show", ...rest] = args.positional;
  if (sub === "init") {
    if (loadProfile()) throw new Error(`a profile already exists at ${profilePath()} — change it with \`profile set\``);
    const p = defaultProfile(argValue(args, "jurisdiction") ?? "FR", argValue(args, "currency") ?? "EUR", clockNow());
    const path = saveProfile(p);
    return out(
      asJson,
      { path, profile: p },
      `profile created: ${path}\n  jurisdiction ${p.jurisdiction}, base currency ${p.baseCurrency}, conservative default limits.\n  Next: \`ultrastock profile suitability\` to ask the questionnaire.`,
    );
  }
  if (sub === "show") {
    const p = requireProfile();
    return out(asJson, p, JSON.stringify({ ...p, history: `${p.history.length} change(s)` }, null, 2));
  }
  if (sub === "set") {
    const [path, ...value] = rest;
    if (!path || !value.length) throw new UsageError(`usage: ultrastock profile set <field> <value> — fields: ${SETTABLE_PATHS.join(", ")}`);
    const p = requireProfile();
    const from = setProfileField(p, path, value.join(" "), clockNow());
    saveProfile(p);
    return out(
      asJson,
      { path, from, to: p.history[p.history.length - 1]!.to },
      `${path}: ${JSON.stringify(from)} → ${JSON.stringify(p.history[p.history.length - 1]!.to)}`,
    );
  }
  if (sub === "envelope") {
    const [id] = rest;
    const type = argValue(args, "type")?.toUpperCase() as EnvelopeType | undefined;
    if (!id || !type || !ENVELOPES.includes(type))
      throw new UsageError(`usage: ultrastock profile envelope <id> --type ${ENVELOPES.join("|")} [--broker <name>] [--currency EUR]`);
    const p = requireProfile();
    upsertEnvelope(p, { id, type, broker: argValue(args, "broker"), currency: (argValue(args, "currency") ?? p.baseCurrency).toUpperCase() }, clockNow());
    saveProfile(p);
    return out(
      asJson,
      p.envelopes,
      `envelopes: ${p.envelopes.map((e) => `${e.id} (${e.type}${e.broker ? ` at ${e.broker}` : ""}, ${e.currency})`).join(", ")}`,
    );
  }
  if (sub === "suitability") {
    const answersFile = argValue(args, "answers");
    if (!answersFile) {
      const text = [
        "Ask the user these questions, in their language, one at a time; write the answers to a JSON file",
        '({ "horizon": "gt10", "drop": "hold", …, "emergencyFundMonths": 6, "experience.crypto": "basic" }),',
        "then run `ultrastock profile suitability --answers <file>`.",
        "",
        ...QUESTIONS.map(
          (q) =>
            `- ${q.id}: ${q.text} / ${q.textFr}${q.choices ? `\n    ${q.choices.map((c) => `${c.value} = ${c.label} / ${c.labelFr}`).join("\n    ")}` : `\n    a number from ${q.numeric!.min} to ${q.numeric!.max}`}`,
        ),
      ].join("\n");
      return out(asJson, { questions: QUESTIONS }, text);
    }
    const answers = JSON.parse(readFileSync(resolve(answersFile), "utf8")) as Record<string, string | number>;
    const r = scoreSuitability(answers);
    const p = requireProfile();
    applySuitability(p, r, clockNow());
    saveProfile(p);
    return out(
      asJson,
      r,
      [
        `risk score ${r.score}/7 — ${r.label} (${r.points}/${r.maxPoints} points)`,
        ...r.reasons.map((x) => `  ${x}`),
        ...r.warnings.map((w) => `  WARNING: ${w}`),
        `limits now: position ≤ ${r.limits.maxPositionPct} %, sector ≤ ${r.limits.maxSectorPct} %, crypto ≤ ${r.limits.maxCryptoPct} %, risk per trade ${r.limits.riskPerTradePct} %, daily loss stop ${r.limits.maxDailyLossPct} %`,
      ].join("\n"),
    );
  }
  throw new UsageError(`unknown profile action "${sub}" — init, show, set, envelope, suitability`);
}

export async function jurisdictionCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "show"] = args.positional;
  const code = (argValue(args, "jurisdiction") ?? loadProfile()?.jurisdiction ?? "FR").toUpperCase();
  const rules = rulesFor(code);
  if (sub === "show") {
    const text = [
      `${rules.name} (${rules.code})`,
      ...rules.rules.map((r) => `- ${r.id}: ${r.status.toUpperCase()} — ${r.summary}\n    verified ${r.verifiedAt}: ${r.sources.map((s) => s.url).join(" ")}`),
    ];
    if (!rules.rules.length) text.push("- no rules recorded for this jurisdiction: every venue is unknown — readable and paper-tradable, never live-tradable");
    return out(asJson, rules, text.join("\n"));
  }
  if (sub !== "verify") throw new UsageError(`unknown jurisdiction action "${sub}" — show or verify`);
  const venues = (argValue(args, "venues") ?? "binance,kraken,coinbase")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const dir = argValue(args, "out") ? resolve(argValue(args, "out")!) : undefined;
  const now = clockNow().toISOString();
  const datasets: Dataset[] = [];
  for (const v of venues) {
    const m = await checkMica(v, code);
    datasets.push({
      kind: "jurisdiction",
      title: `MiCA authorisation — ${v} for ${code} residents`,
      subject: v,
      points: [
        { key: `${v}.mica.authorised.${code}`, label: `${v} authorised MiCA CASP serving ${code}`, value: m.authorised.length > 0 },
        ...m.authorised.map((e, i) => ({
          key: `${v}.mica.entity.${i}`,
          label: `${v} authorised entity`,
          value: `${e.name} (${e.homeState}, ${e.authority}, since ${e.authorisedOn})`,
        })),
        ...m.warnings.map((w, i) => ({
          key: `${v}.mica.warning.${i}`,
          label: `${v} non-compliance notice`,
          value: `${w.name} — ${w.authority}, ${w.decidedOn}: ${w.reason}`,
          untrusted: true,
        })),
      ],
      provenance: { source: "esma-mica-register", url: m.url, fetchedAt: m.fetchedAt, official: true, asOf: m.fetchedAt.slice(0, 10) },
      notes: m.authorised.length
        ? []
        : [`${v} is not in ESMA's MiCA CASP register for ${code}: treat it as unauthorised for live use until the AMF says otherwise`],
    });
  }
  const dns = await checkDnsBlock("gamma-api.polymarket.com");
  datasets.push({
    kind: "jurisdiction",
    title: "Regulator DNS blocks seen from this machine",
    points: [{ key: "polymarket.dns.blocked", label: "Polymarket API blocked by this machine's resolver", value: dns.blocked }],
    provenance: { source: "dns", fetchedAt: now, official: false, asOf: now.slice(0, 10) },
    notes: [dns.detail],
  });
  const registered = registerDatasets(dir, datasets);
  const checklist = verifyChecklist(code);
  if (asJson) return out(true, { registered: registered.map((r) => ({ title: r.dataset.title, ids: r.ids, items: r.items })), checklist }, "");
  process.stdout.write(formatDatasets(registered));
  process.stdout.write(
    `\n## To confirm by web search (rules change; then update the rule's verifiedAt)\n${checklist.map((c) => `- ${c.rule} (verified ${c.verifiedAt}): "${c.query}" — ${c.sources.join(" ")}`).join("\n")}\n`,
  );
}
