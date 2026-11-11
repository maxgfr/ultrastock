import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import type { BrokerAdapter, LiveOrder, OrderResult } from "../src/trading/brokers/types.js";
import { effectiveLimits, isTightening, type LiveLimits, LOOSEN_DELAY_MS, requestLimits, tierFor } from "../src/trading/limits.js";
import { readLedger } from "../src/portfolio/ledger.js";
import {
  clientOrderIdFor,
  LIVE_SWITCH_BINDING,
  liveCancel,
  liveSwitchOn,
  liveSubmit,
  NOT_PLACED_WAIT_MS,
  notPlacedBinding,
  orderBinding,
  preconditions,
  reconcile,
  switchLiveOff,
  switchLiveOn,
  venueSymbol,
} from "../src/trading/live.js";
import { type Channel, issueCode, verifyCode } from "../src/trading/otp.js";
import { killSwitchPath, type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { readCredentials, redact, setupCommands } from "../src/trading/secrets.js";
import { createTicket, loadTicket, readAudit, recordCheck } from "../src/trading/tickets.js";
import { inParallelProcesses, SRC } from "./helpers/processes.js";

/** A venue that answers from a script and counts what it was asked. */
function fakeVenue(
  opts: {
    submit?: (o: LiveOrder) => OrderResult | Promise<OrderResult>;
    query?: OrderResult;
    cancel?: OrderResult;
    open?: OrderResult[];
    /** The open-orders read fails with this message. */
    openError?: string;
    env?: "test" | "live";
    canWithdraw?: boolean;
    bid?: number;
    ask?: number;
    free?: number;
  } = {},
) {
  const calls = { submit: 0, query: 0, cancel: 0 };
  const a: BrokerAdapter = {
    venue: "kraken",
    env: opts.env ?? "test",
    bookTop: async () => ({ bid: opts.bid ?? 99.9, ask: opts.ask ?? 100, at: new Date().toISOString() }),
    permissions: async () => ({ canTrade: true, canWithdraw: opts.canWithdraw ?? false, source: "apiRestrictions" }),
    balances: async () => [{ asset: "SOL", free: opts.free ?? 0, locked: 0 }],
    preview: async () => ({ ok: true }),
    submit: async (o) => {
      calls.submit++;
      return opts.submit ? opts.submit(o) : { state: "accepted", clientOrderId: o.clientOrderId, venueOrderId: "V1" };
    },
    query: async () => {
      calls.query++;
      return opts.query;
    },
    cancel: async (_s, id) => {
      calls.cancel++;
      return opts.cancel ?? { state: "cancelled", clientOrderId: id };
    },
    openOrders: async () => {
      if (opts.openError) throw new Error(opts.openError);
      return opts.open ?? [];
    },
  };
  return { a, calls };
}

let captured: string[] = [];
const capture: Channel = (m) => {
  captured.push(m);
  return true;
};
const codeFrom = () => /^(\d{6})/.exec(captured.at(-1) ?? "")![1]!;

const order = (o: Partial<Order> = {}): Order => ({
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
  ...o,
});

async function checkedTicket(o: Order) {
  const t = createTicket(o);
  await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(o), riskReducing: false, notionalBase: o.quantity * o.price });
  return loadTicket(t.id);
}

const switchOn = (extra: Partial<LiveLimits> = {}) =>
  requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [], ...extra }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
  captured = [];
});
afterEach(() => rmSync(killSwitchPath(), { force: true }));

