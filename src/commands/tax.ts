// tax report | lots | harvest | rules template|set|show | verify | export — the
// ledger through the tax engine of the profile's tax residence (FR, US) or the
// neutral facts report (any country, or --neutral), for a tax year.
//
// ultrastock contains no tax law: every rate, threshold and period comes from
// the rules the agent researched and stored (`tax rules set`); without them for
// the exact year the engines refuse and say what to research.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Dataset, Point } from "../core/datasets.js";
import { clockNow } from "../core/net.js";
import { loadProfile } from "../core/profile.js";
import { argBool, argList, argValue, type CommandArgs, UsageError } from "../engine.js";
import { buildBook, readLedger, type Transaction } from "../portfolio/ledger.js";
import { ENGINE_FORMATS, EXPORT_FORMATS, type ExportFormat, export2074, export2086, export8949, exportKoinly, exportNeutral } from "../tax/export.js";
import { isEngineCountry, regimeFor } from "../tax/index.js";
import { cryptoValuer, currentPrices, historicalFx, withCryptoQuotes } from "../tax/inputs.js";
import { type NeutralReport, neutralReport } from "../tax/neutral.js";
import { cryptoTradeKind, day, type Fx, isCryptoTx, isFiat, splitPair, type TaxInput, type TaxRegime, type TaxSummary, yearOf } from "../tax/regime.js";
import { countryCode, loadRules, type RuleSet, researchChecklist, rulesTemplate, saveRules, specFor, templateCommand } from "../tax/rules.js";
import { emitDatasets, printResult as print } from "./emit.js";

const USAGE =
  "usage: ultrastock tax report|lots|harvest|verify|export|rules template|set|show [--country CC] [--regime fr|us] [--year YYYY] [--neutral] [--file <rules.json>] [--currency <code>] [--book real|paper] [--tmi <rate>] [--marginal-rate <rate>] [--filing single|joint|separate|head] [--income <n>] [--carryforward 2024=1200,… | short=…,long=…] [--envelope-value <account>:<YYYY-MM-DD>=<value>,…] [--lot-method fifo|hifo|lifo] [--household single|couple] [--format 8949|2086|2074|koinly|neutral|neutral-json] [--out <dir>] [--json]";

const DISCLAIMER =
  "ultrastock contains no tax law: every rule here is the agent's research (sources and dates beside each) — a preparation aid, not tax advice; have a professional confirm";

const rate = (raw?: string) => {
  if (raw === undefined) return undefined;
  const v = Number(raw.replace("%", ""));
  if (!Number.isFinite(v) || v < 0 || v > 100) throw new UsageError(`a rate is a number like 30 or 0.30, not "${raw}"`);
  return v > 1 ? v / 100 : v;
};

/** The country of tax residence: --country, --regime (fr|us, kept for the engines), else the profile's. */
function countryOf(args: CommandArgs): string {
  const c = argValue(args, "country") ?? argValue(args, "regime");
  if (c) return countryCode(c);
  const res = loadProfile()?.taxResidence;
  if (res) return countryCode(res);
  throw new UsageError(
    "no tax residence in the profile: pass --country CC (an ISO 3166 code such as FR, US, DE), or run `ultrastock profile init --jurisdiction <CC>`",
  );
}

/** An amount flag: digits and an optional decimal point. "85,000" is refused, not read as NaN (or as 85). */
function amountFlag(args: CommandArgs, flag: string): number | undefined {
  const raw = argValue(args, flag);
  if (raw === undefined) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(raw.trim())) throw new UsageError(`--${flag} is an amount ≥ 0 written like 85000 or 85000.50, not "${raw}"`);
  return Number(raw.trim());
}

/** The ledger of `--book` (default real). A book named on purpose must hold something: a misspelt name is not an empty year. */
function bookTransactions(args: CommandArgs): Transaction[] {
  const named = argValue(args, "book");
  const book = named ?? "real";
  if (!/^[a-z0-9-]{1,40}$/.test(book)) throw new UsageError(`--book is a book name (lowercase letters, digits and dashes), not "${book}"`);
  const txs = readLedger(book);
  if (named !== undefined && !txs.length) throw new UsageError(`no transaction in the "${book}" book: check its name (real, paper, or one you recorded into)`);
  return txs;
}

