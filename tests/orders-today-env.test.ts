// A ticket tried on the testnet first (refused there), then sent for real, is a real order of the day.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { readLedger } from "../src/portfolio/ledger.js";
import type { BrokerAdapter, Environment, LiveOrder, OrderResult } from "../src/trading/brokers/types.js";
import { ordersToday } from "../src/trading/context.js";
import { LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";
import { LIVE_SWITCH_BINDING, LIVE_SWITCH_SUBJECT, liveSubmit, orderBinding, switchLiveOn } from "../src/trading/live.js";
import { type Channel, issueCode } from "../src/trading/otp.js";
import { killSwitchPath, type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, readAudit, recordCheck } from "../src/trading/tickets.js";
import { readyPaperRecord } from "./helpers/paper-record.js";

let captured: string[] = [];
const capture: Channel = (m) => {
  captured.push(m);
  return true;
};
const codeFrom = () => /^(\d{6})/.exec(captured.at(-1) ?? "")![1]!;

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

function venue(env: Environment, submit: (o: LiveOrder) => OrderResult): BrokerAdapter {
  return {
    venue: "kraken",
    env,
    bookTop: async () => ({ bid: 99.9, ask: 100, at: new Date().toISOString() }),
    permissions: async () => ({ canTrade: true, canWithdraw: false, source: "apiRestrictions" }),
    balances: async () => [],
    preview: async () => ({ ok: true }),
    submit: async (o) => submit(o),
    query: async () => undefined,
    cancel: async (_s, id) => ({ state: "cancelled", clientOrderId: id }),
    openOrders: async () => [],
  };
}

const pass = () => ({ verdict: "pass" as const, checks: [], fingerprint: orderFingerprint(order), riskReducing: false, notionalBase: 100 });

const liveBefore = process.env.ULTRASTOCK_LIVE;
beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
  requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
  captured = [];
});
afterEach(() => {
  rmSync(killSwitchPath(), { force: true });
  if (liveBefore === undefined) delete process.env.ULTRASTOCK_LIVE;
  else process.env.ULTRASTOCK_LIVE = liveBefore;
});

// Live orders need Node ≥ 22 (the NODE precondition): on an older Node the real order this test places is refused.
const LIVE_NODE = Number(process.versions.node.split(".")[0]) >= 22;

describe("the orders of the day (the profile's maxOrdersPerDay)", () => {
  it.skipIf(!LIVE_NODE)(
    "count a real order whose ticket was first refused by the testnet",
    async () => {
      const t = createTicket(order);
      await recordCheck(t.id, pass());

      // 1. `broker submit <t>` — `--env test` is the default — and the testnet refuses the order (no test funds, a lot size…).
      await issueCode(t.id, orderBinding(order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
      const tried = await liveSubmit({
        ticket: loadTicket(t.id),
        venue: "kraken",
        env: "test",
        adapter: venue("test", (o) => ({ state: "rejected", clientOrderId: o.clientOrderId, message: "insufficient test funds" })),
        venueSym: "SOLEUR",
        code: codeFrom(),
      });
      expect(tried.refusals).toEqual([]);
      expect(tried.ticket.status).toBe("blocked");

      // 2. `ticket check <t>` again, then the real thing: `broker submit <t> --env live --code …`.
      await recordCheck(t.id, pass());
      await readyPaperRecord();
      process.env.ULTRASTOCK_LIVE = "1";
      await issueCode(LIVE_SWITCH_SUBJECT, LIVE_SWITCH_BINDING, "live", [["capture", capture]]);
      switchLiveOn(codeFrom());
      await issueCode(t.id, orderBinding(order, "kraken", "live", "SOLEUR"), "order", [["capture", capture]]);
      const real = await liveSubmit({
        ticket: loadTicket(t.id),
        venue: "kraken",
        env: "live",
        adapter: venue("live", (o) => ({
          state: "filled",
          clientOrderId: o.clientOrderId,
          venueOrderId: "V1",
          filledQuantity: 1,
          averagePrice: 100,
          fee: 0.26,
        })),
        venueSym: "SOLEUR",
        code: codeFrom(),
        micaAuthorised: true,
      });
      expect(real.refusals).toEqual([]);
      expect(real.ticket.status).toBe("filled");
      // Real money moved: the real book holds the buy.
      expect(readLedger("real").filter((x) => x.origin === `ticket:${t.id}`)).toHaveLength(1);

      // Control: a second real order today, on a ticket that never saw the testnet.
      const other: Order = { ...order, quantity: 1.5 };
      const t2 = createTicket(other, { now: new Date(Date.now() - 60_000) });
      await recordCheck(t2.id, { ...pass(), fingerprint: orderFingerprint(other), notionalBase: 150 });
      await issueCode(t2.id, orderBinding(other, "kraken", "live", "SOLEUR"), "order", [["capture", capture]]);
      const second = await liveSubmit({
        ticket: loadTicket(t2.id),
        venue: "kraken",
        env: "live",
        adapter: venue("live", (o) => ({
          state: "filled",
          clientOrderId: o.clientOrderId,
          venueOrderId: "V2",
          filledQuantity: 1.5,
          averagePrice: 100,
          fee: 0.39,
        })),
        venueSym: "SOLEUR",
        code: codeFrom(),
        micaAuthorised: true,
      });
      expect(second.ticket.status).toBe("filled");

      // The gate's FREQUENCY check reads this: two real orders were placed today (it counts the second one only).
      expect(ordersToday(readAudit(), "real", new Date())).toBe(2);
    },
    60_000,
  );
});
