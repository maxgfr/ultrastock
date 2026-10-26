import { describe, expect, it } from "vitest";
import { clockNow } from "../src/core/net.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions, buildBook, readLedger } from "../src/portfolio/ledger.js";
import { feeFor, paperSubmit, readiness, walkBook } from "../src/trading/paper.js";
import { gateContextFor } from "../src/trading/context.js";
import { planTrade } from "../src/trading/plan.js";
import { riskGate } from "../src/trading/riskgate.js";
import { CHECK_TTL_MS, createTicket, executionRefusal, listTickets, loadTicket, readAudit, recordCheck, transition } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";

describe("paper engine pieces", () => {
  it("walks an order book and charges fees by market", () => {
    expect(
      walkBook(
        [
          [100, 1],
          [101, 2],
        ],
        2,
      ),
    ).toEqual({ price: 100.5, levels: 2 });
    expect(walkBook([[100, 1]], 2)).toBeUndefined();
    expect(feeFor("euronext", 2, 383)).toBe(2);
    expect(feeFor("us", 1000, 10)).toBeCloseTo(5, 10);
    expect(feeFor("crypto", 1, 80_000)).toBeCloseTo(80, 10);
  });
  it("judges readiness on trades, time, expectancy, profit factor and drawdown", () => {
    const trades = Array.from({ length: 20 }, (_, i) => ({ date: `2026-0${1 + Math.floor(i / 10)}-1${i % 10}`, pnl: i % 3 === 0 ? -50 : 80 }));
    const r = readiness(
      trades,
      [
        { at: "a", equity: 100 },
        { at: "b", equity: 95 },
        { at: "c", equity: 110 },
      ],
      "2026-01-10",
      new Date("2026-03-01"),
    );
    expect(r.ready).toBe(true);
    expect(readiness([], [], undefined).ready).toBe(false);
  });
});

describe("tickets", () => {
  const order = {
    account: "cto",
    symbol: "MC.PA",
    side: "buy" as const,
    quantity: 1,
    price: 383,
    orderType: "limit" as const,
    currency: "EUR",
    stop: 366,
    assetKind: "equity" as const,
    venue: "paper",
  };
  it("refuses an unchecked, stale, changed or expired ticket", async () => {
    const t = createTicket(order, { now: new Date("2026-10-24T10:00:00Z") });
    expect(executionRefusal(t)).toMatch(/not checked/);
    const gate = { verdict: "pass" as const, checks: [], fingerprint: t.fingerprint, riskReducing: false, notionalBase: 383 };
    const checked = await recordCheck(t.id, gate, new Date("2026-10-24T10:00:00Z"));
    expect(executionRefusal(checked, new Date("2026-10-24T10:05:00Z"))).toBeUndefined();
    expect(executionRefusal(checked, new Date(Date.parse("2026-10-24T10:00:00Z") + CHECK_TTL_MS + 1))).toMatch(/older than/);
    expect(executionRefusal({ ...checked, order: { ...checked.order, quantity: 9 } }, new Date("2026-10-24T10:05:00Z"))).toMatch(/changed/);
    expect(executionRefusal({ ...checked, validUntil: "2026-10-24T10:01:00Z" }, new Date("2026-10-24T10:05:00Z"))).toMatch(/expired/);
    await expect(recordCheck(t.id, { ...gate, fingerprint: "other" })).rejects.toThrow(/different order/);
    await transition(t.id, "cancelled", "test");
    expect(loadTicket(t.id).history.map((h) => h.to)).toEqual(["draft", "checked", "cancelled"]);
    expect(
      readAudit()
        .filter((e) => e.id === t.id)
        .map((e) => e.to),
    ).toEqual(["draft", "checked", "cancelled"]);
  });
});

describe("paper flow on a recorded fixture", () => {
  it("plans within the limits, checks, fills, and books the trade", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "paper");
    await withFixture("trading-paper-mcpa", async () => {
      const now = clockNow();
      const p = await planTrade({ symbol: "MC.PA", account: "cto", now });
      expect(p.verdict).toBe("ready");
      expect(p.quantity).toBeGreaterThan(0);
      expect(p.positionPct).toBeLessThanOrEqual(5 + 1e-9);
      expect(p.riskPct!).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(String(p.stop)).not.toMatch(/0000000/);
      const t = createTicket(p.order, { now });
      await recordCheck(t.id, p.gate, now);
      // Re-checking the ticket must not count its own order twice (once as pending).
      const again = riskGate(t.order, (await gateContextFor(t.order, { now, ticketId: t.id })).ctx);
      expect(again.verdict).toBe("pass");
      const twice = riskGate(t.order, (await gateContextFor(t.order, { now })).ctx);
      expect(twice.checks.find((c) => c.code === "POSITION_PCT")!.reason).not.toBe(again.checks.find((c) => c.code === "POSITION_PCT")!.reason);
      const r = await paperSubmit(t.id, now);
      expect(r.outcome.kind).toBe("fill");
      expect(r.ticket.status).toBe("filled");
      const book = buildBook(readLedger("paper"));
      expect(book.positions.find((x) => x.symbol === "MC.PA")!.quantity).toBe(p.quantity);
      await expect(paperSubmit(t.id, now)).rejects.toThrow(/filled, not checked/);
      // Selling more than the paper book holds is refused before anything is booked.
      const s = createTicket({ ...p.order, side: "sell", quantity: p.quantity + 5, stop: undefined }, { now: new Date(now.getTime() + 1000) });
      await recordCheck(s.id, { verdict: "pass", checks: [], fingerprint: s.fingerprint, riskReducing: false, notionalBase: 0 }, now);
      await expect(paperSubmit(s.id, now)).rejects.toThrow(/cannot sell/);
      expect(listTickets((x) => x.status === "filled")).toHaveLength(1);
    });
  });
});
