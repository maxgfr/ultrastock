// US, transfer carry: a staking reward is not coins moved from another account.
import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/core/profile.js";
import { parseStatement } from "../src/portfolio/import/index.js";
import { type Transaction, transactionId } from "../src/portfolio/ledger.js";
import type { TaxInput } from "../src/tax/regime.js";
import { UsRegime } from "../src/tax/us.js";

const tx = (t: Partial<Transaction> & Pick<Transaction, "date" | "type" | "account">): Transaction => {
  const raw = { origin: "manual", currency: "USD", ...t } as Omit<Transaction, "id">;
  return { ...raw, id: transactionId(raw) } as Transaction;
};
const COINBASE: Envelope = { id: "coinbase", type: "CRYPTO", broker: "Coinbase", currency: "USD" };
const KRAKEN: Envelope = { id: "kraken", type: "CRYPTO", broker: "Kraken", currency: "USD" };

describe("US: a staking reward received while coins of the same asset are on their way to a wallet outside the ledger", () => {
  it("does not take the basis and the holding period of the coins that left the other account", () => {
    // Coinbase: 1 ETH bought 2022-03-02 for 1 000 $, sent to a hardware wallet on 2025-06-01 (no account of the ledger
    // receives it). Kraken: a staking reward of 0.1 ETH on 2025-06-10, as the Kraken importer books it (a transfer-in
    // without a price, note "kraken staking reward…"), sold 2025-12-01 for 400 $.
    // Rev. Rul. 2023-14 / Notice 2014-21: a reward is income at its value when received; that value is its basis and
    // its holding period starts that day. The ledger has no value for it, so the engine's own rule applies: basis 0
    // from 2025-06-10, short-term, and a warning asking for the value — never the 2022 lot of the coins sent away
    // (0.1 × 1 000 = 100 $ of basis, long-term).
    const ledgersCsv =
      '"txid","refid","time","type","subtype","aclass","asset","amount","fee","balance"\n' +
      '"L1","R1","2025-06-10 08:00:00","staking","","currency","ETH",0.1,0,0.1\n';
    const reward = parseStatement("kraken", ledgersCsv, { account: "kraken", quote: "USD" }).transactions.map(
      (t) => ({ ...t, id: transactionId(t) }) as Transaction,
    );
    expect(reward.map((t) => [t.type, t.symbol, t.quantity, t.price, t.note])).toEqual([
      ["transfer-in", "ETHUSD", 0.1, undefined, "kraken staking reward: no price in the export, booked at the running average cost"],
    ]);
    const txs = [
      tx({ date: "2022-03-02", type: "buy", account: "coinbase", symbol: "ETHUSD", quantity: 1, price: 1000 }),
      tx({ date: "2025-06-01", type: "transfer-out", account: "coinbase", symbol: "ETHUSD", quantity: 1 }),
      ...reward,
      tx({ date: "2025-12-01", type: "sell", account: "kraken", symbol: "ETHUSD", quantity: 0.1, price: 4000 }),
    ];
    const input: TaxInput = { year: 2025, transactions: txs, envelopes: [COINBASE, KRAKEN], fx: () => 1 };
    const res = new UsRegime(2025).replay(input);
    const sale = res.events.filter((e) => e.kind === "crypto-disposal");
    expect(sale.map((e) => [e.proceeds, e.cost, e.term, e.acquired])).toEqual([[400, 0, "short", "2025-06-10"]]);
    expect(res.warnings.join(" ")).toMatch(/transferred into kraken on 2025-06-10 without a price/);
    expect(res.warnings.join(" ")).toMatch(/reward .*Rev\. Rul\. 2023-14/);
  });
  it("a move without a reward note still takes the basis of the coins that left", () => {
    const txs = [
      tx({ date: "2022-03-02", type: "buy", account: "coinbase", symbol: "ETHUSD", quantity: 1, price: 1000 }),
      tx({ date: "2025-06-01", type: "transfer-out", account: "coinbase", symbol: "ETHUSD", quantity: 1 }),
      tx({ date: "2025-06-03", type: "transfer-in", account: "kraken", symbol: "ETHUSD", quantity: 1 }),
      tx({ date: "2025-12-01", type: "sell", account: "kraken", symbol: "ETHUSD", quantity: 1, price: 4000 }),
    ];
    const res = new UsRegime(2025).replay({ year: 2025, transactions: txs, envelopes: [COINBASE, KRAKEN], fx: () => 1 });
    expect(res.events.map((e) => [e.cost, e.term, e.acquired])).toEqual([[1000, "long", "2022-03-02"]]);
  });
});
