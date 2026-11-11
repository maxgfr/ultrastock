// The ledger: every movement of money and securities, append-only, in
// ULTRASTOCK_HOME/ledger/<book>.jsonl ("real" for the user's declared holdings,
// "paper" for simulated trades). Positions, cash and cost bases are always
// RECOMPUTED from the transactions — never stored, never edited — so a wrong
// position is fixed by adding a corrective transaction, and the history of
// how it got there survives.
//
// Cost basis is kept two ways at once, because two tax regimes need them:
// lots (FIFO, for US-style lot accounting and holding periods) and the
// weighted average cost (PMP, the French rule for securities).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../engine.js";
import { inTransaction, ledgerBackend, SCHEMA_VERSION, type SqlDatabase, StoreUnavailableError, schemaVersionOf, withStore } from "../core/db.js";
import { withFileLock } from "../core/lock.js";
import { homeDir } from "../core/paths.js";
import { readJsonl, sealJsonlTail, type Warn } from "./jsonl.js";

export type TxType = "deposit" | "withdrawal" | "buy" | "sell" | "dividend" | "interest" | "fee" | "tax" | "split" | "transfer-in" | "transfer-out";

export interface Transaction {
  /** Content hash of the normalised transaction: importing the same file twice adds nothing. */
  id: string;
  date: string;
  type: TxType;
  /** Envelope / account id from the profile ("pea", "ibkr", "kraken"). */
  account: string;
  /** Instrument symbol (MC.PA, NVDA, BTCUSDT); absent for cash movements. */
  symbol?: string;
  isin?: string;
  /** Units (shares, coins): + for buys and transfers in; the split ratio for a split. */
  quantity?: number;
  /** Price per unit in `currency`. */
  price?: number;
  /** Cash amount in `currency`: + into the account, − out of it. Derived for trades when absent. */
  amount?: number;
  fee?: number;
  currency: string;
  /** Exchange rate to the base currency at the date (units of base per 1 currency), when known. */
  fxToBase?: number;
  note?: string;
  /**
   * "crypto" when the importer knows the instrument is a crypto-asset whatever the account (IBKR's CRYPTO category, held
   * beside shares). Not part of the id. Absent on older rows: the tax engine then reads the account and the symbol.
   */
  assetClass?: "crypto";
  /**
   * The broker's own id of the trade, part of the transaction id — set only where two fills of a statement would
   * otherwise share one (same second, quantity and price), and then on all of them but the lowest id, which keeps the
   * id it always had: a ledger imported before references were kept finds it there.
   */
  ref?: string;
  /** Where the transaction came from: "manual", "import:ibkr-flex", "paper", "ticket:<id>". */
  origin: string;
}

export interface Lot {
  date: string;
  quantity: number;
  /** Cost per unit including the buy fee share, in the trade currency. */
  costPerUnit: number;
}

export interface Position {
  account: string;
  symbol: string;
  currency: string;
  quantity: number;
  /** Weighted average cost per unit (PMP), fees included. */
  averageCost: number;
  lots: Lot[];
  /** Realised P&L so far by the average-cost rule, in the trade currency. */
  realizedPmp: number;
  /** Realised P&L by FIFO lots. */
  realizedFifo: number;
  dividends: number;
  firstBuy?: string;
}

export interface Book {
  positions: Position[];
  /** Cash per account and currency. */
  cash: Array<{ account: string; currency: string; amount: number }>;
  transactions: Transaction[];
}

export function ledgerPath(book = "real"): string {
  if (!/^[a-z0-9-]{1,40}$/.test(book)) throw new Error(`a book name is lowercase letters, digits and dashes, not "${book}"`);
  return join(homeDir(), "ledger", `${book}.jsonl`);
}

/** The id a transaction gets from its content (stable across re-imports). */
export function transactionId(t: Omit<Transaction, "id">): string {
  const norm = [
    t.date.slice(0, 19),
    t.type,
    t.account,
    t.symbol ?? "",
    t.quantity ?? "",
    t.price ?? "",
    t.amount ?? "",
    t.fee ?? "",
    t.currency,
    t.origin.split(":")[0],
  ].join("|");
  // Without a reference the id is what it always was.
  return contentHash(t.ref ? `${norm}|ref:${t.ref}` : norm).slice(0, 16);
}

