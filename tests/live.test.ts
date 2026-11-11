import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import type { BrokerAdapter, LiveOrder, OrderResult } from "../src/trading/brokers/types.js";
import { effectiveLimits, isTightening, type LiveLimits, LOOSEN_DELAY_MS, requestLimits, tierFor } from "../src/trading/limits.js";
import { readLedger } from "../src/portfolio/ledger.js";
import {
  clientOrderIdFor,
  liveCancel,
  liveSubmit,
  NOT_PLACED_WAIT_MS,
  notPlacedBinding,
  orderBinding,
  preconditions,
  reconcile,
  venueSymbol,
} from "../src/trading/live.js";
import { type Channel, issueCode, verifyCode } from "../src/trading/otp.js";
import { killSwitchPath, type Order, orderFingerprint } from "../src/trading/riskgate.js";
import { readCredentials, redact, setupCommands } from "../src/trading/secrets.js";
import { createTicket, loadTicket, readAudit, recordCheck } from "../src/trading/tickets.js";

/** A venue that answers from a script and counts what it was asked. */
function fakeVenue(
  opts: {
    submit?: (o: LiveOrder) => OrderResult | Promise<OrderResult>;
    query?: OrderResult;
    cancel?: OrderResult;
    open?: OrderResult[];
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
    openOrders: async () => opts.open ?? [],
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
    // verifyCode is synchronous: only separate processes can race on the tries counter. Bundle it for them.
    const dir = mkdtempSync(join(tmpdir(), "us-otp-race-"));
    const entry = join(dir, "guess.ts");
    writeFileSync(
      entry,
      `import { verifyCode } from ${JSON.stringify(join(process.cwd(), "src/trading/otp.ts"))};
const [subject, binding, code, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {} // start together
process.stdout.write(JSON.stringify(verifyCode(subject, binding, code)));
`,
    );
    await build({ entry: { guess: entry }, outDir: dir, format: ["esm"], platform: "node", target: "node18", config: false, silent: true });
    await issueCode("t-race01", "fp1", "a test", [["capture", capture]]);
    const right = codeFrom();
    const wrong = right === "000000" ? "111111" : "000000";
    const startAt = String(Date.now() + 1500);
    const guess = () =>
      new Promise<string>((resolve, reject) =>
        execFile(process.execPath, [join(dir, "guess.js"), "t-race01", "fp1", wrong, startAt], { env: process.env }, (err, stdout) =>
          err ? reject(err) : resolve(JSON.parse(stdout).reason),
        ),
      );
    const reasons = await Promise.all([guess(), guess(), guess()]);
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
