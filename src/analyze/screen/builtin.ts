// `screen --engine builtin`: technical screens computed by ultrastock on daily
// bars, for an index's current members (Wikipedia, src/providers/macro/universe.ts)
// or a comma list. At most 120 symbols per run, fetched 4 at a time through
// the router (each provider keeps its own pacing); a symbol that fails is
// named in the notes, never dropped silently.
//
// The benchmark: SPY for US universes, the CAC 40 index (Euronext, ISIN
// FR0003500008) for French ones, CW8.PA (Amundi MSCI World) otherwise.
//
// Points: `<SYMBOL>.screen.<preset>.pass` (true / false / "not evaluable"),
// `.reason` (the checks in words, computed here — not external text) and the
// figures judged, each with its formula. One dataset per price source, since
// a dataset carries one provenance; matches first.
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow } from "../../core/net.js";
import { mapLimit } from "../../engine.js";
import { searchEuronext } from "../../providers/euronext.js";
import { type Constituent, fetchConstituents, indexId } from "../../providers/macro/universe.js";
import { classifySymbol, getHistory, resolveSymbol } from "../../providers/router.js";
import { type Bar, type PriceSeries, ProviderError } from "../../providers/types.js";
import { applyUniverseRanks, type TechnicalId, technicalVerdict, type Verdict } from "./technical.js";

export const BUILTIN_MAX_SYMBOLS = 120;
const CONCURRENCY = 4;
/** Calendar days of history: ~290 sessions, enough for a 252-session year plus the 21-session SMA200 slope. */
const HISTORY_DAYS = 420;

export interface Benchmark {
  symbol: string;
  name: string;
}

const US_INDICES = new Set(["SPX", "NDX", "DJI"]);
const FR_INDICES = new Set(["CAC40", "SBF120"]);

/** The benchmark for a universe: SPY for US, the CAC 40 for French, CW8.PA otherwise. */
export function benchmarkFor(universe: string | undefined, symbols: readonly string[]): Benchmark {
  const id = universe ? indexId(universe) : undefined;
  const all = (pred: (s: string) => boolean) => symbols.length > 0 && symbols.every(pred);
  if ((id && US_INDICES.has(id)) || (!id && all((s) => classifySymbol(s) === "us"))) return { symbol: "SPY", name: "SPY (S&P 500 ETF)" };
  if ((id && FR_INDICES.has(id)) || (!id && all((s) => /\.PA$/i.test(s)))) return { symbol: "FR0003500008", name: "the CAC 40" };
  return { symbol: "CW8.PA", name: "CW8.PA (MSCI World)" };
}

/** A constituent's quotable symbol: UKX EPIC codes get ".L" (BT.A → BT-A.L); other tables already carry Yahoo-style or US tickers. */
export function constituentSymbol(index: string, c: Constituent): string | undefined {
  if (!c.ticker) return undefined;
  const t = c.ticker.toUpperCase();
  return index === "UKX" ? `${t.replace(/\.$/, "").replace(/\./g, "-")}.L` : t;
}

/** Bars of the sessions before `today`: today's may still be trading. */
export function closedBars(bars: readonly Bar[], today: string): Bar[] {
  return bars.filter((b) => b.date.slice(0, 10) < today);
}

export interface BuiltinOptions {
  universe?: string;
  symbols?: string[];
  limit?: number;
  now?: Date;
}

interface Universe {
  symbols: string[];
  notes: string[];
}

async function universeSymbols(opts: BuiltinOptions): Promise<Universe> {
  const notes: string[] = [];
  if (opts.symbols?.length) return { symbols: [...new Set(opts.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))], notes };
  const id = indexId(opts.universe ?? "");
  if (!id) throw new ProviderError("wikipedia", `unknown universe "${opts.universe}" — SPX, NDX, CAC40, SBF120, DAX, SX5E, AEX, UKX or a comma list`, 400);
  const list = await fetchConstituents(id);
  notes.push(...list.notes);
  let symbols: string[];
  if (id === "SBF120") {
    // Names only on fr.wikipedia: each is looked up on Euronext (Paris listing) and quoted by its ISIN.
    const names = list.constituents.slice(0, BUILTIN_MAX_SYMBOLS).map((c) => c.name);
    const found = await mapLimit(names, CONCURRENCY, async (name) => {
      const hits = await searchEuronext(name).catch(() => []);
      const l = hits.find((h) => h.kind === "equity" && h.mic === "XPAR" && h.symbol);
      // The ISIN, not the ticker: a ticker search can miss what the name search found.
      return l?.isin;
    });
    const missing = names.filter((_, i) => !found[i]);
    if (missing.length) notes.push(`${missing.length} of ${names.length} SBF 120 names not found on Euronext Paris, skipped`);
    symbols = found.filter((s): s is string => s !== undefined);
  } else {
    symbols = list.constituents.map((c) => constituentSymbol(id, c)).filter((s): s is string => s !== undefined);
    if (!symbols.length) throw new ProviderError("wikipedia", `${id} lists names only — pass the symbols as a comma list`, 400);
  }
  return { symbols: [...new Set(symbols)], notes };
}

interface Evaluated {
  symbol: string;
  series: PriceSeries;
  verdict: Verdict;
}

