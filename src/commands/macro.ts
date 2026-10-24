// Macro, rates, FX, positioning, sentiment, news and index universes.
import type { Dataset } from "../core/datasets.js";
import { argInt, argValue, type CommandArgs, UsageError } from "../engine.js";
import { blsHeadlines } from "../providers/macro/bls.js";
import { dividendsCalendar, earningsCalendar, forexFactoryCalendar, nasdaqEconomicCalendar } from "../providers/macro/calendars.js";
import { cotReport } from "../providers/macro/cftc.js";
import { ecbFx, ecbPolicyRates, ecbPreset, ecbYieldCurve } from "../providers/macro/ecb.js";
import { eurostatIndicator } from "../providers/macro/eurostat.js";
import { frankfurterLatest } from "../providers/macro/frankfurter.js";
import { fredSeries } from "../providers/macro/fred.js";
import { inseeSeries } from "../providers/macro/insee.js";
import { newsSearch } from "../providers/macro/news.js";
import { cboePutCall, cnnFearGreed, cryptoFearGreed, vixTermStructure } from "../providers/macro/sentiment.js";
import { treasuryCurve } from "../providers/macro/treasury.js";
import { indexUniverse } from "../providers/macro/universe.js";
import { worldBankIndicators } from "../providers/macro/worldbank.js";
import { emitDatasets } from "./emit.js";

/** Run several dataset fetches; keep what answers, and say what did not. */
async function gather(tasks: Array<[string, () => Promise<Dataset | Dataset[]>]>): Promise<Dataset[]> {
  const settled = await Promise.allSettled(tasks.map(([, run]) => run()));
  const out: Dataset[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") out.push(...(Array.isArray(s.value) ? s.value : [s.value]));
    else failed.push(`${tasks[i]![0]}: ${(s.reason as Error).message}`);
  });
  if (!out.length) throw new Error(`no source answered — ${failed.join("; ")}`);
  if (failed.length) out[out.length - 1] = { ...out[out.length - 1]!, notes: [...out[out.length - 1]!.notes, ...failed.map((f) => `unavailable — ${f}`)] };
  return out;
}

export async function macroCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [scope = "us", id] = args.positional;
  let tasks: Array<[string, () => Promise<Dataset | Dataset[]>]>;
  switch (scope.toLowerCase()) {
    case "us":
      tasks = [
        ["BLS headlines", () => blsHeadlines().catch(() => Promise.all(["CPIAUCSL", "CPILFESL", "UNRATE", "PAYEMS"].map((s) => fredSeries(s))))],
        ["jobless claims", () => fredSeries("ICSA")],
        ["fed funds", () => fredSeries("DFF")],
      ];
      break;
    case "ea":
      tasks = [
        ["HICP", () => ecbPreset("hicp")],
        ["core HICP", () => ecbPreset("hicpCore")],
        ["unemployment", () => eurostatIndicator("unemployment", "EA20")],
        ["GDP", () => eurostatIndicator("gdpYoy", "EA20")],
      ];
      break;
    case "fr":
      tasks = [
        ["INSEE CPI", () => inseeSeries("cpi")],
        ["INSEE unemployment", () => inseeSeries("unemployment")],
        ["GDP", () => eurostatIndicator("gdpYoy", "FR")],
        ["HICP", () => eurostatIndicator("hicp", "FR")],
      ];
      break;
    case "fred":
      if (!id) throw new UsageError("usage: ultrastock macro fred <SERIES_ID> (e.g. T10Y2Y, BAMLH0A0HYM2, M2SL)");
      tasks = [[id, () => fredSeries(id.toUpperCase(), { history: true, days: argInt(args, "days", { min: 1, max: 3650 }) ?? 30 })]];
      break;
    default:
      if (!/^[a-z]{2,3}$/i.test(scope)) throw new UsageError("usage: ultrastock macro us|ea|fr|<ISO country>|fred <SERIES_ID>");
      tasks = [["World Bank", () => worldBankIndicators(scope.toUpperCase())]];
  }
  emitDatasets(args, await gather(tasks), asJson);
}

