// Switching the ledger between its two backends, both ways, without losing a
// transaction: `db init` copies every JSONL book into the store (same ids, so
// running it twice adds nothing) and flips store.json to "sqlite"; `db export`
// writes a store book back to its JSONL file (merging: lines already in the
// file stay where they are, missing ones are appended in recording order);
// `db off` exports every book, then flips store.json back to "jsonl".
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../engine.js";
import {
  inTransaction,
  ledgerBackend,
  SCHEMA_VERSION,
  StoreUnavailableError,
  schemaVersionOf,
  setLedgerBackend,
  sqliteSupported,
  storePath,
  withStore,
} from "../core/db.js";
import { withFileLock } from "../core/lock.js";
import { homeDir } from "../core/paths.js";
import { insertSqliteTransactions, ledgerPath, readJsonlLedger, readSqliteLedger } from "./ledger.js";

/** The books that have a JSONL file. */
export function jsonlBooks(): string[] {
  const dir = join(homeDir(), "ledger");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[a-z0-9-]{1,40}\.jsonl$/.test(f))
    .map((f) => f.replace(/\.jsonl$/, ""))
    .sort();
}

/** The books the store holds transactions for. */
export function storeBooks(): string[] {
  return withStore((db) =>
    db
      .prepare("SELECT DISTINCT book FROM transactions ORDER BY book")
      .all()
      .map((r) => String(r.book)),
  );
}

export interface InitResult {
  path: string;
  schemaVersion: number;
  books: Array<{ book: string; read: number; added: number; duplicates: number }>;
  backend: "sqlite";
}

/** Create (or migrate) the store, import every JSONL book into it, switch the ledger to SQLite. */
export async function initStore(now = new Date()): Promise<InitResult> {
  mkdirSync(join(homeDir(), "ledger"), { recursive: true });
  const books: InitResult["books"] = [];
  for (const book of jsonlBooks()) {
    const r = await withFileLock(`${ledgerPath(book)}.lock`, () => {
      const txs = readJsonlLedger(book);
      const ins = withStore((db) => inTransaction(db, () => insertSqliteTransactions(db, txs, book, now)), { create: true });
      return { book, read: txs.length, added: ins.added.length, duplicates: ins.duplicates };
    });
    books.push(r);
  }
  const schemaVersion = withStore(schemaVersionOf, { create: true });
  setLedgerBackend("sqlite", now);
  return { path: storePath(), schemaVersion, books, backend: "sqlite" };
}

/** Write a store book back to its JSONL file, keeping what the file already has. */
export async function exportBook(book: string): Promise<{ book: string; path: string; inStore: number; inFileBefore: number; appended: number }> {
  const path = ledgerPath(book);
  mkdirSync(join(homeDir(), "ledger"), { recursive: true });
  return withFileLock(`${path}.lock`, () => {
    const stored = withStore((db) => readSqliteLedger(db, book));
    const file = readJsonlLedger(book);
    const have = new Set(file.map((t) => t.id));
    const missing = stored.filter((t) => !have.has(t.id));
    if (missing.length || !existsSync(path)) writeFileAtomic(path, [...file, ...missing].map((t) => `${JSON.stringify(t)}\n`).join(""), 0o600);
    return { book, path, inStore: stored.length, inFileBefore: file.length, appended: missing.length };
  });
}

/** Export every book the store holds (or just `book`). */
export async function exportStore(book?: string) {
  const books = book ? [book] : storeBooks();
  const out = [];
  for (const b of books) out.push(await exportBook(b));
  return out;
}

/** Export every book, then read the ledger from JSONL again. The store keeps snapshots, news and events. */
export async function storeOff(now = new Date()) {
  const exported = existsSync(storePath()) ? await exportStore() : [];
  setLedgerBackend("jsonl", now);
  return { backend: "jsonl" as const, exported };
}

export interface StoreStatus {
  backend: "jsonl" | "sqlite";
  path: string;
  exists: boolean;
  bytes?: number;
  schemaVersion?: number;
  expectedSchemaVersion: number;
  counts?: Record<string, number>;
  books?: Array<{ book: string; transactions: number }>;
  jsonlBooks: string[];
  /** Why the store cannot be opened on this Node, when it cannot. */
  unavailable?: string;
}

export function storeStatus(): StoreStatus {
  const path = storePath();
  const exists = existsSync(path);
  const base: StoreStatus = { backend: ledgerBackend(), path, exists, expectedSchemaVersion: SCHEMA_VERSION, jsonlBooks: jsonlBooks() };
  if (!sqliteSupported()) return { ...base, unavailable: new StoreUnavailableError().message };
  if (!exists) return base;
  return withStore(
    (db) => {
      const schemaVersion = schemaVersionOf(db);
      if (schemaVersion < 1) return { ...base, bytes: statSync(path).size, schemaVersion };
      const count = (t: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0);
      return {
        ...base,
        bytes: statSync(path).size,
        schemaVersion,
        counts: { transactions: count("transactions"), snapshots: count("snapshots"), news_items: count("news_items"), events_seen: count("events_seen") },
        books: db
          .prepare("SELECT book, COUNT(*) AS n FROM transactions GROUP BY book ORDER BY book")
          .all()
          .map((r) => ({ book: String(r.book), transactions: Number(r.n) })),
      };
    },
    { readOnly: true },
  );
}
