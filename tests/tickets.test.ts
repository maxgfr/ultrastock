import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../src/core/lock.js";
import { clockNow, setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { type Order, orderFingerprint } from "../src/trading/riskgate.js";
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

describe("a check run on a clock that is not the wall clock", () => {
  it("`ticket check --record <dir holding a fixture.json>`: the gate's clock is the file's, so the check is marked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-review-fixture-"));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ recordedAt: "2020-01-01T00:00:00.000Z" }));
    const o = { ...order, venue: "kraken" };
    const t = createTicket(o);
    setNetMode({ kind: "record", dir });
    try {
      // gateContextFor takes clockNow() as "now": orders today, the breaker's day, week and month, the losing-streak pause.
      const gateNow = clockNow();
      await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(o), riskReducing: false, notionalBase: 600 });
      const honestClock = Math.abs(gateNow.getTime() - Date.now()) < 60_000;
      const marked = loadTicket(t.id).check?.replayed === true;
      expect(honestClock || marked).toBe(true);
    } finally {
      setNetMode({ kind: "live" });
    }
  });
});

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
