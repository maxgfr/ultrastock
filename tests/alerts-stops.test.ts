import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addRule, runAlerts } from "../src/alerts/alerts.js";
import { homeDir } from "../src/core/paths.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import type { PriceSeries } from "../src/providers/types.js";
import { constantBarsUntil } from "./helpers/series.js";

// Every symbol trades flat at 18 up to the day of the read: a stop at 19 is hit, a stop at 17 is not.
vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: async (raw: string) => ({ symbol: raw }),
  getHistory: async (_r: unknown, o: { to: Date }) => ({ bars: constantBarsUntil(o.to, 30, 18) }) as unknown as PriceSeries,
}));

const buy = (account: string, date: string, quantity: number, origin = "manual") =>
  ({ date, type: "buy", account, symbol: "ALO.PA", quantity, price: 20, fee: 0, currency: "EUR", origin }) as const;
const sell = (account: string, date: string, quantity: number) =>
  ({ date, type: "sell", account, symbol: "ALO.PA", quantity, price: 21, fee: 0, currency: "EUR", origin: "manual" }) as const;

function seedTicket(id: string, account: string, filledAt: string, stop: number): void {
  const t = {
    id,
    createdAt: filledAt.replace("T09", "T08"),
    updatedAt: filledAt,
    status: "filled",
    order: { account, symbol: "ALO.PA", side: "buy", quantity: 100, price: 20, orderType: "limit", currency: "EUR", stop, assetKind: "equity", venue: "paper" },
    fingerprint: "test",
    fills: [{ at: filledAt, quantity: 100, price: 20, fee: 0, venue: "paper", method: "test" }],
    history: [{ at: filledAt, from: "working", to: "filled", why: "test" }],
  };
  mkdirSync(join(homeDir(), "tickets"), { recursive: true });
  writeFileSync(join(homeDir(), "tickets", `${id}.json`), JSON.stringify(t));
}

describe("the stops rule", () => {
  it("ignores the stop of a ticket filled before the line was sold out and bought again", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "alerts-stale-stop-"));
    await appendTransactions(
      [
        { date: "2026-06-01", type: "deposit", account: "pea", amount: 10_000, currency: "EUR", origin: "manual" },
        buy("pea", "2026-06-01T09:00:00", 100, "ticket:t-pea-first"),
        sell("pea", "2026-07-01", 100),
        // Bought again without a ticket: no stop on record for the line held now.
        buy("pea", "2026-08-03T09:00:00", 100),
      ],
      "real",
    );
    seedTicket("t-pea-first", "pea", "2026-06-01T09:00:00.000Z", 19);
    addRule({ kind: "stops" });

    const { events, errors } = await runAlerts(new Date("2026-10-02T00:00:00Z"));
    expect(errors).toEqual([]);
    expect(events).toEqual([]);
  });

  it("reads the stop of the newest ticket filled on the line, not the oldest", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "alerts-newest-stop-"));
    await appendTransactions(
      [
        { date: "2026-06-01", type: "deposit", account: "cto", amount: 10_000, currency: "EUR", origin: "manual" },
        // Each buy booked by its ticket: a ticket protects the line its fill was booked to.
        buy("cto", "2026-06-01T09:00:00", 100, "ticket:t-cto-first"),
        buy("cto", "2026-08-03T09:00:00", 100, "ticket:t-cto-again"),
      ],
      "real",
    );
    // The line was added to and its stop raised: the old level, 17, is not hit; the current one, 19, is.
    seedTicket("t-cto-first", "cto", "2026-06-01T09:00:00.000Z", 17);
    seedTicket("t-cto-again", "cto", "2026-08-03T09:00:00.000Z", 19);
    addRule({ kind: "stops" });

    const { events, errors } = await runAlerts(new Date("2026-10-02T00:00:00Z"));
    expect(errors).toEqual([]);
    expect(events.map((e) => e.values)).toEqual([{ low: 18, stop: 19 }]);
    expect(events[0]!.message).toMatch(/^ALO\.PA \(real, cto\) traded at or below its stop 19 /);
  });
});
