import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { morningRun } from "../src/analyze/morning/run.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { withFixture } from "./helpers/fixtures.js";

describe("morning: the stop of a ticket filled in part", () => {
  it("reads the stop of a buy filled 60 of 100 and then cancelled, as the stops alert does", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "morning-partial-home-"));
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions(
      [
        { date: "2026-06-01", type: "deposit", account: "pea", amount: 10_000, currency: "EUR", origin: "manual" },
        { date: "2026-06-01", type: "buy", account: "pea", symbol: "ALO.PA", quantity: 60, price: 20, fee: 0, currency: "EUR", origin: "ticket:t-partial" },
      ],
      "real",
    );
    const ticket = {
      id: "t-partial",
      createdAt: "2026-06-01T08:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
      status: "cancelled",
      order: {
        account: "pea",
        symbol: "ALO.PA",
        side: "buy",
        quantity: 100,
        price: 20,
        orderType: "limit",
        currency: "EUR",
        stop: 16,
        assetKind: "equity",
        venue: "paper",
      },
      fingerprint: "test",
      fills: [{ at: "2026-06-01T09:00:00.000Z", quantity: 60, price: 20, fee: 0, venue: "paper", method: "test" }],
      history: [{ at: "2026-06-01T10:00:00.000Z", from: "submitted", to: "cancelled", why: "test" }],
    };
    mkdirSync(join(homeDir(), "tickets"), { recursive: true });
    writeFileSync(join(homeDir(), "tickets", `${ticket.id}.json`), JSON.stringify(ticket));

    await withFixture("morning-alo", async () => {
      const dir = mkdtempSync(join(tmpdir(), "morning-partial-run-"));
      await morningRun(dir, { markets: ["eu"] });
      const store = EvidenceStore.load(dir)!;
      // The 60 shares it bought are held under its stop: the brief measures the distance to it.
      expect(store.byKey("TICKET.t-partial.stop")?.value).toBe(16);
      expect(store.byKey("TICKET.t-partial.stopDistance")).toBeDefined();
    });
  }, 60_000);
});