/**
 * A process that must never write the user's state (the `serve` dashboard) says so here: a ledger read then
 * refuses to migrate a store on an older schema, and asks for a command that may.
 */
let neverMigrate = false;
export function readLedgerWithoutWriting(on = true): void {
  neverMigrate = on;
}

/** The transactions of a book, in the order they were recorded (JSONL or SQLite, per store.json). */
export function readLedger(book = "real", warn?: Warn): Transaction[] {
  ledgerPath(book);
  if (ledgerBackend() === "sqlite") {
    // A read opens the store read-only; only a store on an older schema is opened to write, to migrate it, once.
    const read = withLedgerStore((db) => (schemaVersionOf(db) === SCHEMA_VERSION ? readSqliteLedger(db, book) : undefined), { readOnly: true });
    if (read) return read;
    if (neverMigrate)
      throw new Error("the local store is on an older schema and this command never writes: run `ultrastock portfolio show` once to migrate it");
    return withLedgerStore((db) => readSqliteLedger(db, book));
  }
  return readJsonlLedger(book, warn);
}

/** withStore for the ledger: on a Node without node:sqlite, say that THIS ledger lives in the store. */
function withLedgerStore<T>(fn: (db: SqlDatabase) => T, opts?: { readOnly?: boolean }): T {
  try {
    return withStore(fn, opts);
  } catch (e) {
    if (e instanceof StoreUnavailableError)
      throw new StoreUnavailableError(
        `${e.message} — but this ledger lives in the SQLite store (store.json): run ultrastock on Node ≥ 22.5, where \`portfolio db off\` writes it back to JSONL`,
        true,
      );
    throw e;
  }
}

/**
 * The JSONL file of a book, whatever the active backend. A last line cut short
 * by a crash mid-append is skipped with a warning (the append never returned:
 * nothing was recorded); an unreadable line anywhere else is an error.
 */
export function readJsonlLedger(book = "real", warn?: Warn): Transaction[] {
  return readJsonl<Transaction>(ledgerPath(book), warn);
}

function validate(t: Omit<Transaction, "id">): void {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(t.date);
  if (!ymd) throw new Error(`transaction date "${t.date}" is not YYYY-MM-DD`);
  // A day the calendar has: 2026-02-30 would sort and group as if it existed.
  const [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) throw new Error(`transaction date "${t.date}" is not a date`);
  if (!/^[A-Z]{3,5}$/.test(t.currency)) throw new Error(`transaction currency "${t.currency}" is not a currency code`);
  const trade = t.type === "buy" || t.type === "sell" || t.type === "transfer-in" || t.type === "transfer-out";
  if (trade || t.type === "split") {
    if (!t.symbol) throw new Error(`a ${t.type} needs a symbol`);
    if (!(typeof t.quantity === "number" && t.quantity > 0)) throw new Error(`a ${t.type} needs a positive quantity`);
  }
  if ((t.type === "buy" || t.type === "sell") && !(typeof t.price === "number" && t.price >= 0)) throw new Error(`a ${t.type} needs a price`);
  if (
    (t.type === "deposit" || t.type === "withdrawal" || t.type === "dividend" || t.type === "interest" || t.type === "fee" || t.type === "tax") &&
    typeof t.amount !== "number"
  )
    throw new Error(`a ${t.type} needs an amount`);
}

type Reading = Partial<Omit<Transaction, "id">>;

/**
 * How an earlier release of an importer read a row, when it read the statement differently (a 12-hour clock read as
 * 24-hour, a pair split wrong): the fields it stored otherwise. Kept beside the parsed row, never in it: the row's own
 * id is unchanged, and a ledger that already holds the id of one of these readings already holds the row.
 */
const legacyReadings = new WeakMap<object, readonly Reading[]>();

