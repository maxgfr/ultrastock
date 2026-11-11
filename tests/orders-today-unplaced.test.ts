// A live attempt that never placed an order — refused by the venue, stopped by the kill switch before the send, or
// declared never placed by the user — moves no money: it does not use up the day's order count (the profile's
// maxOrdersPerDay) nor the per-day notional limit of the experience tier (DAILY_LIMIT).
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { ordersToday } from "../src/trading/context.js";
import { liveActivity } from "../src/trading/live.js";
import { audit, readAudit } from "../src/trading/tickets.js";

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

const order = { venue: "kraken", account: "kraken", symbol: "SOLEUR", side: "buy", quantity: 2, price: 100 };
function attempt(ticket: string, clientOrderId: string, after: Record<string, unknown> | undefined) {
  audit({ event: "live-intent", ticket, venue: "kraken", env: "live", clientOrderId, notional: 200 });
  audit({ event: "ticket", id: ticket, from: "checked", to: "submitted", why: "sending", order });
  if (after) audit({ ticket, venue: "kraken", env: "live", clientOrderId, ...after });
}

describe("a live attempt that placed nothing", () => {
  it("counts neither as an order of the day nor against the daily limit", () => {
    attempt("t-1", "c-1", { event: "live-result", state: "rejected", message: "EOrder:Insufficient funds" });
    attempt("t-2", "c-2", { event: "live-not-sent", reason: "kill switch" });
    attempt("t-3", "c-3", { event: "live-not-placed" });
    attempt("t-4", "c-4", { event: "live-reconcile", state: "rejected" });
    // Placed: accepted, and one whose answer was lost (unknown: it may well be working at the venue).
    attempt("t-5", "c-5", { event: "live-result", state: "accepted" });
    attempt("t-6", "c-6", { event: "live-result", state: "unknown" });
    const now = new Date();
    expect(ordersToday(readAudit(), "real", now)).toBe(2);
    expect(liveActivity(now).todayNotional).toBe(400);
  });

  it("counts again when the same ticket is sent anew and placed", () => {
    attempt("t-1", "c-1", { event: "live-result", state: "rejected" });
    attempt("t-1", "c-1b", { event: "live-result", state: "filled" });
    expect(ordersToday(readAudit(), "real", new Date())).toBe(1);
    expect(liveActivity(new Date())).toMatchObject({ fills: 1, todayNotional: 200 });
  });
});
