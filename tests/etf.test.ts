import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dedupeListings,
  etfCompare,
  etfDomicile,
  etfFind,
  etfOverlap,
  etfPeaStatus,
  etfReplication,
  etfRun,
  holdingNameKey,
  normalizeIndexName,
  PEA_UNKNOWN,
  rankTwins,
  withholdingNote,
} from "../src/analyze/etf.js";
import { debateRunbook } from "../src/analyze/full.js";
import type { TvMatch } from "../src/analyze/screen/tradingview.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { clockNow } from "../src/core/net.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import type { FundLine } from "../src/providers/funds/common.js";
import { tvRowPoints } from "../src/providers/markets/tradingview.js";
import { planTrade } from "../src/trading/plan.js";
import { withFixture } from "./helpers/fixtures.js";

const row = (ticker: string, cols: Record<string, string | number>): TvMatch => ({
  ticker,
  market: "global",
  points: new Map(Object.entries(cols).map(([k, v]) => [k, { key: `${ticker}.tv.${k}`, label: k, value: v }])),
  derived: [],
});

describe("index names", () => {
  it("strips the currency, the TR/NR/Net/Benchmark suffixes, Index and DUPE prefixes", () => {
    expect(normalizeIndexName("MSCI World Index - EUR - Benchmark TR Net")).toBe("msci world");
    expect(normalizeIndexName("MSCI World Index")).toBe("msci world");
    expect(normalizeIndexName("DUPE - MSCI World Index")).toBe("msci world");
    expect(normalizeIndexName("DUPE - BI8545888 - NASDAQ 100 Index - Benchmark TR Net")).toBe("nasdaq 100");
    expect(normalizeIndexName("Nasdaq-100 Index")).toBe("nasdaq 100");
    expect(normalizeIndexName("MSCI WORLD LOW CARBON SRI LEADERS (NR) (USD)")).toBe("msci world low carbon sri leaders");
    expect(normalizeIndexName("S&P 500 Net Total Return Index")).toBe("s&p 500");
    expect(normalizeIndexName("S&P 500")).toBe("s&p 500");
  });
  it("keeps what makes a different index: a hedge, a size, a theme", () => {
    expect(normalizeIndexName("MSCI World 100% Hedged to EUR Net Variant")).toBe("msci world 100% hedged to eur");
    expect(normalizeIndexName("MSCI World Index Small Cap")).toBe("msci world small cap");
    expect(normalizeIndexName("MSCI World Selection Index  - EUR - Benchmark TR Net Hedged")).toBe("msci world selection hedged");
    expect(normalizeIndexName("MSCI World ex USA")).not.toBe(normalizeIndexName("MSCI World Index"));
  });
});

describe("replication, PEA, domicile — the decision table", () => {
  it("replication: the issuer's field, then Swap in the name, else unknown", () => {
    expect(etfReplication({ issuer: "Indirect (Unfunded swap)", name: "Amundi MSCI World" })).toMatchObject({ value: "synthetic (swap)", synthetic: true });
    expect(etfReplication({ issuer: "Direct (Physical)", name: "Something Swap" })).toMatchObject({ value: "physical", synthetic: false });
    expect(etfReplication({ issuer: "Direct (Physical, optimised sampling)" }).value).toBe("physical (sampling)");
    expect(etfReplication({ name: "iShares MSCI World Swap PEA UCITS ETF" })).toMatchObject({ value: "synthetic (swap)", synthetic: true });
    expect(etfReplication({ name: "iShares Core MSCI World UCITS ETF" })).toMatchObject({ value: "unknown", synthetic: false });
  });
  it("PEA: the issuer's flag, then PEA in the name as a hint, else unknown — never from the domicile", () => {
    expect(etfPeaStatus({ issuerFlag: true, name: "Amundi MSCI World Swap" })).toMatchObject({ eligible: true });
    expect(etfPeaStatus({ issuerFlag: false, name: "Amundi PEA something" })).toMatchObject({ eligible: false });
    expect(etfPeaStatus({ name: "iShares MSCI World Swap PEA UCITS ETF" })).toMatchObject({ hint: true });
    expect(etfPeaStatus({ name: "Amundi MSCI World Swap" }).value).toBe(PEA_UNKNOWN);
    // CW8 is Luxembourg-domiciled and PEA-eligible: the decision takes no domicile at all.
    expect(etfPeaStatus({ name: "Amundi MSCI World Swap UCITS ETF" }).basis).toMatch(/domicile says nothing/);
  });
  it("domicile: country_code_fund, then the ISIN prefix, then US for a US listing", () => {
    expect(etfDomicile({ fundCountry: "LU", isin: "FR0010315770" })).toMatchObject({ code: "LU" });
    expect(etfDomicile({ isin: "IE00B4L5Y983" }).code).toBe("IE");
    expect(etfDomicile({ market: "us" }).code).toBe("US");
    expect(etfDomicile({ isin: "XS1234567890", market: "euronext" }).code).toBeUndefined();
    expect(etfDomicile({}).code).toBeUndefined();
  });
  it("the withholding note is qualitative: no invented rate", () => {
    for (const c of ["IE", "LU", "US", "FR", "DE", undefined]) expect(withholdingNote(c)).not.toMatch(/\d\s*%|percent/);
    expect(withholdingNote("US")).toMatch(/PRIIPs/);
  });
});