/** Record how an earlier release read `t` (`t` as the importer returns it): the fields that differed. */
export function setLegacyReadings(t: Omit<Transaction, "id">, readings: readonly Reading[]): void {
  if (readings.length) legacyReadings.set(t, readings);
}

/** The ids an earlier release stored `t` under, if its importer named any. */
export function legacyIdsOf(t: Omit<Transaction, "id">): string[] {
  return (legacyReadings.get(t) ?? []).map((r) => transactionId({ ...t, ...r }));
}

/** The earlier readings of `t` (to tell the user which stored rows they are). */
export function legacyReadingsOf(t: Omit<Transaction, "id">): readonly Reading[] {
  return legacyReadings.get(t) ?? [];
}

/**
 * Append transactions under the ledger's lock; duplicates (same content id, or a row the ledger already holds under the
 * id an earlier release gave it — `setLegacyIds`) are skipped and counted. Returns what was added.
 */
export async function appendTransactions(txs: ReadonlyArray<Omit<Transaction, "id">>, book = "real"): Promise<{ added: Transaction[]; duplicates: number }> {
  const path = ledgerPath(book);
  mkdirSync(join(homeDir(), "ledger"), { recursive: true });
  const sqlite = ledgerBackend() === "sqlite";
  return withFileLock(`${path}.lock`, () => {
    if (sqlite) {
      for (const raw of txs) validate(raw);
      return withLedgerStore((db) =>
        inTransaction(db, () => {
          // Only what the book held before this append counts as stored under an old id: two rows of this batch never do.
          const has = db.prepare("SELECT 1 AS found FROM transactions WHERE book = ? AND id = ?");
          const fresh = txs.filter((raw) => !legacyIdsOf(raw).some((id) => has.get(book, id)));
          const r = insertSqliteTransactions(
            db,
            fresh.map((raw) => ({ ...raw, id: transactionId(raw) }) as Transaction),
            book,
          );
          return { added: r.added, duplicates: r.duplicates + txs.length - fresh.length };
        }),
      );
    }
    const stored = new Set(readJsonlLedger(book).map((t) => t.id));
    const seen = new Set(stored);
    const added: Transaction[] = [];
    let duplicates = 0;
    for (const raw of txs) {
      validate(raw);
      const t = { ...raw, id: transactionId(raw) } as Transaction;
      if (seen.has(t.id) || legacyIdsOf(raw).some((id) => stored.has(id))) {
        duplicates++;
        continue;
      }
      seen.add(t.id);
      added.push(t);
    }
    if (added.length) {
      // Under the lock: a line a crashed append cut short is moved aside, never left in the middle of the file.
      sealJsonlTail(path);
      appendFileSync(path, added.map((t) => `${JSON.stringify(t)}\n`).join(""), { mode: 0o600 });
    }
    return { added, duplicates };
  });
}

// ---- SQLite backend -------------------------------------------------------------

/** A book's transactions from the store, in recording order. */
export function readSqliteLedger(db: SqlDatabase, book: string): Transaction[] {
  ledgerPath(book);
  return db
    .prepare("SELECT doc FROM transactions WHERE book = ? ORDER BY seq")
    .all(book)
    .map((r) => JSON.parse(String(r.doc)) as Transaction);
}

/**
 * Insert transactions (ids already set) into a book in the store; an id the
 * book already holds is skipped and counted. The caller holds the transaction.
 */
export function insertSqliteTransactions(
  db: SqlDatabase,
  txs: readonly Transaction[],
  book: string,
  now = new Date(),
): { added: Transaction[]; duplicates: number } {
  ledgerPath(book);
  const ins = db.prepare(
    `INSERT INTO transactions (book, id, date, type, account, symbol, isin, quantity, price, amount, fee, currency, fx_to_base, note, origin, doc, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (book, id) DO NOTHING`,
  );
  const added: Transaction[] = [];
  let duplicates = 0;
  const at = now.toISOString();
  for (const t of txs) {
    const r = ins.run(
      book,
      t.id,
      t.date,
      t.type,
      t.account,
      t.symbol ?? null,
      t.isin ?? null,
      t.quantity ?? null,
      t.price ?? null,
      t.amount ?? null,
      t.fee ?? null,
      t.currency,
      t.fxToBase ?? null,
      t.note ?? null,
      t.origin,
      JSON.stringify(t),
      at,
    );
    if (Number(r.changes) > 0) added.push(t);
    else duplicates++;
  }
  return { added, duplicates };
}

