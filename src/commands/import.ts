// `portfolio import <file>`: a broker statement into the ledger. The parser
// is pure; this command reads the file (UTF-8, else Latin-1 — French banks
// still export in Windows-1252), shows what is new against the book, checks the
// book still replays with it (no sell beyond holdings), and appends through the
// ledger, which skips anything already imported. --dry-run stops before the
// append: nothing is written.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argOneOf, argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";
import { IMPORT_FORMATS, type ImportFormat, parseStatement, resolveMapOption } from "../portfolio/import/index.js";
import { appendTransactions, buildBook, readLedger, type Transaction, transactionId } from "../portfolio/ledger.js";

const USAGE =
  "usage: ultrastock portfolio import <file> --format ibkr-flex|binance|kraken|coinbase|generic --account <id> [--book real|paper] [--map <json|name>] [--dry-run]";
/** Lines of transactions / skipped rows printed before "… and N more". */
const LIST_CAP = 60;

function readStatement(path: string): { text: string; warning?: string } {
  const buf = readFileSync(path);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf) };
  } catch {
    return { text: buf.toString("latin1"), warning: "the file is not UTF-8: read as Latin-1 (Windows-1252)" };
  }
}

const txLine = (t: Omit<Transaction, "id">): string => {
  const parts = [t.date, t.type.padEnd(12), t.symbol ?? ""];
  if (t.quantity !== undefined) parts.push(String(t.quantity));
  if (t.price !== undefined) parts.push(`@ ${t.price}`);
  if (t.amount !== undefined) parts.push(String(t.amount));
  parts.push(t.currency);
  if (t.fee) parts.push(`fee ${t.fee}`);
  return parts.filter(Boolean).join(" ");
};

export async function importCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  // Wired as a `portfolio` sub-action: tolerate the sub-command word in front.
  const pos = args.positional[0] === "import" ? args.positional.slice(1) : args.positional;
  const file = pos[0];
  if (!file || pos.length > 1) throw new UsageError(USAGE);
  const format = argOneOf(args, "format", IMPORT_FORMATS) as ImportFormat | undefined;
  if (!format) throw new UsageError(`--format is required — ${USAGE}`);
  const account = argValue(args, "account");
  if (!account || !/^[A-Za-z0-9][\w.-]{0,39}$/.test(account))
    throw new UsageError("--account names the envelope the statement belongs to (a profile id such as pea, cto, ibkr, kraken)");
  const book = argValue(args, "book") ?? "real";
  if (book !== "real" && book !== "paper") throw new UsageError("--book is real or paper");
  const dryRun = args.bools.has("dry-run");
  let mapRaw = argValue(args, "map");
  if (mapRaw !== undefined && !mapRaw.trim().startsWith("{") && /\.json$/i.test(mapRaw) && existsSync(resolve(mapRaw)))
    mapRaw = readFileSync(resolve(mapRaw), "utf8");
  let mapOpt: ReturnType<typeof resolveMapOption>;
  try {
    mapOpt = resolveMapOption(format, mapRaw);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (format === "generic" && !mapOpt.map)
    throw new UsageError("--format generic needs --map (a JSON column map, a .json file holding one, or boursorama|fortuneo|trade-republic)");
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);

  const { text, warning } = readStatement(path);
  const res = parseStatement(format, text, { account, quote: mapOpt.quote, map: mapOpt.map, presetName: mapOpt.presetName });
  const warnings = [...(warning ? [warning] : []), ...res.warnings];

  // What is new: not in the book, and the first of identical rows in the file.
  const existing = readLedger(book);
  const known = new Set(existing.map((t) => t.id));
  const fresh: Transaction[] = [];
  const freshIds = new Set<string>();
  let already = 0;
  let sameInFile = 0;
  for (const t of res.transactions) {
    const id = transactionId(t);
    if (known.has(id)) {
      if (freshIds.has(id)) sameInFile++;
      else already++;
      continue;
    }
    known.add(id);
    freshIds.add(id);
    fresh.push({ ...t, id });
  }
  if (sameInFile)
    warnings.push(
      `${sameInFile} row(s) identical to another in this file (same date, type, symbol, quantity, price): the ledger keeps one — separate fills need distinct times`,
    );

  // The book must still replay: a sell beyond holdings means an earlier statement is missing.
  let replay: string | undefined;
  let bookWasSound = true;
  try {
    buildBook(existing);
  } catch {
    bookWasSound = false;
  }
  try {
    buildBook([...existing, ...fresh]);
  } catch (e) {
    replay = (e as Error).message;
  }
  if (replay && !bookWasSound) warnings.push(`the ${book} book did not replay before this import either: ${replay}`);
  if (replay && bookWasSound && !dryRun)
    throw new Error(
      `not imported: the ${book} book would no longer replay — ${replay}. Import the earlier statement first, or record the opening position (portfolio add transfer-in …), then re-run (--dry-run shows what would be added)`,
    );
  if (replay && bookWasSound) warnings.push(`the ${book} book would no longer replay: ${replay}`);

  let added = fresh;
  let duplicates = already + sameInFile;
  if (!dryRun && fresh.length) {
    const r = await appendTransactions(res.transactions, book);
    added = r.added;
    duplicates = r.duplicates;
  }

  const summary = {
    file: path,
    format,
    account,
    book,
    dryRun,
    read: res.transactions.length,
    [dryRun ? "wouldAdd" : "added"]: added,
    duplicates,
    skipped: res.skipped,
    warnings,
    replay: replay ?? "ok",
  };
  if (asJson) {
    process.stdout.write(jsonLine(summary));
    return;
  }
  const lines = [
    `${format} → ${book} book, account ${account}: ${res.transactions.length} transaction(s) read, ${added.length} ${dryRun ? "would be added" : "added"}, ${duplicates} already in the ledger, ${res.skipped.length} row(s) skipped${dryRun ? " — dry run, nothing written" : ""}`,
    ...added.slice(0, LIST_CAP).map((t) => `  + ${txLine(t)}`),
    ...(added.length > LIST_CAP ? [`  … and ${added.length - LIST_CAP} more`] : []),
    ...res.skipped.slice(0, LIST_CAP).map((s) => `  skipped line ${s.line}: ${s.reason}`),
    ...(res.skipped.length > LIST_CAP ? [`  … and ${res.skipped.length - LIST_CAP} more skipped`] : []),
    ...warnings.map((w) => `  warning: ${w}`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
