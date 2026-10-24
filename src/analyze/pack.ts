// `analyze <symbol>`: gather the evidence for one instrument into a run
// directory — evidence.json (every figure, numbered), BRIEF.md (the figures by
// theme, as the agent reads them) and RUNBOOK.md (how to turn them into an
// answer that passes `check`).
//
// Deterministic: the same bars give the same figures in the same order, so a
// replayed fixture gives the same [E#] ids.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../engine.js";
import { atr, annualizedVol, bollinger, lastValue, lookback, macd, maxDrawdown, rsi, sma } from "../analytics/indicators.js";
import { EvidenceStore, type EvidenceItem, formatEvidence, type Provenance } from "../core/evidence.js";
import { clockNow } from "../core/net.js";
import { getHistory, getQuote, resolveSymbol } from "../providers/router.js";
import type { PriceSeries, QuoteResult } from "../providers/types.js";

export interface AnalyzeResult {
  dir: string;
  symbol: string;
  name?: string;
  asOf: string;
  evidence: number;
  notes: string[];
  trend: string;
}

const round = (x: number, d = 6) => Number(x.toFixed(d));

export async function analyzeSymbol(raw: string, dir: string, opts: { now?: Date } = {}): Promise<AnalyzeResult> {
  const now = opts.now ?? clockNow();
  const resolved = await resolveSymbol(raw);
  const { instrument } = resolved;
  // Euronext keeps two years; asking for one day less avoids a truncation note on every run.
  const from = new Date(now.getTime() - 729 * 86400_000);
  const series = await getHistory(resolved, { from, to: now, interval: "1d" });
  const quote = await getQuote(resolved, now);
  const store = EvidenceStore.open(dir, { run: dir, subject: instrument.symbol, createdAt: now.toISOString() });
  const sym = instrument.symbol;
  const ccy = instrument.currency;
  const bars = series.bars;
  const last = bars[bars.length - 1]!;
  const closes = bars.map((b) => b.close);
  const crypto = instrument.market === "crypto";
  const perYear = crypto ? 365 : 252;
  const prov = (p: Omit<Provenance, "asOf">, asOf: string): Provenance => ({ ...p, asOf });
  const hp = prov(series.provenance, last.date);
  const derived = (asOf: string): Provenance => ({ ...series.provenance, asOf });
  const add = (key: string, label: string, value: number | string | boolean, unit: string | undefined, p: Provenance, extra: Partial<EvidenceItem> = {}) =>
    store.add({ key: `${sym}.${key}`, label: `${sym} ${label}`, value: typeof value === "number" ? round(value) : value, unit, ...p, ...extra });

  // Price
  add("quote.price", "latest price", quote.price, ccy, prov(quote.provenance, quote.at));
  if (quote.changePct !== undefined) add("quote.changePct", "change vs previous close", quote.changePct, "%", prov(quote.provenance, quote.at));
  add("close", "last daily close", last.close, ccy, hp);
  if (last.volume !== undefined) add("volume", "last session volume", last.volume, crypto ? instrument.name?.split("/")[0] : "shares", hp);

  // Range and returns
  const year = bars.slice(-perYear);
  const hi = Math.max(...year.map((b) => b.high));
  const lo = Math.min(...year.map((b) => b.low));
  add("high52w", "52-week high", hi, ccy, derived(last.date), { formula: `max(high) over the last ${year.length} sessions` });
  add("low52w", "52-week low", lo, ccy, derived(last.date), { formula: `min(low) over the last ${year.length} sessions` });
  add("fromHigh52w", "distance from 52-week high", (last.close / hi - 1) * 100, "%", derived(last.date), { formula: "(close / high52w − 1) × 100" });
  const spans: Array<[string, number]> = crypto
    ? [
        ["1m", 30],
        ["3m", 90],
        ["6m", 180],
        ["1y", 365],
      ]
    : [
        ["1m", 21],
        ["3m", 63],
        ["6m", 126],
        ["1y", 252],
      ];
  for (const [label, n] of spans) {
    const base = lookback(closes, n);
    if (base !== undefined)
      add(`return${label}`, `${label} price return`, (last.close / base - 1) * 100, "%", derived(last.date), {
        formula: `(close / close[${n} bars ago] − 1) × 100`,
      });
  }

  // Trend and momentum
  const s50 = lastValue(sma(closes, 50));
  const s200 = lastValue(sma(closes, 200));
  if (s50 !== undefined) add("sma50", "50-day simple moving average", s50, ccy, derived(last.date));
  if (s200 !== undefined) {
    add("sma200", "200-day simple moving average", s200, ccy, derived(last.date));
    add("vsSma200", "close vs 200-day average", (last.close / s200 - 1) * 100, "%", derived(last.date), { formula: "(close / sma200 − 1) × 100" });
  }
  let trend = "insufficient history";
  if (s50 !== undefined && s200 !== undefined) {
    trend = last.close > s50 && s50 > s200 ? "uptrend" : last.close < s50 && s50 < s200 ? "downtrend" : "mixed";
    add("trend", "trend state (close / SMA50 / SMA200 alignment)", trend, undefined, derived(last.date), {
      formula: "uptrend if close > sma50 > sma200; downtrend if close < sma50 < sma200; else mixed",
    });
  }
  const r14 = lastValue(rsi(closes, 14));
  if (r14 !== undefined) add("rsi14", "RSI(14), Wilder", r14, undefined, derived(last.date));
  const m = lastValue(macd(closes));
  if (m) {
    add("macd", "MACD(12,26,9) line", m.macd, ccy, derived(last.date));
    add("macdSignal", "MACD(12,26,9) signal", m.signal, ccy, derived(last.date));
    add("macdHist", "MACD(12,26,9) histogram", m.histogram, ccy, derived(last.date));
  }
  const a14 = lastValue(atr(bars, 14));
  if (a14 !== undefined) {
    add("atr14", "ATR(14), Wilder", a14, ccy, derived(last.date));
    add("atrPct", "ATR(14) as % of close", (a14 / last.close) * 100, "%", derived(last.date), { formula: "atr14 / close × 100" });
  }
  const bb = lastValue(bollinger(closes, 20, 2));
  if (bb) {
    add("bbUpper", "Bollinger(20,2) upper band", bb.upper, ccy, derived(last.date));
    add("bbLower", "Bollinger(20,2) lower band", bb.lower, ccy, derived(last.date));
  }

  // Risk
  const vol = annualizedVol(
    year.map((b) => b.close),
    perYear,
  );
  if (vol !== undefined)
    add("vol1y", "annualised volatility (1 year, log returns)", vol * 100, "%", derived(last.date), { formula: `stdev(log returns) × √${perYear} × 100` });
  const dd = maxDrawdown(year);
  if (dd) {
    add("maxDrawdown1y", "maximum drawdown over 1 year", dd.drawdown * 100, "%", derived(last.date), {
      formula: "min over the year of (close / running peak − 1) × 100",
    });
    add("maxDrawdown1y.window", "maximum drawdown window", `${dd.peak} → ${dd.trough}`, undefined, derived(last.date));
  }

  mkdirSync(dir, { recursive: true });
  store.save();
  const notes = [...series.notes, ...quote.notes.filter((n) => !series.notes.includes(n))];
  writeArtifact(join(dir, "BRIEF.md"), briefMarkdown(store, instrument.symbol, instrument.name, series, quote, notes));
  writeArtifact(join(dir, "RUNBOOK.md"), runbookMarkdown(dir, instrument.symbol));
  // The last year of bars, for the report's chart (not evidence: the figures stay in evidence.json).
  writeArtifact(join(dir, "bars.json"), `${JSON.stringify(bars.slice(-perYear))}\n`);
  writeArtifact(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        kind: "analyze",
        subject: instrument.symbol,
        instrument,
        asOf: last.date,
        bars: bars.length,
        firstBar: bars[0]!.date,
        sources: [...new Set(store.items.map((i) => i.url).filter(Boolean))],
        notes,
      },
      null,
      2,
    )}\n`,
  );
  return { dir, symbol: instrument.symbol, name: instrument.name, asOf: last.date, evidence: store.items.length, notes, trend };
}

const SECTIONS: Array<[string, RegExp]> = [
  ["Price", /\.(quote\.|close$|volume$)/],
  ["Range and returns", /\.(high52w|low52w|fromHigh52w|return)/],
  ["Trend and momentum", /\.(sma|vsSma|trend|rsi|macd|bb)/],
  ["Risk", /\.(atr|vol1y|maxDrawdown)/],
];

function briefMarkdown(store: EvidenceStore, symbol: string, name: string | undefined, series: PriceSeries, quote: QuoteResult, notes: string[]): string {
  const lines = [
    `# ${symbol}${name ? ` — ${name}` : ""}`,
    "",
    `Evidence for this run, numbered. Cite each figure you use by its [E#]; compute anything else with \`ultrastock calc\`. ` +
      `Daily bars: ${series.bars.length} sessions from ${series.bars[0]!.date} to ${series.bars[series.bars.length - 1]!.date} (${series.provenance.source}, ${series.provenance.delay}${series.provenance.official ? "" : ", unofficial"}). ` +
      `Quote: ${quote.provenance.source} (${quote.provenance.delay}).`,
    "",
  ];
  for (const [title, re] of SECTIONS) {
    const items = store.items.filter((i) => re.test(i.key));
    if (!items.length) continue;
    lines.push(`## ${title}`, "", ...items.map((i) => `- ${formatEvidence(i)}${i.formula ? ` — ${i.formula}` : ""}`), "");
  }
  if (notes.length) lines.push("## Notes", "", ...notes.map((n) => `- ${n}`), "");
  return `${lines.join("\n")}\n`;
}

function runbookMarkdown(dir: string, symbol: string): string {
  return `# Runbook — ${symbol}

1. Read BRIEF.md. It is the only source of figures for this answer.
2. Need a figure that is not there (a ratio, a gap, a target distance)? Compute it:
   \`ultrastock calc ${dir} "<formula over E ids>" --label "<what it is>" [--unit %]\` — it prints the new [E#].
3. Write the answer. Every sentence or table row with a figure cites the [E#] that holds it.
   State the as-of date and the data delay. A view (bullish, expensive…) is yours: say what would change it.
4. Check it: \`ultrastock check ${dir} answer.md\`. Fix every problem it lists, then answer.
`;
}

/** Read a run's brief, for `analyze` output without --json. */
export function readBrief(dir: string): string {
  return readFileSync(join(dir, "BRIEF.md"), "utf8");
}
