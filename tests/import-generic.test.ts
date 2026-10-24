import { describe, expect, it } from "vitest";
import { type ColumnMap, GENERIC_PRESETS, parseStatement, typeFromWord } from "../src/portfolio/import/index.js";
import { checkColumnMap } from "../src/portfolio/import/generic.js";
import { splitPair, statementDate, statementNumber } from "../src/portfolio/import/shared.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { bySymbol, replay, sample } from "./helpers/import.js";

const FR_MAP: ColumnMap = {
  date: "Date",
  type: "Operation",
  symbol: "Symbole",
  isin: "Code ISIN",
  quantity: "Quantite",
  price: "Cours",
  fee: "Frais",
  amount: "Montant net",
  currency: "Devise",
};
const EN_MAP: ColumnMap = { date: "Date", type: "Type", symbol: "Ticker", quantity: "Qty", price: "Price", fee: "Fees", amount: "Amount", currency: "Ccy" };

describe("statement readers", () => {
  it("dates without the local time zone", () => {
    expect(statementDate("2026-01-05")).toBe("2026-01-05");
    expect(statementDate("20260105;103000")).toBe("2026-01-05T10:30:00");
    expect(statementDate("2026-01-05, 10:30:00")).toBe("2026-01-05T10:30:00");
    expect(statementDate("2026-01-05T10:30:00Z")).toBe("2026-01-05T10:30:00");
    expect(statementDate("2026-01-05 10:30:00.1234")).toBe("2026-01-05T10:30:00");
    expect(statementDate("05/01/2026")).toBe("2026-01-05");
    expect(statementDate("05.01.2026 09:05")).toBe("2026-01-05T09:05:00");
    expect(statementDate("01/05/2026", "MDY")).toBe("2026-01-05");
    expect(statementDate("45/13/2026")).toBeUndefined();
    expect(statementDate("yesterday")).toBeUndefined();
  });
  it("numbers in French and English forms", () => {
    expect(statementNumber("1 234,56", ",")).toBe(1234.56);
    expect(statementNumber("0,125", ",")).toBe(0.125);
    expect(statementNumber("1.234,5", ",")).toBe(1234.5);
    expect(statementNumber("1,234.56", ".")).toBe(1234.56);
    expect(statementNumber("€-12.00")).toBe(-12);
    expect(statementNumber("")).toBeUndefined();
  });
  it("crypto pairs", () => {
    expect(splitPair("BTCUSDT")).toEqual({ base: "BTC", quote: "USDT" });
    expect(splitPair("ETH-EUR")).toEqual({ base: "ETH", quote: "EUR" });
    expect(splitPair("SOL/USDC")).toEqual({ base: "SOL", quote: "USDC" });
    expect(splitPair("BTCFDUSD")).toEqual({ base: "BTC", quote: "FDUSD" });
    expect(splitPair("XYZ")).toBeUndefined();
  });
  it("type words in English and French", () => {
    expect(
      ["ACHAT COMPTANT", "Vente", "Dividende", "Coupon", "Dépôt", "Versement", "Retrait", "Frais", "Droits de garde", "Intérêts", "Prélèvements sociaux"].map(
        (w) => typeFromWord(w),
      ),
    ).toEqual(["buy", "sell", "dividend", "dividend", "deposit", "deposit", "withdrawal", "fee", "fee", "interest", "tax"]);
    expect(typeFromWord("Retenue à la source sur dividende")).toBe("tax");
    expect(typeFromWord("transfer-in")).toBe("transfer-in");
    expect(typeFromWord("OST", { ost: "split" })).toBe("split");
    expect(typeFromWord("Opération sur titres")).toBeUndefined();
  });
});

