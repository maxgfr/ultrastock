// Analysis commands built on the data layer: valuation (and, as they land,
// technicals, regime, screens).
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { technicalsRun } from "../analyze/technicals.js";
import { valuationRun } from "../analyze/valuation.js";
import { runDirFor } from "../core/paths.js";
import { argList, argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";
import type { Interval } from "../providers/types.js";

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

const INTERVALS: Interval[] = ["1d", "1w", "4h", "1h", "15m"];

export async function technicalsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0];
  if (!sym)
    throw new UsageError(
      "usage: ultrastock technicals <symbol> [--interval 1d|1w|4h|1h|15m] [--indicators rsi:period=7,kama] [--benchmark <symbol>] [--out <dir>] [--json]",
    );
  const interval = (argValue(args, "interval") ?? "1d") as Interval;
  if (!INTERVALS.includes(interval)) throw new UsageError(`--interval must be one of ${INTERVALS.join(", ")}`);
  const dir = argValue(args, "out")
    ? resolve(argValue(args, "out")!)
    : runDirFor(undefined, `${sym.toUpperCase().replace(/[^A-Z0-9.-]/g, "_")}-technicals-${runId()}`);
  const r = await technicalsRun(sym, dir, { interval, extra: argList(args, "indicators"), benchmark: argValue(args, "benchmark") });
  if (asJson) process.stdout.write(jsonLine(r));
  else process.stdout.write(`${readFileSync(join(dir, "TECHNICALS.md"), "utf8")}\nrun: ${dir}\n`);
}
