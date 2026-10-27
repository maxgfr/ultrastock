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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../engine.js";
import { inTransaction, ledgerBackend, type SqlDatabase, StoreUnavailableError, withStore } from "../core/db.js";
import { withFileLock } from "../core/lock.js";
import { homeDir } from "../core/paths.js";

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
  return contentHash(norm).slice(0, 16);
}

/** The transactions of a book, in the order they were recorded (JSONL or SQLite, per store.json). */
export function readLedger(book = "real"): Transaction[] {
  ledgerPath(book);
  if (ledgerBackend() === "sqlite") return withLedgerStore((db) => readSqliteLedger(db, book));
  return readJsonlLedger(book);
}

/** withStore for the ledger: on a Node without node:sqlite, say that THIS ledger lives in the store. */
function withLedgerStore<T>(fn: (db: SqlDatabase) => T): T {
  try {
    return withStore(fn);
  } catch (e) {
    if (e instanceof StoreUnavailableError)
      throw new StoreUnavailableError(
        `${e.message} — but this ledger lives in the SQLite store (store.json): run ultrastock on Node ≥ 22.5, where \`portfolio db off\` writes it back to JSONL`,
        true,
      );
    throw e;
  }
}

/** The JSONL file of a book, whatever the active backend. */
export function readJsonlLedger(book = "real"): Transaction[] {
  const path = ledgerPath(book);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Transaction);
}

function validate(t: Omit<Transaction, "id">): void {
  if (!/^\d{4}-\d{2}-\d{2}/.test(t.date)) throw new Error(`transaction date "${t.date}" is not YYYY-MM-DD`);
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

/**
 * Append transactions under the ledger's lock; duplicates (same content id)
 * are skipped and counted. Returns what was added.
 */
export async function appendTransactions(txs: ReadonlyArray<Omit<Transaction, "id">>, book = "real"): Promise<{ added: Transaction[]; duplicates: number }> {
  const path = ledgerPath(book);
  mkdirSync(join(homeDir(), "ledger"), { recursive: true });
  const sqlite = ledgerBackend() === "sqlite";
  return withFileLock(`${path}.lock`, () => {
    if (sqlite) {
      for (const raw of txs) validate(raw);
      return withLedgerStore((db) =>
        inTransaction(db, () =>
          insertSqliteTransactions(
            db,
            txs.map((raw) => ({ ...raw, id: transactionId(raw) }) as Transaction),
            book,
          ),
        ),
      );
    }
    const seen = new Set(readJsonlLedger(book).map((t) => t.id));
    const added: Transaction[] = [];
    let duplicates = 0;
    for (const raw of txs) {
      validate(raw);
      const t = { ...raw, id: transactionId(raw) } as Transaction;
      if (seen.has(t.id)) {
        duplicates++;
        continue;
      }
      seen.add(t.id);
      added.push(t);
    }
    if (added.length) appendFileSync(path, added.map((t) => `${JSON.stringify(t)}\n`).join(""), { mode: 0o600 });
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
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
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
        const costTotal = t.type === "buy" ? q * t.price! + (t.fee ?? 0) : q * (t.price ?? p.averageCost);
        p.averageCost = (p.averageCost * p.quantity + costTotal) / (p.quantity + q);
        p.quantity += q;
        p.lots.push({ date: t.date, quantity: q, costPerUnit: costTotal / q });
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
 * Newton's method with bisection fallback; undefined when there is no sign change.
 */
export function xirr(flows: ReadonlyArray<{ date: string; amount: number }>): number | undefined {
  if (flows.length < 2 || !flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return undefined;
  const t0 = Date.parse(flows[0]!.date);
  const yrs = flows.map((f) => (Date.parse(f.date) - t0) / (365.25 * 86_400_000));
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
