import { appendTransactions } from "../../src/portfolio/ledger.js";
import type { Order } from "../../src/trading/riskgate.js";
import { createTicket, transition } from "../../src/trading/tickets.js";

/**
 * A paper record that passes `readiness`: 20 winning round trips, the first 40 days ago — each leg a paper ticket the
 * paper engine filled (the live gate counts nothing else), booked in the paper ledger under its ticket.
 */
export async function readyPaperRecord(): Promise<void> {
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  await appendTransactions([{ date: day(41), type: "deposit", account: "paper", amount: 10_000, currency: "EUR", origin: "manual" }], "paper");
  for (let i = 0; i < 20; i++)
    for (const [side, price, at] of [
      ["buy", 100 + i, `${day(40 - i)}T10:00:00.000Z`],
      ["sell", 110 + i, `${day(40 - i)}T15:00:00.000Z`],
    ] as const) {
      const order: Order = {
        account: "paper",
        symbol: "AAA",
        side,
        quantity: 1,
        price,
        orderType: "limit",
        currency: "EUR",
        stop: side === "buy" ? price - 5 : undefined,
        assetKind: "equity",
        venue: "paper",
      };
      const t = createTicket(order, { now: new Date(at) });
      const fill = { at, quantity: 1, price, fee: 0, venue: "paper", method: "test fill" };
      await transition(t.id, "filled", fill.method, async (x) => {
        await appendTransactions(
          [{ date: at, type: side, account: "paper", symbol: "AAA", quantity: 1, price, fee: 0, currency: "EUR", origin: `ticket:${x.id}` }],
          "paper",
        );
        x.fills.push(fill);
      });
    }
}