describe("overlap", () => {
  const a: FundLine[] = [
    { name: "NVIDIA CORP", ticker: "NVDA", weightPct: 5 },
    { name: "APPLE INC", isin: "US0378331005", weightPct: 4 },
    { name: "Microsoft Corporation", weightPct: 3 },
    { name: "USD CASH", assetClass: "Cash", weightPct: 1 },
    { name: "ASML HOLDING NV", weightPct: 0.5 },
  ];
  const b: FundLine[] = [
    { name: "Apple Inc.", isin: "US0378331005", weightPct: 7 },
    { name: "NVIDIA Corporation", ticker: "NVDA", weightPct: 2 },
    { name: "MICROSOFT CORP", weightPct: 6 },
    { name: "USD CASH", assetClass: "Cash", weightPct: 2 },
    { name: "TOTALENERGIES SE", weightPct: 1 },
  ];
  it("sums the smaller weight over the lines both hold, cash left out", () => {
    const o = etfOverlap(a, b);
    expect(o.overlapPct).toBeCloseTo(2 + 4 + 3, 10);
    expect(o.common.map((c) => c.min)).toEqual([4, 3, 2]);
    expect(o.common[0]).toMatchObject({ isin: "US0378331005", a: 4, b: 7 });
    expect(o.aLines).toBe(4);
    expect(o.bLines).toBe(4);
  });
  it("matches each line once and is symmetric", () => {
    expect(etfOverlap(b, a).overlapPct).toBeCloseTo(etfOverlap(a, b).overlapPct, 10);
    expect(etfOverlap(a, a).overlapPct).toBeCloseTo(12.5, 10);
    expect(etfOverlap([{ name: "X", weightPct: 1 }], [])).toMatchObject({ overlapPct: 0, common: [] });
    expect(holdingNameKey("NVIDIA CORP")).toBe(holdingNameKey("Nvidia Corporation"));
  });
});

describe("TradingView fund columns", () => {
  it("dates the launch, keeps flags as codes, fences the index label, prices AUM and NAV in the reporting currency", () => {
    const cols = ["currency", "fundamental_currency_code", "launch_date", "ucits_compliant_flag", "dividend_treatment", "index_tracked", "aum", "nav"];
    const pts = tvRowPoints(
      { s: "EURONEXT:CW8", d: ["EUR", "USD", 1245110400, "1", "Capitalizes", "MSCI World Index - EUR - Benchmark TR Net", 7.6e9, 787.5] },
      cols,
    );
    const at = (c: string) => pts.find((p) => p.key === `EURONEXT:CW8.tv.${c}`)!;
    expect(at("launch_date").value).toBe("2009-06-16");
    expect(at("ucits_compliant_flag")).toMatchObject({ value: "1" });
    expect(at("ucits_compliant_flag").untrusted).toBeUndefined();
    expect(at("dividend_treatment").untrusted).toBeUndefined();
    expect(at("index_tracked").untrusted).toBe(true);
    expect(at("aum").unit).toBe("USD");
    expect(at("nav").unit).toBe("USD");
  });
});

describe("listings and twins", () => {
  it("keeps one listing per ISIN, in the wanted currency first, then by venue", () => {
    const rows = [
      row("LSE:IWDA", { isin: "IE00B4L5Y983", currency: "USD" }),
      row("EURONEXT:IWDA", { isin: "IE00B4L5Y983", currency: "EUR" }),
      row("XETR:EUNL", { isin: "IE00B4L5Y983", currency: "EUR" }),
      row("AMEX:URTH", { isin: "US4642863926", currency: "USD" }),
    ];
    expect(dedupeListings(rows).map((m) => m.ticker)).toEqual(["EURONEXT:IWDA", "AMEX:URTH"]);
    expect(dedupeListings(rows, "USD").map((m) => m.ticker)).toEqual(["LSE:IWDA", "AMEX:URTH"]);
  });
  it("ranks UCITS twins by TER, then AUM", () => {
    const twins = rankTwins([
      row("A", { ucits_compliant_flag: "1", expense_ratio: 0.2, aum: 1e9 }),
      row("B", { ucits_compliant_flag: "1", expense_ratio: 0.12, aum: 1e8 }),
      row("C", { ucits_compliant_flag: "1", expense_ratio: 0.2, aum: 5e9 }),
      row("D", { ucits_compliant_flag: "0", expense_ratio: 0.03, aum: 9e10 }),
    ]);
    expect(twins.map((m) => m.ticker)).toEqual(["B", "C", "A"]);
  });
});

