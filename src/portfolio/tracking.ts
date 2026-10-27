// What the local store keeps beyond the ledger: one snapshot row per position
// (and per cash balance) per day, to follow the book over time, and the
// headlines found for the holdings, to tell what is new since the last check.
// Pure store logic here; pricing and searching are the command's job.
import { canonicalizeUrl, contentHash } from "../engine.js";
import { inTransaction, type SqlDatabase } from "../core/db.js";
import { sanitizeExternalText } from "../core/untrusted.js";
import type { Book, Valued } from "./ledger.js";

// ---- snapshots ---------------------------------------------------------------------

export interface SnapshotRow {
  date: string;
  book: string;
  account: string;
  /** The instrument, or CASH:<CCY> for a cash balance. */
  symbol: string;
  quantity: number;
  /** Price per unit in `currency`; null when the price could not be had (never guessed). */
  price: number | null;
  currency: string;
  /** Average cost × quantity, in `currency`. */
  cost: number | null;
  value_base: number | null;
  /** Units of base per 1 `currency`; null when the rate is missing. */
  fx: number | null;
  source: string;
}

/** The rows a valued book gives for one day: positions, then cash balances. */
export function snapshotRows(
  date: string,
  book: string,
  b: Book,
  valued: { positions: Valued[] },
  fx: Record<string, number>,
  base: string,
  sources: Record<string, string> = {},
): SnapshotRow[] {
  const rate = (c: string) => (c === base ? 1 : (fx[c] ?? null));
  const rows: SnapshotRow[] = valued.positions.map((p) => ({
    date,
    book,
    account: p.account,
    symbol: p.symbol,
    quantity: p.quantity,
    price: p.price ?? null,
    currency: p.currency,
    cost: p.averageCost * p.quantity,
    value_base: p.valueBase ?? null,
    fx: rate(p.currency),
    source: p.price === undefined ? "missing" : (sources[p.symbol] ?? "quote"),
  }));
  for (const c of b.cash) {
    const r = rate(c.currency);
    rows.push({
      date,
      book,
      account: c.account,
      symbol: `CASH:${c.currency}`,
      quantity: c.amount,
      price: 1,
      currency: c.currency,
      cost: c.amount,
      value_base: r === null ? null : c.amount * r,
      fx: r,
      source: "ledger",
    });
  }
  return rows;
}

/**
 * Write a day's rows. One row per (date, book, account, symbol): a second run
 * the same day updates it, except that a missing price never overwrites a
 * price already recorded that day.
 */
export function writeSnapshots(db: SqlDatabase, rows: readonly SnapshotRow[], now = new Date()): { written: number; missing: number } {
  const st = db.prepare(
    `INSERT INTO snapshots (date, book, account, symbol, quantity, price, currency, cost, value_base, fx, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (date, book, account, symbol) DO UPDATE SET
       quantity = excluded.quantity, price = excluded.price, currency = excluded.currency, cost = excluded.cost,
       value_base = excluded.value_base, fx = excluded.fx, source = excluded.source, recorded_at = excluded.recorded_at
     WHERE excluded.price IS NOT NULL OR snapshots.price IS NULL`,
  );
  const at = now.toISOString();
  return inTransaction(db, () => {
    for (const r of rows) st.run(r.date, r.book, r.account, r.symbol, r.quantity, r.price, r.currency, r.cost, r.value_base, r.fx, r.source, at);
    return { written: rows.length, missing: rows.filter((r) => r.price === null || r.value_base === null).length };
  });
}

export interface HistoryPoint {
  date: string;
  /** Sum of the rows' base values (positions and cash). */
  valueBase: number;
  /** Sum of cost × fx, in base. */
  costBase: number;
  pnlBase: number;
  /** Rows that day without a price or a rate: the total is then incomplete. */
  missing: number;
  complete: boolean;
  /** Drawdown from the running peak of complete days, %. */
  drawdownPct?: number;
}

export interface History {
  book: string;
  symbol?: string;
  from: string;
  points: HistoryPoint[];
  first?: HistoryPoint;
  last?: HistoryPoint;
  changePct?: number;
  maxDrawdownPct?: number;
  currentDrawdownPct?: number;
}

