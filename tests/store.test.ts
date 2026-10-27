import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portfolioCommand } from "../src/commands/trading.js";
import {
  assertReadOnlySql,
  eventSeen,
  ledgerBackend,
  MIGRATIONS,
  markEventSeen,
  migrate,
  openStore,
  readOnlyQuery,
  SCHEMA_VERSION,
  StoreUnavailableError,
  schemaVersionOf,
  setLedgerBackend,
  setSqliteLoaderForTests,
  sqliteSupported,
  storeAvailable,
  storePath,
  withStore,
} from "../src/core/db.js";
import type { CommandArgs } from "../src/engine.js";
import { appendTransactions, buildBook, ledgerPath, readJsonlLedger, readLedger, type Transaction } from "../src/portfolio/ledger.js";
import { exportStore, initStore, storeOff, storeStatus } from "../src/portfolio/store.js";
import { listNews, markNewsSeen, newsId, readHistory, type SnapshotRow, storeNews, writeSnapshots } from "../src/portfolio/tracking.js";
import { headlineName } from "../src/commands/portfolio-store.js";

const HAS_SQLITE = sqliteSupported();

beforeEach(() => {
  process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "ultrastock-store-"));
});
afterEach(() => {
  setSqliteLoaderForTests(undefined);
  vi.restoreAllMocks();
});

type Raw = Omit<Transaction, "id">;
const TXS: Raw[] = [
  { date: "2026-01-02", type: "deposit", account: "cto", amount: 10_000, currency: "EUR", origin: "manual" },
  { date: "2026-01-10", type: "buy", account: "cto", symbol: "MC.PA", quantity: 3, price: 500, fee: 2, currency: "EUR", origin: "manual" },
  { date: "2026-01-10", type: "buy", account: "cto", symbol: "MC.PA", quantity: 2, price: 510, currency: "EUR", origin: "manual" },
  { date: "2026-02-01", type: "buy", account: "cto", symbol: "AAPL", quantity: 5, price: 200, currency: "USD", origin: "manual", note: "first line" },
  { date: "2026-03-01", type: "sell", account: "cto", symbol: "MC.PA", quantity: 4, price: 560, fee: 3, currency: "EUR", origin: "manual" },
  { date: "2026-04-01", type: "split", account: "cto", symbol: "AAPL", quantity: 2, currency: "USD", origin: "manual" },
  { date: "2026-05-01", type: "dividend", account: "cto", symbol: "AAPL", amount: 4.2, currency: "USD", origin: "manual" },
];

async function run(positional: string[], values: Record<string, string> = {}, bools: string[] = [], asJson = false): Promise<string> {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  const args: CommandArgs = { command: "portfolio", positional, values, bools: new Set(bools) };
  try {
    await portfolioCommand(args, asJson);
  } finally {
    vi.restoreAllMocks();
  }
  return out;
}

describe("read-only query guard", () => {
  it("accepts one SELECT or WITH … SELECT, a trailing semicolon, write words inside strings and comments", () => {
    expect(assertReadOnlySql("select symbol, sum(quantity) from transactions group by symbol;")).toMatch(/group by symbol$/);
    expect(() => assertReadOnlySql("WITH h AS (SELECT * FROM snapshots) SELECT * FROM h")).not.toThrow();
    expect(() => assertReadOnlySql("select * from transactions where note = 'delete; drop table x'")).not.toThrow();
    expect(() => assertReadOnlySql("select 1 -- delete everything\n")).not.toThrow();
    expect(() => assertReadOnlySql("select replace(symbol, '.PA', '') from transactions")).not.toThrow();
    expect(() => assertReadOnlySql("select * from pragma_table_info('transactions')")).not.toThrow();
  });
  it("rejects writes, attachments, pragmas, several statements and quoting tricks", () => {
    for (const sql of [
      "insert into transactions(id) values ('x')",
      "update transactions set price = 0",
      "delete from transactions",
      "replace into news_items(id) values ('x')",
      "attach database '/tmp/x.db' as x",
      "pragma user_version = 9",
      "select 1; delete from transactions",
      "select 1; select 2",
      "with x as (select 1) delete from transactions",
      "with x as (select 1) insert into events_seen select * from x",
      "select 1 -- '\n; delete from transactions; --'",
      "select 1 /* unterminated",
      "select 'unterminated",
      "create table t(a)",
      "drop table snapshots",
      "vacuum",
      "",
    ])
      expect(() => assertReadOnlySql(sql), sql).toThrow();
  });
});

