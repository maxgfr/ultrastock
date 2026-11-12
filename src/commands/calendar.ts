// `calendar`: exchange sessions and holidays, computed from the exchanges' rules; hours and one-off closures from the
// researched calendar facts (core/calendar.ts), each output saying when they are not researched.
import {
  type CalendarMarket,
  CLOSURES_CHECKED_THROUGH,
  hoursNote,
  holidays,
  MARKET_COUNTRY,
  MARKETS,
  marketHours,
  nextSessions,
  sessionCountCaveat,
  specialClosures,
} from "../core/calendar.js";
import { researchCommand } from "../core/researched.js";
import { clockNow } from "../core/net.js";
import { argInt, argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";
import { eventCalendar } from "./macro.js";

export async function calendarCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "sessions", date] = args.positional;
  if (sub === "econ" || sub === "earnings" || sub === "dividends") {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`calendar ${sub} takes a date like 2026-10-26, not "${date}"`);
    return eventCalendar(sub, args, asJson, date ?? clockNow().toISOString().slice(0, 10));
  }
  const market = (argValue(args, "market") ?? "XPAR").toUpperCase() as CalendarMarket;
  if (!MARKETS[market]) throw new UsageError(`--market is one of ${Object.keys(MARKETS).join(", ")}, not "${market}"`);
  const today = clockNow().toISOString().slice(0, 10);
  const year = argInt(args, "year", { min: 1990, max: 2100 }) ?? Number(today.slice(0, 4));
  const spec = MARKETS[market];
  const hours = marketHours(market, year);
  if (sub === "sessions") {
    const sessions = nextSessions(market, today, argInt(args, "days", { min: 1, max: 260 }) ?? 10);
    const hol = holidays(market, year).filter((h) => h.date >= today);
    const notes = [hoursNote(market, hours, year), sessionCountCaveat(market, today, sessions.at(-1)?.date ?? today)].filter((n): n is string => !!n);
    if (asJson)
      return void process.stdout.write(
        jsonLine({ market: { ...spec, open: hours.open, close: hours.close }, hours, today, sessions, upcomingHolidays: hol, notes }),
      );
    process.stdout.write(
      [
        `${spec.name} — ${hours.open}–${hours.close} ${spec.timeZone}`,
        `next sessions: ${sessions.map((s) => `${s.date}${s.early ? ` (closes ${s.closeAt})` : ""}`).join(", ")}`,
        `upcoming holidays ${year}: ${hol.map((h) => `${h.date} ${h.name}${h.kind === "early-close" ? ` (early close ${h.closeAt})` : ""}`).join("; ") || "none left"}`,
        ...notes.map((n) => `note: ${n}`),
        "",
      ].join("\n"),
    );
    return;
  }
  if (sub === "holidays") {
    const list = holidays(market, year);
    const notes =
      market !== "CRYPTO" && !specialClosures(market, year).researched && `${year}-12-31` > CLOSURES_CHECKED_THROUGH
        ? [
            `one-off closures after ${CLOSURES_CHECKED_THROUGH} are not researched for ${year}: this list may lack one — \`${researchCommand("calendar", MARKET_COUNTRY[market], { year })}\``,
          ]
        : [];
    if (asJson) return void process.stdout.write(jsonLine({ market: spec, year, holidays: list, notes }));
    process.stdout.write(
      `${spec.name} ${year}\n${list.map((h) => `  ${h.date}  ${h.kind === "closed" ? "closed     " : `closes ${h.closeAt}`}  ${h.name}`).join("\n")}\n${notes.map((n) => `note: ${n}\n`).join("")}`,
    );
    return;
  }
  if (sub === "verify") {
    const list = holidays(market, year);
    const items = [
      `Compare with the exchange's published ${year} calendar: ${market === "XNYS" ? "https://www.nyse.com/markets/hours-calendars" : "https://www.euronext.com/en/trade/trading-hours-holidays"}`,
      `Computed ${list.length} non-standard sessions: ${list.map((h) => h.date).join(", ")}`,
      `One-off closures ${specialClosures(market, year).researched ? "researched" : `recorded (checked through ${CLOSURES_CHECKED_THROUGH}, not researched for ${year})`}: ${
        specialClosures(market, year)
          .closures.map((s) => `${s.date} ${s.name}`)
          .join("; ") || "none"
      } — search "${spec.name} market closure ${year}" for new ones (a national day of mourning, an outage)`,
      `Trading hours ${hours.open}–${hours.close} ${spec.timeZone} (${hours.origin === "researched" ? `researched, verified ${hours.asOf}` : `built-in, as published on ${hours.asOf}`})`,
      ...(market === "CRYPTO" ? [] : [`Store the year's hours and one-off closures: \`${researchCommand("calendar", MARKET_COUNTRY[market], { year })}\``]),
    ];
    if (asJson) return void process.stdout.write(jsonLine({ market, year, computed: list, checklist: items }));
    process.stdout.write(`${items.map((i) => `- ${i}`).join("\n")}\n`);
    return;
  }
  throw new UsageError(`unknown calendar action "${sub}" — sessions, holidays, verify, econ, earnings or dividends`);
}