/** The book's (or one symbol's) value over time, from the snapshots since `from`. */
export function readHistory(db: SqlDatabase, book: string, from: string, symbol?: string): History {
  const rows = db
    .prepare(
      `SELECT date,
              SUM(COALESCE(value_base, 0)) AS value_base,
              SUM(COALESCE(cost * fx, 0)) AS cost_base,
              SUM(CASE WHEN value_base IS NULL THEN 1 ELSE 0 END) AS missing
         FROM snapshots
        WHERE book = ? AND date >= ? ${symbol ? "AND symbol = ?" : ""}
        GROUP BY date ORDER BY date`,
    )
    .all(...(symbol ? [book, from, symbol] : [book, from]));
  let peak = Number.NEGATIVE_INFINITY;
  let maxDd: number | undefined;
  const points: HistoryPoint[] = rows.map((r) => {
    const valueBase = Number(r.value_base);
    const costBase = Number(r.cost_base);
    const missing = Number(r.missing);
    const p: HistoryPoint = { date: String(r.date), valueBase, costBase, pnlBase: valueBase - costBase, missing, complete: missing === 0 };
    if (p.complete && valueBase > 0) {
      peak = Math.max(peak, valueBase);
      p.drawdownPct = (valueBase / peak - 1) * 100;
      maxDd = Math.min(maxDd ?? 0, p.drawdownPct);
    }
    return p;
  });
  const complete = points.filter((p) => p.complete);
  const first = complete[0];
  const last = complete.at(-1);
  return {
    book,
    symbol,
    from,
    points,
    first,
    last,
    changePct: first && last && first.valueBase > 0 && first !== last ? (last.valueBase / first.valueBase - 1) * 100 : undefined,
    maxDrawdownPct: maxDd,
    currentDrawdownPct: last?.drawdownPct,
  };
}

// ---- news kept for the holdings -------------------------------------------------------

export interface NewsItem {
  id: string;
  subject: string;
  title: string;
  url: string;
  source: string | null;
  published_at: string | null;
  first_seen_at: string;
  seen: boolean;
}

/** The id of a headline: a hash of its canonical URL (the same article found twice is one item). */
export function newsId(url: string): string {
  let canon = url;
  try {
    canon = canonicalizeUrl(url);
  } catch {
    /* not a URL the canonicaliser knows: hash it as given */
  }
  return contentHash(canon).slice(0, 16);
}

/** Store headlines for a subject; an article already stored is left as it is. Returns the ids added. */
export function storeNews(
  db: SqlDatabase,
  subject: string,
  articles: ReadonlyArray<{ title: string; url: string; source?: string; published?: string }>,
  now = new Date(),
): string[] {
  const st = db.prepare(
    `INSERT INTO news_items (id, subject, title, url, source, published_at, first_seen_at, seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT (id) DO NOTHING`,
  );
  const at = now.toISOString();
  return inTransaction(db, () => {
    const added: string[] = [];
    for (const a of articles) {
      if (!a.url || !a.title) continue;
      const id = newsId(a.url);
      const r = st.run(id, subject, sanitizeExternalText(a.title, 300), a.url, a.source ? sanitizeExternalText(a.source, 80) : null, a.published ?? null, at);
      if (Number(r.changes) > 0) added.push(id);
    }
    return added;
  });
}

/** Headlines about `subjects` since `since` (published, else first seen): unseen first, newest first. */
export function listNews(db: SqlDatabase, subjects: readonly string[], since: string): NewsItem[] {
  if (!subjects.length) return [];
  return db
    .prepare(
      `SELECT * FROM news_items
        WHERE subject IN (${subjects.map(() => "?").join(",")}) AND COALESCE(published_at, first_seen_at) >= ?
        ORDER BY seen ASC, COALESCE(published_at, first_seen_at) DESC`,
    )
    .all(...subjects, since)
    .map((r) => ({
      id: String(r.id),
      subject: String(r.subject),
      title: String(r.title),
      url: String(r.url),
      source: r.source === null ? null : String(r.source),
      published_at: r.published_at === null ? null : String(r.published_at),
      first_seen_at: String(r.first_seen_at),
      seen: Number(r.seen) === 1,
    }));
}

/** Mark headlines as seen: the next check lists them after the new ones. */
export function markNewsSeen(db: SqlDatabase, ids: readonly string[], now = new Date()): number {
  const st = db.prepare("UPDATE news_items SET seen = 1, seen_at = ? WHERE id = ? AND seen = 0");
  const at = now.toISOString();
  return inTransaction(db, () => ids.reduce((n, id) => n + Number(st.run(at, id).changes), 0));
}

/** "title | source" (the news dataset's point value) back into its parts. */
export function splitHeadline(value: string): { title: string; source?: string } {
  const i = value.lastIndexOf(" | ");
  return i > 0 ? { title: value.slice(0, i), source: value.slice(i + 3) } : { title: value };
}

/** The UTC timestamp a news point's label carries ("headline 3 (2026-10-24 12:00 UTC)"). */
export function publishedFromLabel(label: string): string | undefined {
  const m = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\)/.exec(label);
  return m ? `${m[1]}T${m[2]}:00Z` : undefined;
}
