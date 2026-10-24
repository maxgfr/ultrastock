// `report <run> [--answer <file>]`: the run's answer as a
// self-contained page — the answer, the decision, the debate's notes, the
// price chart and every cited [E#] linked to its source. Refuses an answer
// that does not pass `check`, so a report never carries an unchecked figure.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkAnswer, NOTE_KINDS } from "../check.js";
import { clockNow } from "../core/net.js";
import { argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";
import { renderReport } from "../report/html.js";

export async function reportCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const run = args.positional[0];
  if (!run) throw new UsageError("usage: ultrastock report <run> [--answer <answer.md>] [--json]");
  const dir = resolve(run);
  const answerFile = resolve(argValue(args, "answer") ?? join(dir, "answer.md"));
  if (!existsSync(answerFile)) throw new UsageError(`no answer at ${answerFile}: write it first (see RUNBOOK.md), or pass --answer`);
  const answer = readFileSync(answerFile, "utf8");
  const check = checkAnswer(dir, answer);
  if ("error" in check) throw new UsageError(check.error);
  const failing = check.problems.filter((p) => !NOTE_KINDS.has(p.kind));
  if (failing.length) {
    process.stdout.write(
      asJson
        ? jsonLine({ ok: false, problems: failing })
        : `report refused: the answer does not pass check (${failing.length} problem(s)) — run \`ultrastock check ${run} ${answerFile}\`\n`,
    );
    process.exitCode = 1;
    return;
  }
  const file = join(dir, "report.html");
  writeFileSync(file, renderReport(dir, answer, { generatedAt: clockNow().toISOString().slice(0, 16).replace("T", " ") }), { mode: 0o600 });
  process.stdout.write(asJson ? jsonLine({ ok: true, file }) : `report written: ${file}\n`);
}
