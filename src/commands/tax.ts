// tax report | lots | harvest | rules | verify | export — the ledger through
// the regime of the profile's tax residence (or --regime), for a tax year.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Dataset, Point } from "../core/datasets.js";
import { clockNow } from "../core/net.js";
import { loadProfile } from "../core/profile.js";
import { argList, argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";
import { buildBook, readLedger, type Transaction } from "../portfolio/ledger.js";
import { EXPORT_FORMATS, type ExportFormat, export2074, export2086, export8949, exportKoinly } from "../tax/export.js";
import { regimeFor } from "../tax/index.js";
import { cryptoValuer, currentPrices, historicalFx } from "../tax/inputs.js";
import { day, envelopeOf, isFiat, type TaxInput, type TaxRegime, type TaxSummary, yearOf } from "../tax/regime.js";
import { emitDatasets } from "./emit.js";

const USAGE =
  "usage: ultrastock tax report|lots|harvest|rules|verify|export [--regime fr|us] [--year YYYY] [--book real|paper] [--tmi <rate>] [--marginal-rate <rate>] [--filing single|joint|separate|head] [--income <n>] [--carryforward 2024=1200,… | short=…,long=…] [--envelope-value <account>:<YYYY-MM-DD>=<value>,…] [--lot-method fifo|hifo|lifo] [--household single|couple] [--format 8949|2086|2074|koinly] [--out <dir>] [--json]";

const rate = (raw?: string) => {
  if (raw === undefined) return undefined;
  const v = Number(raw.replace("%", ""));
  if (!Number.isFinite(v) || v < 0 || v > 100) throw new UsageError(`a rate is a number like 30 or 0.30, not "${raw}"`);
  return v > 1 ? v / 100 : v;
};

function regimeId(args: CommandArgs): string {
  const r = argValue(args, "regime");
  if (r) return r;
  const res = loadProfile()?.taxResidence;
  if (res) return res.toLowerCase();
  throw new UsageError("no tax residence in the profile: pass --regime fr|us (or run `ultrastock profile init`)");
}

/** Everything the regime needs, network included (FX, crypto values). */
async function buildInput(args: CommandArgs, regime: TaxRegime, year: number, opts: { asOf?: string } = {}): Promise<{ input: TaxInput; notes: string[] }> {
  const txs = readLedger(argValue(args, "book") ?? "real");
  const envelopes = loadProfile()?.envelopes ?? [];
  const notes: string[] = [];
  const today = day(clockNow().toISOString());
  // biome-ignore lint/complexity/useMathMinMax: ISO date strings, not numbers
  const end = opts.asOf ?? (`${year}-12-31` < today ? `${year}-12-31` : today);
  // A ledger that starts after the tax year still needs a valid (non-inverted) range.
  const first = txs.map((t) => day(t.date)).sort()[0] ?? end;
  const from = first < end ? first : end;
  const { fx, notes: fxNotes } = await historicalFx(
    regime.currency,
    [...new Set(txs.map((t) => t.currency)), "USD"].filter((c) => c !== regime.currency),
    from,
    end,
  );
  notes.push(...fxNotes);
  const input: TaxInput = { year, transactions: txs, envelopes, fx };
  const tmi = rate(argValue(args, "tmi") ?? argValue(args, "marginal-rate"));
  if (tmi !== undefined) input.marginalRate = tmi;
  const filing = argValue(args, "filing");
  if (filing) {
    if (!["single", "joint", "separate", "head"].includes(filing)) throw new UsageError("--filing is single, joint, separate or head");
    input.filingStatus = filing as TaxInput["filingStatus"];
  }
  const income = argValue(args, "income");
  if (income !== undefined) input.ordinaryIncome = Number(income);
  const lm = argValue(args, "lot-method");
  if (lm) {
    if (!["fifo", "hifo", "lifo"].includes(lm)) throw new UsageError("--lot-method is fifo, hifo or lifo");
    input.lotMethod = lm as TaxInput["lotMethod"];
  }
  const hh = argValue(args, "household");
  if (hh) input.household = hh === "couple" ? "couple" : "single";
  const cf = argList(args, "carryforward");
  if (cf.length) {
    input.carryforward = {};
    for (const kv of cf) {
      const [k, v] = kv.split("=");
      const n = Number(v);
      if (!k || !Number.isFinite(n)) throw new UsageError(`--carryforward takes year=amount (FR) or short=/long= (US), not "${kv}"`);
      if (k === "short" || k === "long") input.carryforward[k] = n;
      else if (/^\d{4}$/.test(k)) input.carryforward.byYear = { ...input.carryforward.byYear, [k]: n };
      else throw new UsageError(`--carryforward key "${k}" is a year or short/long`);
    }
  }
  const ev = argList(args, "envelope-value");
  if (ev.length) {
    input.envelopeValues = {};
    for (const kv of ev) {
      const m = /^([^:]+):(\d{4}-\d{2}-\d{2})=([\d.]+)$/.exec(kv);
      if (!m) throw new UsageError(`--envelope-value takes <account>:<YYYY-MM-DD>=<value>, not "${kv}"`);
      input.envelopeValues[`${m[1]}|${m[2]}`] = Number(m[3]);
    }
  }
  if (regime.id === "fr") {
    const isCrypto = (t: Transaction) => envelopeOf(t.account, envelopes, t.symbol).type === "CRYPTO";
    const dates = txs.filter((t) => isCrypto(t) && t.type === "sell" && isFiat(t.currency) && yearOf(t.date) === year).map((t) => day(t.date));
    if (opts.asOf && txs.some(isCrypto)) dates.push(opts.asOf);
    if (dates.length) {
      const v = await cryptoValuer(txs, envelopes, dates, fx);
      input.cryptoValue = v.value;
      notes.push(...v.notes);
    }
  }
  return { input, notes };
}

function summaryDatasets(s: TaxSummary, regime: TaxRegime, notes: string[]): Dataset[] {
  const fetchedAt = clockNow().toISOString();
  const prov = { source: "ultrastock-tax", fetchedAt, asOf: `${s.year}-12-31`, official: false };
  const P = `TAX.${s.regime.toUpperCase()}.${s.year}`;
  const points: Point[] = [
    ...s.figures.map((f) => ({
      key: f.key,
      label: f.label,
      value: typeof f.value === "number" ? f.value : f.value,
      unit: f.unit || undefined,
      formula: f.formula,
    })),
    ...s.forms.map((f) => ({
      key: `${P}.form.${f.form}.${f.box}`.replace(/\s+/g, "_"),
      label: `${f.form} ${f.box}: ${f.label}${f.note ? ` (${f.note})` : ""}`,
      value: f.value,
      unit: typeof f.value === "number" ? s.currency : undefined,
    })),
    ...s.obligations.map((o, i) => ({ key: `${P}.obligation.${i + 1}`, label: "obligation", value: o })),
  ];
  const params: Point[] = Object.entries(regime.rules.params).map(([k, p]) => ({
    key: `TAXRULE.${s.regime.toUpperCase()}.${regime.rules.year}.${k}`,
    label: `${p.label} (verified ${p.verifiedAt}, ${p.confidence} confidence)`,
    value: typeof p.value === "object" ? JSON.stringify(p.value) : p.value,
    unit: typeof p.value === "number" && p.value < 1 ? "ratio" : undefined,
    url: p.sources[0]?.split(" ")[0],
  }));
  return [
    {
      kind: "tax",
      title: `${s.regime.toUpperCase()} tax ${s.year} — from the ledger (${regime.costBasisMethod()})`,
      subject: `TAX.${s.regime.toUpperCase()}`,
      points,
      provenance: prov,
      notes: [...s.warnings, ...notes, "a preparation aid for the return, not tax advice: the broker's IFU / 1099 and the official notices decide"],
    },
    {
      kind: "tax-rules",
      title: `${s.regime.toUpperCase()} tax parameters for ${regime.rules.year} (each with its sources — \`tax verify\` re-checks them)`,
      subject: `TAXRULE.${s.regime.toUpperCase()}`,
      points: params,
      provenance: { source: "ultrastock-tax-rules", fetchedAt, asOf: regime.rules.params[Object.keys(regime.rules.params)[0]!]?.verifiedAt, official: false },
      notes: [],
    },
  ];
}

const print = (asJson: boolean, value: unknown, text: string): void => {
  process.stdout.write(asJson ? jsonLine(value) : text.endsWith("\n") ? text : `${text}\n`);
};

export async function taxCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "report"] = args.positional;
  const now = clockNow();
  const defaultYear = sub === "harvest" ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const year = Number(argValue(args, "year") ?? defaultYear);
  if (!Number.isInteger(year) || year < 2000 || year > now.getUTCFullYear()) throw new UsageError(`--year ${argValue(args, "year")} is not a tax year`);
  const regime = regimeFor(regimeId(args), year);

  if (sub === "rules") {
    const rows = {
      method: regime.costBasisMethod(),
      envelopes: regime.envelopeRules(),
      withholding: regime.withholdingRules(),
      stale: regime.stale,
      year: regime.rules.year,
    };
    if (asJson) return print(true, { ...rows, params: regime.rules.params }, "");
    print(
      false,
      rows,
      [
        `# ${regime.id.toUpperCase()} tax rules ${year}${regime.stale ? ` — ${regime.stale}` : ""}`,
        `cost basis: ${rows.method}`,
        "",
        ...rows.envelopes.map((e) => `- ${e.envelope}: ${e.rule}`),
        "",
        "withholding:",
        ...rows.withholding.map((w) => `- ${w}`),
        "",
      ].join("\n"),
    );
    return emitDatasets(
      args,
      summaryDatasets(
        { regime: regime.id, year, currency: regime.currency, rulesYear: regime.rules.year, figures: [], forms: [], obligations: [], warnings: [], events: [] },
        regime,
        [],
      ).slice(1),
      false,
    );
  }
  if (sub === "verify") {
    const list = regime.verifyChecklist();
    return print(
      asJson,
      { regime: regime.id, year, items: list },
      [
        `# Verify the ${regime.id.toUpperCase()} parameters for ${year} — search each, compare with the official text, update src/tax/rules.ts (value, sources, verifiedAt) when it changed`,
        ...list.map(
          (i) =>
            `- ${i.key} = ${typeof i.value === "object" ? JSON.stringify(i.value) : i.value} (${i.label}; verified ${i.verifiedAt || "never"}, ${i.confidence})\n    search: "${i.query}"${i.sources.length ? `\n    sources: ${i.sources.join(" · ")}` : ""}${i.note ? `\n    note: ${i.note}` : ""}`,
        ),
      ].join("\n"),
    );
  }
  if (sub === "report" || sub === "lots") {
    const { input, notes } = await buildInput(args, regime, year);
    const s = regime.annualSummary(input);
    if (sub === "lots") {
      const rows = s.events.filter((e) => e.kind !== "crypto-exchange");
      return print(
        asJson,
        rows,
        rows
          .map(
            (e) =>
              `${e.date}  ${e.kind.padEnd(20)} ${(e.symbol ?? "").padEnd(10)} ${e.account.padEnd(10)} ${e.quantity ?? ""} ${e.proceeds !== undefined ? `proceeds ${e.proceeds}` : ""} ${e.cost !== undefined ? `cost ${e.cost}` : ""} ${e.gain !== undefined ? `→ ${e.gain} ${s.currency}` : e.amount !== undefined ? `${e.amount} ${s.currency}` : ""}${e.term ? ` (${e.term})` : ""}${e.washSaleDisallowed ? ` wash ${e.washSaleDisallowed}` : ""}${e.notes.length ? `\n      ${e.notes.join("; ")}` : ""}`,
          )
          .join("\n") || `nothing realised in ${year}`,
      );
    }
    if (!asJson) {
      process.stdout.write(
        [
          `# ${regime.id.toUpperCase()} tax ${year} — ${s.events.length} event(s)`,
          ...s.forms.map((f) => `  ${f.form.padEnd(10)} ${f.box.padEnd(8)} ${String(f.value).padStart(12)}  ${f.label}`),
          ...(s.obligations.length ? ["", "obligations:", ...s.obligations.map((o) => `  - ${o}`)] : []),
          ...(s.warnings.length ? ["", "warnings:", ...s.warnings.map((w) => `  - ${w}`)] : []),
          "",
          "",
        ].join("\n"),
      );
    }
    return emitDatasets(args, summaryDatasets(s, regime, notes), asJson);
  }
  if (sub === "harvest") {
    const asOf = day(now.toISOString());
    const { input, notes } = await buildInput(args, regime, year, { asOf });
    const book = buildBook(input.transactions);
    const open = [...new Set(book.positions.filter((p) => p.quantity > 0).map((p) => p.symbol))];
    const { prices, notes: pn } = await currentPrices(open);
    const c = regime.harvestCandidates(input, prices, asOf);
    return print(
      asJson,
      { asOf, candidates: c, notes: [...notes, ...pn] },
      c.length
        ? [
            `# Tax-loss harvest candidates (${regime.id.toUpperCase()}, ${asOf})`,
            ...c.map(
              (x) =>
                `- ${x.symbol} (${x.account}): unrealized ${x.unrealized} ${regime.currency}${x.term ? ` ${x.term}-term` : ""}, saves about ${x.saving ?? "?"} this year — ${x.formula}\n    ${x.notes.join("\n    ")}`,
            ),
            ...pn.map((n) => `note: ${n}`),
            "Selling is the user's decision: a ticket goes through `plan` and the risk gate like any order.",
          ].join("\n")
        : `no open position under water (${open.length} priced)${pn.length ? `\n${pn.join("\n")}` : ""}`,
    );
  }
  if (sub === "export") {
    const format = (argValue(args, "format") ?? (regime.id === "us" ? "8949" : "2074")) as ExportFormat;
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new UsageError(`--format is one of ${EXPORT_FORMATS.join(", ")}`);
    const { input } = await buildInput(args, regime, year);
    const events = format === "koinly" ? [] : regime.realize(input);
    const csv =
      format === "8949"
        ? export8949(events)
        : format === "2086"
          ? export2086(events)
          : format === "2074"
            ? export2074(events)
            : exportKoinly(
                input.transactions.filter((t) => yearOf(t.date) === year),
                (t) => envelopeOf(t.account, input.envelopes, t.symbol).type === "CRYPTO",
              );
    const out = argValue(args, "out");
    if (!out) return void process.stdout.write(csv);
    mkdirSync(resolve(out), { recursive: true });
    const file = join(resolve(out), `tax-${regime.id}-${year}-${format}.csv`);
    writeFileSync(file, csv, { mode: 0o600 });
    return print(asJson, { file, rows: csv.split("\r\n").length - 2 }, `written ${file}`);
  }
  throw new UsageError(USAGE);
}
