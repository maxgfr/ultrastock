// Companies: statements, filings, insiders, institutional holders, analysts,
// short interest, dividends, Congress trades, and resolving a name to a listing.
import type { Dataset } from "../core/datasets.js";
import { argInt, argList, argValue, type CommandArgs, UsageError } from "../engine.js";
import { cribleScreen, SOURCE as CRIBLE } from "../providers/external/crible.js";
import { searchEuronext } from "../providers/euronext.js";
import { amfInsiderDeclarations } from "../providers/fundamentals/amf.js";
import { esefFundamentals } from "../providers/fundamentals/esef.js";
import { finraShortVolume } from "../providers/fundamentals/finra.js";
import { gleifByIsin, gleifSearch } from "../providers/fundamentals/gleif.js";
import { housePtrFilings, housePtrTransactions } from "../providers/fundamentals/house.js";
import { nasdaqAnalyst, nasdaqDividends, nasdaqShortInterest } from "../providers/fundamentals/nasdaq-analyst.js";
import { openfigiIdentifiers } from "../providers/fundamentals/openfigi.js";
import { secCompany, secFilings, secFullTextSearch, secFundamentals } from "../providers/fundamentals/sec.js";
import { sec13f } from "../providers/fundamentals/sec-13f.js";
import { secInsiders } from "../providers/fundamentals/sec-insiders.js";
import { clockNow } from "../core/net.js";
import { resolveSymbol } from "../providers/router.js";
import { ProviderError } from "../providers/types.js";
import { emitDatasets } from "./emit.js";

/** The crible fields worth registering for one company, with their units. */
const CRIBLE_FIELDS: Array<[string, string, string]> = [
  ["revenue", "revenue", "ccy"],
  ["gross_profit", "gross profit", "ccy"],
  ["operating_income", "operating income", "ccy"],
  ["net_income", "net income", "ccy"],
  ["ebitda", "EBITDA", "ccy"],
  ["operating_cashflow", "operating cash flow", "ccy"],
  ["capital_expenditure", "capital expenditure", "ccy"],
  ["free_cash_flow", "free cash flow", "ccy"],
  ["dividends_paid", "dividends paid", "ccy"],
  ["total_assets", "total assets", "ccy"],
  ["total_liabilities", "total liabilities", "ccy"],
  ["total_equity", "total equity", "ccy"],
  ["total_debt", "total debt", "ccy"],
  ["cash_and_equivalents", "cash and equivalents", "ccy"],
  ["shares_outstanding", "shares outstanding", "shares"],
  ["gross_margin", "gross margin", "ratio"],
  ["interest_coverage_ratio", "interest coverage", "x"],
  ["piotroski_f", "Piotroski F-score (crible)", "score"],
  ["altman_z", "Altman Z-score (crible)", "score"],
  ["beneish_m", "Beneish M-score (crible)", "score"],
  ["composite_rank", "composite rank 0–100 (crible)", "rank"],
  ["quality_rank", "quality rank 0–100 (crible)", "rank"],
  ["value_rank", "value rank 0–100 (crible)", "rank"],
  ["momentum_rank", "momentum rank 0–100 (crible)", "rank"],
];

/** One company's latest period from crible, as a dataset. */
export async function cribleFundamentals(symbol: string, currency: string): Promise<Dataset> {
  const r = await cribleScreen(`symbol = '${symbol.replace(/'/g, "")}'`, { limit: 1 });
  const row = r.rows[0];
  if (!row) throw new ProviderError(CRIBLE, `crible does not cover ${symbol}`, 404);
  const period = String(row.period ?? "");
  const points = CRIBLE_FIELDS.filter(([f]) => typeof row[f] === "number").map(([f, label, unit]) => ({
    key: `${symbol}.fund.${f}.${period || "latest"}`,
    label: `${symbol} ${label}${period ? ` (period ending ${period})` : ""}`,
    value: row[f] as number,
    unit: unit === "ccy" ? String(row.currency ?? currency) : unit,
    asOf: period || undefined,
  }));
  return {
    kind: "fundamentals",
    title: `${symbol} fundamentals — latest period (crible)`,
    subject: symbol,
    points,
    provenance: { source: CRIBLE, fetchedAt: clockNow().toISOString(), official: false, delay: "filing", asOf: period || undefined },
    notes: ["crible aggregates audited filings (SEC, ESEF, registers) and market data; check a figure that matters against the filing"],
  };
}

export async function fundamentalsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0];
  if (!sym) throw new UsageError("usage: ultrastock fundamentals <symbol> [--asof <date>] [--years <n>] [--quarters <n>] [--source sec|esef|crible]");
  const source = argValue(args, "source");
  const asOf = argValue(args, "asof");
  const r = await resolveSymbol(sym);
  const i = r.instrument;
  const out: Dataset[] = [];
  if (source === "crible") out.push(await cribleFundamentals(i.symbol, i.currency));
  else if (i.market === "us" && source !== "esef") {
    out.push(
      await secFundamentals(i.symbol.split("|")[0]!, {
        years: argInt(args, "years", { min: 1, max: 15 }),
        quarters: argInt(args, "quarters", { min: 0, max: 12 }),
        asOf,
      }),
    );
  } else if (i.isin && source !== "crible") {
    try {
      out.push(await esefFundamentals(i.isin, { asOf, subject: i.symbol }));
    } catch (e) {
      out.push({ ...(await cribleFundamentals(i.symbol, i.currency)), notes: [`ESEF unavailable (${(e as Error).message}) — crible stood in`] });
    }
  } else out.push(await cribleFundamentals(i.symbol, i.currency));
  emitDatasets(args, out, asJson);
}

