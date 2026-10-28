// `morning [--days 14] [--book real|paper] [--symbols A,B] [--market eu,us,crypto] [--notify] [--out <run>]`:
// the brief that starts the day — what is dated ahead of the held and watched
// names, what moved, the stops, alerts and theses to look at, and the market
// (MORNING.md). `--notify` sends the HIGH flags to the configured channels.
import { type AlertEvent, notify } from "../alerts/alerts.js";
import { morningRun, type RegimeMarket } from "../analyze/morning/run.js";
import { clockNow } from "../core/net.js";
import { runDirFor } from "../core/paths.js";
import { argBool, argInt, argList, argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";

const MARKETS = new Set(["us", "eu", "crypto"]);

export async function morningCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const markets = argList(args, "market").map((m) => m.toLowerCase());
  const bad = markets.filter((m) => !MARKETS.has(m));
  if (bad.length) throw new UsageError(`--market takes us, eu or crypto (comma-separated), not ${bad.join(", ")}`);
  const dir = runDirFor(argValue(args, "out"), `morning-${runId()}`);
  const r = await morningRun(dir, {
    days: argInt(args, "days", { min: 1, max: 60 }) ?? 14,
    book: argValue(args, "book") ?? "real",
    symbols: argList(args, "symbols"),
    markets: markets as RegimeMarket[],
  });
  const high = r.flags.filter((x) => x.level === "high");
  const at = clockNow().toISOString();
  const sent = argBool(args, "notify")
    ? await notify(high.map((x): AlertEvent => ({ rule: `morning:${x.kind}`, ...(x.symbol ? { symbol: x.symbol } : {}), at, message: x.text })))
    : [];
  if (asJson) {
    process.stdout.write(jsonLine({ dir: r.dir, file: r.file, flags: r.flags, universe: r.universe, notes: r.notes, sent }));
    return;
  }
  process.stdout.write(
    [
      `morning: ${r.universe.length} name(s) followed, ${high.length} high and ${r.flags.length - high.length} other flag(s) — ${r.file}`,
      ...r.flags.slice(0, 12).map((x) => `  ${x.level.toUpperCase().padEnd(6)} ${x.text}`),
      ...(r.flags.length > 12 ? [`  … ${r.flags.length - 12} more in MORNING.md`] : []),
      ...r.notes.slice(0, 8).map((n) => `note: ${n}`),
      ...sent.map((s) => `  ${s}`),
      "",
    ].join("\n"),
  );
}
