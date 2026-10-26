// `etf compare|overlap|find|propose`: ETFs side by side, the overlap of two
// funds' holdings, a search by index or theme (or a browse of the catalogue),
// and a proposal for a goal and an envelope — every figure an [E#] with --out.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ETF_ASSETS, ETF_SORTS, etfCompare, etfFind, etfOverlapReport } from "../analyze/etf.js";
import { ETF_ENVELOPES, ETF_GOALS, EtfProposeError, etfPropose } from "../analyze/etf-propose.js";
import { formatDatasets, registerDatasets } from "../core/datasets.js";
import { formatNumber } from "../core/evidence.js";
import { clockNow } from "../core/net.js";
import { runDirFor } from "../core/paths.js";
import { argBool, argInt, argOneOf, argValue, type CommandArgs, jsonLine, runId, UsageError } from "../engine.js";
import { emitDatasets } from "./emit.js";

export const ETF_USAGE = `usage:
  ultrastock etf compare <A,B,C> [--out <dir>] [--json]       fund facts side by side, correlation, overlap (2 to 6 ETFs)
  ultrastock etf overlap <A,B> [--out <dir>] [--json]         Σ of the smaller weights, and the common lines
  ultrastock etf find "<index|theme>" [--pea] [--acc|--dist] [--ucits] [--currency EUR] [--limit 10] [--out <dir>] [--json]
  ultrastock etf find [--asset equity|bond|commodity|money-market|multi-asset|real-estate] [--focus "<focus>"] [--exposure <region>]
                      [--sort aum|ter|perf] [--leveraged] [--pea] [--acc|--dist] [--ucits] [--currency EUR] [--limit 10]
                                                              no query: browse the catalogue (leveraged/inverse left out)
  ultrastock etf propose [--goal core|growth|income|defensive] [--envelope pea|cto|av] [--risk 1-7] [--amount <EUR>]
                         [--max-funds 4] [--acc|--dist] [--currency EUR] [--hedged] [--out <run>] [--json]
                                                              PROPOSAL.md + TARGETS.json: a stated allocation convention, scored funds`;
const USAGE = ETF_USAGE;

function distributionOf(args: CommandArgs): "acc" | "dist" | undefined {
  if (argBool(args, "acc") && argBool(args, "dist")) throw new UsageError("--acc and --dist are opposites: pick one");
  return argBool(args, "acc") ? "acc" : argBool(args, "dist") ? "dist" : undefined;
}

function currencyOf(args: CommandArgs): string | undefined {
  const currency = argValue(args, "currency");
  if (currency && !/^[A-Za-z]{3}$/.test(currency)) throw new UsageError(`--currency takes a currency code like EUR, not "${currency}"`);
  return currency?.toUpperCase();
}

