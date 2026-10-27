// The local SQLite store (opt-in): ULTRASTOCK_HOME/ultrastock.db, mode 0600,
// on the user's machine and nowhere else. It holds the ledger once switched on
// (`ultrastock portfolio db init`), the daily snapshots of the book
// (`portfolio track`), the headlines kept for the holdings (`portfolio news`)
// and the events already seen (`events_seen`, for the events watcher).
//
// It uses Node's built-in `node:sqlite` (Node >= 22.5; unflagged from 22.13 /
// 23.4), loaded LAZILY at call time: the published bundle's floor is Node 18,
// where nothing here is ever loaded unless the user asks for the store — and
// then it fails with a clear message while the JSONL ledger keeps working.
//
// Which backend the LEDGER uses is one rule, readable without SQLite:
// ULTRASTOCK_HOME/store.json says {"ledger":"sqlite"} (written by `db init`,
// set back to "jsonl" by `db off` after an export). The database file may
// exist with the ledger on JSONL — snapshots, news and events still live there.
//
// API for other modules (keep it tiny):
//   sqliteSupported()        this Node can load node:sqlite
//   storeAvailable()         supported AND the store was initialised (the db file exists)
//   openStore(opts?)         an open, migrated handle — close it (or use withStore)
//   withStore(fn, opts?)     open, run, close
//   markEventSeen(id, opts?) record an event id; true when it was new
//   eventSeen(id)            whether an event id was recorded
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { writeFileAtomic } from "../engine.js";
import { homeDir } from "./paths.js";

/** The slice of node:sqlite's DatabaseSync this code uses (the repo's @types/node predates it). */
export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
  all(...params: SqlValue[]): Array<Record<string, SqlValue>>;
}
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}
export type SqlValue = string | number | bigint | null | Uint8Array;
type SqliteModule = { DatabaseSync: new (path: string, opts?: { readOnly?: boolean; open?: boolean }) => SqlDatabase };

export const SQLITE_UNAVAILABLE =
  "the SQLite store needs Node ≥ 22.5 (unflagged from 22.13) with node:sqlite — the JSONL ledger keeps working; upgrade Node to use `portfolio db`";

export class StoreUnavailableError extends Error {
  constructor(detail?: string, verbatim = false) {
    super(verbatim && detail ? detail : detail ? `${SQLITE_UNAVAILABLE} (${detail})` : SQLITE_UNAVAILABLE);
    this.name = "StoreUnavailableError";
  }
}

let loader: () => SqliteModule = () => createRequire(import.meta.url)("node:sqlite") as SqliteModule;
let loaded: SqliteModule | undefined;

/** Test seam: replace how node:sqlite is loaded (undefined restores the default). */
export function setSqliteLoaderForTests(fn: (() => unknown) | undefined): void {
  loader = (fn as () => SqliteModule) ?? (() => createRequire(import.meta.url)("node:sqlite") as SqliteModule);
  loaded = undefined;
}