const provKey = (s: PriceSeries) => [s.provenance.source, s.provenance.delay ?? "", s.provenance.official, s.provenance.fallbackFrom ?? ""].join("|");

/** Run one builtin screen; one dataset per price source, matches first. */
export async function builtinScreen(id: TechnicalId, opts: BuiltinOptions): Promise<Dataset[]> {
  const now = opts.now ?? clockNow();
  const today = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - HISTORY_DAYS * 86400_000);
  const uni = await universeSymbols(opts);
  const notes = [...uni.notes];
  let symbols = uni.symbols;
  if (symbols.length > BUILTIN_MAX_SYMBOLS) {
    notes.push(`universe truncated to its first ${BUILTIN_MAX_SYMBOLS} of ${symbols.length} members (list order) — the cap keeps the fan-out polite`);
    symbols = symbols.slice(0, BUILTIN_MAX_SYMBOLS);
  }
  if (!symbols.length) throw new ProviderError("screen", "the universe is empty", 400);
  const bench = benchmarkFor(opts.universe, symbols);
  const fetchBars = async (sym: string) => {
    const series = await getHistory(await resolveSymbol(sym), { from, to: now, interval: "1d" });
    return { ...series, bars: closedBars(series.bars, today) };
  };
  let benchBars: Bar[] | undefined;
  const needsBench = id === "minervini" || id === "canslim-technical" || id === "rs-leaders";
  if (needsBench) {
    try {
      benchBars = (await fetchBars(bench.symbol)).bars;
    } catch (e) {
      notes.push(`benchmark ${bench.name} unavailable (${(e as Error).message}) — its relative-strength checks are not evaluable`);
    }
  }
  const failures: string[] = [];
  const fetched = await mapLimit(symbols, CONCURRENCY, async (sym) => {
    try {
      const series = await fetchBars(sym);
      if (!series.bars.length) throw new Error("no closed daily bars");
      return { symbol: series.instrument.symbol, series };
    } catch (e) {
      failures.push(`${sym}: ${(e as Error).message}`);
      return undefined;
    }
  });
  const ok = fetched.filter((x): x is { symbol: string; series: PriceSeries } => x !== undefined);
  if (!ok.length) throw new ProviderError("screen", `no symbol could be read — ${failures.slice(0, 5).join("; ")}`, 0);
  const verdicts = applyUniverseRanks(
    ok.map((x) => technicalVerdict(id, x.series.bars, { benchmark: benchBars, benchmarkName: bench.name, currency: x.series.instrument.currency })),
  );
  const rows: Evaluated[] = ok.map((x, i) => ({ ...x, verdict: verdicts[i]! }));
  const order = (v: Verdict) => (v.pass === true ? 0 : v.pass === false ? 1 : 2);
  rows.sort((a, b) => order(a.verdict) - order(b.verdict));
  const matches = rows.filter((r) => r.verdict.pass === true).length;
  const shown = rows.slice(0, opts.limit ?? rows.length);

  notes.push(
    `${matches} of ${rows.length} symbols pass ${id}${rows.length < symbols.length ? ` (${symbols.length - rows.length} could not be read)` : ""}`,
    `computed by ultrastock on closed daily bars up to the last session before ${today}; benchmark ${bench.name}`,
  );
  if (shown.length < rows.length) notes.push(`showing ${shown.length} of ${rows.length} (matches first) — raise --limit to see the rest`);
  for (const f of failures) notes.push(`unavailable — ${f}`);

  const groups = new Map<string, Evaluated[]>();
  for (const r of shown) groups.set(provKey(r.series), [...(groups.get(provKey(r.series)) ?? []), r]);
  const datasets: Dataset[] = [];
  for (const group of groups.values()) {
    const s0 = group[0]!.series;
    const points: Point[] = [];
    for (const r of group) {
      const v = r.verdict;
      const base = `${r.symbol}.screen.${id}`;
      const url = r.series.provenance.url;
      const at = { asOf: v.asOf, ...(url ? { url } : {}) };
      points.push(
        { key: `${base}.pass`, label: `${r.symbol} passes screen ${id}`, value: v.pass === null ? "not evaluable" : v.pass, ...at },
        { key: `${base}.reason`, label: `${r.symbol} screen ${id} checks`, value: v.reasons.join("; "), ...at },
        ...v.metrics.map((m) => ({
          key: `${base}.${m.name}`,
          label: `${r.symbol} ${m.label}`,
          value: typeof m.value === "number" ? Number(m.value.toPrecision(10)) : m.value,
          ...(m.unit ? { unit: m.unit } : {}),
          ...(m.formula ? { formula: m.formula } : {}),
          ...at,
        })),
      );
    }
    datasets.push({
      kind: "screen",
      title: `Screen ${id} — ${opts.universe ? (indexId(opts.universe) ?? opts.universe) : "symbols"} (bars from ${s0.provenance.source})`,
      subject: opts.universe ?? symbols.join(","),
      points,
      provenance: {
        ...s0.provenance,
        asOf: group
          .map((r) => r.verdict.asOf)
          .sort()
          .pop(),
      },
      notes: datasets.length === 0 ? notes : [`continued: symbols whose bars came from ${s0.provenance.source}`],
    });
  }
  return datasets;
}
