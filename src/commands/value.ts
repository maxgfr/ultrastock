// `value`: search for cheap stocks that are not value traps, rank them on
// sector-relative percentiles, value the top ones and write VALUE.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { valueRun } from "../analyze/value/run.js";
import { valueRegion, valueStyles } from "../analyze/value/styles.js";
import { runDirFor } from "../core/paths.js";
import { argBool, argInt, argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";
import { cribleAvailable, cribleBootstrapped, cribleDataDir, SOURCE as CRIBLE } from "../providers/external/crible.js";
import { ProviderError } from "../providers/types.js";
import { SEARCH_DELEGATES, type SearchDelegate } from "../research/delegate.js";

export const VALUE_USAGE =
  "usage: ultrastock value [--style quality-value|deep-value|dividend|garp|magic-formula|all] [--region world|europe|pea|us|<ISO,…>] " +
  "[--shortlist 30] [--top 10] [--min-cap-eur <n>] [--watch] [--research-with claude|codex|ccs [--research-top 3] [--search-model <m>]] [--out <run>] [--json]";

export async function valueCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  let styles: ReturnType<typeof valueStyles>;
  let region: ReturnType<typeof valueRegion>;
  try {
    styles = valueStyles(argValue(args, "style"));
    region = valueRegion(argValue(args, "region"));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const shortlist = argInt(args, "shortlist", { min: 1, max: 100 }) ?? 30;
  const top = argInt(args, "top", { min: 0, max: 30 }) ?? 10;
  if (top > shortlist) throw new UsageError(`--top (${top}) cannot exceed --shortlist (${shortlist})`);
  const capArg = argValue(args, "min-cap-eur");
  const minCapEur = capArg === undefined ? undefined : Number(capArg.replace(/_/g, ""));
  if (minCapEur !== undefined && !(Number.isFinite(minCapEur) && minCapEur >= 0))
    throw new UsageError(`--min-cap-eur takes an amount in euros (500000000), not "${capArg}"`);
  const researchWith = argValue(args, "research-with");
  if (researchWith !== undefined && !(SEARCH_DELEGATES as readonly string[]).includes(researchWith))
    throw new UsageError(`--research-with is one of ${SEARCH_DELEGATES.join(", ")}, not "${researchWith}"`);
  const researchTop = argInt(args, "research-top", { min: 1, max: 30 });
  if (researchTop !== undefined && !researchWith) throw new UsageError("--research-top goes with --research-with claude|codex|ccs");
  if (!cribleAvailable()) throw new ProviderError(CRIBLE, "uvx is not installed — install uv (https://docs.astral.sh/uv/) to use crible", 0);
  if (!cribleBootstrapped())
    throw new ProviderError(
      CRIBLE,
      `crible has no dataset in ${cribleDataDir()} — run \`ultrastock screen --engine crible --bootstrap\` once (about a minute), or set ULTRASTOCK_CRIBLE_DATA_DIR`,
      400,
    );
  const label = styles.length > 1 ? "all" : styles[0]!.id;
  const dir = runDirFor(argValue(args, "out"), `value-${label}-${region.id.replace(/[^a-z0-9-]/gi, "_")}-${runId()}`);
  const r = await valueRun(dir, {
    styles,
    region,
    shortlist,
    top,
    minCapEur,
    watch: argBool(args, "watch"),
    ...(researchWith
      ? { research: { with: researchWith as SearchDelegate, top: Math.min(researchTop ?? 3, top || 1), model: argValue(args, "search-model") } }
      : {}),
    progress: (m) => process.stderr.write(`${m}\n`),
  });
  if (asJson) process.stdout.write(jsonLine(r));
  else process.stdout.write(`${readFileSync(join(dir, "VALUE.md"), "utf8")}\nrun: ${dir}\n`);
}