/** "A,B" or "A B" → symbols, deduplicated, in order. */
function symbolsOf(args: CommandArgs): string[] {
  return [
    ...new Set(
      args.positional
        .slice(1)
        .flatMap((s) => s.split(","))
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

export async function etfCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sub = args.positional[0];
  if (sub === "compare") {
    const syms = symbolsOf(args);
    if (syms.length < 2 || syms.length > 6) throw new UsageError(`etf compare takes 2 to 6 ETFs, comma-separated\n${USAGE}`);
    const r = await etfCompare(syms);
    const out = argValue(args, "out");
    const registered = registerDatasets(out ? resolve(out) : undefined, r.datasets);
    const byKey = new Map(registered.flatMap((x) => x.items.map((i) => [i.key, i] as const)));
    const cell = (key: string | undefined) => {
      const i = key ? byKey.get(key) : undefined;
      if (!i) return { text: "n/a" };
      const v = typeof i.value === "number" ? `${formatNumber(i.value)}${i.unit ? (i.unit === "%" ? " %" : ` ${i.unit}`) : ""}` : String(i.value);
      return { text: i.untrusted ? "(see below)" : `${v}${i.id ? ` [${i.id}]` : ""}`, id: i.id || undefined, value: i.value, unit: i.unit };
    };
    const rows = r.table.rows.map((row) => ({ label: row.label, cells: row.keys.map(cell) }));
    if (asJson) {
      process.stdout.write(
        jsonLine({
          dir: out ? resolve(out) : undefined,
          symbols: r.table.symbols,
          table: rows.map((x) => ({ label: x.label, cells: x.cells.map(({ id, value, unit }) => ({ id, value, unit })) })),
          datasets: registered.map((x) => ({ ...x.dataset, ids: x.ids, points: x.items })),
          notes: r.notes,
        }),
      );
      return;
    }
    const esc = (s: string) => s.replace(/\|/g, "/");
    process.stdout.write(
      [
        `| | ${r.table.symbols.join(" | ")} |`,
        `|---|${r.table.symbols.map(() => "---").join("|")}|`,
        ...rows.map((x) => `| ${x.label} | ${x.cells.map((c) => esc(c.text)).join(" | ")} |`),
        "",
        formatDatasets(registered),
        ...r.notes.map((n) => `note: ${n}`),
        ...(out ? [] : ["note: no --out, so nothing was registered as evidence — pass --out <dir> to cite these figures"]),
        "",
      ].join("\n"),
    );
    return;
  }
  if (sub === "overlap") {
    const syms = symbolsOf(args);
    if (syms.length !== 2) throw new UsageError(`etf overlap takes exactly two ETFs\n${USAGE}`);
    emitDatasets(args, await etfOverlapReport(syms[0]!, syms[1]!), asJson);
    return;
  }
  if (sub === "find") {
    const query = args.positional.slice(1).join(" ").trim();
    const browse = {
      asset: argOneOf(args, "asset", ETF_ASSETS),
      focus: argValue(args, "focus"),
      exposure: argValue(args, "exposure"),
      sort: argOneOf(args, "sort", ETF_SORTS),
      leveraged: argBool(args, "leveraged"),
    };
    if (query && (browse.asset || browse.focus || browse.exposure || browse.sort || browse.leveraged))
      throw new UsageError(`--asset, --focus, --exposure, --sort and --leveraged browse the catalogue: drop the query "${query}", or drop them\n${USAGE}`);
    let r: Awaited<ReturnType<typeof etfFind>>;
    try {
      r = await etfFind(query, {
        pea: argBool(args, "pea"),
        distribution: distributionOf(args),
        ucits: argBool(args, "ucits"),
        currency: currencyOf(args),
        limit: argInt(args, "limit", { min: 1, max: 50 }) ?? 10,
        ...(query ? {} : browse),
      });
    } catch (e) {
      if (/^--exposure takes/.test((e as Error).message)) throw new UsageError((e as Error).message);
      throw e;
    }
    emitDatasets(args, r.datasets, asJson);
    return;
  }
  if (sub === "propose") {
    if (args.positional.length > 1) throw new UsageError(`etf propose takes flags only\n${USAGE}`);
    const riskRaw = argValue(args, "risk");
    const risk = riskRaw === undefined ? undefined : Number(riskRaw);
    if (risk !== undefined && !(Number.isInteger(risk) && risk >= 1 && risk <= 7))
      throw new UsageError(`--risk takes a whole score from 1 to 7, not "${riskRaw}"`);
    const amountRaw = argValue(args, "amount");
    const amount = amountRaw === undefined ? undefined : Number(amountRaw.replace(/[_\s]/g, ""));
    if (amount !== undefined && !(Number.isFinite(amount) && amount > 0)) throw new UsageError(`--amount takes a positive amount (10000), not "${amountRaw}"`);
    const goal = argOneOf(args, "goal", ETF_GOALS) ?? "core";
    const envelope = argOneOf(args, "envelope", ETF_ENVELOPES) ?? "cto";
    const dir = runDirFor(argValue(args, "out"), `etf-propose-${goal}-${envelope}-${runId()}`);
    let r: Awaited<ReturnType<typeof etfPropose>>;
    try {
      r = await etfPropose(dir, {
        goal,
        envelope,
        risk,
        amount,
        maxFunds: argInt(args, "max-funds", { min: 1, max: 8 }) ?? 4,
        distribution: distributionOf(args),
        currency: currencyOf(args),
        hedged: argBool(args, "hedged"),
        now: clockNow(),
      });
    } catch (e) {
      if (e instanceof EtfProposeError) throw new UsageError(e.message);
      throw e;
    }
    if (asJson) process.stdout.write(jsonLine(r));
    else process.stdout.write(`${readFileSync(join(dir, "PROPOSAL.md"), "utf8")}\nrun: ${dir}\n`);
    return;
  }
  throw new UsageError(USAGE);
}
