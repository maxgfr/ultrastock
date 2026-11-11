import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCommand } from "../src/commands/import.js";
import type { CommandArgs } from "../src/engine.js";
import { parseStatement } from "../src/portfolio/import/index.js";
import { appendTransactions, buildBook, ledgerPath, readLedger, type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { keepDistinctFills } from "../src/portfolio/import/shared.js";
import { parseGeneric as parseGenericBefore } from "./helpers/generic-before-818a2ef.js";
import { parseKraken as parseKrakenBefore } from "./helpers/kraken-before-c2fdfc7.js";

const fixture = (name: string) => new URL(`./fixtures/import/${name}`, import.meta.url).pathname;

beforeEach(() => {
  // A fresh home per test: the ledger must start empty.
  process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "ultrastock-import-"));
});
afterEach(() => vi.restoreAllMocks());

async function run(file: string, values: Record<string, string>, bools: string[] = [], asJson = false): Promise<string> {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  const args: CommandArgs = { command: "portfolio", positional: ["import", file], values, bools: new Set(bools) };
  try {
    await importCommand(args, asJson);
  } finally {
    vi.restoreAllMocks();
  }
  return out;
}

describe("portfolio import", () => {
  it("--dry-run parses and prints what would be added, and writes nothing", async () => {
    const out = await run(fixture("ibkr-flex.xml"), { format: "ibkr-flex", account: "ibkr" }, ["dry-run"]);
    expect(out).toMatch(/16 transaction\(s\) read, 16 would be added, 0 already in the ledger, 6 row\(s\) skipped — dry run, nothing written/);
    expect(out).toMatch(/\+ 2026-01-06T09:30:00 buy +MC\.PA 2 @ 700 EUR fee 7\.2/);
    expect(out).toMatch(/skipped line 14: asset class OPT/);
    expect(existsSync(ledgerPath("real"))).toBe(false);
  });
  it("imports, then a re-import adds nothing", async () => {
    const first = JSON.parse(await run(fixture("kraken-trades.csv"), { format: "kraken", account: "kraken" }, [], true));
    expect(first.added).toHaveLength(5);
    expect(first.replay).toBe("ok");
    expect(readLedger("real")).toHaveLength(5);
    const again = JSON.parse(await run(fixture("kraken-trades.csv"), { format: "kraken", account: "kraken" }, [], true));
    expect(again).toMatchObject({ added: [], duplicates: 5 });
    // A dry run against a populated book counts what is already there.
    expect(await run(fixture("kraken-trades.csv"), { format: "kraken", account: "kraken" }, ["dry-run"])).toMatch(/0 would be added, 5 already in the ledger/);
    expect(readLedger("real")).toHaveLength(5);
  });
  it("writes to the paper book when asked and takes the crypto quote from --map", async () => {
    const out = JSON.parse(await run(fixture("kraken-ledgers.csv"), { format: "kraken", account: "kraken", book: "paper", map: '{"quote":"USD"}' }, [], true));
    expect(out.added.filter((t: { symbol?: string }) => t.symbol === "BTCUSD")).toHaveLength(2);
    expect(readLedger("paper").length).toBe(out.added.length);
    expect(existsSync(ledgerPath("real"))).toBe(false);
  });
  it("refuses an import the book could not replay, and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ultrastock-import-src-"));
    const file = join(dir, "sell.csv");
    writeFileSync(file, "Date,Type,Ticker,Qty,Price,Ccy\n2026-02-01,Sell,NVDA,4,140,USD\n");
    const map = '{"date":"Date","type":"Type","symbol":"Ticker","quantity":"Qty","price":"Price","currency":"Ccy"}';
    expect(await run(file, { format: "generic", account: "us", map }, ["dry-run"])).toMatch(/warning: the real book would no longer replay: .*missing a buy/);
    await expect(run(file, { format: "generic", account: "us", map })).rejects.toThrow(/not imported: the real book would no longer replay/);
    expect(existsSync(ledgerPath("real"))).toBe(false);
  });
  it("keeps two identical fills apart by their trade id, and an older ledger gains only the one it lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ultrastock-import-src-"));
    const file = join(dir, "fills.xml");
    const trade = (id: string, side: string, qty: number) =>
      `<Trade currency="USD" assetCategory="STK" symbol="NVDA" listingExchange="NASDAQ" tradeID="${id}" dateTime="20260105;153000" quantity="${qty}" tradePrice="100" ibCommission="-1" ibCommissionCurrency="USD" buySell="${side}" levelOfDetail="EXECUTION" />`;
    // Bought 10 in one fill, sold 4 in two fills of 2, same second, same price: listed with the higher id first.
    const rows = [trade("9000", "BUY", 10), trade("9002", "SELL", -2), trade("9001", "SELL", -2)];
    writeFileSync(
      file,
      `<FlexQueryResponse><FlexStatements><FlexStatement><Trades>\n${rows.join("\n")}\n</Trades></FlexStatement></FlexStatements></FlexQueryResponse>`,
    );
    const parsed = parseStatement("ibkr-flex", readFileSync(file, "utf8"), { account: "ibkr" }).transactions;
    // Only the second of the identical fills carries its reference (and so another id); the rest keep today's ids.
    expect(parsed.map((t) => t.ref)).toEqual([undefined, "9002", undefined]);
    expect(new Set(parsed.map((t) => transactionId(t))).size).toBe(3);
    // A ledger written before references were kept: the two sales collapsed into one.
    const legacy = parsed.map(({ ref: _, ...t }) => t);
    expect((await appendTransactions(legacy)).added).toHaveLength(2);
    const re = JSON.parse(await run(file, { format: "ibkr-flex", account: "ibkr" }, [], true));
    expect(re).toMatchObject({ duplicates: 2, replay: "ok" });
    expect(re.added.map((t: Transaction) => [t.type, t.ref])).toEqual([["sell", "9002"]]);
    expect(buildBook(readLedger("real")).positions[0]!.quantity).toBe(6);
    // And again: nothing more.
    expect(JSON.parse(await run(file, { format: "ibkr-flex", account: "ibkr" }, [], true))).toMatchObject({ added: [], duplicates: 3 });
  });
  it("reads a Latin-1 file and a named or file-held map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ultrastock-import-src-"));
    const file = join(dir, "latin1.csv");
    writeFileSync(file, Buffer.from("Date;Opération;Code ISIN;Quantité;Cours;Frais;Montant net;Devise\n05/01/2026;Dépôt;;;;;1 000,00;EUR\n", "latin1"));
    const mapFile = join(dir, "map.json");
    writeFileSync(mapFile, JSON.stringify({ date: "Date", type: "Opération", amount: "Montant net", currency: "Devise" }));
    const out = await run(file, { format: "generic", account: "pea", map: mapFile }, ["dry-run"]);
    expect(out).toMatch(/\+ 2026-01-05 deposit +1000 EUR/);
    expect(out).toMatch(/not UTF-8: read as Latin-1/);
    // A named map whose columns the file lacks says it is best-effort and how to override it.
    await expect(run(file, { format: "generic", account: "pea", map: "boursorama" }, ["dry-run"])).rejects.toThrow(/"Date opération".*best-effort/);
  });
  it("usage errors", async () => {
    await expect(run(fixture("coinbase.csv"), { account: "cb" })).rejects.toThrow(/--format is required/);
    await expect(run(fixture("coinbase.csv"), { format: "csv", account: "cb" })).rejects.toThrow(/invalid --format/);
    await expect(run(fixture("coinbase.csv"), { format: "coinbase" })).rejects.toThrow(/--account/);
    await expect(run(fixture("coinbase.csv"), { format: "coinbase", account: "cb", book: "demo" })).rejects.toThrow(/--book is real or paper/);
    await expect(run(fixture("generic-en.csv"), { format: "generic", account: "x" })).rejects.toThrow(/needs --map/);
    await expect(run(fixture("generic-en.csv"), { format: "generic", account: "x", map: "{nope" })).rejects.toThrow(/JSON column map/);
    await expect(run(fixture("kraken-trades.csv"), { format: "kraken", account: "x", map: '{"date":"x"}' })).rejects.toThrow(/only \{"quote"/);
    await expect(run(fixture("ibkr-flex.xml"), { format: "ibkr-flex", account: "x", map: "{}" })).rejects.toThrow(/does not apply/);
    await expect(run("/no/such/file.csv", { format: "coinbase", account: "cb" })).rejects.toThrow(/no such file/);
    await expect(importCommand({ command: "portfolio", positional: ["import"], values: {}, bools: new Set() }, false)).rejects.toThrow(
      /usage: ultrastock portfolio import/,
    );
  });
});