/** ECB rates into `currency` for every currency of the ledger over its history; crypto quotes (ETHBTC) at their daily close when asked. */
async function ledgerFx(txs: readonly Transaction[], currency: string, year: number, opts: { asOf?: string; cryptoQuotes: boolean }) {
  const notes: string[] = [];
  const today = day(clockNow().toISOString());
  // biome-ignore lint/complexity/useMathMinMax: ISO date strings, not numbers
  const end = opts.asOf ?? (`${year}-12-31` < today ? `${year}-12-31` : today);
  // A ledger that starts after the tax year still needs a valid (non-inverted) range.
  const first = txs.map((t) => day(t.date)).sort()[0] ?? end;
  // biome-ignore lint/complexity/useMathMinMax: ISO date strings, not numbers
  const from = first < end ? first : end;
  const currencies = [...new Set(txs.map((t) => t.currency)), "USD"].filter((c) => c !== currency);
  // The fiat base of a pair such as GBPUSDT (the pounds paid or received) is converted too: its rate is asked.
  const fiatBases = txs.map((t) => splitPair(t.symbol ?? t.currency, t.currency).base).filter((c) => isFiat(c) && c !== currency);
  const ecb = await historicalFx(currency, [...new Set([...currencies, ...fiatBases])], from, end);
  notes.push(...ecb.notes);
  let fx: Fx = ecb.fx;
  if (opts.cryptoQuotes) {
    const quoted = await withCryptoQuotes(fx, currencies, from, end);
    fx = quoted.fx;
    notes.push(...quoted.notes);
  }
  return { fx, notes };
}

/** Everything the regime needs, network included (FX, crypto values). */
async function buildInput(args: CommandArgs, regime: TaxRegime, year: number, opts: { asOf?: string } = {}): Promise<{ input: TaxInput; notes: string[] }> {
  // The flags are read before anything is fetched: a usage error costs no request.
  const income = amountFlag(args, "income");
  const hh = argValue(args, "household");
  if (hh !== undefined && hh !== "single" && hh !== "couple") throw new UsageError(`--household is single or couple, not "${hh}"`);
  const txs = bookTransactions(args);
  const envelopes = loadProfile()?.envelopes ?? [];
  // The US taxes a trade quoted in a crypto-asset (ETHBTC) at its dollar value; France defers it and needs no rate.
  const { fx, notes } = await ledgerFx(txs, regime.currency, year, { asOf: opts.asOf, cryptoQuotes: regime.id === "us" });
  const input: TaxInput = { year, transactions: txs, envelopes, fx };
  const tmi = rate(argValue(args, "tmi") ?? argValue(args, "marginal-rate"));
  if (tmi !== undefined) input.marginalRate = tmi;
  const filing = argValue(args, "filing");
  if (filing) {
    if (!["single", "joint", "separate", "head"].includes(filing)) throw new UsageError("--filing is single, joint, separate or head");
    input.filingStatus = filing as TaxInput["filingStatus"];
  }
  if (income !== undefined) input.ordinaryIncome = income;
  const lm = argValue(args, "lot-method");
  if (lm) {
    if (!["fifo", "hifo", "lifo"].includes(lm)) throw new UsageError("--lot-method is fifo, hifo or lifo");
    input.lotMethod = lm as TaxInput["lotMethod"];
  }
  if (hh) input.household = hh;
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
    const isCrypto = (t: Transaction) => isCryptoTx(t, envelopes);
    // The disposals the formula needs a portfolio value for: crypto given for fiat (a sale of BTCEUR, a purchase of
    // EURUSDT), a convert's leg priced in fiat excepted — those of earlier years too: each one took its share of the
    // acquisition price out of the pool (art. 150 VH bis III, form 2086 lines 221 and 223), and the replay recomputes it.
    const dates = txs.filter((t) => isCrypto(t) && cryptoTradeKind(t) === "disposal" && yearOf(t.date) <= year).map((t) => day(t.date));
    if (opts.asOf && txs.some(isCrypto)) dates.push(opts.asOf);
    if (dates.length) {
      const v = await cryptoValuer(txs, envelopes, dates, fx);
      input.cryptoValue = v.value;
      notes.push(...v.notes);
    }
  }
  return { input, notes };
}

const formatValue = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

