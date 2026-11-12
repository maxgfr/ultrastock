// The dashboard's view models: plain data, the same for a page and for its
// /api twin, built from the functions the commands use — only those that write
// nothing. The book is marked with `loadMarkedBook` (never `markBook`, which
// appends an equity snapshot on every call), the analyses fill an in-memory
// `Findings` (never `registerFindings`, which creates a run directory), and the
// SQLite store is opened read-only (no migration). Alerts are listed, never
// evaluated (an evaluation records what fired); decisions are read, never
// settled.
import { loadMarkedBook, type MarkedBook } from "../analyze/portfolio/book.js";
import { Findings } from "../analyze/portfolio/findings.js";
import { incomeAnalysis, locationAnalysis, lookthroughAnalysis } from "../analyze/portfolio/run-book.js";
import { riskAnalysis, stressAnalysis } from "../analyze/portfolio/run-risk.js";
import { loadRules } from "../alerts/alerts.js";
import { bookPerformance, flowRates } from "../commands/trading.js";
import { sqliteSupported, storeAvailable, withStore } from "../core/db.js";
import { dataCacheDir, homeDir } from "../core/paths.js";
import { loadProfile } from "../core/profile.js";
import { listTheses, overdueTheses, readLessons } from "../journal/journal.js";
import { hitRates, readDecisions, readSettlements } from "../journal/settle.js";
import { buildBook, readLedger, type Transaction } from "../portfolio/ledger.js";
import { readHistory } from "../portfolio/tracking.js";
import { loadWatchlist } from "../portfolio/watchlist.js";
import { contributions, readEquity } from "../trading/breaker.js";
import { listTickets, readAudit } from "../trading/tickets.js";

export const BOOKS = ["real", "paper"] as const;
export type BookName = (typeof BOOKS)[number];
export const ANALYSES = ["risk", "stress", "income", "location", "lookthrough"] as const;
export type AnalysisName = (typeof ANALYSES)[number];

/** A request the dashboard refuses (an unknown filter value): a 400, never a path or a query run with it. */
export class BadRequest extends Error {}

/**
 * A message as a page or its JSON shows it: the absolute paths of the cache and
 * home directories said as `<cache>` and `<home>`. Messages from the core name
 * the file at fault by its full path, which tells where the user's home is
 * (often their login name); the file's own name is enough to act on.
 */
export function withoutLocalPaths(message: string): string {
  let out = message;
  // The cache first: by default it lives inside the home, and its longer path must not be cut at the home's end.
  for (const [dir, name] of [
    [dataCacheDir(), "<cache>"],
    [homeDir(), "<home>"],
  ] as const)
    if (dir.length > 1) out = out.split(dir).join(name);
  return out;
}

/** A page with nothing to show yet, and the command that changes that. */
export interface Hint {
  hint: string;
}
export const isHint = (v: unknown): v is Hint => typeof v === "object" && v !== null && "hint" in v;

/** Where an input came from, as the page shows it next to the figures. */
export interface SourceRow {
  title: string;
  source: string;
  official: boolean;
  asOf?: string;
  delay?: string;
  fetchedAt: string;
  fallbackFrom?: string;
}

const sourcesOf = (f: Findings): SourceRow[] =>
  f.inputs.map((d) => ({
    title: d.title,
    source: d.provenance.source,
    official: d.provenance.official,
    asOf: d.provenance.asOf,
    delay: d.provenance.delay,
    fetchedAt: d.provenance.fetchedAt,
    fallbackFrom: d.provenance.fallbackFrom,
  }));

/** The two states `loadMarkedBook` throws on, said as a hint (a page that tells what to run, not a 500). */
function bookHint(book: BookName): Hint | undefined {
  if (!loadProfile()) return { hint: "No profile yet: run `ultrastock profile init --jurisdiction <CC>` first." };
  const b = buildBook(readLedger(book));
  if (!b.positions.some((p) => p.quantity > 0) && !b.cash.length)
    return { hint: `The ${book} book is empty: record a deposit and trades first (\`ultrastock portfolio deposit|add … --book ${book}\`).` };
  return undefined;
}