describe("portfolio import into a ledger an earlier release wrote", () => {
  it("does not add again a 12-hour-clock row stored at the time the reader before 818a2ef gave it, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ultrastock-import-src-"));
    const file = join(dir, "us.csv");
    writeFileSync(
      file,
      ["Date,Action,Symbol,Quantity,Price,Currency", "1/5/2026 10:15:00 AM,Buy,NVDA,10,100,USD", "1/5/2026 2:30:00 PM,Buy,NVDA,10,101,USD"].join("\n"),
    );
    const map = '{"date":"Date","type":"Action","symbol":"Symbol","quantity":"Quantity","price":"Price","currency":"Currency","dateOrder":"MDY","decimal":"."}';
    const old = parseGenericBefore(readFileSync(file, "utf8"), { account: "us", map: JSON.parse(map) });
    await appendTransactions(old.transactions, "real");
    const out = JSON.parse(await run(file, { format: "generic", account: "us", map }, [], true));
    expect(out).toMatchObject({ added: [], duplicates: 2 });
    expect(out.warnings.join(" ")).toMatch(
      /1 row\(s\) are already in the real book as an earlier release of the importer read them .*date 2026-01-05T02:30:00 for 2026-01-05T14:30:00/,
    );
    expect(readLedger("real")).toHaveLength(2);
  });
  it("does not add again a Kraken trade stored under the symbol the reader before c2fdfc7 gave it, and names it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ultrastock-import-src-"));
    const file = join(dir, "trades.csv");
    writeFileSync(
      file,
      '"txid","ordertxid","pair","time","type","ordertype","price","cost","fee","vol","margin","misc","ledgers"\n' +
        '"T1","O1","XXBTZUSD","2024-01-02 10:00:00","buy","limit",40000,40000,0,1,0,"",""\n' +
        '"T2","O2","AVAXXBT","2025-02-03 10:00:00","buy","limit",0.0005,0.05,0,100,0,"",""\n',
    );
    // What that release wrote, through the same reference rule as today.
    await appendTransactions(keepDistinctFills(parseKrakenBefore(readFileSync(file, "utf8"), { account: "kraken" })).transactions, "real");
    const out = JSON.parse(await run(file, { format: "kraken", account: "kraken" }, [], true));
    expect(out).toMatchObject({ added: [], duplicates: 2 });
    expect(out.warnings.join(" ")).toMatch(
      /1 row\(s\) are already in the real book as an earlier release .*AVAXBTC .*\(stored with symbol AVABTC for AVAXBTC\)/,
    );
    expect(readLedger("real").map((t) => t.symbol)).toEqual(["BTCUSD", "AVABTC"]);
  });
});
