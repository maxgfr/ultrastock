// Market-context commands: the regime (how much to have at risk), sector
// leadership, and the catalysts dated around one instrument. Each prints a
// summary citing its [E#] ids, then every registered figure.
import { argInt, argValue, type CommandArgs, UsageError } from "../engine.js";
import { catalystsReport } from "../analyze/regime/catalysts.js";
import { emitReport } from "../analyze/regime/common.js";
import { cryptoRegimeReport, euRegime, usRegime } from "../analyze/regime/market.js";
import { euSectors, usSectors } from "../analyze/regime/sectors.js";

const marketFlag = <T extends string>(args: CommandArgs, allowed: readonly T[], usage: string): T => {
  const m = (argValue(args, "market") ?? allowed[0]!).toLowerCase() as T;
  if (!allowed.includes(m)) throw new UsageError(`--market is ${allowed.join(", ")}, not "${m}" — ${usage}`);
  return m;
};

/** `regime [--market us|eu|crypto]`: the exposure coach (equities) or the crypto risk-on score, every signal and component as evidence. */
export async function regimeCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const usage = "usage: ultrastock regime [--market us|eu|crypto] [--out <dir>] [--json]";
  if (args.positional.length) throw new UsageError(usage);
  const m = marketFlag(args, ["us", "eu", "crypto"] as const, usage);
  const report = m === "us" ? await usRegime() : m === "eu" ? await euRegime() : await cryptoRegimeReport();
  emitReport(args, report, asJson);
}

/** `sectors [--market us|eu]`: sector relative strength, trend position and the rotation reading. */
export async function sectorsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const usage = "usage: ultrastock sectors [--market us|eu] [--out <dir>] [--json]";
  if (args.positional.length) throw new UsageError(usage);
  const m = marketFlag(args, ["us", "eu"] as const, usage);
  emitReport(args, m === "us" ? await usSectors() : await euSectors(), asJson);
}

/** `catalysts <symbol> [--days 30]`: a dated timeline of what can move the instrument in the window. */
export async function catalystsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0];
  if (!sym || args.positional.length > 1) throw new UsageError("usage: ultrastock catalysts <symbol> [--days <1-90>] [--out <dir>] [--json]");
  const days = argInt(args, "days", { min: 1, max: 90 }) ?? 30;
  emitReport(args, await catalystsReport(sym, days), asJson);
}