export interface PositionRow {
  symbol: string;
  assetClass: string;
  accounts: string[];
  quantity: number;
  currency: string;
  averageCost: number;
  price?: number;
  changePct?: number;
  valueBase?: number;
  weightPct?: number;
  /** Against the average cost (PMP), in the base currency; absent when the quote and the book disagree on the currency. */
  pnlBase?: number;
  pnlPct?: number;
  source?: string;
  delay?: string;
  quoteAsOf?: string;
}

export interface PortfolioView {
  book: BookName;
  base: string;
  asOf: string;
  total: number;
  cash: number;
  positions: PositionRow[];
  cashByAccount: Array<{ account: string; currency: string; amount: number; amountBase?: number }>;
  unpriced: string[];
  performance: ReturnType<typeof bookPerformance>;
  history: { points: Array<{ date: string; valueBase: number }>; changePct?: number; maxDrawdownPct?: number; hint?: string };
  sources: SourceRow[];
  notes: string[];
}

function positionRows(m: MarkedBook, f: Findings): PositionRow[] {
  return m.holdings.map((h) => {
    const quote = f.inputs.find((d) => d.kind === "quote" && d.subject === h.symbol);
    // loadMarkedBook switches a line to its quote currency: the average cost is then in another currency, and no P&L is computed from it.
    const sameCurrency = m.book.positions.every((p) => p.symbol !== h.symbol || p.currency === h.currency);
    const pnl = h.price !== undefined && h.fx !== undefined && sameCurrency && h.averageCost > 0;
    return {
      symbol: h.symbol,
      assetClass: h.assetClass,
      accounts: h.accounts.map((a) => a.account),
      quantity: h.quantity,
      currency: h.currency,
      averageCost: h.averageCost,
      price: h.price,
      changePct: h.changePct,
      valueBase: h.valueBase,
      weightPct: h.weightPct,
      pnlBase: pnl ? h.quantity * (h.price! - h.averageCost) * h.fx! : undefined,
      pnlPct: pnl ? (h.price! / h.averageCost - 1) * 100 : undefined,
      source: quote?.provenance.source,
      delay: quote?.provenance.delay,
      quoteAsOf: quote?.provenance.asOf,
    };
  });
}

/** The book's value over time from the store's daily snapshots, or the one line that says how to get them. */
function historyOf(book: BookName, now: Date): PortfolioView["history"] {
  if (!storeAvailable())
    return {
      points: [],
      hint: sqliteSupported()
        ? "Value over time comes from the local store: run `ultrastock portfolio db init`, then `ultrastock portfolio track` once a day."
        : `Value over time comes from the local store, which needs Node ≥ 22.5 (this is Node ${process.versions.node}).`,
    };
  try {
    const from = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
    const h = withStore((db) => readHistory(db, book, from), { readOnly: true });
    const points = h.points.filter((p) => p.complete).map((p) => ({ date: p.date, valueBase: p.valueBase }));
    if (!points.length)
      return { points, hint: `No snapshot of the ${book} book in the last year: run \`ultrastock portfolio track --book ${book}\` once a day.` };
    return { points, changePct: h.changePct, maxDrawdownPct: h.maxDrawdownPct };
  } catch (e) {
    return { points: [], hint: `Value over time unavailable: ${withoutLocalPaths((e as Error).message)}` };
  }
}

export async function portfolioView(book: BookName, now: Date): Promise<PortfolioView | Hint> {
  const hint = bookHint(book);
  if (hint) return hint;
  const f = new Findings();
  const m = await loadMarkedBook(book, f, now, { dayChange: true });
  // The breaker reads the equity curve as `perf` would see it right after marking — the recorded curve plus
  // today's value — without appending that value to the file.
  // Today's point carries the money paid in so far, as a recorded point does: the breaker measures losses net of
  // deposits, withdrawals and transfers across, and a point without it would read a deposit as a gain and a withdrawal as a loss.
  // A valuation that left a position out (no price, no rate) is not what the book is worth: no point for today then,
  // as `portfolio show` records none — the breaker reads the last complete one.
  const unpriced = m.holdings.filter((h) => h.valueBase === undefined).map((h) => h.symbol);
  const contributed = contributions(m.txs, m.rates, m.base);
  const curve =
    m.totalBase > 0 && !unpriced.length ? [...readEquity(book), { at: now.toISOString(), equity: m.totalBase, ...(contributed ?? {}) }] : readEquity(book);
  // Each deposit's rate on its own date: read here, so that bookPerformance stays pure; a failed read leaves the XIRR n/a, with why.
  const rates = await flowRates(m.txs, m.base, now);
  return {
    book,
    base: m.base,
    asOf: now.toISOString(),
    total: m.totalBase,
    cash: m.cashBase,
    positions: positionRows(m, f),
    cashByAccount: m.cash,
    unpriced,
    performance: bookPerformance(m.txs, m.book, m.totalBase, curve, m.profile.limits, now, rates),
    history: historyOf(book, now),
    sources: sourcesOf(f),
    notes: f.notes,
  };
}

