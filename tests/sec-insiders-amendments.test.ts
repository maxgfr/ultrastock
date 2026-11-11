// Amended Form 4s (sec-insiders): each 4/A replaces the line it corrects, in filing order.
// An amendment that corrects ONE of several lines of the same transaction date and code
// (several fills on one day is the ordinary shape of a Form 4) must replace that line —
// not the first line of the original that happens to share the date and the code.
import { describe, expect, it } from "vitest";
import { netOfAmendments, summarizeInsiders } from "../src/providers/fundamentals/sec-insiders.js";

const now = new Date("2026-10-20T00:00:00Z");
const jane = { cik: "01", name: "Doe Jane", title: "CEO" };
const buy = (date: string, shares: number, price: number) => ({ date, code: "P", shares, price, acquired: true, direct: true });

describe("a 4/A correcting one of several same-day lines", () => {
  // Original, filed 2026-10-02: three purchases on 2026-10-01
  //   1 000 @ 10 = 10 000 ; 500 @ 11 = 5 500 ; 200 @ 12 = 2 400
  // Amendment, filed 2026-10-06, restates only the third line with its share count corrected: 250 @ 12 = 3 000.
  // Net of the amendment: 1 000 + 500 + 250 = 1 750 shares, 10 000 + 5 500 + 3 000 = 18 500 USD.
  const original = { owners: [jane], transactions: [buy("2026-10-01", 1000, 10), buy("2026-10-01", 500, 11), buy("2026-10-01", 200, 12)], filed: "2026-10-02" };
  const amended = { owners: [jane], transactions: [buy("2026-10-01", 250, 12)], filed: "2026-10-06", amendment: true, originalFiled: "2026-10-02" };

  it("replaces the line it corrects (same price), not the first line of that day", () => {
    const s = summarizeInsiders([amended, original], now);
    expect(s.buyShares).toBe(1750);
    expect(s.buyValue).toBe(18500);
  });

  it("keeps the two lines the amendment does not mention", () => {
    const { transactions } = netOfAmendments([amended, original]);
    expect(transactions[1]).toEqual([buy("2026-10-01", 1000, 10), buy("2026-10-01", 500, 11)]);
  });

  // The same with a corrected price on the second line: 500 @ 11 → 500 @ 11.5 (5 750).
  // Net: 1 000 @ 10 + 500 @ 11.5 + 200 @ 12 = 1 700 shares, 10 000 + 5 750 + 2 400 = 18 150 USD.
  it("replaces the line with the same share count when the price is what was corrected", () => {
    const priceFix = { owners: [jane], transactions: [buy("2026-10-01", 500, 11.5)], filed: "2026-10-06", amendment: true, originalFiled: "2026-10-02" };
    const s = summarizeInsiders([priceFix, original], now);
    expect(s.buyShares).toBe(1700);
    expect(s.buyValue).toBe(18150);
  });
});

describe("a 4/A whose corrected line could replace several of its day", () => {
  it("picks none by position, and says so", () => {
    const two = { owners: [jane], transactions: [buy("2026-10-01", 100, 10), buy("2026-10-01", 200, 11)], filed: "2026-10-02" };
    // Price and share count both differ from each line: nothing tells which one it corrects.
    const fix = { owners: [jane], transactions: [buy("2026-10-01", 300, 12)], filed: "2026-10-06", amendment: true, originalFiled: "2026-10-02" };
    const { transactions, notes } = netOfAmendments([fix, two]);
    expect(transactions[1]).toEqual(two.transactions);
    expect(notes.join(" ")).toMatch(/could replace several lines of its day.*none is picked/);
  });
});

describe("two amendments of one form filed on the same day", () => {
  // Original 1 000 @ 10; a first 4/A (accession …002) corrects the price to 11; a second 4/A (accession …003),
  // filed the same day, corrects the share count to 900. The last word is 900 @ 11 = 9 900, in whatever order the
  // filings are given — EDGAR lists them newest first, which is the order that fails.
  const one = { owners: [jane], transactions: [buy("2026-10-01", 1000, 10)], filed: "2026-10-02", accession: "0001-26-000001" };
  const amend = (accession: string, shares: number) => ({
    owners: [jane],
    transactions: [buy("2026-10-01", shares, 11)],
    filed: "2026-10-05",
    accession,
    amendment: true,
    originalFiled: "2026-10-02",
  });
  const first = amend("0001-26-000002", 1000);
  const second = amend("0001-26-000003", 900);

  it("keeps the later amendment, newest first as EDGAR lists them", () => {
    expect(summarizeInsiders([one, first, second], now)).toMatchObject({ buyShares: 900, buyValue: 9900 });
    expect(summarizeInsiders([second, first, one], now)).toMatchObject({ buyShares: 900, buyValue: 9900 });
  });
});
