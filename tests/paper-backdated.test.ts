import { FIXTURE_SAFE_DATE, installTestVenueFacts } from "./helpers/venue-facts.js";
// `paper submit <ticket> --fixture <dir>` (the paper command takes --fixture/--record; the package ships
// assets/fixtures/*) fills at the recording's price and books the trade at the recording's date. The paper ledger is
// what `readiness` — a precondition of every live order (live.ts:177-186) — measures "30 days of paper trading" on.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clockNow } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions, readLedger } from "../src/portfolio/ledger.js";
import { closedTradeResults, readEquity } from "../src/trading/breaker.js";
import { paperRecord, paperSubmit, readiness } from "../src/trading/paper.js";
import { planTrade } from "../src/trading/plan.js";
import { createTicket, listTickets, recordCheck } from "../src/trading/tickets.js";
import { withFixture } from "./helpers/fixtures.js";

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

describe("the paper record the live gate reads", () => {
  it("does not start before the day its first paper order was placed", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    installTestVenueFacts({ date: FIXTURE_SAFE_DATE });
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "paper");

    // Today, for the first time: `plan MC.PA --account cto --ticket --fixture assets/fixtures/trading-paper-mcpa`, then
    // `paper submit <ticket> --fixture assets/fixtures/trading-paper-mcpa` — exactly what commands/trading.ts runs.
    await withFixture("trading-paper-mcpa", async () => {
      const p = await planTrade({ symbol: "MC.PA", account: "cto" });
      const t = createTicket(p.order);
      await recordCheck(t.id, p.gate);
      const r = await paperSubmit(t.id, clockNow());
      expect(r.ticket.status).toBe("filled");
    });

    // `paper readiness`, and the live precondition, on the wall clock.
    const txs = readLedger("paper");
    const first = txs.find((x) => x.type === "buy")!.date;
    const r = readiness(closedTradeResults(txs), readEquity("paper"), first, new Date());
    // The first paper trade was made a moment ago: zero days of paper trading.
    expect(r.criteria.find((c) => c.id === "days")!.value).toBe(0);
    // The fill is marked replayed, and the record the live gate reads leaves it out.
    expect(listTickets((t) => t.status === "filled").flatMap((t) => t.fills.map((f) => f.replayed))).toEqual([true]);
    const rec = paperRecord(txs, listTickets());
    expect(rec.txs.filter((x) => x.type === "buy")).toEqual([]);
    expect(rec.excluded.join("\n")).toMatch(/1 paper fill\(s\) made on a replayed fixture/);
  }, 60_000);
});