/** The researched rules as citable points, each with its first source and its verification date. */
function rulesDataset(rules: RuleSet, fetchedAt: string): Dataset {
  const specs = new Map(specFor(rules.country).map((s) => [s.key, s]));
  const params: Point[] = Object.entries(rules.facts).map(([k, p]) => {
    const t = specs.get(k)?.type;
    return {
      key: `TAXRULE.${rules.country}.${rules.year}.${k}`,
      label: `${p.label} (researched, verified ${p.verifiedAt}, ${p.confidence} confidence)`,
      value: typeof p.value === "object" && p.value !== null ? JSON.stringify(p.value) : (p.value as string | number),
      unit: t === "rate" ? "ratio" : t === "amount" ? rules.currency : undefined,
      url: p.sources[0],
    };
  });
  return {
    kind: "tax-rules",
    title: `${rules.country} tax rules for ${rules.year} — researched by the agent on ${rules.researchedAt}, each with its sources (\`tax verify\` lists what to re-check)`,
    subject: `TAXRULE.${rules.country}`,
    points: params,
    provenance: { source: "researched-tax-rules", fetchedAt, asOf: rules.researchedAt, official: false },
    notes: [DISCLAIMER],
  };
}

function summaryDatasets(s: TaxSummary, regime: TaxRegime, notes: string[]): Dataset[] {
  const fetchedAt = clockNow().toISOString();
  const prov = { source: "ultrastock-tax", fetchedAt, asOf: `${s.year}-12-31`, official: false };
  const P = `TAX.${s.regime.toUpperCase()}.${s.year}`;
  const points: Point[] = [
    ...s.figures.map((f) => ({
      key: f.key,
      label: f.label,
      value: f.value,
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
  return [
    {
      kind: "tax",
      title: `${s.regime.toUpperCase()} tax ${s.year} — from the ledger (${regime.costBasisMethod()})`,
      subject: `TAX.${s.regime.toUpperCase()}`,
      points,
      provenance: prov,
      notes: [...s.warnings, ...notes, `${DISCLAIMER}; the broker's IFU / 1099 and the official notices decide`],
    },
    rulesDataset(regime.rules, fetchedAt),
  ];
}

function neutralDatasets(r: NeutralReport, notes: string[]): Dataset[] {
  const fetchedAt = clockNow().toISOString();
  const P = `TAXFACT.${r.country}.${r.year}`;
  const t = r.totals;
  const pt = (key: string, label: string, value: number, unit: string | undefined = r.currency): Point => ({ key: `${P}.${key}`, label, value, unit });
  const points: Point[] = [
    pt("disposals", "disposals in the year", t.disposals, undefined),
    pt("exchanges", "of which crypto-to-crypto exchanges", t.exchanges, undefined),
    pt("proceeds", "disposal proceeds, net of fees", t.proceeds),
    pt("cost.fifo", "cost of the disposals under FIFO", t.costFifo),
    pt("cost.average", "cost of the disposals under the weighted average", t.costAverage),
    pt("gain.fifo", "proceeds minus FIFO cost (no tax rule applied)", t.gainFifo),
    pt("gain.average", "proceeds minus average cost (no tax rule applied)", t.gainAverage),
    pt("fees.trades", "fees paid on trades", t.tradeFees),
    pt("income.dividends", "dividends received (gross)", t.dividends),
    pt("income.interest", "interest received (gross)", t.interest),
    pt("income.rewards", "staking and other rewards with a known value", t.rewards),
    pt("withheld", "tax withheld (net of refunds)", t.withheld),
    pt("fees.account", "account fees (net of refunds)", t.accountFees),
  ];
  const out: Dataset[] = [
    {
      kind: "tax-facts",
      title: `${r.country} ${r.year} — facts from the ledger in ${r.currency} at each date's rate (no tax computed; cost method ${r.costMethod.chosen ?? "not chosen"})`,
      subject: `TAXFACT.${r.country}`,
      points,
      provenance: { source: "ultrastock-tax-facts", fetchedAt, asOf: `${r.year}-12-31`, official: false },
      notes: [...r.warnings, ...notes, `${DISCLAIMER}; the agent applies the researched rules to these facts`],
    },
  ];
  if (r.rules) out.push(rulesDataset(r.rules, fetchedAt));
  return out;
}

function neutralText(r: NeutralReport, path: string): string {
  const c = r.currency;
  const held = (d: NeutralReport["disposals"][number]) =>
    d.heldDaysMin === undefined ? "?" : d.heldDaysMin === d.heldDaysMax ? `${d.heldDaysMin} d` : `${d.heldDaysMin}–${d.heldDaysMax} d`;
  const mark = (m: "fifo" | "average") => (r.costMethod.chosen === m ? "*" : "");
  return [
    `# ${r.country} ${r.year} — facts from the ledger, in ${c} at each date's rate`,
    `${DISCLAIMER}. No tax is computed here: apply the researched rules below to these facts.`,
    `cost method researched: ${r.costMethod.researched ? `"${r.costMethod.researched}"` : "not researched"} → ${r.costMethod.chosen ? `${r.costMethod.chosen} (marked *)` : "both shown, none chosen"}`,
    "",
    `disposals (${r.disposals.length}):`,
    ...r.disposals.map(
      (d) =>
        `  ${d.date}  ${d.asset.padEnd(12)} ${String(d.quantity).padStart(12)}  proceeds ${d.proceeds}  cost FIFO${mark("fifo")} ${d.costFifo} / average${mark("average")} ${d.costAverage}  gain FIFO ${d.gainFifo} / average ${d.gainAverage}  fees ${d.fees}  held ${held(d)} (acquired ${d.lots.map((l) => l.acquired).join(", ") || "?"})  → ${d.received}${d.exchange ? " [exchange]" : ""}  ${d.account}${d.notes.length ? `\n      ${d.notes.join("; ")}` : ""}`,
    ),
    "",
    `income (${r.income.length}):`,
    ...r.income.map(
      (i) =>
        `  ${i.date}  ${i.kind.padEnd(9)} ${(i.symbol ?? "").padEnd(12)} ${i.amount ?? "value unknown"} ${c}  withheld ${i.withheld}  ${i.account}${i.notes.length ? `  (${i.notes.join("; ")})` : ""}`,
    ),
    "",
    `withholding and fees (${r.charges.length}):`,
    ...r.charges.map((x) => `  ${x.date}  ${x.kind.padEnd(12)} ${(x.symbol ?? "").padEnd(12)} ${x.amount} ${c}  ${x.account}`),
    "",
    `totals: proceeds ${r.totals.proceeds}, cost FIFO ${r.totals.costFifo} / average ${r.totals.costAverage}, gain FIFO ${r.totals.gainFifo} / average ${r.totals.gainAverage}, trade fees ${r.totals.tradeFees}; dividends ${r.totals.dividends}, interest ${r.totals.interest}, rewards ${r.totals.rewards}, withheld ${r.totals.withheld}, account fees ${r.totals.accountFees} (${c})`,
    "",
    `researched rules (${path}):`,
    ...Object.entries(r.rules?.facts ?? {}).map(
      ([k, p]) =>
        `  - ${k} = ${formatValue(p.value)} — ${p.label} (verified ${p.verifiedAt}, ${p.confidence}; ${p.sources.join(" · ")})${p.note ? ` — ${p.note}` : ""}`,
    ),
    ...(r.warnings.length ? ["", "warnings:", ...r.warnings.map((w) => `  - ${w}`)] : []),
    "",
    "",
  ].join("\n");
}

async function neutral(args: CommandArgs, country: string, year: number): Promise<{ report: NeutralReport; notes: string[]; path: string }> {
  // The researched rules first: no fetch for a report the agent has not researched.
  const { rules, path, missing, stale } = loadRules(country, year);
  const txs = bookTransactions(args);
  const envelopes = loadProfile()?.envelopes ?? [];
  const { fx, notes } = await ledgerFx(txs, rules.currency, year, { cryptoQuotes: true });
  const report = neutralReport({ year, transactions: txs, envelopes, fx, currency: rules.currency, rules });
  if (missing.length) report.warnings.push(`not researched yet (${path}): ${missing.join(", ")} — \`${templateCommand(country, year)}\` lists them`);
  for (const s of stale) report.warnings.push(`${s.key} is stale (${s.reason}): re-research it`);
  return { report, notes, path };
}

async function rulesCommand(args: CommandArgs, asJson: boolean, sub: string | undefined, country: () => string, year: () => number): Promise<void> {
  if (sub === "template") {
    const c = country();
    const y = year();
    const currency = argValue(args, "currency");
    const t = rulesTemplate(c, y);
    if (currency && t.currency === null) t.currency = currency.toUpperCase();
    return void process.stdout.write(`${JSON.stringify(t, null, asJson ? undefined : 2)}\n`);
  }
  if (sub === "set") {
    const f = argValue(args, "file");
    if (!f) throw new UsageError("tax rules set needs --file <rules.json> (fill the skeleton of `tax rules template`)");
    const path = resolve(f);
    if (!existsSync(path)) throw new UsageError(`no such file: ${path}`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new UsageError(`${path} is not valid JSON: ${(e as Error).message}`);
    }
    // --country / --year, when given, pin what the file must be for.
    const pinC = argValue(args, "country") ?? argValue(args, "regime");
    const pinY = argValue(args, "year");
    const v = saveRules(raw, { country: pinC ? countryCode(pinC) : undefined, year: pinY ? year() : undefined });
    const engine = isEngineCountry(v.rules.country);
    const lines = [
      `stored ${v.path} — ${Object.keys(v.rules.facts).length} researched fact(s) for ${v.rules.country} ${v.rules.year}`,
      ...(v.missing.length
        ? [
            engine
              ? `the ${v.rules.country} engine refuses until these are researched: ${v.missing.join(", ")}`
              : `template keys not researched yet (the report lists them): ${v.missing.join(", ")}`,
          ]
        : []),
      ...v.stale.map((s) => `stale: ${s.key} (${s.reason})`),
      DISCLAIMER,
    ];
    return print(
      asJson,
      { path: v.path, country: v.rules.country, year: v.rules.year, facts: Object.keys(v.rules.facts).length, missing: v.missing, stale: v.stale },
      lines.join("\n"),
    );
  }
  if (sub === undefined || sub === "show") {
    const c = country();
    const y = year();
    const { rules, missing, stale, path } = loadRules(c, y);
    let engine: { method: string; envelopes: ReturnType<TaxRegime["envelopeRules"]>; withholding: string[] } | undefined;
    if (isEngineCountry(c) && !missing.length) {
      const regime = regimeFor(c, y);
      engine = { method: regime.costBasisMethod(), envelopes: regime.envelopeRules(), withholding: regime.withholdingRules() };
    }
    if (asJson) return print(true, { path, rules, missing, stale, engine, disclaimer: DISCLAIMER }, "");
    print(
      false,
      rules,
      [
        `# ${c} tax rules ${y} — researched ${rules.researchedAt} (${path})`,
        DISCLAIMER,
        "",
        ...Object.entries(rules.facts).map(
          ([k, p]) =>
            `- ${k} = ${formatValue(p.value)} — ${p.label} (verified ${p.verifiedAt}, ${p.confidence}; ${p.sources.join(" · ")})${p.note ? ` — ${p.note}` : ""}`,
        ),
        ...stale.map((s) => `stale (not used): ${s.key} — ${s.reason}`),
        ...(missing.length ? ["", `not researched: ${missing.join(", ")} — \`${templateCommand(c, y)}\``] : []),
        ...(engine
          ? [
              "",
              `cost basis: ${engine.method}`,
              ...engine.envelopes.map((e) => `- ${e.envelope}: ${e.rule}`),
              "",
              "withholding:",
              ...engine.withholding.map((w) => `- ${w}`),
            ]
          : []),
        "",
      ].join("\n"),
    );
    return emitDatasets(args, [rulesDataset(rules, clockNow().toISOString())], false);
  }
  throw new UsageError(`tax rules is template, set or show — ${USAGE}`);
}

export async function taxCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "report", sub2] = args.positional;
  const now = clockNow();
  const defaultYear = sub === "harvest" ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const year = () => {
    const y = Number(argValue(args, "year") ?? defaultYear);
    if (!Number.isInteger(y) || y < 2000 || y > now.getUTCFullYear()) throw new UsageError(`--year ${argValue(args, "year")} is not a tax year`);
    return y;
  };
  if (sub === "rules") return rulesCommand(args, asJson, sub2, () => countryOf(args), year);
  const y = year();
  const country = countryOf(args);

  if (sub === "verify") {
    const c = researchChecklist(country, y);
    return print(
      asJson,
      { country, year: y, ...c },
      [
        `# Research checklist — ${country} tax rules for ${y} (${c.path}: ${c.stored ? "stored" : "not stored yet"})`,
        `${DISCLAIMER}. For each key: search it on the preferred official source, read the text for ${y}, fill value / sources / verifiedAt / confidence (\`${templateCommand(country, y)}\` gives the skeleton), then \`ultrastock tax rules set --file <file.json>\`.`,
        ...c.items.map(
          (i) =>
            `- ${i.key} [${i.status}] ${i.label} (${i.type}${i.unit ? `, ${i.unit}` : ""})\n    search: "${i.query}"\n    prefer: ${i.prefer}${i.status !== "missing" ? `\n    stored: ${formatValue(i.value)} (verified ${i.verifiedAt}, ${i.confidence}) ${i.sources?.join(" · ") ?? ""}${i.note ? `\n    note: ${i.note}` : ""}` : ""}`,
        ),
        ...(c.formLines.length
          ? ["", `form lines the engine writes — check their numbering on the ${y} forms:`, ...c.formLines.map((f) => `- ${f.form} ${f.lines}: ${f.usedFor}`)]
          : []),
      ].join("\n"),
    );
  }

  const wantsNeutral = argBool(args, "neutral") || !isEngineCountry(country);
  if (sub === "report" && wantsNeutral) {
    const { report, notes, path } = await neutral(args, country, y);
    if (asJson) return print(true, { ...report, notes, rulesFile: path, disclaimer: DISCLAIMER }, "");
    process.stdout.write(neutralText(report, path));
    return emitDatasets(args, neutralDatasets(report, notes), false);
  }
  if (sub === "export") {
    const engineFormat = !isEngineCountry(country) || argBool(args, "neutral") ? "neutral" : country === "US" ? "8949" : "2074";
    const format = (argValue(args, "format") ?? engineFormat) as ExportFormat;
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new UsageError(`--format is one of ${EXPORT_FORMATS.join(", ")}`);
    if ((ENGINE_FORMATS as readonly string[]).includes(format) && !isEngineCountry(country))
      throw new UsageError(
        `--format ${format} is a form of an engine (${ENGINE_FORMATS.join(", ")}: FR or US); for ${country} use --format neutral or neutral-json`,
      );
    let body: string;
    let ext = "csv";
    if (format === "neutral" || format === "neutral-json") {
      const { report } = await neutral(args, country, y);
      body = format === "neutral" ? exportNeutral(report) : `${JSON.stringify(report, null, 2)}\n`;
      if (format === "neutral-json") ext = "json";
    } else {
      const regime = regimeFor(country, y);
      const { input } = await buildInput(args, regime, y);
      const events = format === "koinly" ? [] : regime.realize(input);
      body =
        format === "8949"
          ? export8949(events)
          : format === "2086"
            ? export2086(events)
            : format === "2074"
              ? export2074(events)
              : exportKoinly(
                  input.transactions.filter((t) => yearOf(t.date) === y),
                  (t) => isCryptoTx(t, input.envelopes),
                );
    }
    const out = argValue(args, "out");
    if (!out) return void process.stdout.write(body);
    mkdirSync(resolve(out), { recursive: true });
    const file = join(resolve(out), `tax-${country.toLowerCase()}-${y}-${format}.${ext}`);
    writeFileSync(file, body, { mode: 0o600 });
    return print(asJson, { file, rows: ext === "csv" ? body.split("\r\n").length - 2 : undefined }, `written ${file}`);
  }
  if (!isEngineCountry(country)) {
    if (sub === "lots" || sub === "harvest")
      throw new UsageError(
        `tax ${sub} needs a tax engine (FR, US): for ${country}, \`tax report\` lists the disposals and lots as facts beside the researched rules`,
      );
    throw new UsageError(USAGE);
  }
  // The engine refuses here, before any request, when the researched rules are missing or incomplete.
  const regime = regimeFor(country, y);
  if (sub === "report" || sub === "lots") {
    const { input, notes } = await buildInput(args, regime, y);
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
          .join("\n") || `nothing realised in ${y}`,
      );
    }
    if (!asJson) {
      process.stdout.write(
        [
          `# ${regime.id.toUpperCase()} tax ${y} — ${s.events.length} event(s), with the rules researched on ${regime.rules.researchedAt}`,
          `${DISCLAIMER}.`,
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
    const { input, notes } = await buildInput(args, regime, y, { asOf });
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
  throw new UsageError(USAGE);
}