const tradeCash = (t: Transaction) => {
  if (typeof t.amount === "number") return t.amount;
  const gross = (t.quantity ?? 0) * (t.price ?? 0);
  return t.type === "buy" ? -(gross + (t.fee ?? 0)) : t.type === "sell" ? gross - (t.fee ?? 0) : 0;
};

/**
 * The note the IBKR importer gives a split dated by its report date (the statement has no Date/Time for it): that day
 * is the first one the shares trade split, so the split takes effect at its start. Not part of the id.
 */
export const SPLIT_REPORT_DATE_NOTE = "split dated by its report date: the first day the shares trade split";

/**
 * When a transaction takes effect, for ordering: its date, the time of day included when it has one. A row with a
 * date only sorts at the start of its day — except a split imported from IBKR dated by its Date/Time: IBKR posts it
 * on the evening before the shares trade split and the importer keeps that day, without the time (the id depends on
 * the stored date), so it takes effect at the end of that day, after the day's trades. One dated by its report date
 * (`SPLIT_REPORT_DATE_NOTE`) is already on the first split day and stays at its start.
 */
function effectiveDate(t: Pick<Transaction, "date" | "type" | "origin" | "note">): string {
  return t.type === "split" && t.origin === "import:ibkr-flex" && t.date.length === 10 && t.note !== SPLIT_REPORT_DATE_NOTE ? `${t.date}T23:59:59.999` : t.date;
}