function sqlite(): SqliteModule {
  if (loaded) return loaded;
  try {
    const m = loader();
    if (typeof m?.DatabaseSync !== "function") throw new Error("node:sqlite has no DatabaseSync");
    loaded = m;
    return m;
  } catch (e) {
    throw new StoreUnavailableError(`Node ${process.versions.node}: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** This Node can load node:sqlite. */
export function sqliteSupported(): boolean {
  try {
    sqlite();
    return true;
  } catch {
    return false;
  }
}

export const storePath = (): string => join(homeDir(), "ultrastock.db");
const markerPath = (): string => join(homeDir(), "store.json");

/** The store exists (db init was run) and this Node can open it. */
export function storeAvailable(): boolean {
  return existsSync(storePath()) && sqliteSupported();
}

// ---- schema ------------------------------------------------------------------

/**
 * Migrations, in order: MIGRATIONS[i] takes the schema to version i + 1
 * (PRAGMA user_version). Never edit a shipped migration — append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE transactions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    book TEXT NOT NULL,
    id TEXT NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    account TEXT NOT NULL,
    symbol TEXT,
    isin TEXT,
    quantity REAL,
    price REAL,
    amount REAL,
    fee REAL,
    currency TEXT NOT NULL,
    fx_to_base REAL,
    note TEXT,
    origin TEXT NOT NULL,
    doc TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (book, id)
  );
  CREATE INDEX transactions_book_date ON transactions (book, date);
  CREATE INDEX transactions_symbol ON transactions (symbol);
  CREATE TRIGGER transactions_no_update BEFORE UPDATE ON transactions
    BEGIN SELECT RAISE(ABORT, 'the ledger is append-only: add a corrective transaction'); END;
  CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions
    BEGIN SELECT RAISE(ABORT, 'the ledger is append-only: add a corrective transaction'); END;

  CREATE TABLE snapshots (
    date TEXT NOT NULL,
    book TEXT NOT NULL,
    account TEXT NOT NULL,
    symbol TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL,
    currency TEXT NOT NULL,
    cost REAL,
    value_base REAL,
    fx REAL,
    source TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (date, book, account, symbol)
  );

  CREATE TABLE news_items (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    source TEXT,
    published_at TEXT,
    first_seen_at TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    seen_at TEXT
  );
  CREATE INDEX news_items_subject ON news_items (subject, published_at);

  CREATE TABLE events_seen (
    event_id TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL,
    alerted_at TEXT,
    note TEXT
  );
  `,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

const userVersion = (db: SqlDatabase): number => Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);

/** Bring a database to SCHEMA_VERSION; running it again is a no-op. Returns the versions applied. */
export function migrate(db: SqlDatabase): number[] {
  const applied: number[] = [];
  const current = userVersion(db);
  if (current > SCHEMA_VERSION)
    throw new Error(`${storePath()} has schema version ${current}, newer than this ultrastock (${SCHEMA_VERSION}) — update ultrastock`);
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v - 1]!);
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec("COMMIT");
      applied.push(v);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return applied;
}

/**
 * Open the store, migrated to the current schema. Throws StoreUnavailableError
 * on a Node without node:sqlite, and a "run db init" error when the store was
 * never created (unless `create`). readOnly opens without migrating or writing.
 */
export function openStore(opts: { readOnly?: boolean; create?: boolean } = {}): SqlDatabase {
  const { DatabaseSync } = sqlite();
  const path = storePath();
  if (!existsSync(path)) {
    if (!opts.create || opts.readOnly) throw new Error(`no local store at ${path}: run \`ultrastock portfolio db init\` first`);
    mkdirSync(homeDir(), { recursive: true });
    closeSync(openSync(path, "a", 0o600));
  }
  const db = new DatabaseSync(path, opts.readOnly ? { readOnly: true } : {});
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (opts.readOnly) db.exec("PRAGMA query_only = ON");
    else {
      db.exec("PRAGMA foreign_keys = ON");
      migrate(db);
      chmodSync(path, 0o600);
    }
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** Open the store, run `fn`, close it. */
export function withStore<T>(fn: (db: SqlDatabase) => T, opts?: { readOnly?: boolean; create?: boolean }): T {
  const db = openStore(opts);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Run `fn` in one write transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK on error). */
export function inTransaction<T>(db: SqlDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const schemaVersionOf = (db: SqlDatabase): number => userVersion(db);

// ---- ledger backend marker -----------------------------------------------------

export type LedgerBackend = "jsonl" | "sqlite";

/** The ledger's backend: "sqlite" only when store.json says so (db init), else "jsonl". */
export function ledgerBackend(): LedgerBackend {
  const p = markerPath();
  if (!existsSync(p)) return "jsonl";
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { ledger?: string }).ledger === "sqlite" ? "sqlite" : "jsonl";
  } catch {
    throw new Error(`${p} is not valid JSON — fix it or delete it (the ledger then reads JSONL)`);
  }
}

