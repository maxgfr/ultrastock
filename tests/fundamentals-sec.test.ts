import { describe, expect, it } from "vitest";
import type { Dataset } from "../src/core/datasets.js";
import {
  isImportant8k,
  parseCompanyFacts,
  parseFullTextSearch,
  parseSecTickerMap,
  parseSubmissions,
  secFilings,
  secFullTextSearch,
  secFundamentals,
  secFundamentalsPoints,
  secTickerForm,
  secUserAgent,
} from "../src/providers/fundamentals/sec.js";
import { diff13f, managerFor, parse13fTable, sec13f } from "../src/providers/fundamentals/sec-13f.js";
import { parseForm4, secInsiders, summarizeInsiders } from "../src/providers/fundamentals/sec-insiders.js";
import { withFixture } from "./helpers/fixtures.js";

const point = (ds: Dataset, key: string) => ds.points.find((p) => p.key === key);

const fact = (start: string | undefined, end: string, val: number, form: string, filed: string, fy: number, fp: string, accn: string) => ({
  ...(start ? { start } : {}),
  end,
  val,
  form,
  filed,
  fy,
  fp,
  accn,
});

// A small companyfacts document: FY2024 and three 2025 quarters (Q2/Q3 also as
// year-to-date), a restated FY2024 filed later, and a cash-flow line that is
// only ever year-to-date, as in real 10-Qs.
const FACTS = {
  cik: 1,
  entityName: "Example Corp",
  facts: {
    "us-gaap": {
      Revenues: {
        units: {
          USD: [
            fact("2024-01-01", "2024-12-31", 1000, "10-K", "2025-02-10", 2024, "FY", "k24"),
            fact("2024-10-01", "2024-12-31", 280, "10-K", "2025-02-10", 2024, "FY", "k24"),
            fact("2024-01-01", "2024-09-30", 720, "10-Q", "2024-11-01", 2024, "Q3", "q324"),
            fact("2025-01-01", "2025-03-31", 300, "10-Q", "2025-05-01", 2025, "Q1", "q125"),
            fact("2025-04-01", "2025-06-30", 310, "10-Q", "2025-08-01", 2025, "Q2", "q225"),
            fact("2025-07-01", "2025-09-30", 320, "10-Q", "2025-11-01", 2025, "Q3", "q325"),
            fact("2024-01-01", "2024-12-31", 990, "10-K/A", "2025-06-01", 2024, "FY", "ka24"),
          ],
        },
      },
      NetCashProvidedByUsedInOperatingActivities: {
        units: {
          USD: [
            fact("2025-01-01", "2025-03-31", 50, "10-Q", "2025-05-01", 2025, "Q1", "q125"),
            fact("2025-01-01", "2025-06-30", 120, "10-Q", "2025-08-01", 2025, "Q2", "q225"),
            fact("2025-01-01", "2025-09-30", 200, "10-Q", "2025-11-01", 2025, "Q3", "q325"),
          ],
        },
      },
      PaymentsToAcquirePropertyPlantAndEquipment: {
        units: {
          USD: [
            fact("2025-01-01", "2025-06-30", 30, "10-Q", "2025-08-01", 2025, "Q2", "q225"),
            fact("2025-01-01", "2025-03-31", 10, "10-Q", "2025-05-01", 2025, "Q1", "q125"),
          ],
        },
      },
      Assets: {
        units: {
          USD: [
            fact(undefined, "2024-12-31", 5000, "10-K", "2025-02-10", 2024, "FY", "k24"),
            fact(undefined, "2025-09-30", 5600, "10-Q", "2025-11-01", 2025, "Q3", "q325"),
          ],
        },
      },
    },
    dei: { EntityCommonStockSharesOutstanding: { units: { shares: [fact(undefined, "2025-10-20", 42, "10-Q", "2025-11-01", 2025, "Q3", "q325")] } } },
  },
};

