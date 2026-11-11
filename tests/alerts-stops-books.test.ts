// The `stops` alert rule: which ticket protects a line (its own book's, filled last since the line opened), and once per what.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addRule, runAlerts } from "../src/alerts/alerts.js";
import { homeDir } from "../src/core/paths.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import type { PriceSeries } from "../src/providers/types.js";
import { constantBars } from "./helpers/series.js";

// Every symbol trades flat at 18: a stop at 19 is hit, a stop at 17 is not.
vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: async (raw: string) => ({ symbol: raw }),
  getHistory: async () => ({ bars: constantBars(30, 18) }) as unknown as PriceSeries,
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

  it("alerts once per line opening: a second run on the same hit stop is silent", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "stops-once-"));
    await appendTransactions([deposit("pea"), tx("buy", "pea", "2026-06-01T09:00:00", "ticket:t-once")], "real");
    seedTicket("t-once", "pea", "2026-06-01T08:00:00.000Z", "2026-06-01T09:00:00.000Z", 19);
    addRule({ kind: "stops" });
    expect((await runAlerts(new Date("2026-06-10T00:00:00Z"))).events).toHaveLength(1);
    expect((await runAlerts(new Date("2026-06-11T00:00:00Z"))).events).toEqual([]);
  });
});
