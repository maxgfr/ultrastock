// src/tax/neutral.ts, the neutral facts report.
//
// 1. chosenMethod marked the cost "the law's" by the first word it found: any text holding "fifo" was FIFO, even one
//    that names the weighted average and says FIFO is NOT allowed. The key's unit is 'text: "fifo", "average" or a
//    description' (tax/rules.ts), so a description is expected input; the report then starred the FIFO cost and
//    titled its dataset "cost method fifo".
// 2. Interest paid in a stablecoin: a payment of an EARLIER year joined the holding at its value (stablecoins
//    included), a payment of the REPORT year did not. The report lists stablecoin disposals, so spending that interest
//    in the year it was paid showed a cost of 0 and a gain equal to the whole proceeds.
import { describe, expect, it } from "vitest";
import { type Transaction, transactionId } from "../src/portfolio/ledger.js";
import { chosenMethod, neutralReport } from "../src/tax/neutral.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const r = { origin: "manual", currency: "EUR", ...t } as Omit<Transaction, "id">;
  return { ...r, id: transactionId(r) } as Transaction;
};
// 1 $ = 0.90 € every day; a stablecoin is at its peg.
const fx = (c: string) => (c === "EUR" ? 1 : c === "USD" ? 0.9 : undefined);
const report = (txs: Transaction[]) => neutralReport({ year: 2025, transactions: txs, envelopes: [], fx, currency: "EUR" });

describe("the researched costMethod that names both methods", () => {
  it("control: a plain answer is read", () => {
    expect(chosenMethod("fifo")).toBe("fifo");
    expect(chosenMethod("weighted average cost")).toBe("average");
  });
  it("a text prescribing the average and excluding FIFO is not marked FIFO", () => {
    expect(chosenMethod("weighted average cost of the pool (Section 104); FIFO is not allowed")).not.toBe("fifo");
    expect(chosenMethod("prix moyen pondéré d'acquisition (PMP) — pas de FIFO")).not.toBe("fifo");
  });
  it("only an unambiguous answer is marked: a text that excludes or names both methods is applied as described", () => {
    expect(chosenMethod("first in, first out")).toBe("fifo");
    expect(chosenMethod("prix moyen pondéré (PMP)")).toBe("average");
    expect(chosenMethod("FIFO is not allowed")).toBeUndefined();
    expect(chosenMethod("FIFO or the weighted average, at the taxpayer's choice")).toBeUndefined();
    expect(chosenMethod("specific identification")).toBeUndefined();
  });
});

describe("interest paid in a stablecoin and spent the same year", () => {
  // 100 USDT of interest (90 €), then 0.001 BTC bought for those 100 USDT: the USDT given were acquired at 90 €.
  const spend = tx({ date: "2025-03-01", type: "buy", account: "kraken", symbol: "BTCUSDT", currency: "USDT", quantity: 0.001, price: 100_000 });
  const usdt = (paid: string) => {
    const r = report([tx({ date: paid, type: "interest", account: "kraken", currency: "USDT", amount: 100 }), spend]);
    const d = r.disposals.find((x) => x.asset === "USDT")!;
    return { cost: d.costFifo, average: d.costAverage, gain: d.gainFifo, warnings: r.warnings.join(" ") };
  };
  it("control: paid the year before, the USDT have their value when received as cost", () => {
    expect(usdt("2024-12-31")).toMatchObject({ cost: 90, average: 90, gain: 0 });
  });
  it("paid in the report year, they have the same cost — not 0", () => {
    const r = usdt("2025-01-02");
    expect(r.warnings).not.toMatch(/more than the ledger's acquisitions/);
    expect(r).toMatchObject({ cost: 90, average: 90, gain: 0 });
  });
});