describe("SEC parsers", () => {
  it("maps tickers to CIKs, EDGAR-style", () => {
    const map = parseSecTickerMap({
      "0": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" },
      "1": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE" },
    });
    expect(map.NVDA).toEqual({ cik: 1045810, ticker: "NVDA", title: "NVIDIA CORP" });
    expect(map[secTickerForm("brk.b")]?.cik).toBe(1067983);
    expect(parseSecTickerMap(null)).toEqual({});
  });

  it("never sends a github.com User-Agent, which EDGAR refuses", () => {
    expect(secUserAgent()).not.toMatch(/github\.com/);
    process.env.ULTRASTOCK_SEC_CONTACT = "ops@example.org";
    expect(secUserAgent()).toMatch(/ops@example\.org$/);
    delete process.env.ULTRASTOCK_SEC_CONTACT;
  });

  it("normalizes company facts: restatements, YTD-derived quarters, TTM, FCF", () => {
    const f = parseCompanyFacts(FACTS);
    const pts = secFundamentalsPoints(f, "EX");
    const get = (k: string) => pts.find((p) => p.key === `EX.fund.${k}`);
    // The 10-K/A restated FY2024 to 990, filed later: it wins, stamped with its own filing date.
    expect(get("revenue.FY2024")).toMatchObject({ value: 990, asOf: "2024-12-31" });
    expect(get("revenue.FY2024")?.label).toMatch(/10-K\/A filed 2025-06-01/);
    expect(get("revenue.FY2025Q3")).toMatchObject({ value: 320 });
    expect(get("revenue.TTM")).toMatchObject({ value: 280 + 300 + 310 + 320, asOf: "2025-09-30" });
    expect(get("revenue.TTM")?.formula).toBe("sum of FY2024Q4 + FY2025Q1 + FY2025Q2 + FY2025Q3");
    // Cash flow is year-to-date only: Q2 and Q3 are differences.
    expect(get("operatingCashFlow.FY2025Q3")).toMatchObject({ value: 80 });
    expect(get("operatingCashFlow.FY2025Q2")).toMatchObject({ value: 70 });
    expect(get("freeCashFlow.FY2025Q2")).toMatchObject({ value: 70 - 20, formula: "operatingCashFlow − capex" });
    expect(get("assets.FY2024")).toMatchObject({ value: 5000 });
    expect(get("assets.FY2025Q3")).toMatchObject({ value: 5600 });
    expect(get("sharesOutstanding.latest")).toMatchObject({ value: 42, unit: "shares", asOf: "2025-10-20" });
    expect(f.notes.join(" ")).toMatch(/gross profit: not reported/);
  });

  it("is point-in-time: asOf hides later filings and restatements", () => {
    const pts = secFundamentalsPoints(parseCompanyFacts(FACTS, { asOf: "2025-05-15" }), "EX");
    expect(pts.find((p) => p.key === "EX.fund.revenue.FY2024")).toMatchObject({ value: 1000 });
    expect(pts.find((p) => p.key === "EX.fund.revenue.FY2025Q2")).toBeUndefined();
    expect(pts.find((p) => p.key === "EX.fund.revenue.TTM")).toBeUndefined();
  });

  it("reads submissions columns and flags important 8-K items", () => {
    const s = parseSubmissions({
      cik: "320193",
      name: "Apple Inc.",
      tickers: ["AAPL"],
      filings: {
        recent: {
          accessionNumber: ["0000320193-26-000018", "0001140361-26-040540"],
          filingDate: ["2026-07-30", "2026-10-22"],
          reportDate: ["2026-07-30", "2026-10-20"],
          form: ["8-K", "4"],
          items: ["2.02,9.01", ""],
          primaryDocument: ["aapl-20260730.htm", "xslF345X06/form4.xml"],
        },
      },
    });
    expect(s.filings.map((f) => f.form)).toEqual(["4", "8-K"]);
    const k = s.filings[1]!;
    expect(k.items).toEqual(["2.02", "9.01"]);
    expect(isImportant8k(k)).toBe(true);
    expect(isImportant8k({ form: "8-K", items: ["9.01"] })).toBe(false);
    expect(k.url).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/0000320193-26-000018-index.htm");
  });

  it("reads full-text search hits with their document URL", () => {
    const r = parseFullTextSearch({
      hits: {
        total: { value: 1 },
        hits: [
          {
            _id: "0001213900-26-109249:ex99-1.htm",
            _source: { ciks: ["0001999261"], display_names: ["X Corp (X)"], form: "8-K", file_date: "2026-10-14", file_description: "EXHIBIT 99.1" },
          },
        ],
      },
    });
    expect(r.hits[0]).toMatchObject({
      accession: "0001213900-26-109249",
      url: "https://www.sec.gov/Archives/edgar/data/1999261/000121390026109249/ex99-1.htm",
    });
  });

  it("reads Form 4 transactions and detects a cluster buy", () => {
    const xml = `<?xml version="1.0"?><ownershipDocument><issuer><issuerCik>0000000001</issuerCik><issuerTradingSymbol>EX</issuerTradingSymbol></issuer>
      <reportingOwner><reportingOwnerId><rptOwnerCik>01</rptOwnerCik><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
      <aff10b5One>0</aff10b5One><nonDerivativeTable><nonDerivativeTransaction><transactionDate><value>2026-10-01</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1,000</value></transactionShares>
      <transactionPricePerShare><value>10.5</value><footnoteId id="F1"/></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
    const f = parseForm4(xml);
    expect(f.owners).toEqual([{ cik: "01", name: "Doe Jane", title: "CEO, Director" }]);
    expect(f.transactions).toEqual([{ date: "2026-10-01", code: "P", shares: 1000, price: 10.5, acquired: true, sharesAfter: 5000, direct: true }]);
    const now = new Date("2026-10-20T00:00:00Z");
    const one = summarizeInsiders([f], now);
    expect(one).toMatchObject({ buyShares: 1000, buyValue: 10500, netValue: 10500, buyers30d: 1, clusterBuy: false });
    const others = ["02", "03"].map((cik) => ({ ...f, owners: [{ ...f.owners[0]!, cik }] }));
    expect(summarizeInsiders([f, ...others], now).clusterBuy).toBe(true);
    expect(summarizeInsiders([f], new Date("2027-03-01T00:00:00Z")).buyValue).toBe(0);
  });

  it("aggregates a 13F information table and diffs two quarters", () => {
    const row = (cusip: string, value: number, shares: number, putCall = "") =>
      `<ns1:infoTable><ns1:nameOfIssuer>CO ${cusip}</ns1:nameOfIssuer><ns1:titleOfClass>COM</ns1:titleOfClass><ns1:cusip>${cusip}</ns1:cusip><ns1:value>${value}</ns1:value><ns1:shrsOrPrnAmt><ns1:sshPrnamt>${shares}</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt>${putCall ? `<ns1:putCall>${putCall}</ns1:putCall>` : ""}</ns1:infoTable>`;
    const cur = parse13fTable(
      `<ns1:informationTable>${row("AAA111111", 100, 10)}${row("AAA111111", 50, 5)}${row("BBB222222", 300, 30)}${row("AAA111111", 7, 1, "Put")}</ns1:informationTable>`,
    );
    expect(cur.map((h) => [h.cusip, h.putCall, h.value, h.shares])).toEqual([
      ["BBB222222", undefined, 300, 30],
      ["AAA111111", undefined, 150, 15],
      ["AAA111111", "PUT", 7, 1],
    ]);
    const prev = parse13fTable(`${row("AAA111111", 20, 20)}${row("CCC333333", 9, 9)}`, { thousands: true });
    expect(prev[0]?.value).toBe(20_000);
    const d = diff13f(cur, prev);
    expect(d.map((x) => [x.holding.cusip, x.holding.putCall, x.change, x.sharesChange])).toEqual([
      ["BBB222222", undefined, "new", 30],
      ["AAA111111", undefined, "trimmed", -5],
      ["AAA111111", "PUT", "new", 1],
      ["CCC333333", undefined, "sold", -9],
    ]);
    expect(managerFor("berkshire").cik).toBe(1067983);
    expect(managerFor("CIK1649339").note).toMatch(/2025/);
    expect(() => managerFor("nobody at all")).toThrow(/unknown 13F manager/);
  });
});

describe("SEC fixtures", () => {
  it("replays Reddit's company facts, also as filed by mid-2025", async () => {
    await withFixture("fundamentals-sec-facts", async () => {
      const ds = await secFundamentals("1713445", { subject: "RDDT" });
      expect(ds.provenance).toMatchObject({ source: "sec-edgar", official: true, delay: "filing" });
      expect(point(ds, "RDDT.fund.revenue.FY2025")).toMatchObject({ value: 2202506000, unit: "USD", asOf: "2025-12-31" });
      expect(point(ds, "RDDT.fund.revenue.FY2025")?.label).toMatch(/10-K filed 2026-02-06/);
      expect(point(ds, "RDDT.fund.revenue.TTM")?.formula).toMatch(/^sum of /);
      expect(point(ds, "RDDT.fund.freeCashFlow.FY2025")?.formula).toBe("operatingCashFlow − capex");
      expect(ds.points.every((p) => typeof p.value === "number" && p.asOf)).toBe(true);
      const old = await secFundamentals("1713445", { subject: "RDDT", asOf: "2025-06-30" });
      expect(point(old, "RDDT.fund.revenue.FY2025")).toBeUndefined();
      expect(point(old, "RDDT.fund.revenue.FY2024")).toMatchObject({ value: 1300205000 });
      expect(old.title).toMatch(/as filed by 2025-06-30/);
    });
  }, 60_000);

  it("replays Apple's recent 8-Ks and Form 4 insider trades", async () => {
    await withFixture("fundamentals-sec-aapl", async () => {
      const f = await secFilings("320193", { forms: ["8-K"], limit: 5 });
      expect(f.subject).toBe("AAPL");
      expect(f.points.filter((p) => p.key.startsWith("AAPL.filing.")).every((p) => /^8-K/.test(String(p.value)))).toBe(true);
      expect(point(f, "AAPL.filings.8k.important.count")?.unit).toBe("count");
      const ins = await secInsiders("320193", { limit: 5 });
      expect(ins.kind).toBe("insiders");
      const owners = ins.points.filter((p) => p.key.endsWith(".owner"));
      expect(owners.length).toBe(5);
      expect(owners.every((p) => p.untrusted)).toBe(true);
      const trades = ins.points.filter((p) => /\.insider\.[\d-]+\.\d+$/.test(p.key));
      expect(trades.length).toBeGreaterThan(5);
      expect(trades.every((p) => p.unit === "shares" && typeof p.value === "number")).toBe(true);
      expect(point(ins, "AAPL.insider.clusterBuy")?.value).toBe(false);
      expect(point(ins, "AAPL.insider.net90d.value")?.unit).toBe("USD");
    });
  }, 60_000);

  it("replays Berkshire's latest two 13F-HRs, with OpenFIGI tickers", async () => {
    await withFixture("fundamentals-sec-13f", async () => {
      const ds = await sec13f("berkshire", { top: 5, tickers: true });
      expect(ds.title).toMatch(/^Berkshire Hathaway 13F holdings/);
      const total = point(ds, "CIK1067983.13f.total.value")?.value as number;
      expect(total).toBeGreaterThan(1e11);
      const weights = ds.points.filter((p) => p.key.endsWith(".weight"));
      expect(weights).toHaveLength(5);
      expect(weights.every((p) => p.unit === "%" && (p.value as number) > 0 && (p.value as number) < 100)).toBe(true);
      expect(point(ds, "CIK1067983.13f.037833100.ticker")?.value).toBe("AAPL");
      expect(ds.points.filter((p) => p.key.endsWith(".change")).length).toBe(5);
      expect(ds.notes.join(" ")).toMatch(/45 days/);
    });
  }, 60_000);

  it("replays an EDGAR full-text search", async () => {
    await withFixture("fundamentals-sec-fts", async () => {
      const ds = await secFullTextSearch('"material weakness"', { forms: ["8-K"], days: 7, limit: 5 });
      const hits = ds.points.filter((p) => p.untrusted);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((p) => p.url?.startsWith("https://www.sec.gov/Archives/edgar/data/"))).toBe(true);
      expect(point(ds, "SEC.search.total")?.unit).toBe("count");
    });
  }, 60_000);
});
