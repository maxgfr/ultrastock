// `screen <preset|query>`: stock, ETF and crypto screens on three engines —
// TradingView's scanner (fundamental and technical columns over a whole
// market), crible (audited fundamentals, its DSL and presets) and builtin
// (technical patterns computed here on daily bars for an index or a list).
// `screen --list` prints every preset's rules in plain words with its source:
// no preset is hidden logic.
import { untrustedBlock } from "../core/untrusted.js";
import { argBool, argInt, argList, argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";
import { builtinScreen, BUILTIN_MAX_SYMBOLS } from "../analyze/screen/builtin.js";
import { collapseForeignLines, criblePresets, cribleRowsToDataset, looksLikePresetId, primaryListingsOnly } from "../analyze/screen/crible.js";
import { baseFilters, BUILTIN_PRESETS, describeFilter, type Engine, EUROPE_MARKETS, TV_PRESETS, tvPreset, tvPresetRules } from "../analyze/screen/presets.js";
import { TECHNICAL_IDS, type TechnicalId } from "../analyze/screen/technical.js";
import { tradingviewScreen } from "../analyze/screen/tradingview.js";
import { indexId } from "../providers/macro/universe.js";
import { cribleAvailable, cribleBootstrap, cribleBootstrapped, cribleDataDir, cribleScreen, SOURCE as CRIBLE } from "../providers/external/crible.js";
import { ProviderError } from "../providers/types.js";
import { emitDatasets } from "./emit.js";

const ENGINES: Engine[] = ["tradingview", "crible", "builtin"];
const USAGE =
  "usage: ultrastock screen <preset|query> [--engine tradingview|crible|builtin] [--market america|france|germany|europe|uk|crypto|…] " +
  "[--universe SPX|NDX|CAC40|SBF120|DAX|SX5E|AEX|UKX|<comma list>] [--limit <n>] [--sort <field>|-<field>] [--bootstrap] [--out <dir>] [--json] | screen --list [--engine …]";

const isTechnical = (q: string): q is TechnicalId => (TECHNICAL_IDS as readonly string[]).includes(q);

/** The engine a query runs on when --engine is absent: a TradingView preset, then a builtin one, then DSL for crible. */
function pickEngine(query: string): Engine {
  if (tvPreset(query)) return "tradingview";
  if (isTechnical(query)) return "builtin";
  if (/[<>=]|\bIN\b/i.test(query)) return "crible";
  throw new UsageError(
    `unknown screen "${query}" — \`ultrastock screen --list\` shows the tradingview and builtin presets; crible's: \`ultrastock screen --engine crible --list\` (pass --engine crible to run one, or a DSL query)`,
  );
}

function listText(engine: Engine | undefined): string {
  const lines: string[] = ["# screen presets — every rule in the open", ""];
  if (!engine || engine === "tradingview") {
    lines.push(
      "## engine tradingview — TradingView's scanner (unofficial, delayed snapshot)",
      `--market: a scanner market (america, france, germany, uk, italy, spain…), europe (= ${EUROPE_MARKETS.join(", ")}, merged) or crypto (stocks presets do not apply there).`,
      `Every stock preset first keeps primary listings of common stocks: ${baseFilters("stock", "america").map(describeFilter).join("; ")} (the OTC exclusion on america only).`,
      `On --market crypto (TradingView's one-row-per-coin market): ${baseFilters("stock", "coin").map(describeFilter).join("; ")}.`,
      "Money thresholds (market cap, AUM) are in each listing's own currency; a money-valued sort across currencies compares euros at ECB reference rates.",
      "",
    );
    for (const p of TV_PRESETS) {
      lines.push(
        `- ${p.id} — ${p.title} [engine tradingview; ${p.assets === "etf" ? "ETFs" : "stocks"}${p.crypto ? " or crypto" : ""}; default market ${p.defaultMarket}]`,
      );
      lines.push(`    rules: ${tvPresetRules(p).join("; ")}`);
      lines.push(
        `    sorted by: ${p.id === "magic-formula" ? "combined rank" : `${p.sort.sortBy} ${p.sort.sortOrder === "asc" ? "ascending" : "descending"}`}`,
      );
      lines.push(`    source: ${p.source}`);
      for (const a of p.approximations ?? []) lines.push(`    approximated: ${a}`);
    }
    lines.push("");
  }
  if (!engine || engine === "builtin") {
    lines.push(
      "## engine builtin — computed by ultrastock on closed daily bars",
      `--universe: SPX, NDX, CAC40, SBF120, DAX, SX5E, AEX, UKX (today's members, Wikipedia) or a comma list; at most ${BUILTIN_MAX_SYMBOLS} symbols, 4 at a time.`,
      "Benchmark: SPY for US universes, the CAC 40 (FR0003500008) for French ones, CW8.PA otherwise.",
      "",
    );
    for (const p of BUILTIN_PRESETS) {
      lines.push(`- ${p.id} — ${p.title} [engine builtin]`);
      lines.push(`    rules: ${p.rules.join("; ")}`);
      lines.push(`    source: ${p.source}`);
      for (const a of p.approximations ?? []) lines.push(`    approximated: ${a}`);
    }
    lines.push("");
  }
  if (!engine) {
    lines.push(
      "## engine crible — maxgfr/crible, audited fundamentals (~95k companies), run through uvx",
      "Its presets (Piotroski, Altman, Beneish, magic formula, GARP…) and their DSL: `ultrastock screen --engine crible --list`.",
      "Names shared with tradingview presets (magic-formula, garp) run on tradingview unless --engine crible is given; any other query with an operator is crible DSL.",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function listCommand(engine: Engine | undefined, asJson: boolean): Promise<void> {
  if (engine === "crible") {
    if (!cribleAvailable()) throw new ProviderError(CRIBLE, "uvx is not installed — install uv (https://docs.astral.sh/uv/) to use crible", 0);
    const presets = await criblePresets();
    if (asJson) return void process.stdout.write(jsonLine({ engine: "crible", presets }));
    process.stdout.write(
      [
        "# crible presets — run one with `ultrastock screen <id> --engine crible`; any other query is passed as DSL",
        `dataset: ${cribleBootstrapped() ? "present" : "missing — add --bootstrap to the first screen (about a minute)"} (${cribleDataDir()})`,
        untrustedBlock(
          "crible presets",
          presets.flatMap((p) => [
            `${p.id} — ${p.name}: ${p.description}`,
            `    DSL: ${p.dsl}`,
            ...(p.columns?.length ? [`    shows: ${p.columns.join(", ")}`] : []),
          ]),
        ),
        "",
      ].join("\n"),
    );
    return;
  }
  if (asJson) {
    process.stdout.write(
      jsonLine({
        tradingview:
          engine && engine !== "tradingview"
            ? undefined
            : TV_PRESETS.map((p) => ({
                id: p.id,
                title: p.title,
                engines: ["tradingview"],
                assets: p.assets,
                crypto: !!p.crypto,
                defaultMarket: p.defaultMarket,
                baseRules: baseFilters(p.assets, "america").map(describeFilter),
                rules: tvPresetRules(p),
                filter: p.filter,
                sort: p.sort,
                source: p.source,
                approximations: p.approximations ?? [],
              })),
        builtin:
          engine && engine !== "builtin" ? undefined : BUILTIN_PRESETS.map((p) => ({ ...p, engines: ["builtin"], approximations: p.approximations ?? [] })),
      }),
    );
    return;
  }
  process.stdout.write(listText(engine));
}

/** --universe: an index id, else a comma list of symbols. */
function universeArg(args: CommandArgs): { universe?: string; symbols?: string[] } {
  const raw = argValue(args, "universe");
  if (!raw)
    throw new UsageError(
      `the builtin engine needs --universe SPX|NDX|CAC40|SBF120|DAX|SX5E|AEX|UKX or a comma list of symbols (at most ${BUILTIN_MAX_SYMBOLS})`,
    );
  if (!raw.includes(",") && indexId(raw)) return { universe: indexId(raw) };
  return { symbols: argList(args, "universe") };
}

async function cribleRun(query: string, args: CommandArgs): Promise<ReturnType<typeof cribleRowsToDataset>> {
  if (!cribleAvailable()) throw new ProviderError(CRIBLE, "uvx is not installed — install uv (https://docs.astral.sh/uv/) to use crible", 0);
  if (!cribleBootstrapped()) {
    if (!argBool(args, "bootstrap"))
      throw new ProviderError(
        CRIBLE,
        `crible has no dataset in ${cribleDataDir()} — rerun with --bootstrap to download it once (about a minute), or set ULTRASTOCK_CRIBLE_DATA_DIR to an existing one`,
        400,
      );
    process.stderr.write(`downloading crible's published dataset into ${cribleDataDir()} (about a minute)…\n`);
    await cribleBootstrap();
  }
  const limit = argInt(args, "limit", { min: 1, max: 200 }) ?? 25;
  const sort = argValue(args, "sort");
  let preset: Awaited<ReturnType<typeof criblePresets>>[number] | undefined;
  if (looksLikePresetId(query)) {
    const presets = await criblePresets();
    preset = presets.find((p) => p.id === query.trim().toLowerCase());
    if (!preset)
      throw new UsageError(
        `crible has no preset "${query}" — available: ${presets.map((p) => p.id).join(", ")} (or pass a DSL query such as "piotroski_f >= 7")`,
      );
  }
  const dsl = preset?.dsl ?? query;
  if (argBool(args, "all-listings")) return cribleRowsToDataset(await cribleScreen(dsl, { limit, ...(sort ? { sort } : {}) }), { query: dsl, preset });
  // Fetch past the limit so an ADR whose home listing ranks just below still collapses.
  const run = primaryListingsOnly(dsl);
  const r = await cribleScreen(run, { limit: Math.min(limit * 2, 400), ...(sort ? { sort } : {}) });
  const { rows, dropped } = collapseForeignLines(r.rows);
  return cribleRowsToDataset({ total: r.total, rows: rows.slice(0, limit) }, { query: dsl, preset, dsl: run, dropped });
}

export async function screenCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const engineArg = argValue(args, "engine")?.toLowerCase();
  if (engineArg && !ENGINES.includes(engineArg as Engine)) throw new UsageError(`--engine is ${ENGINES.join(", ")}`);
  const engineFlag = engineArg as Engine | undefined;
  if (argBool(args, "list")) return listCommand(engineFlag, asJson);
  const query = args.positional.join(" ").trim();
  if (!query) throw new UsageError(USAGE);
  const engine = engineFlag ?? pickEngine(query);
  if (argBool(args, "bootstrap") && engine !== "crible") throw new UsageError("--bootstrap downloads crible's dataset: it goes with --engine crible");
  if (argValue(args, "universe") && engine !== "builtin")
    throw new UsageError("--universe is for --engine builtin (an index or a list); tradingview screens a whole --market, crible its own universe");
  if (argValue(args, "market") && engine !== "tradingview") throw new UsageError("--market is for --engine tradingview; builtin takes --universe");

  if (engine === "tradingview") {
    const preset = tvPreset(query);
    if (!preset) throw new UsageError(`no tradingview preset "${query}" — available: ${TV_PRESETS.map((p) => p.id).join(", ")}`);
    const ds = await tradingviewScreen(preset, {
      market: argValue(args, "market"),
      limit: argInt(args, "limit", { min: 1, max: 200 }) ?? 25,
      sort: argValue(args, "sort"),
    });
    return emitDatasets(args, ds, asJson);
  }
  if (engine === "builtin") {
    if (!isTechnical(query)) throw new UsageError(`no builtin preset "${query}" — available: ${TECHNICAL_IDS.join(", ")}`);
    if (argValue(args, "sort")) throw new UsageError("--sort is for tradingview and crible; builtin lists matches first");
    const ds = await builtinScreen(query, { ...universeArg(args), limit: argInt(args, "limit", { min: 1, max: BUILTIN_MAX_SYMBOLS }) });
    return emitDatasets(args, ds, asJson);
  }
  emitDatasets(args, [await cribleRun(query, args)], asJson);
}
