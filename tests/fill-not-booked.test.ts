// A fill the ledger keeps out as a duplicate is never dropped in silence: a paper fill is then not made at all (the
// ticket stays as it was), a venue fill — real, already done — leaves an audit line saying it is missing.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

let refuseAsDuplicate = false;
vi.mock("../src/portfolio/ledger.js", async (original) => {
  const real = await original<typeof import("../src/portfolio/ledger.js")>();
  return {
    ...real,
    appendTransactions: async (...a: Parameters<typeof real.appendTransactions>) =>
      refuseAsDuplicate ? { added: [], duplicates: a[0].length } : real.appendTransactions(...a),
  };
});

import { clockNow } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import type { BrokerAdapter } from "../src/trading/brokers/types.js";
import { LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";
import { liveSubmit, orderBinding } from "../src/trading/live.js";
import { type Channel, issueCode } from "../src/trading/otp.js";
import { paperSubmit } from "../src/trading/paper.js";
import { planTrade } from "../src/trading/plan.js";
import { type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, readAudit, recordCheck } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
  refuseAsDuplicate = false;
});

describe("a fill the ledger refuses as a duplicate", () => {
  it("is no paper fill: the ticket stays checked", async () => {
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "paper");
    await withFixture("trading-paper-mcpa", async () => {
      const p = await planTrade({ symbol: "MC.PA", account: "cto" });
      const t = createTicket(p.order);
      await recordCheck(t.id, p.gate);
      refuseAsDuplicate = true;
      await expect(paperSubmit(t.id, clockNow())).rejects.toThrow(/already in the paper ledger/);
      expect(loadTicket(t.id).status).toBe("checked");
      expect(loadTicket(t.id).fills).toEqual([]);
    });
  }, 60_000);

  it("of a venue leaves an audit line saying it is not in the ledger", async () => {
    requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
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
    const captured: string[] = [];
    const capture: Channel = (m) => {
      captured.push(m);
      return true;
    };
    const adapter: BrokerAdapter = {
      venue: "kraken",
      env: "test",
      bookTop: async () => ({ bid: 99.9, ask: 100, at: new Date().toISOString() }),
      permissions: async () => ({ canTrade: true, canWithdraw: false, source: "apiRestrictions" }),
      balances: async () => [],
      preview: async () => ({ ok: true }),
      submit: async (o) => ({ state: "filled", clientOrderId: o.clientOrderId, venueOrderId: "V1", filledQuantity: 1, averagePrice: 100, fee: 0.25 }),
      query: async () => undefined,
      cancel: async (_s, id) => ({ state: "cancelled", clientOrderId: id }),
      openOrders: async () => [],
    };
    const t = createTicket(order);
    await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(order), riskReducing: false, notionalBase: 100 });
    await issueCode(t.id, orderBinding(order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
    refuseAsDuplicate = true;
    const r = await liveSubmit({
      ticket: loadTicket(t.id),
      venue: "kraken",
      env: "test",
      adapter,
      venueSym: "SOLEUR",
      code: /^(\d{6})/.exec(captured.at(-1)!)![1]!,
    });
    expect(r.ticket.status).toBe("filled");
    expect(readAudit().filter((e) => e.event === "live-fill-not-booked" && e.ticket === t.id)).toHaveLength(1);
  }, 60_000);
});