export async function ratesCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [scope = "all"] = args.positional;
  const us: Array<[string, () => Promise<Dataset>]> = [
    ["US Treasury curve", () => treasuryCurve()],
    ["US high-yield spread", () => fredSeries("BAMLH0A0HYM2")],
    ["US investment-grade spread", () => fredSeries("BAMLC0A0CM")],
  ];
  const ea: Array<[string, () => Promise<Dataset>]> = [
    ["ECB policy rates", () => ecbPolicyRates()],
    ["€STR", () => ecbPreset("estr")],
    ["euro AAA curve", () => ecbYieldCurve()],
  ];
  const tasks = scope === "us" ? us : scope === "ea" ? ea : [...us, ...ea];
  emitDatasets(args, await gather(tasks), asJson);
}

export async function fxCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const ccys = (args.positional[0] ?? "USD,GBP,CHF,JPY")
    .toUpperCase()
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (!ccys.every((c) => /^[A-Z]{3}$/.test(c))) throw new UsageError("usage: ultrastock fx USD,GBP,… (euro reference rates, ECB; Frankfurter as fallback)");
  emitDatasets(args, await gather([["ECB reference rates", () => ecbFx(ccys).catch(() => frankfurterLatest("EUR", ccys))]]), asJson);
}

export async function cotCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const market = args.positional.join(" ").trim();
  if (!market) throw new UsageError("usage: ultrastock cot <ES|NQ|GC|CL|ZN|BTC|EURO FX|…> [--report legacy|tff]");
  const report = (argValue(args, "report") ?? "legacy") as "legacy" | "tff";
  if (report !== "legacy" && report !== "tff") throw new UsageError("--report is legacy or tff");
  emitDatasets(args, [await cotReport(market, { kind: report })], asJson);
}

export async function sentimentCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [which = "all"] = args.positional;
  const all: Record<string, [string, () => Promise<Dataset>]> = {
    cnn: ["CNN Fear & Greed", () => cnnFearGreed()],
    crypto: ["crypto Fear & Greed", () => cryptoFearGreed(7)],
    vix: ["VIX term structure", () => vixTermStructure()],
    putcall: ["Cboe put/call ratios", () => cboePutCall()],
  };
  if (which !== "all" && !all[which]) throw new UsageError("usage: ultrastock sentiment [all|cnn|crypto|vix|putcall]");
  emitDatasets(args, await gather(which === "all" ? Object.values(all) : [all[which]!]), asJson);
}

export async function newsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const query = args.positional.join(" ").trim();
  if (!query) throw new UsageError('usage: ultrastock news "<query>" [--symbol <SYM>] [--lang en|fr] [--days <n>] [--limit <n>]');
  const lang = (argValue(args, "lang") ?? "en") as "en" | "fr";
  emitDatasets(
    args,
    [
      await newsSearch(query, {
        lang,
        days: argInt(args, "days", { min: 1, max: 90 }) ?? 7,
        limit: argInt(args, "limit", { min: 1, max: 100 }) ?? 20,
        symbol: argValue(args, "symbol"),
      }),
    ],
    asJson,
  );
}

export async function universeCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const index = args.positional[0];
  if (!index) throw new UsageError("usage: ultrastock universe SPX|NDX|DJI|CAC40|SBF120|DAX|SX5E|AEX|UKX");
  emitDatasets(args, [await indexUniverse(index.toUpperCase())], asJson);
}

/** The event side of `calendar`: economic releases, earnings and dividends. */
export async function eventCalendar(sub: "econ" | "earnings" | "dividends", args: CommandArgs, asJson: boolean, date: string): Promise<void> {
  const limit = argInt(args, "limit", { min: 1, max: 500 });
  const ds =
    sub === "econ"
      ? await gather([
          ["Nasdaq economic calendar", () => nasdaqEconomicCalendar(date)],
          ["ForexFactory calendar", () => forexFactoryCalendar({ minImpact: "medium" })],
        ])
      : sub === "earnings"
        ? [await earningsCalendar(date, limit ?? 40)]
        : [await dividendsCalendar(date, limit ?? 60)];
  emitDatasets(args, ds, asJson);
}
