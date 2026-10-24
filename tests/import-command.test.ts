import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCommand } from "../src/commands/import.js";
import type { CommandArgs } from "../src/engine.js";
import { ledgerPath, readLedger } from "../src/portfolio/ledger.js";

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
