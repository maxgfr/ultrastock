import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Dataset } from "../src/core/datasets.js";
import { finraShortVolume, parseRegShoApi, parseRegShoFile } from "../src/providers/fundamentals/finra.js";
import { housePtrFilings, parseHouseIndex, parsePtrText } from "../src/providers/fundamentals/house.js";
import {
  nasdaqAnalyst,
  nasdaqDividends,
  nasdaqShortInterest,
  parseEarningsForecast,
  parseEstimateMomentum,
  parseNasdaqDividends,
  parseTargetPrice,
} from "../src/providers/fundamentals/nasdaq-analyst.js";
import { monthYearToIso } from "../src/providers/fundamentals/util.js";
import { xmlBlocks, xmlNumber, xmlValue } from "../src/providers/fundamentals/xml.js";
import { zipEntries, zipRead } from "../src/providers/fundamentals/zip.js";
import { withFixture } from "./helpers/fixtures.js";

const point = (ds: Dataset, key: string) => ds.points.find((p) => p.key === key);

/** A ZIP built by hand: one stored and one deflated entry, central directory, end record. */
function makeZip(files: Array<{ name: string; data: Buffer; deflate: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(f.deflate ? 8 : 0, 8);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(f.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(f.deflate ? 8 : 0, 10);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    centrals.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("helpers", () => {
  it("reads stored and deflated ZIP entries, and refuses ZIP64 and garbage", () => {
    const xml = Buffer.from("<a>".repeat(200));
    const zip = makeZip([
      { name: "2026FD.txt", data: Buffer.from("hello"), deflate: false },
      { name: "2026FD.xml", data: xml, deflate: true },
    ]);
    const entries = zipEntries(zip);
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ["2026FD.txt", 0],
      ["2026FD.xml", 8],
    ]);
    expect(zipRead(zip, entries[0]!).toString()).toBe("hello");
    expect(zipRead(zip, entries[1]!).equals(xml)).toBe(true);
    const z64 = Buffer.from(zip);
    z64.writeUInt32LE(0xffffffff, z64.length - 22 + 16);
    expect(() => zipEntries(z64)).toThrow(/ZIP64/);
    expect(() => zipEntries(Buffer.from("not a zip at all, not even close"))).toThrow(/not a ZIP/);
  });

  it("reads XML elements by local name, self-closing ones included", () => {
    const x = `<r><ns:item a="1"><v>1,5</v></ns:item><item/><item><v> x &amp; y </v></item></r>`;
    expect(xmlBlocks(x, "item")).toHaveLength(3);
    expect(xmlNumber(x, "item", "v")).toBe(15);
    expect(xmlValue(xmlBlocks(x, "item")[2]!, "v")).toBe("x & y");
    expect(xmlValue(x, "missing")).toBeUndefined();
    expect(monthYearToIso("Oct 2026")).toBe("2026-10");
  });
});

describe("US market parsers", () => {
  it("reads Nasdaq's analyst payloads", () => {
    expect(
      parseTargetPrice({
        consensusOverview: { lowPriceTarget: 275.0, highPriceTarget: 465.0, priceTarget: 323.45, buy: 33, sell: 0, hold: 0 },
        historicalConsensus: [{ z: { date: "10/01/2026" } }],
      }),
    ).toEqual({ mean: 323.45, high: 465, low: 275, buy: 33, hold: 0, sell: 0, asOf: "2026-10-01" });
    const f = parseEarningsForecast({
      quarterlyForecast: {
        rows: [{ fiscalEnd: "Oct 2026", consensusEPSForecast: 2.49, highEPSForecast: 2.7, lowEPSForecast: 2.34, noOfEstimates: 13, up: 1, down: 0 }],
      },
    });
    expect(f.quarterly[0]).toMatchObject({ fiscalEnd: "2026-10", mean: 2.49, estimates: 13 });
    expect(f.yearly).toEqual([]);
    expect(
      parseEstimateMomentum({
        changeInConsensus: {
          monthData: { qtrMean: 2.47, yrMean: 9.25 },
          currentData: { qtrMean: 2.49, yrMean: 9.3 },
          fiscalQtrEndText: "Fiscal Quarter End Oct 2026",
        },
      }),
    ).toMatchObject({ quarterEnd: "2026-10", quarter: { current: 2.49, monthAgo: 2.47 } });
    const d = parseNasdaqDividends({
      yield: "0.47%",
      annualizedDividend: "1",
      dividends: { rows: [{ exOrEffDate: "09/10/2026", type: "Cash", amount: "$0.25", paymentDate: "10/01/2026", currency: "USD" }] },
    });
    expect(d).toEqual({ yieldPct: 0.47, annual: 1, rows: [{ exDate: "2026-09-10", type: "Cash", amount: 0.25, currency: "USD", paid: "2026-10-01" }] });
  });

  it("sums FINRA facilities per day, and reads a daily file", () => {
    const days = parseRegShoApi([
      { tradeReportDate: "2026-10-23", reportingFacilityCode: "NCTRF", shortParQuantity: 10, shortExemptParQuantity: 0, totalParQuantity: 40 },
      { tradeReportDate: "2026-10-23", reportingFacilityCode: "NQTRF", shortParQuantity: 30, shortExemptParQuantity: 1, totalParQuantity: 60 },
      { tradeReportDate: "2026-10-23", reportingFacilityCode: "ORF", shortParQuantity: 999, totalParQuantity: 999 },
      { tradeReportDate: "2026-10-22", reportingFacilityCode: "NQTRF", shortParQuantity: 5, totalParQuantity: 20 },
    ]);
    expect(days.map((d) => [d.date, d.shortVolume, d.totalVolume, d.ratio])).toEqual([
      ["2026-10-23", 40, 100, 40],
      ["2026-10-22", 5, 20, 25],
    ]);
    const file =
      "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n20261023|NVDA|9498803.375829|58957|32380765.151177|B,Q,N\n20261023|NVDL|1|0|2|Q\n12272\n";
    expect(parseRegShoFile(file, "nvda")).toMatchObject({ date: "2026-10-23", shortVolume: 9498803.375829, shortExemptVolume: 58957 });
    expect(parseRegShoFile(file, "AAPL")).toBeUndefined();
  });

  it("reads the House index and a PTR's extracted text", () => {
    const xml = `<FinancialDisclosure><Member><Prefix>Hon.</Prefix><Last>Doe</Last><First>Jane</First><Suffix /><FilingType>P</FilingType><StateDst>CA01</StateDst><Year>2026</Year><FilingDate>10/2/2026</FilingDate><DocID>20035669</DocID></Member>
      <Member><Last>Roe</Last><First>Rick</First><FilingType>A</FilingType><StateDst>TX02</StateDst><Year>2026</Year><FilingDate>5/13/2026</FilingDate><DocID>10078016</DocID></Member></FinancialDisclosure>`;
    const idx = parseHouseIndex(xml);
    expect(idx[0]).toMatchObject({
      docId: "20035669",
      member: "Hon. Jane Doe",
      filingType: "P",
      date: "2026-10-02",
      pdfUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035669.pdf",
    });
    expect(idx[1]?.pdfUrl).toMatch(/financial-pdfs\/2026\/10078016\.pdf$/);
    // Text as an extraction rung returns it for a real PTR (20035669), whitespace collapsed.
    const text =
      "**T** **ID Owner Asset Transaction Date Notification Amount Cap.** NVIDIA Corporation-Common Stock P 10/01/2026 10/01/2026 $1,001 - $15,000 (NVDA) [ST] F S: New S O: Morgan Stanley-E*TRADE #2 Taiwan Semiconductor S (partial) 10/09/2026 10/10/2026 $15,001 - $50,000 Manufacturing Company Ltd. (TSM) [ST] F S: New US Treasury Bill E 10/11/2026 10/11/2026 Over $50,000,000";
    expect(parsePtrText(text)).toEqual([
      { ticker: "NVDA", type: "P", date: "2026-10-01", notified: "2026-10-01", amountLow: 1001, amountHigh: 15000 },
      { ticker: "TSM", type: "S (partial)", date: "2026-10-09", notified: "2026-10-10", amountLow: 15001, amountHigh: 50000 },
      { type: "E", date: "2026-10-11", notified: "2026-10-11", amountLow: 50000000 },
    ]);
  });
});

describe("US market fixtures", () => {
  it("replays NVDA analyst data, short interest and dividends from Nasdaq", async () => {
    await withFixture("fundamentals-nasdaq-nvda", async () => {
      const sets = await nasdaqAnalyst("NVDA");
      expect(sets.map((d) => d.kind)).toEqual(["analyst", "estimates", "estimates", "estimates"]);
      expect(sets.every((d) => d.provenance.official === false)).toBe(true);
      const all = sets.flatMap((d) => d.points);
      expect(all.find((p) => p.key === "NVDA.analyst.target.mean")?.unit).toBe("USD");
      expect(all.some((p) => /^NVDA\.est\.eps\.q\.\d{4}-\d{2}\.mean$/.test(p.key))).toBe(true);
      expect(all.some((p) => /^NVDA\.eps\.surprise\.\d{4}-\d{2}$/.test(p.key) && p.unit === "%")).toBe(true);
      const si = await nasdaqShortInterest("NVDA", { limit: 2 });
      expect(si.points.filter((p) => p.key.startsWith("NVDA.short.interest."))).toHaveLength(2);
      expect(si.notes[0]).toMatch(/not daily short VOLUME/);
      const div = await nasdaqDividends("NVDA", { limit: 3 });
      expect(point(div, "NVDA.div.yield")?.unit).toBe("%");
      expect(div.points.filter((p) => /^NVDA\.div\.\d{4}-\d{2}-\d{2}$/.test(p.key))).toHaveLength(3);
    });
  }, 60_000);

  it("replays NVDA's Reg SHO short-volume ratio from FINRA", async () => {
    await withFixture("fundamentals-finra-nvda", async () => {
      const ds = await finraShortVolume("NVDA", { sessions: 5 });
      expect(ds.provenance).toMatchObject({ source: "finra", official: true });
      const days = ds.points.filter((p) => /\.ratio\.\d{4}-/.test(p.key));
      expect(days).toHaveLength(5);
      expect(days.every((p) => p.unit === "%" && (p.value as number) > 0 && (p.value as number) < 100)).toBe(true);
      expect(point(ds, "NVDA.shortvol.ratio.avg")?.formula).toBe("mean of the daily ratios");
    });
  }, 60_000);

  it("replays the House disclosure index (a ZIP) for recent PTRs", async () => {
    await withFixture("fundamentals-house", async () => {
      const ds = await housePtrFilings({ limit: 5 });
      expect(ds.provenance).toMatchObject({ source: "house-clerk", official: true });
      expect(ds.points).toHaveLength(5);
      expect(ds.points.every((p) => p.untrusted && p.url?.includes("/ptr-pdfs/"))).toBe(true);
      const dates = ds.points.map((p) => p.asOf!);
      expect([...dates].sort().reverse()).toEqual(dates);
    });
  }, 60_000);
});
