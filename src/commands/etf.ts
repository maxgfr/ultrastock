// `etf compare|overlap|find`: ETFs side by side, the overlap of two funds'
// holdings, and a search by index or theme — every figure an [E#] with --out.
import { resolve } from "node:path";
import { etfCompare, etfFind, etfOverlapReport } from "../analyze/etf.js";
import { formatDatasets, registerDatasets } from "../core/datasets.js";
import { formatNumber } from "../core/evidence.js";
import { argBool, argInt, argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";
import { emitDatasets } from "./emit.js";

const USAGE = `usage:
  ultrastock etf compare <A,B,C> [--out <dir>] [--json]       fund facts side by side, correlation, overlap (2 to 6 ETFs)
  ultrastock etf overlap <A,B> [--out <dir>] [--json]         Σ of the smaller weights, and the common lines
  ultrastock etf find "<index|theme>" [--pea] [--acc|--dist] [--ucits] [--currency EUR] [--limit 10] [--out <dir>] [--json]`;

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
    if (!query) throw new UsageError(USAGE);
    if (argBool(args, "acc") && argBool(args, "dist")) throw new UsageError("--acc and --dist are opposites: pick one");
    const currency = argValue(args, "currency");
    if (currency && !/^[A-Za-z]{3}$/.test(currency)) throw new UsageError(`--currency takes a currency code like EUR, not "${currency}"`);
    const r = await etfFind(query, {
      pea: argBool(args, "pea"),
      distribution: argBool(args, "acc") ? "acc" : argBool(args, "dist") ? "dist" : undefined,
      ucits: argBool(args, "ucits"),
      currency,
      limit: argInt(args, "limit", { min: 1, max: 50 }) ?? 10,
    });
    emitDatasets(args, r.datasets, asJson);
    return;
  }
  throw new UsageError(USAGE);
}
