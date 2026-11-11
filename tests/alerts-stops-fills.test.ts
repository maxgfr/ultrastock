// The `stops` alert rule: only bars after the fill hit a stop, a ticket filled in part carries its stop, a line apart.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addRule, runAlerts } from "../src/alerts/alerts.js";
import { homeDir } from "../src/core/paths.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import type { Bar } from "../src/providers/types.js";
import { bar } from "./helpers/series.js";

// The daily bars the provider answers with, by symbol; a symbol set to "down" cannot be read.
const market = vi.hoisted(() => ({ bars: {} as Record<string, Bar[] | "down"> }));
vi.mock("../src/providers/router.js", () => ({
  resolveSymbol: async (raw: string) => ({ symbol: raw }),
  getHistory: async (r: { symbol: string }) => {
    const bars = market.bars[r.symbol];
    if (!bars || bars === "down") throw new Error(`no price history for ${r.symbol}`);
    return { bars };
  },
}));

const buy = (symbol: string, date: string, quantity: number, price: number, ticket: string) =>
  ({ date, type: "buy", account: "cto", symbol, quantity, price, fee: 0, currency: "EUR", origin: `ticket:${ticket}` }) as const;

/** A buy ticket with a stop, as the paper and live engines leave it. */
function seedTicket(
  id: string,
  symbol: string,
  o: { at: string; stop: number; ordered: number; filled: number; status: "filled" | "cancelled" | "submitted" },
): void {
  const t = {
    id,
    createdAt: o.at,
    updatedAt: o.at,
    status: o.status,
    order: {
      account: "cto",
      symbol,
      side: "buy",
      quantity: o.ordered,
      price: 20,
      orderType: "limit",
      currency: "EUR",
      stop: o.stop,
      assetKind: "equity",
      venue: "paper",
    },
    fingerprint: "test",
    fills: [{ at: o.at, quantity: o.filled, price: 20, fee: 0, venue: "paper", method: "test" }],
    history: [{ at: o.at, from: "submitted", to: o.status, why: "test" }],
  };
  mkdirSync(join(homeDir(), "tickets"), { recursive: true });
  writeFileSync(join(homeDir(), "tickets", `${id}.json`), JSON.stringify(t));
}

const deposit = { date: "2026-11-02", type: "deposit", account: "cto", amount: 100_000, currency: "EUR", origin: "manual" } as const;

