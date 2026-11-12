// src/portfolio/import/generic.ts, `--fee-sign`.
//
// The module's own rule: the sign convention is "decided per type (a French export signs its withholding but writes
// custody fees as positive charges). One sign throughout a type: those rows are charges. Both signs within a type: a
// refund is the other sign" — and only then is the file asked (`--fee-sign`). The flag was applied to EVERY fee and
// tax row, whatever the type that was mixed: the type written with one sign throughout stopped being read as charges
// and was booked as refunds.
import { describe, expect, it } from "vitest";
import type { ColumnMap } from "../src/portfolio/import/generic.js";
import { parseStatement } from "../src/portfolio/import/index.js";

const map: ColumnMap = { date: "Date", type: "Type", amount: "Amount", defaultCurrency: "EUR" };

describe("--fee-sign is applied to a type the file writes with one sign only", () => {
  // The very file the comment describes: withholding signed (−15 paid, +5 handed back), custody fees written as
  // positive charges. Only the tax rows carry both signs, so only they need --fee-sign charge-negative.
  const french = ["Date;Type;Amount", "05/01/2026;Tax;-15,00", "06/01/2026;Tax;5,00", "07/01/2026;Fee;2,50", "08/01/2026;Fee;4,00"].join("\n");

  it("control: the tax rows alone are what makes the file ambiguous", () => {
    expect(() => parseStatement("generic", french, { account: "cto", map })).toThrow(/tax rows with both signs/);
    expect(() => parseStatement("generic", french, { account: "cto", map })).not.toThrow(/fee rows/);
  });

  it("charge-negative for the signed tax rows must not turn the all-positive custody fees into refunds", () => {
    const r = parseStatement("generic", french, { account: "cto", map, feeSign: "charge-negative" });
    const fees = r.transactions.filter((t) => t.type === "fee").map((t) => t.amount);
    // One sign throughout the fee type: charges (cash out), as without the flag.
    expect(fees).toEqual([-2.5, -4]);
  });

  it("charge-positive for mixed fee rows must not turn an all-negative withholding into refunds", () => {
    const csv = ["Date;Type;Amount", "05/01/2026;Fee;2,50", "06/01/2026;Fee;-1,00", "07/01/2026;Tax;-15,00", "08/01/2026;Tax;-3,00"].join("\n");
    const r = parseStatement("generic", csv, { account: "cto", map, feeSign: "charge-positive" });
    expect(r.transactions.filter((t) => t.type === "tax").map((t) => t.amount)).toEqual([-15, -3]);
  });

  it("a flag no type needs is said to be unused, and every row stays a charge", () => {
    const csv = ["Date;Type;Amount", "05/01/2026;Fee;2,50", "07/01/2026;Tax;-15,00"].join("\n");
    const r = parseStatement("generic", csv, { account: "cto", map, feeSign: "charge-positive" });
    expect(r.transactions.map((t) => t.amount)).toEqual([-2.5, -15]);
    expect(r.warnings.join(" ")).toMatch(/--fee-sign charge-positive is not used/);
  });
});
