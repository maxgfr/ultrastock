import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { appendTransactions, ledgerPath, readLedger } from "../src/portfolio/ledger.js";
import { equityPath, readEquity, recordEquity } from "../src/trading/breaker.js";
import { audit, readAudit } from "../src/trading/tickets.js";

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

describe("an append cut short by a crash", () => {
  it("leaves the ledger readable, with a warning, and the next append moves the cut line aside", async () => {
    await appendTransactions([{ date: "2026-01-02", type: "deposit", account: "cto", amount: 1000, currency: "EUR", origin: "manual" }], "paper");
    appendFileSync(ledgerPath("paper"), '{"id":"x","date":"2026-01-0');
    const warnings: string[] = [];
    expect(readLedger("paper", (m) => warnings.push(m))).toHaveLength(1);
    expect(warnings[0]).toMatch(/cut short/);
    await appendTransactions([{ date: "2026-01-03", type: "deposit", account: "cto", amount: 500, currency: "EUR", origin: "manual" }], "paper");
    const after: string[] = [];
    expect(readLedger("paper", (m) => after.push(m)).map((t) => t.amount)).toEqual([1000, 500]);
    expect(after).toEqual([]);
    expect(readFileSync(`${ledgerPath("paper")}.torn`, "utf8")).toBe('{"id":"x","date":"2026-01-0\n');
  });

  it("still refuses a ledger with an unreadable line before others: that is corruption", async () => {
    write(ledgerPath("paper"), 'garbage\n{"id":"a","date":"2026-01-02","type":"deposit","account":"cto","amount":1,"currency":"EUR","origin":"manual"}\n');
    expect(() => readLedger("paper")).toThrow(/line 1: unreadable.*corruption/);
    // A last line that ends with its newline was written whole: also corruption.
    write(ledgerPath("paper"), "garbage\n");
    expect(() => readLedger("paper")).toThrow(/corruption/);
  });

  it("leaves the order audit readable and keeps every whole line on the next append", () => {
    audit({ event: "ticket", id: "t-1" });
    const path = join(homeDir(), "audit", "orders.jsonl");
    appendFileSync(path, '{"at":"2026-');
    const warnings: string[] = [];
    expect(readAudit((m) => warnings.push(m)).map((e) => e.id)).toEqual(["t-1"]);
    expect(warnings).toHaveLength(1);
    audit({ event: "ticket", id: "t-2" });
    expect(readAudit().map((e) => e.id)).toEqual(["t-1", "t-2"]);
    expect(readFileSync(`${path}.torn`, "utf8")).toBe('{"at":"2026-\n');
  });

  it("leaves the equity curve readable and keeps every whole line on the next append", () => {
    recordEquity("paper", 1000, new Date("2026-01-02T10:00:00Z"));
    appendFileSync(equityPath("paper"), '{"at":"2026-01-02T11');
    const warnings: string[] = [];
    expect(readEquity("paper", (m) => warnings.push(m))).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    recordEquity("paper", 990, new Date("2026-01-02T12:00:00Z"));
    expect(readEquity("paper").map((p) => p.equity)).toEqual([1000, 990]);
    // A whole record that only lost its newline is kept, and the next one starts on its own line.
    appendFileSync(equityPath("paper"), '{"at":"2026-01-02T13:00:00.000Z","equity":980}');
    recordEquity("paper", 970, new Date("2026-01-02T14:00:00Z"));
    expect(readEquity("paper").map((p) => p.equity)).toEqual([1000, 990, 980, 970]);
  });
});