export function setLedgerBackend(backend: LedgerBackend, now = new Date()): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileAtomic(markerPath(), `${JSON.stringify({ ledger: backend, since: now.toISOString(), db: storePath() }, null, 2)}\n`, 0o600);
}

// ---- read-only query (agent-facing) --------------------------------------------

const WRITE_WORDS =
  /\b(insert|update|delete|replace(?!\s*\()|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b/i;

/**
 * The query with string literals, quoted identifiers and comments blanked out,
 * in one left-to-right pass (so a quote inside a comment, or `--` inside a
 * string, cannot hide a statement from the guard). Throws on an unterminated
 * literal.
 */
function sqlSkeleton(sql: string): string {
  let out = "";
  let i = 0;
  const closers: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new Error("an unterminated /* comment in the query");
      i = end + 2;
      out += " ";
    } else if (c in closers) {
      const close = closers[c]!;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) throw new Error(`an unterminated ${c} in the query`);
        // '' inside a string (and "" inside an identifier) is an escaped quote.
        if ((close === "'" || close === '"') && sql[k + 1] === close) {
          j = k + 2;
          continue;
        }
        i = k + 1;
        break;
      }
      out += c === "'" ? "''" : '""';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Throws unless `sql` is ONE SELECT (or WITH … SELECT) statement with no write keyword. */
export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) throw new Error("an empty query");
  const sk = sqlSkeleton(trimmed);
  if (sk.includes(";")) throw new Error("one statement only: no `;` inside the query");
  if (!/^\s*(select|with)\b/i.test(sk)) throw new Error("only a SELECT (or WITH … SELECT) is allowed");
  const w = WRITE_WORDS.exec(sk);
  if (w) throw new Error(`a read-only query may not contain ${w[1]!.toUpperCase()}`);
  return trimmed;
}

/** Run one guarded SELECT on a read-only handle; rows capped at `limit`. */
export function readOnlyQuery(sql: string, limit = 1000): { columns: string[]; rows: Array<Record<string, SqlValue>>; truncated: boolean } {
  const q = assertReadOnlySql(sql);
  return withStore(
    (db) => {
      const rows: Array<Record<string, SqlValue>> = [];
      let truncated = false;
      const stmt = db.prepare(q) as SqlStatement & { iterate?: () => Iterable<Record<string, SqlValue>> };
      const it = stmt.iterate ? stmt.iterate() : stmt.all();
      for (const r of it) {
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        const plain: Record<string, SqlValue> = {};
        for (const [k, v] of Object.entries(r)) plain[k] = typeof v === "bigint" ? Number(v) : v;
        rows.push(plain);
      }
      return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, truncated };
    },
    { readOnly: true },
  );
}

// ---- events_seen (for the events watcher) -------------------------------------

/** Record an event id as seen (and alerted, when asked). True when the id was new. */
export function markEventSeen(id: string, opts: { alerted?: boolean; note?: string; now?: Date } = {}): boolean {
  const at = (opts.now ?? new Date()).toISOString();
  return withStore((db) => {
    const r = db
      .prepare("INSERT INTO events_seen (event_id, first_seen_at, alerted_at, note) VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING")
      .run(id, at, opts.alerted ? at : null, opts.note ?? null);
    const fresh = Number(r.changes) > 0;
    if (!fresh && (opts.alerted || opts.note !== undefined))
      db.prepare("UPDATE events_seen SET alerted_at = COALESCE(alerted_at, ?), note = COALESCE(?, note) WHERE event_id = ?").run(
        opts.alerted ? at : null,
        opts.note ?? null,
        id,
      );
    return fresh;
  });
}

/** Whether an event id was already recorded. */
export function eventSeen(id: string): boolean {
  return withStore((db) => db.prepare("SELECT 1 AS hit FROM events_seen WHERE event_id = ?").get(id) !== undefined);
}
