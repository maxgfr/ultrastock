// `profile` and `jurisdiction`: who the investor is, and what their country allows.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerDatasets, formatDatasets, type Dataset } from "../core/datasets.js";
import { checkDnsBlock, cryptoVenueGate, JURISDICTION, rulesFor, verifyChecklist } from "../core/jurisdiction.js";
import { researchCommand } from "../core/researched.js";
import { withFileLockSync } from "../core/lock.js";
import {
  defaultProfile,
  type EnvelopeType,
  loadProfile,
  loosens,
  type Profile,
  parseProfileValue,
  profileChangeBinding,
  profilePath,
  profileValue,
  requestProfileChange,
  SETTABLE_PATHS,
  saveProfile,
  upsertEnvelope,
} from "../core/profile.js";
import { applySuitability, QUESTIONS, scoreSuitability, suitabilityBinding } from "../core/suitability.js";
import { liveEverApproved } from "../trading/limits.js";
import { issueCode, verifyCode } from "../trading/otp.js";
import { clockNow } from "../core/net.js";
import { argValue, type CommandArgs, UsageError } from "../engine.js";
import { printResult as out } from "./emit.js";

const ENVELOPES: EnvelopeType[] = ["PEA", "PEA-PME", "CTO", "AV", "PER", "CRYPTO", "TAXABLE", "IRA", "ROTH-IRA", "401K", "OTHER"];

/**
 * The profile ratchets once live trading has ever been approved for a venue
 * (in force, waiting out its 24 hours, or switched off since): from then on its
 * limits and its jurisdiction guard real money, and lowering them takes a code
 * and 24 hours, like the live limits themselves. Switching every venue off — a
 * tightening, with no code — does not lift it.
 */
export function profileRatchetOn(): boolean {
  return liveEverApproved();
}

function requireProfile() {
  const p = loadProfile(clockNow());
  if (!p) throw new Error(`no profile yet — run \`ultrastock profile init --jurisdiction FR --currency EUR\` (it lives in ${profilePath()})`);
  return p;
}

/** Every profile write runs under one lock: two `profile` commands at once must not erase each other's change. */
const profileLock = <T>(fn: () => T): T => withFileLockSync(`${profilePath()}.lock`, fn);

/** Read, change and save the profile as one step. */
function changeProfile(change: (p: Profile) => void): Profile {
  return profileLock(() => {
    const p = requireProfile();
    change(p);
    saveProfile(p);
    return p;
  });
}

export async function profileCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "show", ...rest] = args.positional;
  if (sub === "init") {
    const p = defaultProfile(argValue(args, "jurisdiction") ?? "FR", argValue(args, "currency") ?? "EUR", clockNow());
    const path = profileLock(() => {
      if (loadProfile()) throw new Error(`a profile already exists at ${profilePath()} — change it with \`profile set\``);
      return saveProfile(p);
    });
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
  if (sub === "set" || sub === "code") {
    const [path, ...value] = rest;
    if (!path || !value.length)
      throw new UsageError(`usage: ultrastock profile ${sub} <field> <value>${sub === "set" ? " [--code <code>]" : ""} — fields: ${SETTABLE_PATHS.join(", ")}`);
    const to = parseProfileValue(path, value.join(" "));
    const now = clockNow();
    if (sub === "code") {
      const p = requireProfile();
      if (!profileRatchetOn() || !loosens(path, profileValue(p, path), to))
        return out(asJson, { needed: false }, `${path}: no code needed — \`profile set ${path} ${value.join(" ")}\` applies it now`);
      const r = await issueCode(
        "profile",
        profileChangeBinding(path, to),
        `profile ${path}: ${JSON.stringify(profileValue(p, path))} → ${JSON.stringify(to)} (in force 24 hours after approval)`,
      );
      return out(
        asJson,
        r,
        `approval code sent to ${r.sentTo.join(", ")} (valid until ${r.expiresAt}). Then: ultrastock profile set ${path} ${value.join(" ")} --code <code>`,
      );
    }
    const code = argValue(args, "code");
    const approved = code ? verifyCode("profile", profileChangeBinding(path, to), code, now).ok : false;
    if (code && !approved) throw new Error(`the approval code does not match this change (or expired): run \`profile code ${path} ${value.join(" ")}\` again`);
    let o!: ReturnType<typeof requestProfileChange>;
    changeProfile((x) => {
      o = requestProfileChange(x, path, to, { ratchet: profileRatchetOn(), approved, now });
    });
    return out(
      asJson,
      o,
      o.applied
        ? `${path}: ${JSON.stringify(o.from)} → ${JSON.stringify(o.to)}`
        : o.effectiveAt
          ? `${path}: ${JSON.stringify(o.from)} → ${JSON.stringify(o.to)} approved — in force from ${o.effectiveAt}`
          : `${path}: not changed — ${o.reason}`,
    );
  }
  if (sub === "envelope") {
    const [id] = rest;
    const type = argValue(args, "type")?.toUpperCase() as EnvelopeType | undefined;
    if (!id || !type || !ENVELOPES.includes(type))
      throw new UsageError(`usage: ultrastock profile envelope <id> --type ${ENVELOPES.join("|")} [--broker <name>] [--currency EUR]`);
    const p = changeProfile((x) =>
      upsertEnvelope(x, { id, type, broker: argValue(args, "broker"), currency: (argValue(args, "currency") ?? x.baseCurrency).toUpperCase() }, clockNow()),
    );
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
    const now = clockNow();
    const ratchet = profileRatchetOn();
    const code = argValue(args, "code");
    const approved = code ? verifyCode("profile", suitabilityBinding(r), code, now).ok : false;
    if (code && !approved) throw new Error("the approval code does not match these answers' limits (or expired)");
    if (ratchet && !code && args.bools.has("request-code")) {
      const c = await issueCode("profile", suitabilityBinding(r), `the questionnaire's limits (risk score ${r.score}/7), in force 24 hours after approval`);
      return out(
        asJson,
        c,
        `approval code sent to ${c.sentTo.join(", ")} (valid until ${c.expiresAt}). Then: ultrastock profile suitability --answers ${answersFile} --code <code>`,
      );
    }
    let waiting: ReturnType<typeof applySuitability>["waiting"] = [];
    let held: ReturnType<typeof applySuitability>["held"] = [];
    changeProfile((p) => ({ waiting, held } = applySuitability(p, r, now, { ratchet, approved })));
    return out(
      asJson,
      r,
      [
        `risk score ${r.score}/7 — ${r.label} (${r.points}/${r.maxPoints} points)`,
        ...r.reasons.map((x) => `  ${x}`),
        ...r.warnings.map((w) => `  WARNING: ${w}`),
        `limits from the answers: position ≤ ${r.limits.maxPositionPct} %, sector ≤ ${r.limits.maxSectorPct} %, crypto ≤ ${r.limits.maxCryptoPct} %, risk per trade ${r.limits.riskPerTradePct} %, daily loss stop ${r.limits.maxDailyLossPct} %`,
        ...waiting.map((w) => `  ${w.path} → ${JSON.stringify(w.to)}: approved, in force from ${w.effectiveAt}`),
        ...(held.length
          ? [
              `  NOT applied (live trading is on: lowering a guard needs a code and 24 hours): ${held.map((h) => h.path).join(", ")} — \`profile suitability --answers ${answersFile} --request-code\`, then the same with --code <code>`,
            ]
          : []),
      ].join("\n"),
    );
  }
  throw new UsageError(`unknown profile action "${sub}" — init, show, set, code, envelope, suitability`);
}

