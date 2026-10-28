// `morning [--days 14] [--book real|paper] [--symbols A,B] [--market eu,us,crypto] [--research-with claude|codex|ccs] [--no-news] [--notify] [--out <run>]`:
// the brief that starts the day — what is dated ahead of the held and watched
// names, what moved and what was written about them, the stops, alerts and
// theses to look at, and the market (MORNING.md). The flagged results dates get
// a financial-calendar worklist for the web; `--research-with` searches it in
// the run, `morning --confirm --out <run>` reads what the host's search brought.
// `--notify` sends the HIGH flags to the configured channels.
import { type AlertEvent, notify } from "../alerts/alerts.js";
import type { Confirmation } from "../analyze/morning/confirm.js";
import { confirmMorning, morningRun, type RegimeMarket } from "../analyze/morning/run.js";
import { clockNow } from "../core/net.js";
import { runDirFor } from "../core/paths.js";
import { argBool, argInt, argList, argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";
import { SEARCH_DELEGATES, type SearchDelegate } from "../research/delegate.js";

const MARKETS = new Set(["us", "eu", "crypto"]);

const confirmationLine = (c: Confirmation) =>
  `  ${c.symbol} ${c.kind} ${c.date}: ${
    c.status === "confirmed"
      ? `confirmed by ${c.stating[0]!.host}`
      : c.status === "press-only"
        ? `stated by ${c.stating[0]!.host} (press, not the issuer)`
        : c.status === "differs"
          ? `the issuer (${c.issuerDate!.host}) says ${c.issuerDate!.date}`
          : c.status === "unconfirmed"
            ? `not stated by the ${c.sources} page(s) read`
            : "to search on the web"
  }`;

export async function morningCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  if (argBool(args, "confirm")) {
    const out = argValue(args, "out");
    if (!out) throw new UsageError("usage: ultrastock morning --confirm --out <run> — after the web search of the run's calendar worklists");
    const r = confirmMorning(runDirFor(out, "unused"));
    if (asJson) process.stdout.write(jsonLine(r));
    else process.stdout.write([`morning --confirm: ${r.file}`, ...r.confirmations.map(confirmationLine), ""].join("\n"));
    return;
  }
  const markets = argList(args, "market").map((m) => m.toLowerCase());
  const bad = markets.filter((m) => !MARKETS.has(m));
  if (bad.length) throw new UsageError(`--market takes us, eu or crypto (comma-separated), not ${bad.join(", ")}`);
  const researchWith = argValue(args, "research-with");
  if (researchWith !== undefined && !(SEARCH_DELEGATES as readonly string[]).includes(researchWith))
    throw new UsageError(`--research-with is one of ${SEARCH_DELEGATES.join(", ")}, not "${researchWith}"`);
  const dir = runDirFor(argValue(args, "out"), `morning-${runId()}`);
  const r = await morningRun(dir, {
    days: argInt(args, "days", { min: 1, max: 60 }) ?? 14,
    book: argValue(args, "book") ?? "real",
    symbols: argList(args, "symbols"),
    markets: markets as RegimeMarket[],
    ...(researchWith ? { researchWith: researchWith as SearchDelegate, model: argValue(args, "search-model") } : {}),
    news: !argBool(args, "no-news"),
  });
  const high = r.flags.filter((x) => x.level === "high");
  const at = clockNow().toISOString();
  const sent = argBool(args, "notify")
    ? await notify(high.map((x): AlertEvent => ({ rule: `morning:${x.kind}`, ...(x.symbol ? { symbol: x.symbol } : {}), at, message: x.text })))
    : [];
  if (asJson) {
    process.stdout.write(jsonLine({ dir: r.dir, file: r.file, flags: r.flags, universe: r.universe, confirmations: r.confirmations, notes: r.notes, sent }));
    return;
  }
  process.stdout.write(
    [
      `morning: ${r.universe.length} name(s) followed, ${high.length} high and ${r.flags.length - high.length} other flag(s) — ${r.file}`,
      ...r.flags.slice(0, 12).map((x) => `  ${x.level.toUpperCase().padEnd(6)} ${x.text}`),
      ...(r.flags.length > 12 ? [`  … ${r.flags.length - 12} more in MORNING.md`] : []),
      ...(r.confirmations.length ? ["dates on the web:", ...r.confirmations.map(confirmationLine)] : []),
      ...r.notes.slice(0, 8).map((n) => `note: ${n}`),
      ...sent.map((s) => `  ${s}`),
      "",
    ].join("\n"),
  );
}
