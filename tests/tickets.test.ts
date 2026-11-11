import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../src/core/lock.js";
import { homeDir } from "../src/core/paths.js";
import type { Order } from "../src/trading/riskgate.js";
import { createTicket, loadTicket, recordCheck, ticketsDir, transition } from "../src/trading/tickets.js";

const order: Order = {
  account: "cto",
  symbol: "MC.PA",
  side: "buy",
  quantity: 1,
  price: 383,
  orderType: "limit",
  currency: "EUR",
  stop: 366,
  assetKind: "equity",
  venue: "paper",
};

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

describe("ticket transitions", () => {
  it("refuse a move from a state the caller did not expect, read under the lock", async () => {
    const t = createTicket(order, { now: new Date("2026-10-24T10:00:00Z") });
    await expect(transition(t.id, "filled", "test", undefined, undefined, ["working"])).rejects.toThrow(/is draft/);
    expect(loadTicket(t.id).status).toBe("draft");
    await transition(t.id, "cancelled", "test", undefined, undefined, ["draft"]);
    expect(loadTicket(t.id).status).toBe("cancelled");
  });

  it("a check racing a submit does not move a submitted ticket back to checked", async () => {
    const t = createTicket(order, { now: new Date("2026-10-24T10:00:00Z") });
    const gate = { verdict: "pass" as const, checks: [], fingerprint: t.fingerprint, riskReducing: false, notionalBase: 383 };
    await recordCheck(t.id, gate, new Date("2026-10-24T10:00:00Z"));
    // Another process holds the ticket's lock and sends the order meanwhile.
    const path = join(ticketsDir(), `${t.id}.json`);
    const release = await acquireLock(`${path}.lock`);
    const check = recordCheck(t.id, gate, new Date("2026-10-24T10:01:00Z"));
    const settled = check.then(
      () => "moved",
      (e: Error) => e.message,
    );
    const held = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...held, status: "submitted" }));
    release();
    expect(await settled).toMatch(/is submitted: it can no longer be checked/);
    expect(loadTicket(t.id).status).toBe("submitted");
  });
});