export async function jurisdictionCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "show"] = args.positional;
  const code = (argValue(args, "jurisdiction") ?? loadProfile()?.jurisdiction ?? "FR").toUpperCase();
  const rules = rulesFor(code);
  const flow = `ultrastock holds no jurisdiction rule: research them (\`${researchCommand("jurisdiction", code)}\` gathers the official documents and prints the worklist), store the conclusions (\`${JURISDICTION.setCommand}\`); until then each rule reads as unknown and fails closed`;
  if (sub === "show") {
    const text = [
      `${rules.name} (${rules.code}) — researched jurisdiction rules`,
      ...rules.rules.map((r) =>
        r.researched
          ? `- ${r.id}: ${r.status.toUpperCase()} — ${r.summary}\n    researched ${r.verifiedAt}: ${r.sources.map((x) => x.url).join(" ")}`
          : `- ${r.id}: UNKNOWN — ${r.summary}`,
      ),
    ];
    if (rules.rules.some((r) => !r.researched)) text.push("", flow);
    return out(asJson, { ...rules, research: researchCommand("jurisdiction", code) }, text.join("\n"));
  }
  if (sub !== "verify") throw new UsageError(`unknown jurisdiction action "${sub}" — show or verify`);
  const venues = (argValue(args, "venues") ?? "binance,kraken,coinbase")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const dir = argValue(args, "out") ? resolve(argValue(args, "out")!) : undefined;
  const now = clockNow().toISOString();
  const datasets: Dataset[] = [];
  for (const v of venues) {
    // The check a live order runs: the researched regime, then the register it names (ESMA's is read here).
    const g = await cryptoVenueGate(v, code);
    const m = g.mica;
    datasets.push({
      kind: "jurisdiction",
      title: `Crypto platform authorisation — ${v} for ${code} residents`,
      subject: v,
      points: [
        { key: `${v}.crypto.liveAllowed.${code}`, label: `${v}: live crypto orders allowed for a ${code} resident`, value: g.ok },
        ...(m
          ? [
              { key: `${v}.mica.authorised.${code}`, label: `${v} authorised MiCA CASP serving ${code}`, value: m.authorised.length > 0 },
              ...m.authorised.map((e, i) => ({
                key: `${v}.mica.entity.${i}`,
                label: `${v} authorised entity`,
                value: `${e.name}${e.lei ? ` (LEI ${e.lei})` : ""} — ${e.homeState}, ${e.authority}, since ${e.authorisedOn}`,
              })),
              ...m.warnings.map((w, i) => ({
                key: `${v}.mica.warning.${i}`,
                label: `${v} non-compliance notice`,
                value: `${w.name} — ${w.authority}, ${w.decidedOn}: ${w.reason}`,
                untrusted: true,
              })),
            ]
          : []),
      ],
      provenance: m
        ? { source: "esma-mica-register", url: m.url, fetchedAt: m.fetchedAt, official: true, asOf: m.fetchedAt.slice(0, 10) }
        : { source: "researched-jurisdiction-facts", fetchedAt: now, official: false, asOf: now.slice(0, 10) },
      notes: [g.reason, ...(m?.notes ?? [])],
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
  if (asJson)
    return out(
      true,
      {
        registered: registered.map((r) => ({ title: r.dataset.title, ids: r.ids, items: r.items })),
        checklist,
        research: researchCommand("jurisdiction", code),
      },
      "",
    );
  process.stdout.write(formatDatasets(registered));
  process.stdout.write(
    `\n## To research (rules change — ${flow})\n${checklist.map((c) => `- ${c.rule}: ${c.current}${c.verifiedAt ? ` (researched ${c.verifiedAt})` : ""} — search "${c.query}"${c.sources.length ? `, re-check ${c.sources.join(" ")}` : ""}`).join("\n")}\n`,
  );
}