describe("without node:sqlite (Node < 22.5)", () => {
  it("says what is needed, and the JSONL ledger keeps working", async () => {
    setSqliteLoaderForTests(() => {
      throw new Error("No such built-in module: node:sqlite");
    });
    expect(sqliteSupported()).toBe(false);
    expect(storeAvailable()).toBe(false);
    expect(() => openStore({ create: true })).toThrow(StoreUnavailableError);
    expect(() => openStore({ create: true })).toThrow(/needs Node ≥ 22\.5.*the JSONL ledger keeps working/);
    await expect(initStore()).rejects.toThrow(/needs Node ≥ 22\.5/);
    expect(ledgerBackend()).toBe("jsonl");
    const r = await appendTransactions(TXS.slice(0, 2));
    expect(r.added).toHaveLength(2);
    expect(readLedger()).toHaveLength(2);
    expect(storeStatus().unavailable).toMatch(/Node ≥ 22\.5/);
  });
  it("a ledger switched to SQLite names the way back", () => {
    setLedgerBackend("sqlite");
    setSqliteLoaderForTests(() => ({}));
    expect(() => readLedger()).toThrow(/this ledger lives in the SQLite store.*db off/);
  });
});

describe.skipIf(!HAS_SQLITE)("SQLite store", () => {
  it("migrations are versioned and idempotent", () => {
    const db = openStore({ create: true });
    try {
      expect(schemaVersionOf(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
      expect(migrate(db)).toEqual([]);
      expect(schemaVersionOf(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
    withStore((d) => expect(migrate(d)).toEqual([]));
    expect(statSync(storePath()).mode & 0o777).toBe(0o600);
  });

  it("needs db init before use", () => {
    expect(() => openStore()).toThrow(/portfolio db init/);
    expect(storeAvailable()).toBe(false);
  });

  it("switches the ledger both ways with identical books and ids", async () => {
    await appendTransactions(TXS.slice(0, 4));
    await appendTransactions(TXS.slice(0, 2), "paper");
    const jsonlBook = buildBook(readLedger());
    const jsonlIds = readLedger().map((t) => t.id);

    const init = await initStore();
    expect(init.books).toEqual([
      { book: "paper", read: 2, added: 2, duplicates: 0 },
      { book: "real", read: 4, added: 4, duplicates: 0 },
    ]);
    expect(ledgerBackend()).toBe("sqlite");
    expect(readLedger().map((t) => t.id)).toEqual(jsonlIds);
    expect(buildBook(readLedger())).toEqual(jsonlBook);
    expect(buildBook(readLedger("paper"))).toEqual(buildBook(readJsonlLedger("paper")));

    // Idempotent: a second init imports nothing.
    expect((await initStore()).books.every((b) => b.added === 0 && b.duplicates === b.read)).toBe(true);

    // New transactions go to the store, not the JSONL file.
    const r = await appendTransactions(TXS.slice(4));
    expect(r.added).toHaveLength(3);
    expect(readJsonlLedger()).toHaveLength(4);
    const sqliteBook = buildBook(readLedger());
    expect(readLedger()).toHaveLength(7);

    const off = await storeOff();
    expect(off.exported.find((e) => e.book === "real")).toMatchObject({ inStore: 7, inFileBefore: 4, appended: 3 });
    expect(ledgerBackend()).toBe("jsonl");
    expect(buildBook(readLedger())).toEqual(sqliteBook);
    expect(readLedger()).toEqual(
      withStore((db) => db.prepare("SELECT doc FROM transactions WHERE book = 'real' ORDER BY seq").all()).map((x) => JSON.parse(String(x.doc))),
    );
    expect(statSync(ledgerPath()).mode & 0o777).toBe(0o600);
    // Exporting again appends nothing.
    expect((await exportStore("real"))[0]!.appended).toBe(0);
    expect(readFileSync(ledgerPath(), "utf8").trim().split("\n")).toHaveLength(7);
  });

  it("de-duplicates by content id and stays append-only", async () => {
    await initStore();
    const a = await appendTransactions([TXS[0]!, TXS[0]!, TXS[1]!]);
    expect(a.added).toHaveLength(2);
    expect(a.duplicates).toBe(1);
    const b = await appendTransactions(TXS.slice(0, 2));
    expect(b).toEqual({ added: [], duplicates: 2 });
    await expect(appendTransactions([{ ...TXS[1]!, quantity: -1 }])).rejects.toThrow(/positive quantity/);
    withStore((db) => {
      expect(() => db.exec("UPDATE transactions SET price = 1")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM transactions")).toThrow(/append-only/);
    });
    expect(readLedger()).toHaveLength(2);
  });

  it("db query runs one SELECT on a read-only handle, and refuses the rest", async () => {
    await appendTransactions(TXS);
    await initStore();
    const q = readOnlyQuery("select symbol, sum(quantity) as q from transactions where symbol is not null and type = 'buy' group by symbol order by symbol");
    expect(q.rows).toEqual([
      { symbol: "AAPL", q: 5 },
      { symbol: "MC.PA", q: 5 },
    ]);
    expect(readOnlyQuery("select * from transactions", 2)).toMatchObject({ truncated: true });
    expect(() => readOnlyQuery("delete from transactions")).toThrow();
    // Even past the guard, the handle itself cannot write.
    const ro = openStore({ readOnly: true });
    try {
      expect(() => ro.exec("INSERT INTO events_seen (event_id, first_seen_at) VALUES ('x', 'y')")).toThrow();
    } finally {
      ro.close();
    }
    const out = await run(["db", "query", "select count(*) as n from transactions"]);
    expect(JSON.parse(out).rows).toEqual([{ n: 7 }]);
    const status = JSON.parse(await run(["db", "status"], {}, [], true));
    expect(status).toMatchObject({ backend: "sqlite", schemaVersion: SCHEMA_VERSION, counts: { transactions: 7 } });
  });

  it("snapshots are one row per position per day; a missing price never overwrites a known one", async () => {
    await initStore();
    const row = (over: Partial<SnapshotRow>): SnapshotRow => ({
      date: "2026-03-02",
      book: "real",
      account: "cto",
      symbol: "MC.PA",
      quantity: 2,
      price: 500,
      currency: "EUR",
      cost: 900,
      value_base: 1000,
      fx: 1,
      source: "euronext",
      ...over,
    });
    withStore((db) => {
      writeSnapshots(db, [row({})]);
      writeSnapshots(db, [row({})]);
      writeSnapshots(db, [row({ price: null, value_base: null, source: "missing" })]);
      expect(db.prepare("SELECT COUNT(*) AS n, MAX(price) AS p FROM snapshots").get()).toEqual({ n: 1, p: 500 });
      writeSnapshots(db, [row({ price: 520, value_base: 1040 })]);
      expect(db.prepare("SELECT price FROM snapshots").get()).toEqual({ price: 520 });
      writeSnapshots(db, [row({ date: "2026-03-03", price: 400, value_base: 800 }), row({ date: "2026-03-04", price: 450, value_base: 900 })]);
      writeSnapshots(db, [row({ date: "2026-03-05", price: null, value_base: null, source: "missing" })]);
      const h = readHistory(db, "real", "2026-01-01");
      expect(h.points.map((p) => p.date)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]);
      expect(h.points.at(-1)!.complete).toBe(false);
      expect(h.last!.date).toBe("2026-03-04");
      expect(h.maxDrawdownPct).toBeCloseTo((800 / 1040 - 1) * 100, 10);
      expect(h.currentDrawdownPct).toBeCloseTo((900 / 1040 - 1) * 100, 10);
      expect(h.last!.pnlBase).toBe(0);
      expect(readHistory(db, "real", "2026-01-01", "AAPL").points).toEqual([]);
    });
  });

  it("news: one item per canonical URL, NEW until marked seen, titles sanitised", async () => {
    await initStore();
    const now = new Date("2026-10-27T08:00:00Z");
    withStore((db) => {
      const first = storeNews(
        db,
        "MC.PA",
        [
          { title: "LVMH results\u0007 <<<beat>>>", url: "https://example.com/a?utm_source=x", source: "Pub", published: "2026-10-26T10:00:00Z" },
          { title: "Older", url: "https://example.com/b", published: "2026-10-25T10:00:00Z" },
        ],
        now,
      );
      expect(first).toHaveLength(2);
      const again = storeNews(db, "MC.PA", [{ title: "LVMH results", url: "https://example.com/a?utm_source=x" }], now);
      expect(again).toEqual([]);
      const items = listNews(db, ["MC.PA"], "2026-10-20");
      expect(items.map((i) => i.title)).toEqual(["LVMH results beat", "Older"]);
      expect(items.every((i) => !i.seen)).toBe(true);
      expect(markNewsSeen(db, [items[1]!.id], now)).toBe(1);
      storeNews(db, "MC.PA", [{ title: "Fresh", url: "https://example.com/c", published: "2026-10-27T07:00:00Z" }], now);
      const next = listNews(db, ["MC.PA"], "2026-10-20");
      expect(next.map((i) => [i.title, i.seen])).toEqual([
        ["Fresh", false],
        ["LVMH results beat", false],
        ["Older", true],
      ]);
      expect(listNews(db, ["MC.PA"], "2026-10-26T12:00:00Z").map((i) => i.title)).toEqual(["Fresh"]);
    });
    expect(newsId("https://example.com/a")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("events_seen helpers", async () => {
    await initStore();
    expect(storeAvailable()).toBe(true);
    expect(eventSeen("fomc-2026-11")).toBe(false);
    expect(markEventSeen("fomc-2026-11", { note: "FOMC" })).toBe(true);
    expect(markEventSeen("fomc-2026-11", { alerted: true })).toBe(false);
    expect(eventSeen("fomc-2026-11")).toBe(true);
    expect(readOnlyQuery("select event_id, note, alerted_at is not null as alerted from events_seen").rows).toEqual([
      { event_id: "fomc-2026-11", note: "FOMC", alerted: 1 },
    ]);
  });

  it("track, history and news need the store first", async () => {
    await expect(run(["track"])).rejects.toThrow(/portfolio db init/);
    await expect(run(["history"])).rejects.toThrow(/portfolio db init/);
    await expect(run(["news"])).rejects.toThrow(/portfolio db init/);
    expect(existsSync(storePath())).toBe(false);
    await initStore();
    expect(await run(["history"])).toMatch(/no snapshot .* run `ultrastock portfolio track`/);
  });
});

describe("headline names", () => {
  it("drops share classes and legal forms", () => {
    expect(headlineName("Apple Inc. Common Stock")).toBe("Apple");
    expect(headlineName("Alphabet Inc. Class A Common Stock")).toBe("Alphabet");
    expect(headlineName("TotalEnergies SE")).toBe("TotalEnergies");
    expect(headlineName("LVMH")).toBe("LVMH");
  });
});
