// The `stops` alert rule: which ticket protects a line (its own book's, filled last since the line opened), and once per what.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addRule, runAlerts } from "../src/alerts/alerts.js";
import { homeDir } from "../src/core/paths.js";
import { appendTransactions, buildBook, readLedger } from "../src/portfolio/ledger.js";
import type { PriceSeries } from "../src/providers/types.js";
import { constantBarsUntil } from "./helpers/series.js";

// Every symbol trades flat at 18 up to the day of the read: a stop at 19 is hit, a stop at 17 is not.
vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: async (raw: string) => ({ symbol: raw }),
  getHistory: async (_r: unknown, o: { to: Date }) => ({ bars: constantBarsUntil(o.to, 30, 18) }) as unknown as PriceSeries,
}));

const tx = (type: "buy" | "sell", account: string, date: string, origin = "manual") =>
  ({ date, type, account, symbol: "ALO.PA", quantity: 100, price: 20, fee: 0, currency: "EUR", origin }) as const;
const deposit = (account: string) => ({ date: "2026-06-01", type: "deposit", account, amount: 10_000, currency: "EUR", origin: "manual" }) as const;

function seedTicket(id: string, account: string, createdAt: string, filledAt: string, stop: number, venue = "paper"): void {
  const t = {
    id,
    createdAt,
    updatedAt: filledAt,
    status: "filled",
    order: { account, symbol: "ALO.PA", side: "buy", quantity: 100, price: 20, orderType: "limit", currency: "EUR", stop, assetKind: "equity", venue },
    fingerprint: "test",
    fills: [{ at: filledAt, quantity: 100, price: 20, fee: 0, venue, method: "test" }],
    history: [{ at: filledAt, from: "working", to: "filled", why: "test" }],
  };
  mkdirSync(join(homeDir(), "tickets"), { recursive: true });
  writeFileSync(join(homeDir(), "tickets", `${id}.json`), JSON.stringify(t));
}

