// `events [--days 60] [--since 7] [--country BR,US] [--all] [--book real] [--out <run>]`:
// the elections and rate decisions that move the markets the book is exposed
// to — ahead and just past — with the event study, the book impact scenario
// and the market's pricing (EVENTS.md).
import { eventsRun } from "../analyze/events/run.js";
import { runDirFor } from "../core/paths.js";
import { argBool, argInt, argList, argValue, type CommandArgs, jsonLine, runId } from "../engine.js";

export async function eventsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const dir = runDirFor(argValue(args, "out"), `events-${runId()}`);
  const r = await eventsRun(dir, {
    days: argInt(args, "days", { min: 1, max: 365 }) ?? 60,
    since: argInt(args, "since", { min: 0, max: 90 }) ?? 7,
    book: argValue(args, "book") ?? "real",
    countries: argList(args, "country").map((c) => c.toUpperCase()),
    all: argBool(args, "all"),
    maxEvents: argInt(args, "limit", { min: 1, max: 20 }),
  });
  if (asJson) {
    process.stdout.write(jsonLine({ dir: r.dir, file: r.file, ahead: r.ahead, past: r.past, exposures: r.exposures, notes: r.notes }));
    return;
  }
  const show = (e: (typeof r.ahead)[number]) => `  ${e.date} ${e.type === "election" ? "election     " : "rate decision"} ${e.title}`;
  process.stdout.write(
    [
      `events: ${r.ahead.length} ahead, ${r.past.length} just past, touching the book — ${r.file}`,
      ...(r.past.length ? ["just happened:", ...r.past.map(show)] : []),
      ...(r.ahead.length ? ["ahead:", ...r.ahead.map(show)] : []),
      ...r.notes.slice(0, 8).map((n) => `note: ${n}`),
      "",
    ].join("\n"),
  );
}