export interface AnalysisView {
  book: BookName;
  analysis: AnalysisName;
  base: string;
  asOf: string;
  sections: Array<{ section: string; figures: Array<{ key: string; label: string; value: number | string | boolean; unit?: string; formula: string }> }>;
  sources: SourceRow[];
  notes: string[];
}

const RUN: Record<AnalysisName, (m: MarkedBook, f: Findings) => Promise<unknown>> = {
  risk: (m, f) => riskAnalysis(m, f),
  stress: stressAnalysis,
  income: incomeAnalysis,
  location: locationAnalysis,
  lookthrough: lookthroughAnalysis,
};

export async function analysisView(book: BookName, analysis: AnalysisName, now: Date): Promise<AnalysisView | Hint> {
  const hint = bookHint(book);
  if (hint) return hint;
  const f = new Findings();
  const m = await loadMarkedBook(book, f, now);
  await RUN[analysis](m, f);
  const sections = new Map<string, AnalysisView["sections"][number]["figures"]>();
  for (const d of f.derived)
    sections.set(d.section, [...(sections.get(d.section) ?? []), { key: d.key, label: d.label, value: d.value, unit: d.unit, formula: d.formula }]);
  return {
    book,
    analysis,
    base: m.base,
    asOf: now.toISOString(),
    sections: [...sections].map(([section, figures]) => ({ section, figures })),
    sources: sourcesOf(f),
    notes: f.notes,
  };
}

export interface LedgerView {
  book: BookName;
  asOf: string;
  accounts: string[];
  symbols: string[];
  filter: { account?: string; symbol?: string };
  /** Newest first. */
  transactions: Transaction[];
  count: number;
}

/** The ledger, newest first; a filter value must be one the ledger holds. */
export function ledgerView(book: BookName, filter: { account?: string; symbol?: string }, now: Date): LedgerView {
  const txs = readLedger(book);
  const accounts = [...new Set(txs.map((t) => t.account))].sort();
  const symbols = [...new Set(txs.flatMap((t) => (t.symbol ? [t.symbol] : [])))].sort();
  if (filter.account !== undefined && !accounts.includes(filter.account)) throw new BadRequest("unknown account: pick one from the list");
  if (filter.symbol !== undefined && !symbols.includes(filter.symbol)) throw new BadRequest("unknown symbol: pick one from the list");
  // Reverse first, then a stable sort: the same day keeps the latest recorded on top.
  const shown = [...txs]
    .reverse()
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((t) => (filter.account === undefined || t.account === filter.account) && (filter.symbol === undefined || t.symbol === filter.symbol));
  return { book, asOf: now.toISOString(), accounts, symbols, filter, transactions: shown, count: txs.length };
}

export function journalView(now: Date) {
  const settlements = readSettlements();
  const overdue = new Set(overdueTheses(now).map((t) => t.id));
  return {
    asOf: now.toISOString(),
    decisions: readDecisions().reverse(),
    settlements: [...settlements].reverse(),
    hitRates: hitRates(settlements),
    theses: listTheses().map((t) => ({ ...t, overdue: overdue.has(t.id) })),
    lessons: readLessons().map((l) => l.replace(/^- /, "")),
  };
}
export type JournalView = ReturnType<typeof journalView>;

export function watchView(now: Date) {
  return { asOf: now.toISOString(), watchlist: loadWatchlist(), rules: loadRules() };
}
export type WatchView = ReturnType<typeof watchView>;

/** The audit trail is append-only and grows forever: the page shows its latest lines. */
export const AUDIT_SHOWN = 200;

export function ticketsView(now: Date) {
  const audit = readAudit();
  return { asOf: now.toISOString(), tickets: listTickets(), audit: audit.slice(-AUDIT_SHOWN).reverse(), auditCount: audit.length };
}
export type TicketsView = ReturnType<typeof ticketsView>;