describe("approval codes", () => {
  it("are delivered out of band only, bound to what they approve, single-use, short-lived", async () => {
    const r = await issueCode("t-abc123", "fp1", "a test", [["capture", capture]]);
    expect(r.sentTo).toEqual(["capture"]);
    expect(JSON.stringify(r)).not.toMatch(/\d{6}/);
    const code = codeFrom();
    expect(verifyCode("t-abc123", "fp2", code)).toMatchObject({ ok: false, reason: expect.stringMatching(/different order/) });
    await issueCode("t-abc123", "fp1", "a test", [["capture", capture]]);
    expect(verifyCode("t-abc123", "fp1", "000000" === codeFrom() ? "111111" : "000000")).toMatchObject({ ok: false });
    expect(verifyCode("t-abc123", "fp1", codeFrom())).toEqual({ ok: true });
    expect(verifyCode("t-abc123", "fp1", codeFrom())).toMatchObject({ ok: false, reason: expect.stringMatching(/no code/) });
    await issueCode("t-abc123", "fp1", "a test", [["capture", capture]]);
    expect(verifyCode("t-abc123", "fp1", codeFrom(), new Date(Date.now() + 121_000))).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    await expect(issueCode("t-abc123", "fp1", "x", [["none", () => false]])).rejects.toThrow(/no out-of-band channel/);
  }, 30_000);

  it("count every wrong guess when several processes guess at once", async () => {
    // verifyCode is synchronous: only separate processes can race on the tries counter.
    await issueCode("t-race01", "fp1", "a test", [["capture", capture]]);
    const right = codeFrom();
    const wrong = right === "000000" ? "111111" : "000000";
    const out = await inParallelProcesses(
      `import { verifyCode } from ${JSON.stringify(join(SRC, "trading/otp.ts"))};
process.stdout.write(JSON.stringify(verifyCode("t-race01", "fp1", args[0])));`,
      [[wrong], [wrong], [wrong]],
    );
    const reasons = out.map((o) => JSON.parse(o).reason);
    expect(reasons.sort()).toEqual(["wrong code (1 tries left)", "wrong code (2 tries left)", "wrong code 3 times: void, issue a new one"]);
    // Three wrong guesses void the code: the right one comes too late.
    expect(verifyCode("t-race01", "fp1", right)).toMatchObject({ ok: false, reason: expect.stringMatching(/no code/) });
  }, 60_000);
});