/** Transactions in the order they take effect (`effectiveDate`), ledger order between equals: the order every replay uses. */
export function inReplayOrder<T extends Pick<Transaction, "date" | "type" | "origin" | "note">>(txs: readonly T[]): T[] {
  return txs
    .map((t, i) => ({ t, i, at: effectiveDate(t) }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i)
    .map(({ t }) => t);
}

/** Replay the transactions, in date order, into positions and cash. */
export function buildBook(txs: readonly Transaction[]): Book {
  const positions = new Map<string, Position>();
  const cash = new Map<string, number>();
  const addCash = (account: string, currency: string, v: number) => cash.set(`${account}|${currency}`, (cash.get(`${account}|${currency}`) ?? 0) + v);
  const pos = (t: Transaction) => {
    const k = `${t.account}|${t.symbol}`;
    let p = positions.get(k);
    if (!p) {
      p = { account: t.account, symbol: t.symbol!, currency: t.currency, quantity: 0, averageCost: 0, lots: [], realizedPmp: 0, realizedFifo: 0, dividends: 0 };
      positions.set(k, p);
    }
    return p;
  };
  // Units moved out of an account, at the average cost they left with: a transfer-in without a price of the same
  // symbol into another account takes that cost over (a move between the user's own accounts).
  type Move = { account: string; symbol: string; quantity: number; cost: number };
  const inTransit: Move[] = [];
  // Arrivals that found nothing in transit: a statement may list the day's transfer-in before its transfer-out.
  const waiting: Array<{ t: Transaction; p: Position; lot: Lot; left: number; fallback: number }> = [];
  /** Up to `need` units of `symbol` for `account` from the move `m` (out of another account): the units and their cost. */
  const take = (m: Move, account: string, symbol: string, need: number): { qty: number; cost: number } => {
    if (m.symbol !== symbol || m.account === account || m.quantity <= 1e-12 || need <= 1e-12) return { qty: 0, cost: 0 };
    const qty = Math.min(need, m.quantity);
    m.quantity -= qty;
    return { qty, cost: qty * m.cost };
  };
  const sorted = inReplayOrder(txs);
  for (const t of sorted) {
    switch (t.type) {
      case "deposit":
      case "withdrawal":
      case "interest":
      case "fee":
      case "tax":
        addCash(t.account, t.currency, t.amount!);
        break;
      case "dividend":
        addCash(t.account, t.currency, t.amount!);
        if (t.symbol) pos(t).dividends += t.amount!;
        break;
      case "buy":
      case "transfer-in": {
        const p = pos(t);
        const q = t.quantity!;
        let costTotal = t.type === "buy" ? q * t.price! + (t.fee ?? 0) : q * (t.price ?? p.averageCost);
        let left = 0;
        if (t.type === "transfer-in" && t.price === undefined) {
          // Units of the user's own, moved from another account: they keep the average cost they left with.
          const fallback = p.averageCost;
          left = q;
          costTotal = 0;
          for (const m of inTransit) {
            const got = take(m, t.account, t.symbol!, left);
            left -= got.qty;
            costTotal += got.cost;
          }
          costTotal += left * fallback;
        }
        const lot = { date: t.date, quantity: q, costPerUnit: costTotal / q };
        if (left > 1e-12) waiting.push({ t, p, lot, left, fallback: p.averageCost });
        p.averageCost = (p.averageCost * p.quantity + costTotal) / (p.quantity + q);
        p.quantity += q;
        p.lots.push(lot);
        p.firstBuy ??= t.date;
        if (t.type === "buy") addCash(t.account, t.currency, tradeCash(t));
        break;
      }
      case "sell":
      case "transfer-out": {
        const p = pos(t);
        let q = t.quantity!;
        if (q > p.quantity + 1e-9)
          throw new Error(`${t.date}: ${t.type} of ${q} ${t.symbol} in ${t.account} exceeds the ${p.quantity} held — the ledger is missing a buy`);
        const proceedsPerUnit = t.type === "sell" ? (q * t.price! - (t.fee ?? 0)) / q : p.averageCost;
        if (t.type === "sell") p.realizedPmp += (proceedsPerUnit - p.averageCost) * q;
        else {
          const m = { account: t.account, symbol: t.symbol!, quantity: q, cost: p.averageCost };
          inTransit.push(m);
          // An arrival of the same day, still untouched, takes its cost now.
          for (const w of waiting) {
            if (w.t.date.slice(0, 10) !== t.date.slice(0, 10) || w.lot.quantity !== w.t.quantity || !w.p.lots.includes(w.lot)) continue;
            const got = take(m, w.t.account, w.t.symbol!, w.left);
            if (!got.qty) continue;
            const delta = got.cost - got.qty * w.fallback;
            w.left -= got.qty;
            w.lot.costPerUnit += delta / w.lot.quantity;
            w.p.averageCost += delta / w.p.quantity;
          }
        }
        // FIFO: consume the oldest lots first.
        while (q > 1e-12 && p.lots.length) {
          const lot = p.lots[0]!;
          const take = Math.min(q, lot.quantity);
          if (t.type === "sell") p.realizedFifo += (proceedsPerUnit - lot.costPerUnit) * take;
          lot.quantity -= take;
          q -= take;
          if (lot.quantity <= 1e-12) p.lots.shift();
        }
        p.quantity -= t.quantity!;
        if (p.quantity <= 1e-12) {
          p.quantity = 0;
          p.averageCost = 0;
        }
        if (t.type === "sell") addCash(t.account, t.currency, tradeCash(t));
        break;
      }
      case "split": {
        // quantity = ratio (2 for a 2-for-1): units multiply, per-unit costs divide.
        const p = pos(t);
        const r = t.quantity!;
        p.quantity *= r;
        p.averageCost /= r;
        for (const lot of p.lots) {
          lot.quantity *= r;
          lot.costPerUnit /= r;
        }
        break;
      }
    }
  }
  return {
    positions: [...positions.values()].filter((p) => p.quantity > 0 || p.realizedPmp !== 0 || p.dividends !== 0),
    cash: [...cash.entries()].map(([k, amount]) => {
      const [account, currency] = k.split("|") as [string, string];
      return { account, currency, amount };
    }),
    transactions: sorted,
  };
}

/**
 * When each account's line (`account|symbol`) was last opened: the date of the
 * trade that took its quantity up from zero, replayed in `buildBook`'s order
 * and with its rounding (a quantity at or under 1e-12 is closed).
 */
export function lineOpenedAt(txs: readonly Transaction[]): Map<string, string> {
  const held = new Map<string, number>();
  const opened = new Map<string, string>();
  for (const t of txs) {
    if (!t.symbol) continue;
    const k = `${t.account}|${t.symbol}`;
    const before = held.get(k) ?? 0;
    const q = t.quantity ?? 0;
    let after: number;
    if (t.type === "buy" || t.type === "transfer-in") after = before + q;
    else if (t.type === "sell" || t.type === "transfer-out") after = before - q;
    else if (t.type === "split") after = before * q;
    else continue;
    if (after <= 1e-12) after = 0;
    if (before === 0 && after > 0) opened.set(k, t.date);
    held.set(k, after);
  }
  return opened;
}

export interface Valued {
  account: string;
  symbol: string;
  quantity: number;
  currency: string;
  price?: number;
  value?: number;
  /** Value in the base currency. */
  valueBase?: number;
  averageCost: number;
  unrealized?: number;
  unrealizedPct?: number;
  weightPct?: number;
}

/** Mark open positions to market: `prices` by symbol (trade currency), `fx` to base by currency. */
export function valueBook(
  book: Book,
  prices: Record<string, number>,
  fx: Record<string, number>,
  base: string,
): { positions: Valued[]; cashBase: number; totalBase: number; missing: string[] } {
  const missing: string[] = [];
  const toBase = (ccy: string) => (ccy === base ? 1 : fx[ccy]);
  const vals: Valued[] = book.positions
    .filter((p) => p.quantity > 0)
    .map((p) => {
      const price = prices[p.symbol];
      const rate = toBase(p.currency);
      if (price === undefined) missing.push(`price of ${p.symbol}`);
      if (rate === undefined) missing.push(`${p.currency}→${base} rate`);
      const value = price !== undefined ? price * p.quantity : undefined;
      return {
        account: p.account,
        symbol: p.symbol,
        quantity: p.quantity,
        currency: p.currency,
        price,
        value,
        valueBase: value !== undefined && rate !== undefined ? value * rate : undefined,
        averageCost: p.averageCost,
        unrealized: value !== undefined ? value - p.averageCost * p.quantity : undefined,
        unrealizedPct: price !== undefined && p.averageCost > 0 ? (price / p.averageCost - 1) * 100 : undefined,
      };
    });
  let cashBase = 0;
  for (const c of book.cash) {
    const rate = toBase(c.currency);
    if (rate === undefined) missing.push(`${c.currency}→${base} rate (cash)`);
    else cashBase += c.amount * rate;
  }
  const totalBase = vals.reduce((s, v) => s + (v.valueBase ?? 0), 0) + cashBase;
  for (const v of vals) if (v.valueBase !== undefined && totalBase > 0) v.weightPct = (v.valueBase / totalBase) * 100;
  return { positions: vals, cashBase, totalBase, missing: [...new Set(missing)] };
}

/**
 * Money-weighted return (XIRR) of dated cash flows, + into the investor's pocket.
 * Found by bisection between −99.99 % and +1 000 % a year; undefined when the flows do not change sign over that range,
 * or when no time passes between them.
 */
export function xirr(flows: ReadonlyArray<{ date: string; amount: number }>): number | undefined {
  if (flows.length < 2 || !flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return undefined;
  const t0 = Date.parse(flows[0]!.date);
  const yrs = flows.map((f) => (Date.parse(f.date) - t0) / (365.25 * 86_400_000));
  // No time between the flows (a book funded and valued the same day): every rate, or none, solves it — no return a year.
  if (!yrs.some((y) => y !== 0)) return undefined;
  const npv = (r: number) => flows.reduce((s, f, i) => s + f.amount / (1 + r) ** yrs[i]!, 0);
  let lo = -0.9999;
  let hi = 10;
  if (npv(lo) * npv(hi) > 0) return undefined;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}
