// `portfolio risk|stress|optimize|rebalance|location|lookthrough|income|goals`:
// the analyses of a book (real or paper) on top of the ledger, the quotes and
// the ECB rates. Each registers its inputs and every figure it derives in a
// run directory (--out, else <home>/runs/portfolio-<action>-…) and prints them
// numbered. None of them places an order.
import { argInt, argList, argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";
import { loadMarkedBook } from "../analyze/portfolio/book.js";
import { Findings, formatFindings, registerFindings } from "../analyze/portfolio/findings.js";
import { parseTargets } from "../analyze/portfolio/rebalance.js";
import { incomeAnalysis, locationAnalysis, lookthroughAnalysis, rebalanceAnalysis } from "../analyze/portfolio/run-book.js";
import { goalsAnalysis, optimizeAnalysis } from "../analyze/portfolio/run-optimize.js";
import { riskAnalysis, stressAnalysis } from "../analyze/portfolio/run-risk.js";
import { clockNow } from "../core/net.js";
import { runDirFor } from "../core/paths.js";

export const PORTFOLIO_ANALYTICS_ACTIONS = ["risk", "stress", "optimize", "rebalance", "location", "lookthrough", "income", "goals"] as const;
type Action = (typeof PORTFOLIO_ANALYTICS_ACTIONS)[number];

const USAGE =
  "usage: ultrastock portfolio risk|stress|optimize|rebalance|location|lookthrough|income|goals [--book real|paper] [--out <dir>] [--json]\n" +
  "  optimize   [--universe a,b,c]\n" +
  '  rebalance  --targets <file.json | {"CW8.PA":60,"MC.PA":10}> [--band <points>] [--rel-band <pct>] [--contribution <amount>]\n' +
  "  goals      --target <amount> --years <n> [--monthly <amount>]\n" +
  "  risk       [--benchmark <symbol>]";

const TITLES: Record<Action, string> = {
  risk: "risk",
  stress: "stress tests",
  optimize: "target weights (optimisation)",
  rebalance: "rebalancing proposal",
  location: "asset location by envelope",
  lookthrough: "fund look-through",
  income: "income",
  goals: "goal projection",
};

const number = (args: CommandArgs, flag: string, check?: (n: number) => boolean, what = "a number"): number | undefined => {
  const v = argValue(args, flag);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || (check && !check(n))) throw new UsageError(`--${flag} takes ${what}, not "${v}"`);
  return n;
};

export async function portfolioAnalyticsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const action = args.positional[0] as Action | undefined;
  if (!action || !PORTFOLIO_ANALYTICS_ACTIONS.includes(action)) throw new UsageError(USAGE);
  const bookName = argValue(args, "book") ?? "real";
  if (bookName !== "real" && bookName !== "paper") throw new UsageError("--book is real or paper");

  // Validate the action's flags before any network call.
  let targets: Record<string, number> | undefined;
  const band = number(args, "band", (n) => n > 0 && n <= 50, "a band in points between 0 and 50, like 5");
  const relBandPct = number(args, "rel-band", (n) => n > 0 && n <= 100, "a relative band in % between 0 and 100, like 25");
  const contribution = number(args, "contribution", (n) => n > 0, "a positive amount");
  let goal: { target: number; years: number; monthly: number } | undefined;
  if (action === "rebalance") {
    const raw = argValue(args, "targets");
    if (!raw)
      throw new UsageError(
        'usage: ultrastock portfolio rebalance --targets <file.json | {"CW8.PA":60,"MC.PA":10}> [--band 5] [--rel-band 25] [--contribution <amount>]',
      );
    targets = parseTargets(raw);
  }
  if (action === "goals") {
    const target = number(args, "target", (n) => n > 0, "a positive amount");
    const years = argInt(args, "years", { min: 1, max: 60 });
    const monthly = number(args, "monthly", (n) => n >= 0, "an amount ≥ 0") ?? 0;
    if (target === undefined || years === undefined)
      throw new UsageError("usage: ultrastock portfolio goals --target <amount> --years <n> [--monthly <amount>]");
    goal = { target, years, monthly };
  }

  const now = clockNow();
  const dir = runDirFor(argValue(args, "out"), `portfolio-${action}-${bookName}-${runId()}`);
  const f = new Findings();
  const m = await loadMarkedBook(bookName, f, now);
  let result: unknown;
  switch (action) {
    case "risk":
      result = await riskAnalysis(m, f, { benchmark: argValue(args, "benchmark") });
      break;
    case "stress":
      result = await stressAnalysis(m, f);
      break;
    case "optimize":
      result = await optimizeAnalysis(m, f, { universe: argList(args, "universe") });
      break;
    case "rebalance":
      result = await rebalanceAnalysis(m, f, {
        targets: targets!,
        bandPct: band,
        relBand: relBandPct === undefined ? undefined : relBandPct / 100,
        contribution,
      });
      break;
    case "location":
      result = await locationAnalysis(m, f);
      break;
    case "lookthrough":
      result = await lookthroughAnalysis(m, f);
      break;
    case "income":
      result = await incomeAnalysis(m, f);
      break;
    case "goals":
      result = await goalsAnalysis(m, f, goal!);
      break;
  }
  const { store, result: emitted } = registerFindings(dir, f, `portfolio:${bookName}`, now);
  const title = `${bookName} book — ${TITLES[action]} (${m.base}, ${now.toISOString().slice(0, 10)})`;
  if (asJson) process.stdout.write(jsonLine({ action, book: bookName, dir, result, evidence: emitted.derived, inputs: emitted.inputs, notes: emitted.notes }));
  else process.stdout.write(formatFindings(title, f, emitted, store));
}