describe("the debate runbook", () => {
  it("gives an ETF an ETF analyst reading ETF.md instead of the fundamentals analyst", () => {
    const etf = debateRunbook("/run", "CW8.PA", "standard", "flat", [], false, false, true);
    expect(etf).toContain("**ETF** — ETF.md");
    expect(etf).not.toContain("**fundamentals**");
    expect(etf).not.toContain("VALUATION.md (companies)");
    const stock = debateRunbook("/run", "MC.PA", "standard", "flat", [], false, false);
    expect(stock).toContain("**fundamentals** — VALUATION.md");
    expect(stock).not.toContain("ETF.md");
  });
});

describe("etf fixtures", () => {
  it("analyses CW8: swap, PEA by the issuer's flag, Luxembourg, no look-through, tracking against EUR peers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-etf-"));
    const r = await withFixture("etf-cw8", () => etfRun("CW8.PA", dir));
    expect(r).toMatchObject({ replication: "synthetic (swap)", peaShort: "eligible", domicile: "LU" });
    const store = EvidenceStore.load(dir)!;
    expect(store.byKey("CW8.PA.etf.pea")!.value).toBe("eligible (issuer flag)");
    expect(store.byKey("LU1681043599.amundi.pea")!.value).toBe(true);
    expect(store.byKey("EURONEXT:CW8.tv.country_code_fund")!.value).toBe("LU");
    expect(store.byKey("EURONEXT:CW8.tv.index_tracked")!.untrusted).toBe(true);
    expect(store.byKey("EURONEXT:CW8.tv.ucits_compliant_flag")!.untrusted).toBeUndefined();
    expect(store.items.some((i) => i.key.startsWith("CW8.PA.lt."))).toBe(false);
    expect(typeof store.byKey("CW8.PA.etf.tracking.vsMedian.1Y")?.value).toBe("number");
    const md = readFileSync(join(dir, "ETF.md"), "utf8");
    expect(md).toContain("## Relative tracking");
    expect(md).toContain("no look-through");
    expect(md).not.toContain("UCITS twins");
    // A replay gives the same ids.
    const dir2 = mkdtempSync(join(tmpdir(), "us-etf-"));
    await withFixture("etf-cw8", () => etfRun("CW8.PA", dir2));
    expect(EvidenceStore.load(dir2)!.items.map((i) => [i.id, i.key])).toEqual(store.items.map((i) => [i.id, i.key]));
  });
  it("compares CW8 and IWDA: the table, the correlation, no overlap with a swap basket", async () => {
    const r = await withFixture("etf-compare-world", () => etfCompare(["CW8.PA", "IWDA.AS"], clockNow()));
    expect(r.table.symbols).toEqual(["CW8.PA", "IWDA.AS"]);
    const keys = r.datasets.flatMap((d) => d.points.map((p) => p.key));
    expect(keys).toContain("EURONEXT:IWDA.tv.expense_ratio");
    expect(keys).toContain("ETF.corr.CW8.PA.IWDA.AS");
    expect(keys).toContain("IWDA.AS.lt.lines");
    expect(keys.some((k) => k.startsWith("ETF.overlap."))).toBe(false);
    expect(r.notes.join(" ")).toMatch(/same index .* by construction/);
    const rho = r.datasets.flatMap((d) => d.points).find((p) => p.key === "ETF.corr.CW8.PA.IWDA.AS")!.value as number;
    expect(rho).toBeGreaterThan(0.9);
  });
  it("finds PEA ETFs on the MSCI World: the issuer's flag or a name hint, Paris listings", async () => {
    const r = await withFixture("etf-find-world-pea", () => etfFind("MSCI World", { pea: true, limit: 10 }));
    const pts = r.datasets.flatMap((d) => d.points);
    const pea = pts.filter((p) => p.key.endsWith(".etf.pea"));
    expect(pea.length).toBeGreaterThan(0);
    expect(pea.every((p) => /issuer flag|hint/.test(String(p.value)) && !/not eligible/.test(String(p.value)))).toBe(true);
    expect(pts.find((p) => p.key === "EURONEXT:CW8.etf.pea")?.value).toBe("eligible (issuer flag)");
    expect(pts.filter((p) => p.key.endsWith(".etf.find.rank")).every((p) => p.key.startsWith("EURONEXT:"))).toBe(true);
  });
  it("plan fills the domicile of a US ETF, so the PRIIPs block fires for a French resident", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions([{ date: "2026-01-02", type: "deposit", account: "cto", amount: 20_000, currency: "EUR", origin: "manual" }], "paper");
    const p = await withFixture("etf-plan-urth", () => planTrade({ symbol: "URTH", account: "cto", now: clockNow() }));
    expect(p.order.domicile).toBe("US");
    expect(p.gate.checks.find((c) => c.code === "PRIIPS")?.status).toBe("block");
    expect(p.verdict).toBe("reject");
  });
});