describe("generic CSV with a column map", () => {
  it("reads a French export: ';', decimal commas, DD/MM/YYYY, French labels, ISIN as symbol", () => {
    const r = parseStatement("generic", sample("generic-fr.csv"), { account: "pea", map: FR_MAP });
    expect(r.transactions.map((t) => `${t.type}:${t.symbol ?? t.currency}`)).toEqual([
      "deposit:EUR",
      "buy:FR0000120073",
      "buy:MC.PA",
      "buy:FR0000131104",
      "buy:FR0099999990",
      "sell:MC.PA",
      "dividend:FR0000120073",
      "tax:FR0000120073",
      "fee:EUR",
      "withdrawal:EUR",
    ]);
    expect(r.transactions[0]).toMatchObject({ date: "2026-01-02", amount: 5000 });
    expect(r.transactions[1]).toMatchObject({ quantity: 10, price: 165.5, fee: 1.99, isin: "FR0000120073" });
    // No price: (|net amount| − fee) / quantity.
    expect(r.transactions[3]).toMatchObject({ quantity: 20, price: 65 });
    // "0,125" is an eighth of a share, not 125.
    expect(r.transactions[4]!.quantity).toBe(0.125);
    // Signs normalised by type.
    expect(r.transactions.slice(-3).map((t) => t.amount)).toEqual([-5.07, -12, -500]);
    expect(r.skipped).toEqual([
      { line: 12, reason: 'unreadable date "45/13/2026"' },
      { line: 13, reason: expect.stringMatching(/Opération sur titres/) },
    ]);
    expect(r.warnings.join(" ")).toMatch(/no price/);
    expect(replay(r.transactions).positions.find((p) => p.symbol === "MC.PA")).toMatchObject({ quantity: 1 });
  });
  it("reads an English export with the map from the docs, and dedupes a re-import", async () => {
    const r = parseStatement("generic", sample("generic-en.csv"), { account: "us", map: EN_MAP });
    expect(r.transactions.map((t) => t.type)).toEqual(["deposit", "buy", "buy", "sell", "dividend", "split", "fee"]);
    expect(r.transactions[0]!.amount).toBe(10000);
    expect(r.skipped).toEqual([{ line: 9, reason: "a buy needs a positive quantity" }]);
    expect(replay(r.transactions).positions.find((p) => p.symbol === "NVDA")).toMatchObject({ quantity: 60 });
    expect((await appendTransactions(r.transactions, "test-generic")).added).toHaveLength(7);
    expect((await appendTransactions(r.transactions, "test-generic")).added).toHaveLength(0);
    expect(bySymbol(r.transactions, "MSFT")).toHaveLength(2);
  });
  it("refuses a map that does not fit, naming the file's columns", () => {
    expect(() => parseStatement("generic", sample("generic-en.csv"), { account: "us", map: { ...EN_MAP, fee: "Commission" } })).toThrow(
      /fee → "Commission".*"Date", "Type"/,
    );
    expect(() => parseStatement("generic", sample("generic-en.csv"), { account: "us", map: { date: "When", type: "Type" } })).toThrow(/date column "When"/);
    // A named (best-effort) map only warns about optional columns it cannot find.
    const preset = { ...GENERIC_PRESETS.fortuneo!.map, date: "Date", type: "Opération", delimiter: ";" };
    const r = parseStatement("generic", sample("generic-fr.csv"), { account: "pea", map: preset, presetName: "fortuneo" });
    expect(r.warnings.join(" ")).toMatch(/best-effort/);
    expect(r.warnings.join(" ")).toMatch(/not in the file/);
  });
  it("validates the map itself", () => {
    expect(() => checkColumnMap([])).toThrow(/JSON object/);
    expect(() => checkColumnMap({ type: "Type" })).toThrow(/needs "date"/);
    expect(() => checkColumnMap({ date: "Date" })).toThrow(/"type"/);
    expect(() => checkColumnMap({ date: "Date", type: "T", ticker: "X" })).toThrow(/unknown column-map key/);
    expect(() => checkColumnMap({ date: "Date", defaultType: "purchase" })).toThrow(/defaultType/);
    expect(() => checkColumnMap({ date: "Date", type: "T", types: { OST: "nope" } })).toThrow(/types\["OST"\]/);
    expect(checkColumnMap({ date: "Date", defaultType: "buy", decimal: "," })).toMatchObject({ defaultType: "buy" });
  });
});