describe("live limits", () => {
  it("tighten at once, loosen only with approval and after 24 hours, capped by the experience tier", () => {
    expect(tierFor(0).maxOrder).toBe(250);
    expect(tierFor(150).name).toBe("experienced");
    const now = new Date("2026-10-24T10:00:00Z");
    expect(requestLimits({ maxOrder: 100, maxDaily: 200, venues: [], attestedNoWithdraw: [] }, false, now)).toEqual({ applied: true });
    expect(requestLimits({ maxOrder: 200, maxDaily: 400, venues: ["kraken"], attestedNoWithdraw: [] }, false, now)).toMatchObject({
      applied: false,
      reason: expect.stringMatching(/approval code/),
    });
    const r = requestLimits({ maxOrder: 200, maxDaily: 400, venues: ["kraken"], attestedNoWithdraw: [] }, true, now);
    expect(r.effectiveAt).toBe("2026-10-25T10:00:00.000Z");
    expect(effectiveLimits(0, new Date("2026-10-25T09:00:00Z")).limits.maxOrder).toBe(100);
    expect(effectiveLimits(0, new Date("2026-10-25T10:00:01Z")).limits).toMatchObject({ maxOrder: 200, venues: ["kraken"] });
    // The tier caps whatever is set.
    requestLimits({ maxOrder: 9000, maxDaily: 9000, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date("2026-10-26T00:00:00Z"));
    expect(effectiveLimits(0, new Date("2026-10-28T00:00:00Z")).limits.maxOrder).toBe(250);
    expect(
      isTightening(
        { maxOrder: 1, maxDaily: 1, venues: ["kraken"], attestedNoWithdraw: [] },
        { maxOrder: 1, maxDaily: 1, venues: ["kraken", "binance"], attestedNoWithdraw: [] },
      ),
    ).toBe(false);
  });

  it("keep every change when two processes set them at once", async () => {
    // The same limits again count as a tightening, recorded each time: a change saved over another's loses its history line.
    await inParallelProcesses(
      `import { requestLimits } from ${JSON.stringify(join(SRC, "trading/limits.ts"))};
for (let i = 0; i < 100; i++) requestLimits({ maxOrder: 100, maxDaily: 200, venues: [], attestedNoWithdraw: [] }, false);`,
      [[], []],
    );
    const stored = JSON.parse(readFileSync(join(homeDir(), "state", "live-limits.json"), "utf8")) as { history: unknown[] };
    expect(stored.history).toHaveLength(200);
  }, 60_000);
});

describe("live preconditions and the single submission", () => {
  it("refuses with named reasons: venue off, kill switch, jurisdiction, withdrawal right, price band, limits, no code", async () => {
    const t = await checkedTicket(order({ price: 103 }));
    const { a } = fakeVenue({ canWithdraw: true });
    const p = await preconditions({ ticket: t, venue: "kraken", env: "test", adapter: a, venueSym: "SOLEUR", micaAuthorised: false });
    const codes = p.refusals.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["VENUE_OFF", "WITHDRAW_RIGHT", "PRICE_BAND", "CODE"]));
    expect(codes).not.toContain("BLOCKED_JURISDICTION");
    switchOn();
    mkdirSync(join(homeDir()), { recursive: true });
    writeFileSync(killSwitchPath(), "");
    const big = await checkedTicket(order({ quantity: 3 }));
    const q = await preconditions({ ticket: big, venue: "kraken", env: "test", adapter: fakeVenue().a, venueSym: "SOLEUR", micaAuthorised: true });
    expect(q.refusals.map((r) => r.code)).toEqual(expect.arrayContaining(["KILL_SWITCH", "ORDER_LIMIT"]));
    // Live needs the switch, Node ≥ 22 and a ready paper record.
    const l = await preconditions({ ticket: t, venue: "kraken", env: "live", adapter: fakeVenue().a, venueSym: "SOLEUR", micaAuthorised: true });
    expect(l.refusals.map((r) => r.code)).toEqual(expect.arrayContaining(["LIVE_OFF", "NOT_READY"]));
    const unauthorised = await preconditions({ ticket: t, venue: "kraken", env: "live", adapter: fakeVenue().a, venueSym: "SOLEUR", micaAuthorised: false });
    expect(unauthorised.refusals.map((r) => r.code)).toContain("BLOCKED_JURISDICTION");
    // A sell needs the asset at the venue: no short.
    const s = await checkedTicket(order({ side: "sell", stop: undefined, price: 99.9 }));
    const n = await preconditions({ ticket: s, venue: "kraken", env: "test", adapter: fakeVenue({ free: 0.5 }).a, venueSym: "SOLEUR", micaAuthorised: true });
    expect(n.refusals.map((r) => r.code)).toContain("NO_SHORT");
  });

  it("keeps live off when the environment alone says on: the switch is a file the user writes with an out-of-band code", async () => {
    const t = await checkedTicket(order());
    const liveOff = async () =>
      (await preconditions({ ticket: t, venue: "kraken", env: "live", adapter: fakeVenue().a, venueSym: "SOLEUR", micaAuthorised: true })).refusals.find(
        (r) => r.code === "LIVE_OFF",
      );
    const before = process.env.ULTRASTOCK_LIVE;
    try {
      // An agent can prefix one command with the variable: that is not the user switching live on.
      process.env.ULTRASTOCK_LIVE = "1";
      expect((await liveOff())?.reason).toMatch(/broker code live.*broker live on --code/);
      // No code, a wrong one: still off.
      expect(() => switchLiveOn(undefined)).toThrow(/code/);
      await issueCode("live-switch", LIVE_SWITCH_BINDING, "live", [["capture", capture]]);
      expect(() => switchLiveOn(codeFrom() === "000000" ? "111111" : "000000")).toThrow(/wrong code/);
      expect(liveSwitchOn()).toBe(false);
      switchLiveOn(codeFrom());
      expect(liveSwitchOn()).toBe(true);
      expect(await liveOff()).toBeUndefined();
      // The variable stays a second requirement.
      delete process.env.ULTRASTOCK_LIVE;
      expect((await liveOff())?.reason).toMatch(/ULTRASTOCK_LIVE=1/);
      process.env.ULTRASTOCK_LIVE = "1";
      // Switching off needs no code.
      switchLiveOff();
      expect(liveSwitchOn()).toBe(false);
      expect(await liveOff()).toBeDefined();
    } finally {
      if (before === undefined) delete process.env.ULTRASTOCK_LIVE;
      else process.env.ULTRASTOCK_LIVE = before;
    }
  }, 30_000);

  it("sends exactly once with a valid code; a timeout is unknown, blocks resending, and reconcile settles it", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, orderBinding(t.order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
    const v = fakeVenue({ submit: () => Promise.reject(new Error("timeout after 10000 ms")) });
    const r = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: v.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
    expect(r.refusals).toEqual([]);
    expect(r.result?.state).toBe("unknown");
    expect(v.calls.submit).toBe(1);
    expect(loadTicket(t.id).status).toBe("submitted");
    // No second send while unknown, whatever the code.
    const again = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: v.a, venueSym: "SOLEUR", code: "123456", micaAuthorised: true });
    expect(again.refusals[0]!.code).toBe("PENDING");
    expect(v.calls.submit).toBe(1);
    // The venue did get it, and it filled.
    const filled = fakeVenue({
      query: {
        state: "filled",
        clientOrderId: clientOrderIdFor(t.id, 1),
        venueOrderId: "V9",
        filledQuantity: 1,
        averagePrice: 99.95,
        fee: 0.26,
        feeCurrency: "EUR",
      },
    });
    const rec = await reconcile(t.id, filled.a);
    expect(rec.note).toBe("filled");
    expect(loadTicket(t.id).status).toBe("filled");
    const events = readAudit().map((e) => e.event);
    expect(events.indexOf("live-intent")).toBeLessThan(events.indexOf("live-result"));
    expect(events).toContain("live-reconcile");
  });

  /** A ticket sent to the fake venue (kraken, test) and accepted there. */
  async function acceptedTicket() {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, orderBinding(t.order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
    const r = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: fakeVenue().a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
    expect(r.result?.state).toBe("accepted");
    return t;
  }

  it("does not take 'not found at the venue' for 'never placed': only the user's code, after a wait, frees the ticket", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, orderBinding(t.order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
    const sentAt = new Date();
    const lost = fakeVenue({ submit: () => Promise.reject(new Error("timeout after 10000 ms")) });
    await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: lost.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true, now: sentAt });
    const rec = (loadTicket(t.id) as unknown as { live: { venue: "kraken"; env: "test"; clientOrderId: string } }).live;
    const silent = fakeVenue(); // the lookup finds nothing, and nothing is working
    // A minute later: the request may still be in flight, the venue's index may lag.
    const early = await reconcile(t.id, silent.a, new Date(sentAt.getTime() + 60_000));
    expect(early.note).toMatch(/not found at kraken yet — that is not proof/);
    expect(loadTicket(t.id).status).toBe("submitted");
    // Later, still absent: absence alone resends nothing.
    const later = new Date(sentAt.getTime() + 11 * 60_000);
    expect((await reconcile(t.id, silent.a, later)).note).toMatch(/Nothing is resent on that alone/);
    expect(loadTicket(t.id).status).toBe("submitted");
    // A code issued for something else does not declare it either.
    await issueCode(t.id, "something-else", "x", [["capture", capture]], later);
    expect((await reconcile(t.id, silent.a, later, { notPlacedCode: codeFrom() })).note).toMatch(/does not declare it never placed/);
    expect(loadTicket(t.id).status).toBe("submitted");
    // The lookup by id missed an order that is in fact working: the open orders are read too.
    const working = fakeVenue({ open: [{ state: "accepted", clientOrderId: rec.clientOrderId, venueOrderId: "V7" }] });
    expect((await reconcile(t.id, working.a, later)).note).toBe("accepted");
    expect(loadTicket(t.id).status).toBe("submitted");
  }, 60_000);

  it("frees a lost order once the user declares it never placed, by code, after the wait", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, orderBinding(t.order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
    const sentAt = new Date();
    const lost = fakeVenue({ submit: () => Promise.reject(new Error("timeout after 10000 ms")) });
    await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: lost.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true, now: sentAt });
    const rec = (loadTicket(t.id) as unknown as { live: { venue: "kraken"; env: "test"; clientOrderId: string } }).live;
    const silent = fakeVenue();
    // Even with the right code, not before the wait is over — and the refusal does not use the code up.
    const soon = new Date(sentAt.getTime() + 60_000);
    await issueCode(t.id, notPlacedBinding(rec), "never placed", [["capture", capture]], soon);
    expect((await reconcile(t.id, silent.a, soon, { notPlacedCode: codeFrom() })).note).toMatch(/not found at kraken yet/);
    expect(loadTicket(t.id).status).toBe("submitted");
    const after = new Date(sentAt.getTime() + NOT_PLACED_WAIT_MS + 1000);
    await issueCode(t.id, notPlacedBinding(rec), "never placed", [["capture", capture]], after);
    const freed = await reconcile(t.id, silent.a, after, { notPlacedCode: codeFrom() });
    expect(freed.note).toMatch(/declared never placed/);
    expect(loadTicket(t.id).status).toBe("blocked");
    expect(readAudit().map((e) => e.event)).toContain("live-not-placed");
  }, 60_000);

  it("does not take a failed read of the open orders for an absence", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, orderBinding(t.order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
    const sentAt = new Date();
    const lost = fakeVenue({ submit: () => Promise.reject(new Error("timeout after 10000 ms")) });
    await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: lost.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true, now: sentAt });
    const rec = (loadTicket(t.id) as unknown as { live: { venue: "kraken"; env: "test"; clientOrderId: string } }).live;
    const after = new Date(sentAt.getTime() + NOT_PLACED_WAIT_MS + 1000);
    await issueCode(t.id, notPlacedBinding(rec), "never placed", [["capture", capture]], after);
    // The lookup by id misses it and the open orders cannot be read: the order may be working there right now.
    const blind = fakeVenue({ openError: "HTTP 503" });
    const r = await reconcile(t.id, blind.a, after, { notPlacedCode: codeFrom() });
    expect(r.note).toMatch(/open orders could not be read \(HTTP 503\)/);
    expect(loadTicket(t.id).status).toBe("submitted");
    expect((loadTicket(t.id) as unknown as { live: { state: string } }).live.state).toBe("unknown");
    // The code was not used up: once the cross-check can be made, it declares the order never placed.
    expect((await reconcile(t.id, fakeVenue().a, after, { notPlacedCode: codeFrom() })).note).toMatch(/declared never placed/);
    expect(loadTicket(t.id).status).toBe("blocked");
  }, 60_000);

  it("never reconciles or cancels against another environment than the one the order went to", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, orderBinding(t.order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
    const lost = fakeVenue({ submit: () => Promise.reject(new Error("timeout after 10000 ms")) });
    await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: lost.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
    // The other environment knows nothing of the order: asking it would read "never placed" and free the ticket for a resend.
    const other = fakeVenue({ env: "live" });
    await expect(reconcile(t.id, other.a)).rejects.toThrow(/went to kraken test/);
    await expect(liveCancel(t.id, other.a)).rejects.toThrow(/went to kraken test/);
    expect(other.calls).toMatchObject({ query: 0, cancel: 0 });
    expect(loadTicket(t.id).status).toBe("submitted");
  });

  it("ends a ticket the venue only validated (Kraken validate, Coinbase preview): nothing is left to follow", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, orderBinding(t.order, "kraken", "test", "SOLEUR"), "order", [["capture", capture]]);
    const v = fakeVenue({ submit: (o) => ({ state: "accepted", clientOrderId: o.clientOrderId, message: "validated only", validatedOnly: true }) });
    await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: v.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
    // It used to stay "submitted": every later send refused as PENDING, reconcile finding nothing for ever.
    expect(loadTicket(t.id).status).toBe("cancelled");
    expect((loadTicket(t.id) as unknown as { live: { state: string } }).live.state).toBe("cancelled");
    await expect(liveCancel(t.id, v.a)).rejects.toThrow(/already cancelled/);
    expect(v.calls.cancel).toBe(0);
  });

  it("refuses a live order checked against a replayed fixture", async () => {
    switchOn();
    const o = order();
    const t = createTicket(o);
    setNetMode({ kind: "fixture", dir: mkdtempSync(join(tmpdir(), "us-replay-")) });
    try {
      await recordCheck(t.id, { verdict: "pass", checks: [], fingerprint: orderFingerprint(o), riskReducing: false, notionalBase: 100 });
    } finally {
      setNetMode({ kind: "live" });
    }
    expect(loadTicket(t.id).check?.replayed).toBe(true);
    const p = await preconditions({ ticket: loadTicket(t.id), venue: "kraken", env: "test", adapter: fakeVenue().a, venueSym: "SOLEUR", micaAuthorised: true });
    expect(p.refusals.map((r) => r.code)).toContain("REPLAY");
  });

  it("keeps a ticket pending when the venue refuses the cancel", async () => {
    const t = await acceptedTicket();
    const v = fakeVenue({ cancel: { state: "rejected", clientOrderId: clientOrderIdFor(t.id, 1), message: "HTTP 503" } });
    const r = await liveCancel(t.id, v.a);
    expect(r?.state).toBe("rejected");
    // Still working at the venue as far as anyone knows: not resendable.
    expect(loadTicket(t.id).status).toBe("submitted");
    const again = await liveSubmit({
      ticket: loadTicket(t.id),
      venue: "kraken",
      env: "test",
      adapter: v.a,
      venueSym: "SOLEUR",
      code: "123456",
      micaAuthorised: true,
    });
    expect(again.refusals[0]!.code).toBe("PENDING");
    expect(v.calls.submit).toBe(0);
  });

  it("reads what became of the order when a cancel is refused because it filled, and refuses to cancel a finished one", async () => {
    const t = await acceptedTicket();
    const id = clientOrderIdFor(t.id, 1);
    const v = fakeVenue({
      cancel: { state: "rejected", clientOrderId: id, message: "Unknown order sent." },
      query: { state: "filled", clientOrderId: id, venueOrderId: "V1", filledQuantity: 1, averagePrice: 100, fee: 0.26, feeCurrency: "EUR" },
    });
    await liveCancel(t.id, v.a);
    expect(loadTicket(t.id).status).toBe("filled");
    expect(readLedger("live-test").filter((x) => x.type === "buy")).toHaveLength(1);
    await expect(liveCancel(t.id, v.a)).rejects.toThrow(/already filled/);
    expect(v.calls.cancel).toBe(1);
    expect(loadTicket(t.id).status).toBe("filled");
  });

  it("books what filled before a cancel", async () => {
    const t = await acceptedTicket();
    const id = clientOrderIdFor(t.id, 1);
    const v = fakeVenue({
      query: { state: "cancelled", clientOrderId: id, venueOrderId: "V1", filledQuantity: 0.4, averagePrice: 99.9, fee: 0.1, feeCurrency: "EUR" },
    });
    const r = await liveCancel(t.id, v.a);
    expect(r).toMatchObject({ state: "cancelled", filledQuantity: 0.4 });
    const after = loadTicket(t.id);
    expect(after.status).toBe("cancelled");
    expect(after.fills).toMatchObject([{ quantity: 0.4, price: 99.9 }]);
    expect(readLedger("live-test").filter((x) => x.type === "buy")).toMatchObject([{ quantity: 0.4, price: 99.9 }]);
    // Asking again books nothing twice.
    await reconcile(t.id, v.a);
    expect(readLedger("live-test").filter((x) => x.type === "buy")).toHaveLength(1);
  });

  it("books only the rest when a cancelled order is later reported filled", async () => {
    const t = await acceptedTicket();
    const id = clientOrderIdFor(t.id, 1);
    // The cancel answer says 0.4 filled before it; the venue later says the whole order filled.
    await liveCancel(
      t.id,
      fakeVenue({ cancel: { state: "cancelled", clientOrderId: id, venueOrderId: "V1", filledQuantity: 0.4, averagePrice: 99, fee: 0.1 } }).a,
    );
    expect(loadTicket(t.id).status).toBe("cancelled");
    const v = fakeVenue({
      query: { state: "filled", clientOrderId: id, venueOrderId: "V1", filledQuantity: 1, averagePrice: 99.6, fee: 0.25, feeCurrency: "EUR" },
    });
    await reconcile(t.id, v.a);
    await reconcile(t.id, v.a);
    const after = loadTicket(t.id);
    expect(after.status).toBe("filled");
    expect(after.fills.reduce((s, f) => s + f.quantity, 0)).toBeCloseTo(1, 10);
    const buys = readLedger("live-test").filter((x) => x.type === "buy");
    expect(buys.reduce((s, x) => s + (x.quantity ?? 0), 0)).toBeCloseTo(1, 10);
    // The rest is booked at the price that makes the whole order's average the venue's: (99.6 − 0.4 × 99) / 0.6.
    expect(buys[1]).toMatchObject({ quantity: expect.closeTo(0.6, 10), price: expect.closeTo(100, 10), fee: expect.closeTo(0.15, 10) });
  });

  it("books a fill reported after a cancel with nothing filled, once", async () => {
    const t = await acceptedTicket();
    const id = clientOrderIdFor(t.id, 1);
    await liveCancel(t.id, fakeVenue().a);
    expect(loadTicket(t.id).status).toBe("cancelled");
    expect(readLedger("live-test").filter((x) => x.type === "buy")).toHaveLength(0);
    const v = fakeVenue({
      query: { state: "filled", clientOrderId: id, venueOrderId: "V1", filledQuantity: 1, averagePrice: 100, fee: 0.26, feeCurrency: "EUR" },
    });
    await reconcile(t.id, v.a);
    await reconcile(t.id, v.a);
    expect(loadTicket(t.id).status).toBe("filled");
    expect(readLedger("live-test").filter((x) => x.type === "buy")).toMatchObject([{ quantity: 1, price: 100 }]);
  });

  it("settles a filled order once when two follow-ups race for it", async () => {
    const t = await acceptedTicket();
    const id = clientOrderIdFor(t.id, 1);
    const filled: OrderResult = { state: "filled", clientOrderId: id, venueOrderId: "V1", filledQuantity: 1, averagePrice: 100, fee: 0.26, feeCurrency: "EUR" };
    const v = fakeVenue({ query: filled, cancel: { state: "rejected", clientOrderId: id, message: "Unknown order sent." } });
    // Seconds apart, as two commands would run: the ledger's own same-second dedup cannot hide a double booking.
    const now = new Date();
    const later = (s: number) => new Date(now.getTime() + s * 1000);
    await Promise.allSettled([reconcile(t.id, v.a, now), reconcile(t.id, v.a, later(5)), liveCancel(t.id, v.a, later(10))]);
    expect(loadTicket(t.id).status).toBe("filled");
    expect(loadTicket(t.id).fills).toHaveLength(1);
    expect(readLedger("live-test").filter((x) => x.type === "buy")).toHaveLength(1);
    // The cancel came after the fill was known: it was refused before reaching the venue.
    expect(v.calls.cancel).toBe(0);
  });

  it("binds a code to the environment, the venue and the venue symbol it was read for", async () => {
    switchOn();
    let n = 0;
    const send = async (venue: "kraken" | "binance", env: "test" | "live", sym: string) => {
      const o = order({ quantity: 1 + ++n / 100 }); // a ticket of its own each time
      const t = await checkedTicket(o);
      await issueCode(t.id, orderBinding(o, venue, env, sym), "order", [["capture", capture]]);
      const v = fakeVenue();
      const r = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: v.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
      return { codes: r.refusals.map((x) => x.code), sent: v.calls.submit };
    };
    // The same order, approved for the other environment, another venue or another contract: void here.
    expect(await send("kraken", "live", "SOLEUR")).toEqual({ codes: ["CODE"], sent: 0 });
    expect(await send("binance", "test", "SOLEUR")).toEqual({ codes: ["CODE"], sent: 0 });
    expect(await send("kraken", "test", "XBTEUR")).toEqual({ codes: ["CODE"], sent: 0 });
    expect(await send("kraken", "test", "SOLEUR")).toEqual({ codes: [], sent: 1 });
  }, 60_000);

  it("refuses a code issued for another order, and maps symbols per venue", async () => {
    switchOn();
    const t = await checkedTicket(order());
    await issueCode(t.id, "another-fingerprint", "order", [["capture", capture]]);
    const v = fakeVenue();
    const r = await liveSubmit({ ticket: t, venue: "kraken", env: "test", adapter: v.a, venueSym: "SOLEUR", code: codeFrom(), micaAuthorised: true });
    expect(r.refusals.map((x) => x.code)).toEqual(["CODE"]);
    expect(v.calls.submit).toBe(0);
    expect(venueSymbol("kraken", "BTCEUR", "EUR")).toBe("XBTEUR");
    expect(venueSymbol("coinbase", "ETHEUR", "EUR")).toBe("ETH-EUR");
    expect(venueSymbol("binance", "BTCUSDT", "USDT")).toBe("BTCUSDT");
    expect(() => venueSymbol("ibkr", "AAPL", "USD")).toThrow(/conid/);
    // A contract id names an IBKR contract; nowhere else may anything replace the ticket's own symbol.
    expect(venueSymbol("ibkr", "AAPL", "USD", "265598")).toBe("265598");
    expect(() => venueSymbol("kraken", "SOLEUR", "EUR", "XBTEUR")).toThrow(/cannot be replaced/);
    expect(clientOrderIdFor("t-x", 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(clientOrderIdFor("t-x", 2)).not.toBe(clientOrderIdFor("t-x", 1));
  });

  it("reads credentials from the keychain entries, then the environment, and never needs them on the command line", () => {
    const store: Record<string, string> = { "kraken-test-key": "KEY-abcdef", "kraken-test-secret": "SECRET-abcdef" };
    const r = readCredentials("kraken", "test", (a) => store[a]);
    expect(r?.creds).toMatchObject({ key: "KEY-abcdef", secret: "SECRET-abcdef" });
    expect(readCredentials("kraken", "live", (a) => store[a])).toBeUndefined();
    process.env.ULTRASTOCK_BINANCE_TEST_KEY = "envkey-123456";
    process.env.ULTRASTOCK_BINANCE_TEST_SECRET = "envsecret-123456";
    expect(readCredentials("binance", "test", () => undefined)).toMatchObject({ source: "environment" });
    delete process.env.ULTRASTOCK_BINANCE_TEST_KEY;
    delete process.env.ULTRASTOCK_BINANCE_TEST_SECRET;
    expect(redact("error: key KEY-abcdef rejected", r!.creds)).toBe("error: key [redacted] rejected");
    for (const c of setupCommands("kraken", "live")) expect(c).not.toMatch(/SECRET|KEY-/);
  });
});
