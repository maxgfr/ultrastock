// `ultrastock people`: public figures' disclosed trades and positions — House
// members (Clerk PTRs), the executive branch (OGE 278-T), and SEC filers (13F,
// Form 4 as owner, Schedules 13D/13G) — found by name at each source, live,
// and followed through the alert engine (a "person" rule per follow).
import { addRule, loadRules, notify, removeRule, runAlerts } from "../alerts/alerts.js";
import { sanitizeExternalText } from "../core/untrusted.js";
import { clockNow } from "../core/net.js";
import { argInt, argValue, type CommandArgs, UsageError } from "../engine.js";
import { personActivity } from "../people/activity.js";
import { activityDataset, positionsDataset } from "../people/datasets.js";
import { AmbiguousPerson, pickPerson, searchPeople } from "../people/resolve.js";
import { type PersonRef, type PersonSource, refString } from "../people/types.js";
import { emitDatasets, printResult as out } from "./emit.js";

const USAGE =
  'usage: ultrastock people search "<name>" [--source house|oge|sec] | show "<name|source:id>" [--since <date>] [--filings <n>] [--limit <n>] [--positions] | follow "<name|source:id>" [--message <text>] | unfollow <alert-id|source:id> | list | check [--notify]';

const SOURCES: readonly PersonSource[] = ["house", "oge", "sec"];

function sourceArg(args: CommandArgs): PersonSource | undefined {
  const s = argValue(args, "source")?.toLowerCase();
  if (s === undefined) return undefined;
  if (s === "senate") throw new UsageError("the Senate's eFD refuses automated clients: search a senator by hand at https://efdsearch.senate.gov/search/");
  if (!(SOURCES as readonly string[]).includes(s)) throw new UsageError(`--source is one of ${SOURCES.join(", ")}`);
  return s as PersonSource;
}

function sinceArg(args: CommandArgs): string | undefined {
  const s = argValue(args, "since");
  if (s !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new UsageError("--since is a day, YYYY-MM-DD");
  return s;
}

const line = (c: PersonRef) => `${refString(c).padEnd(34)} ${sanitizeExternalText(c.name, 60)}${c.role ? `  (${sanitizeExternalText(c.role, 80)})` : ""}`;

/** The one person a query means, or a usage error that lists who it may mean. */
async function person(args: CommandArgs, query: string): Promise<PersonRef> {
  try {
    return await pickPerson(query, { source: sourceArg(args) });
  } catch (e) {
    if (!(e instanceof AmbiguousPerson)) throw e;
    const list = e.candidates.slice(0, 15).map((c) => `  ${line(c)}`);
    throw new UsageError([e.message, ...list, ...(e.candidates.length ? [`then: ultrastock people show "${refString(e.candidates[0]!)}"`] : [])].join("\n"));
  }
}

export async function peopleCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub, ...rest] = args.positional;
  const query = rest.join(" ").trim();
  if (sub === "search") {
    if (!query) throw new UsageError(USAGE);
    const r = await searchPeople(query, { source: sourceArg(args) });
    return out(
      asJson,
      r,
      [
        ...(r.candidates.length ? r.candidates.map(line) : [`nobody matches "${query}"`]),
        ...r.notes.map((n) => `note: ${n}`),
        ...(r.candidates.length ? [`show one: ultrastock people show "${refString(r.candidates[0]!)}"`] : []),
      ].join("\n"),
    );
  }
  if (sub === "show") {
    if (!query) throw new UsageError(USAGE);
    const ref = await person(args, query);
    const act = await personActivity(ref, { since: sinceArg(args), limit: argInt(args, "filings", { min: 1, max: 50 }) });
    const ds = [activityDataset(act, { limit: argInt(args, "limit", { min: 1, max: 500 }) ?? 30 })];
    if (args.bools.has("positions")) ds.push(await positionsDataset(act, { top: argInt(args, "limit", { min: 1, max: 100 }) ?? 15 }));
    return emitDatasets(args, ds, asJson);
  }
  if (sub === "follow") {
    if (!query) throw new UsageError(USAGE);
    const ref = await person(args, query);
    // What is already filed is the starting point: only filings after this one fire.
    const listed = await personActivity(ref, { listOnly: true, limit: 20 });
    const rule = addRule({ kind: "person", person: listed.ref, message: argValue(args, "message"), seen: listed.filings.map((f) => f.id) }, clockNow());
    return out(asJson, rule, `following ${refString(ref)} as alert ${rule.id} — \`ultrastock people check\` (or \`watch run\`) reports its new filings`);
  }
  if (sub === "unfollow") {
    if (!query) throw new UsageError(USAGE);
    const ids = loadRules()
      .filter((r) => r.kind === "person" && (r.id === query || (r.person && refString(r.person) === query)))
      .map((r) => r.id);
    for (const id of ids) removeRule(id);
    return out(asJson, { removed: ids }, ids.length ? `stopped following (${ids.join(", ")})` : `no person alert ${query}`);
  }
  if (sub === "list" || sub === undefined) {
    const rules = loadRules().filter((r) => r.kind === "person" && r.person);
    return out(
      asJson,
      rules,
      rules.map((r) => `${r.id}  ${line(r.person!)}${r.firedAt ? `  (last fired ${r.firedAt})` : ""}`).join("\n") ||
        'nobody is followed — ultrastock people follow "<name>"',
    );
  }
  if (sub === "check") {
    const r = await runAlerts(clockNow(), { kinds: ["person"] });
    const sent = args.bools.has("notify") ? await notify(r.events) : [];
    return out(
      asJson,
      { ...r, sent },
      [...r.events.map((e) => `NEW ${e.message}`), ...r.errors.map((e) => `error: ${e}`), ...sent.map((s) => `  ${s}`)].join("\n") || "no new filing",
    );
  }
  throw new UsageError(USAGE);
}
