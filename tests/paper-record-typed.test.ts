// live.ts condition 1 — "the paper record is ready" (20 closed paper trades over 30 days, a positive
// expectancy…). `readiness` is fed `closedTradeResults(readLedger("paper"))` and the first buy's date: any row of the
// paper ledger, wherever it came from. `portfolio add buy|sell --book paper --date …` writes such rows with no ticket,
// no gate, no price from anywhere, at any date.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { portfolioCommand } from "../src/commands/trading.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { readLedger } from "../src/portfolio/ledger.js";
import type { BrokerAdapter } from "../src/trading/brokers/types.js";
import { preconditions } from "../src/trading/live.js";
import { type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { createTicket, listTickets, loadTicket, recordCheck } from "../src/trading/tickets.js";
import { closedTradeResults } from "../src/trading/breaker.js";
import { paperRecord, readiness } from "../src/trading/paper.js";
import { readyPaperRecord } from "./helpers/paper-record.js";

const venue: BrokerAdapter = {
  venue: "kraken",
  env: "live",
  bookTop: async () => ({ bid: 99.9, ask: 100, at: new Date().toISOString() }),
  permissions: async () => ({ canTrade: true, canWithdraw: false, source: "apiRestrictions" }),
  balances: async () => [],
  preview: async () => ({ ok: true }),
  submit: async (o) => ({ state: "accepted", clientOrderId: o.clientOrderId }),
  query: async () => undefined,
  cancel: async (_s, id) => ({ state: "cancelled", clientOrderId: id }),
  openOrders: async () => [],
};

const order: Order = {
  account: "kraken",
  symbol: "SOLEUR",
  side: "buy",
  quantity: 1,
  price: 100,
  orderType: "limit",
  currency: "EUR",
  stop: 90,
  assetKind: "crypto",
  venue: "kraken",
};

const portfolio = async (positional: string[], values: Record<string, string>) => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await portfolioCommand({ command: "portfolio", positional, values: { book: "paper", ...values }, bools: new Set() }, true);
  } finally {
    write.mockRestore();
  }
};

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

describe("the paper record a live order waits on", () => {
  it("is not made ready by typing trades into the paper ledger", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    // 41 commands, a minute's work, none of them a paper order:
    await portfolio(["deposit", "paper", "10000"], { date: day(41) });
    for (let i = 0; i < 20; i++) {
      await portfolio(["add", "buy"], { account: "paper", symbol: "AAA", quantity: "1", price: String(100 + i), date: `${day(40 - i)}T10:00:00` });
      await portfolio(["add", "sell"], { account: "paper", symbol: "AAA", quantity: "1", price: String(110 + i), date: `${day(40 - i)}T15:00:00` });
    }
    expect(readLedger("paper")).toHaveLength(41);
    expect(listTickets((t) => t.status === "filled")).toEqual([]); // not one paper order was ever filled

    const t = createTicket(order);
    await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(order), riskReducing: false, notionalBase: 100 });
    const p = await preconditions({ ticket: loadTicket(t.id), venue: "kraken", env: "live", adapter: venue, venueSym: "SOLEUR", micaAuthorised: true });
    expect(p.refusals.map((r) => r.code)).toContain("NOT_READY");
  }, 60_000);

  it("is made of paper tickets' fills, and says what it left out", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    await readyPaperRecord();
    await portfolio(["add", "buy"], { account: "paper", symbol: "BBB", quantity: "1", price: "50", date: "2026-01-02" });
    const rec = paperRecord(readLedger("paper"), listTickets());
    expect(rec.excluded).toHaveLength(1);
    expect(rec.excluded[0]).toMatch(/1 paper ledger row\(s\) not filled by a paper ticket/);
    expect(rec.first).not.toBe("2026-01-02");
    const r = readiness(closedTradeResults(rec.txs), [], rec.first, new Date());
    expect(r.ready).toBe(true);
  }, 60_000);
});