describe("the stops rule", () => {
  beforeEach(() => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "alerts-stops-fills-"));
    market.bars = {};
  });

  // Monday 9 Nov: ALO.PA ranges 90–100. Tuesday 10 Nov, 15:00: it has gapped up, 100 are bought at 105, stop 100.
  const breakout = async () => {
    await appendTransactions([deposit, buy("ALO.PA", "2026-11-10T15:00:00", 100, 105, "t-breakout-1")], "real");
    seedTicket("t-breakout-1", "ALO.PA", { at: "2026-11-10T15:00:00.000Z", stop: 100, ordered: 100, filled: 100, status: "filled" });
    addRule({ kind: "stops" });
    // Five minutes after the fill the last daily bar is Monday's, whose low (90) is under a stop that did not exist yet.
    market.bars["ALO.PA"] = [bar("2026-11-06", 95, 99, 93, 97), bar("2026-11-09", 96, 100, 90, 99)];
    return runAlerts(new Date("2026-11-10T15:05:00Z"));
  };

  it("AL1a — does not alert on a bar from before the position was bought", async () => {
    const first = await breakout();
    expect(first.errors).toEqual([]);
    expect(first.events.map((e) => e.message)).toEqual([]);
  });

  it("AL1b — alerts when the stop is really hit, whatever a run right after the fill saw", async () => {
    await breakout();
    // Wednesday 11 Nov: the price falls through the stop. This is the alert the rule exists for.
    market.bars["ALO.PA"] = [...(market.bars["ALO.PA"] as Bar[]), bar("2026-11-10", 105, 108, 104, 106), bar("2026-11-11", 105, 105, 96, 97)];
    const second = await runAlerts(new Date("2026-11-12T08:00:00Z"));
    expect(second.events.map((e) => e.values)).toEqual([{ low: 96, stop: 100 }]);
    expect(second.events[0]?.message).toContain("on 2026-11-11");
  });

  it("AL2 — reads the stop of a ticket filled in part and then cancelled: the shares it bought are held", async () => {
    // 100 ordered with a stop at 19; 60 filled, the rest cancelled. The ledger holds the 60, booked by the ticket.
    await appendTransactions([deposit, buy("ALO.PA", "2026-11-03T09:00:00", 60, 20, "t-partial-1")], "real");
    seedTicket("t-partial-1", "ALO.PA", { at: "2026-11-03T09:00:00.000Z", stop: 19, ordered: 100, filled: 60, status: "cancelled" });
    addRule({ kind: "stops" });
    market.bars["ALO.PA"] = [bar("2026-11-03", 20, 20.5, 19.8, 20), bar("2026-11-04", 20, 20, 18, 18.2)];

    const { events, errors } = await runAlerts(new Date("2026-11-05T08:00:00Z"));
    expect(errors).toEqual([]);
    expect(events.map((e) => e.values)).toEqual([{ low: 18, stop: 19 }]);
  });

  it("AL3 — still checks the other lines when one line's history cannot be read", async () => {
    await appendTransactions(
      [deposit, buy("GONE.PA", "2026-11-03T09:00:00", 100, 20, "t-gone-1"), buy("ALO.PA", "2026-11-03T09:05:00", 100, 20, "t-held-1")],
      "real",
    );
    seedTicket("t-gone-1", "GONE.PA", { at: "2026-11-03T09:00:00.000Z", stop: 19, ordered: 100, filled: 100, status: "filled" });
    seedTicket("t-held-1", "ALO.PA", { at: "2026-11-03T09:05:00.000Z", stop: 19, ordered: 100, filled: 100, status: "filled" });
    addRule({ kind: "stops" });
    // GONE.PA is no longer quoted (delisted, renamed); ALO.PA trades through its stop.
    market.bars = { "GONE.PA": "down", "ALO.PA": [bar("2026-11-03", 20, 20.5, 19.8, 20), bar("2026-11-04", 20, 20, 18, 18.2)] };

    const { events, errors } = await runAlerts(new Date("2026-11-05T08:00:00Z"));
    expect(errors.join("\n")).toContain("GONE.PA");
    expect(events.map((e) => [e.symbol, e.values])).toEqual([["ALO.PA", { low: 18, stop: 19 }]]);
  });

  it("reads the stop of a ticket still working with part of it filled, and not of one cancelled with nothing filled", async () => {
    await appendTransactions(
      [deposit, buy("ALO.PA", "2026-11-03T09:00:00", 40, 20, "t-working-1"), buy("BNP.PA", "2026-11-03T09:05:00", 40, 20, "t-empty-1")],
      "real",
    );
    seedTicket("t-working-1", "ALO.PA", { at: "2026-11-03T09:00:00.000Z", stop: 19, ordered: 100, filled: 40, status: "submitted" });
    seedTicket("t-empty-1", "BNP.PA", { at: "2026-11-03T09:05:00.000Z", stop: 19, ordered: 100, filled: 0, status: "cancelled" });
    addRule({ kind: "stops" });
    const falling = [bar("2026-11-03", 20, 20.5, 19.8, 20), bar("2026-11-04", 20, 20, 18, 18.2)];
    market.bars = { "ALO.PA": falling, "BNP.PA": falling };

    const { events, errors } = await runAlerts(new Date("2026-11-05T08:00:00Z"));
    expect(errors).toEqual([]);
    expect(events.map((e) => [e.symbol, e.values])).toEqual([["ALO.PA", { low: 18, stop: 19 }]]);
  });
});