export async function filingsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const search = argValue(args, "search");
  const forms = argList(args, "forms");
  if (search)
    return emitDatasets(
      args,
      [await secFullTextSearch(search, { forms: forms.length ? forms : undefined, days: argInt(args, "days", { min: 1, max: 3650 }) ?? 30 })],
      asJson,
    );
  const sym = args.positional[0];
  if (!sym) throw new UsageError('usage: ultrastock filings <US symbol> [--forms 8-K,10-Q] [--days <n>] | filings --search "<text>" [--forms 8-K]');
  emitDatasets(
    args,
    [
      await secFilings(sym.toUpperCase(), {
        forms: forms.length ? forms : undefined,
        days: argInt(args, "days", { min: 1, max: 3650 }),
        limit: argInt(args, "limit", { min: 1, max: 100 }) ?? 20,
      }),
    ],
    asJson,
  );
}

export async function insidersCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0];
  if (!sym) throw new UsageError("usage: ultrastock insiders <symbol> — SEC Form 4 for US listings, AMF declarations for French issuers");
  const r = await resolveSymbol(sym);
  const limit = argInt(args, "limit", { min: 1, max: 50 });
  const ds =
    r.instrument.market === "us"
      ? await secInsiders(r.instrument.symbol, { limit: limit ?? 10 })
      : await amfInsiderDeclarations(r.instrument.isin ?? r.instrument.name ?? r.instrument.symbol, { limit: limit ?? 5, subject: r.instrument.symbol });
  emitDatasets(args, [ds], asJson);
}

export async function holdingsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const manager = args.positional[0];
  if (!manager) throw new UsageError("usage: ultrastock holdings <berkshire|pershing-square|bridgewater|…|CIK> [--limit <top n>] — latest 13F and its changes");
  emitDatasets(
    args,
    [await sec13f(/^\d+$/.test(manager) ? Number(manager) : manager, { top: argInt(args, "limit", { min: 1, max: 100 }) ?? 15, tickers: true })],
    asJson,
  );
}

export async function analystCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0];
  if (!sym) throw new UsageError("usage: ultrastock analyst <US symbol> — price targets, ratings, EPS estimates and surprises (Nasdaq, unofficial)");
  emitDatasets(args, await nasdaqAnalyst(sym.toUpperCase()), asJson);
}

export async function shortCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0]?.toUpperCase();
  if (!sym) throw new UsageError("usage: ultrastock short <US symbol> — short interest (Nasdaq) and daily short volume (FINRA)");
  const got = await Promise.allSettled([nasdaqShortInterest(sym), finraShortVolume(sym)]);
  const ds = got.filter((g): g is PromiseFulfilledResult<Dataset> => g.status === "fulfilled").map((g) => g.value);
  if (!ds.length) throw new Error(`no short data for ${sym}: ${got.map((g) => (g.status === "rejected" ? (g.reason as Error).message : "")).join("; ")}`);
  emitDatasets(args, ds, asJson);
}

export async function dividendsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0]?.toUpperCase();
  if (!sym) throw new UsageError("usage: ultrastock dividends <US symbol> — dividend history, yield and ex-dates (Nasdaq)");
  emitDatasets(args, [await nasdaqDividends(sym, { limit: argInt(args, "limit", { min: 1, max: 100 }) ?? 12 })], asJson);
}

export async function congressCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const doc = argValue(args, "doc");
  const ds = doc
    ? await housePtrTransactions(doc, { year: argInt(args, "year", { min: 2008, max: 2100 }) })
    : await housePtrFilings({
        member: argValue(args, "member"),
        limit: argInt(args, "limit", { min: 1, max: 200 }) ?? 20,
        year: argInt(args, "year", { min: 2008, max: 2100 }),
      });
  emitDatasets(args, [ds], asJson);
}

/** A name, a ticker or an ISIN → the listings and identifiers that match. */
export async function resolveCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const q = args.positional.join(" ").trim();
  if (!q) throw new UsageError('usage: ultrastock resolve "<name|ticker|ISIN>"');
  const isin = /^[A-Z]{2}[A-Z0-9]{9}\d$/i.test(q);
  const out: Dataset[] = [];
  const fetchedAt = clockNow().toISOString();
  const listings = await searchEuronext(q).catch(() => []);
  if (listings.length)
    out.push({
      kind: "resolve",
      title: `Euronext listings matching "${q}"`,
      points: listings.slice(0, 12).map((l, i) => ({
        key: `RESOLVE.euronext.${i}`,
        label: `Euronext listing ${i + 1}`,
        value: `${l.symbol} | ${l.name} | ${l.isin} | ${l.mic} | ${l.kind}`,
        untrusted: true,
      })),
      provenance: { source: "euronext", fetchedAt, official: true },
      notes: ["use TICKER.PA / .AS / .BR / .LS / .MI / .OL / .IR, or the ISIN"],
    });
  if (!isin) {
    const sec = await secCompany(q).catch(() => undefined);
    if (sec)
      out.push({
        kind: "resolve",
        title: `SEC registrant for "${q}"`,
        points: [
          { key: `RESOLVE.sec.${sec.cik}`, label: "SEC registrant", value: `${sec.ticker ?? "?"} | ${sec.title ?? ""} | CIK ${sec.cik}`, untrusted: true },
        ],
        provenance: { source: "sec-edgar", fetchedAt, official: true },
        notes: [],
      });
    const lei = await gleifSearch(q, { limit: 5 }).catch(() => undefined);
    if (lei) out.push(lei);
  } else {
    for (const run of [() => gleifByIsin(q.toUpperCase()), () => openfigiIdentifiers([q.toUpperCase()])]) {
      const d = await run().catch(() => undefined);
      if (d) out.push(d);
    }
  }
  if (!out.length) throw new ProviderError("resolve", `nothing matches "${q}"`, 404);
  emitDatasets(args, out, asJson);
}
