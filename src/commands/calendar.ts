// `calendar`: exchange sessions and holidays, computed from the exchanges' rules.
import { type CalendarMarket, holidays, MARKETS, nextSessions, SPECIAL_CLOSURES } from "../core/calendar.js";
import { clockNow } from "../core/net.js";
import { argInt, argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";

export async function calendarCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "sessions"] = args.positional;
  const market = (argValue(args, "market") ?? "XPAR").toUpperCase() as CalendarMarket;
  if (!MARKETS[market]) throw new UsageError(`--market is one of ${Object.keys(MARKETS).join(", ")}, not "${market}"`);
  const today = clockNow().toISOString().slice(0, 10);
  const year = argInt(args, "year", { min: 1990, max: 2100 }) ?? Number(today.slice(0, 4));
  const spec = MARKETS[market];
  if (sub === "sessions") {
    const sessions = nextSessions(market, today, argInt(args, "days", { min: 1, max: 260 }) ?? 10);
    const hol = holidays(market, year).filter((h) => h.date >= today);
    if (asJson) return void process.stdout.write(jsonLine({ market: spec, today, sessions, upcomingHolidays: hol }));
    process.stdout.write(
      [
        `${spec.name} — ${spec.open}–${spec.close} ${spec.timeZone}`,
        `next sessions: ${sessions.map((s) => `${s.date}${s.early ? ` (closes ${s.closeAt})` : ""}`).join(", ")}`,
        `upcoming holidays ${year}: ${hol.map((h) => `${h.date} ${h.name}${h.kind === "early-close" ? ` (early close ${h.closeAt})` : ""}`).join("; ") || "none left"}`,
        "",
      ].join("\n"),
    );
    return;
  }
  if (sub === "holidays") {
    const list = holidays(market, year);
    if (asJson) return void process.stdout.write(jsonLine({ market: spec, year, holidays: list }));
    process.stdout.write(
      `${spec.name} ${year}\n${list.map((h) => `  ${h.date}  ${h.kind === "closed" ? "closed     " : `closes ${h.closeAt}`}  ${h.name}`).join("\n")}\n`,
    );
    return;
  }
  if (sub === "verify") {
    const list = holidays(market, year);
    const items = [
      `Compare with the exchange's published ${year} calendar: ${market === "XNYS" ? "https://www.nyse.com/markets/hours-calendars" : "https://www.euronext.com/en/trade/trading-hours-holidays"}`,
      `Computed ${list.length} non-standard sessions: ${list.map((h) => h.date).join(", ")}`,
      `One-off closures recorded: ${
        SPECIAL_CLOSURES.filter((s) => s.market === market)
          .map((s) => `${s.date} ${s.name}`)
          .join("; ") || "none"
      } — search "${spec.name} market closure ${year}" for new ones (a national day of mourning, an outage)`,
    ];
    if (asJson) return void process.stdout.write(jsonLine({ market, year, computed: list, checklist: items }));
    process.stdout.write(`${items.map((i) => `- ${i}`).join("\n")}\n`);
    return;
  }
  throw new UsageError(`unknown calendar action "${sub}" — sessions, holidays or verify`);
}
