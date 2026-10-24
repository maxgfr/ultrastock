// Analysis commands built on the data layer: valuation (and, as they land,
// technicals, regime, screens).
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { valuationRun } from "../analyze/valuation.js";
import { runDirFor } from "../core/paths.js";
import { argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";

const pct = (v: string | undefined, flag: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 20) throw new UsageError(`--${flag} is a percentage between 0 and 20, like 5 or 4.5`);
  return n / 100;
};

export async function valuationCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0];
  if (!sym) throw new UsageError("usage: ultrastock valuation <symbol> [--erp <pct>] [--terminal <pct>] [--out <dir>] [--json]");
  const dir = argValue(args, "out")
    ? resolve(argValue(args, "out")!)
    : runDirFor(undefined, `${sym.toUpperCase().replace(/[^A-Z0-9.-]/g, "_")}-valuation-${runId()}`);
  const r = await valuationRun(sym, dir, { erp: pct(argValue(args, "erp"), "erp"), terminalGrowth: pct(argValue(args, "terminal"), "terminal") });
  if (asJson) process.stdout.write(jsonLine(r));
  else process.stdout.write(`${readFileSync(join(dir, "VALUATION.md"), "utf8")}\nrun: ${dir}\n`);
}