describe("the stops rule, line by line", () => {
  it("fires again for a line reopened with a new ticket at the same stop level", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "zz-review-c-reopen-"));
    await appendTransactions([deposit("pea"), tx("buy", "pea", "2026-06-01T09:00:00", "ticket:t-first")], "real");
    seedTicket("t-first", "pea", "2026-06-01T08:00:00.000Z", "2026-06-01T09:00:00.000Z", 19);
    addRule({ kind: "stops" });
    const first = await runAlerts(new Date("2026-06-10T00:00:00Z"));
    expect(first.events.map((e) => e.values?.stop)).toEqual([19]);

    // The stop was acted on: the line is sold out, then bought again later through a new ticket whose stop is 19 too.
    await appendTransactions([tx("sell", "pea", "2026-06-11T09:00:00"), tx("buy", "pea", "2026-08-03T09:00:00", "ticket:t-second")], "real");
    seedTicket("t-second", "pea", "2026-08-03T08:00:00.000Z", "2026-08-03T09:00:00.000Z", 19);
    const second = await runAlerts(new Date("2026-10-02T00:00:00Z"));
    expect(second.errors).toEqual([]);
    // The new position trades under ITS stop and has never been alerted on: the alert must fire.
    expect(
      second.events.map((e) => e.values?.stop),
      "the reopened line's stop is hit but the rule stays silent (seen key = book|account|symbol|level)",
    ).toEqual([19]);
  });

  it("does not protect (or alert on) a real line with the stop of a paper ticket", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "zz-review-c-crossbook-"));
    // Real book: bought by hand, no ticket, no stop on record.
    await appendTransactions([deposit("pea"), tx("buy", "pea", "2026-06-01T09:00:00")], "real");
    // Paper book: the same account id and symbol, bought through a paper ticket with a stop at 19.
    await appendTransactions([deposit("pea"), tx("buy", "pea", "2026-08-03T09:00:00.000Z", "ticket:t-paper")], "paper");
    seedTicket("t-paper", "pea", "2026-08-03T08:00:00.000Z", "2026-08-03T09:00:00.000Z", 19, "paper");
    addRule({ kind: "stops" });
    const { events, errors } = await runAlerts(new Date("2026-10-02T00:00:00Z"));
    expect(errors).toEqual([]);
    expect(
      events.map((e) => e.message.slice(0, 20)),
      "a paper ticket's stop is reported as the stop of the real position",
    ).toEqual(["ALO.PA (paper, pea) "]);
  });

  it("reads the stop of the ticket filled last, not of the ticket created last", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "zz-review-c-order-"));
    await appendTransactions(
      [deposit("cto"), tx("buy", "cto", "2026-06-02T09:00:00", "ticket:t-market"), tx("buy", "cto", "2026-08-03T09:00:00", "ticket:t-limit")],
      "real",
    );
    // A limit ticket created first and left working: it fills in August, stop 19 (hit).
    seedTicket("t-limit", "cto", "2026-06-01T08:00:00.000Z", "2026-08-03T09:00:00.000Z", 19);
    // A market ticket created a day later, filled at once in June, stop 17 (not hit).
    seedTicket("t-market", "cto", "2026-06-02T08:00:00.000Z", "2026-06-02T09:00:00.000Z", 17);
    addRule({ kind: "stops" });
    const { events, errors } = await runAlerts(new Date("2026-10-02T00:00:00Z"));
    expect(errors).toEqual([]);
    expect(
      events.map((e) => e.values?.stop),
      "the newest FILL carries the line's latest stop; tickets are ordered by createdAt",
    ).toEqual([19]);
  });

  it("drops the stop of a ticket filled on the day the line was sold out and bought again, date-only rows", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "stops-same-day-"));
    // Bought through a ticket in the morning, sold out, bought again by hand — all on 2026-08-03, rows without an hour.
    await appendTransactions(
      // (Bought back at 21: a row identical to the morning's would be read as the same row.)
      [deposit("pea"), tx("buy", "pea", "2026-08-03", "ticket:t-morning"), tx("sell", "pea", "2026-08-03"), { ...tx("buy", "pea", "2026-08-03"), price: 21 }],
      "real",
    );
    seedTicket("t-morning", "pea", "2026-08-03T07:00:00.000Z", "2026-08-03T08:00:00.000Z", 19);
    addRule({ kind: "stops" });
    const { events, errors } = await runAlerts(new Date("2026-10-02T00:00:00Z"));
    expect(errors).toEqual([]);
    expect(events).toEqual([]);
    // The line is held: it is the stop that was dropped, not the position.
    expect(buildBook(readLedger("real")).positions.find((x) => x.symbol === "ALO.PA")?.quantity).toBe(100);
  });

  it("keeps the stop of the ticket that reopened the line that day, booked after the sale", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "stops-same-day-ticket-"));
    await appendTransactions(
      [
        deposit("pea"),
        tx("buy", "pea", "2026-08-03", "ticket:t-old"),
        tx("sell", "pea", "2026-08-03"),
        { ...tx("buy", "pea", "2026-08-03", "ticket:t-new"), price: 21 },
      ],
      "real",
    );
    seedTicket("t-old", "pea", "2026-08-03T07:00:00.000Z", "2026-08-03T08:00:00.000Z", 17);
    seedTicket("t-new", "pea", "2026-08-03T12:00:00.000Z", "2026-08-03T13:00:00.000Z", 19);
    addRule({ kind: "stops" });
    const { events, errors } = await runAlerts(new Date("2026-10-02T00:00:00Z"));
    expect(errors).toEqual([]);
    expect(events.map((e) => e.values?.stop)).toEqual([19]);
  });

  it("alerts once per line opening: a second run on the same hit stop is silent", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "stops-once-"));
    await appendTransactions([deposit("pea"), tx("buy", "pea", "2026-06-01T09:00:00", "ticket:t-once")], "real");
    seedTicket("t-once", "pea", "2026-06-01T08:00:00.000Z", "2026-06-01T09:00:00.000Z", 19);
    addRule({ kind: "stops" });
    expect((await runAlerts(new Date("2026-06-10T00:00:00Z"))).events).toHaveLength(1);
    expect((await runAlerts(new Date("2026-06-11T00:00:00Z"))).events).toEqual([]);
  });
});
