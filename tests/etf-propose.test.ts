import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { etfExposureOf, etfFind, etfFocusOf } from "../src/analyze/etf.js";
import {
  ETF_BUCKETS,
  ETF_PEA_BOND_REASON,
  type EtfScreenContext,
  etfAllocation,
  etfEquityShare,
  etfPlacement,
  etfPropose,
  etfRoundWeights,
  etfScoreCandidates,
  etfScreenCandidates,
  etfYahooSymbol,
} from "../src/analyze/etf-propose.js";
import { parseTargets } from "../src/analyze/portfolio/rebalance.js";
import type { TvMatch } from "../src/analyze/screen/tradingview.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { clockNow } from "../src/core/net.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import type { AmundiFacts } from "../src/providers/funds/amundi.js";
import { withFixture } from "./helpers/fixtures.js";

const row = (ticker: string, cols: Record<string, string | number>): TvMatch => ({
  ticker,
  market: "global",
  points: new Map(Object.entries(cols).map(([k, v]) => [k, { key: `${ticker}.tv.${k}`, label: k, value: v }])),
  derived: [],
});

/** A plain, large, old, cheap UCITS world fund; override what a case needs. */
const fund = (ticker: string, over: Record<string, string | number> = {}) =>
  row(ticker, {
    description: `${ticker} MSCI World UCITS ETF`,
    isin: `IE00B${ticker
      .replace(/[^A-Z0-9]/g, "")
      .padEnd(6, "0")
      .slice(0, 6)}1`,
    index_tracked: "MSCI World Index",
    currency: "EUR",
    expense_ratio: 0.2,
    aum: 5e9,
    "nav_total_return.1Y": 17,
    dividend_treatment: "Capitalizes",
    ucits_compliant_flag: "1",
    country_code_fund: "IE",
    etf_fund_currency: "USD",
    leveraged_flag: "Non-leveraged",
    currency_hedged_flag: "0",
    launch_date: "2012-01-01",
    ...over,
  });

const NOW = new Date("2026-10-26T12:00:00Z");
const ctx = (over: Partial<EtfScreenContext> = {}): EtfScreenContext => ({
  currency: "EUR",
  hedged: false,
  priips: true,
  ucits: true,
  pea: false,
  now: NOW,
  facts: new Map<string, AmundiFacts>(),
  ...over,
});

describe("the allocation convention", () => {
  it("sets the equity share from the risk score, shifted by the goal", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((r) => etfEquityShare(r, "core"))).toEqual([10, 25, 40, 55, 70, 85, 100]);
    expect(etfEquityShare(4, "income")).toBe(55);
    expect(etfEquityShare(1, "defensive")).toBe(0);
    expect(etfEquityShare(4, "defensive")).toBe(40);
    expect(etfEquityShare(7, "growth")).toBe(100);
    expect(etfEquityShare(4, "growth")).toBe(65);
  });
  it("splits each sleeve per goal, weights in whole % summing to 100", () => {
    const core = etfAllocation({ goal: "core", risk: 5, maxFunds: 4 });
    expect(core.equityPct).toBe(70);
    expect(core.lines.map((l) => [l.bucket.id, l.weightPct])).toEqual([
      ["world", 53],
      ["euro-gov", 30],
      ["em", 10],
      ["small", 7],
    ]);
    const def = etfAllocation({ goal: "defensive", risk: 2, maxFunds: 4 });
    expect(Object.fromEntries(def.lines.map((l) => [l.bucket.id, l.weightPct]))).toEqual({ world: 10, "euro-gov": 59, money: 31 });
    const inc = etfAllocation({ goal: "income", risk: 4, maxFunds: 4 });
    expect(inc.lines.map((l) => l.bucket.id)).toEqual(["dividend", "euro-gov", "world", "euro-corp"]);
    const gro = etfAllocation({ goal: "growth", risk: 6, maxFunds: 4 });
    expect(gro.lines.map((l) => l.bucket.id)).toEqual(["world", "euro-gov", "us-tech", "em"]);
    for (const a of [core, def, inc, gro]) expect(a.lines.reduce((s, l) => s + l.weightPct, 0)).toBe(100);
  });
  it("folds a line under 5 % and the lines beyond --max-funds into the sleeve's first line", () => {
    // risk 2 core: equity 25 → world 18.75, em 3.75 and small caps 2.5 fold into world.
    const low = etfAllocation({ goal: "core", risk: 2, maxFunds: 4 });
    expect(low.lines.map((l) => [l.bucket.id, l.weightPct])).toEqual([
      ["world", 25],
      ["euro-gov", 75],
    ]);
    expect(low.lines[0]!.merged.map((m) => m.bucket)).toEqual(["em", "small"]);
    const two = etfAllocation({ goal: "core", risk: 7, maxFunds: 2 });
    expect(two.lines.map((l) => [l.bucket.id, l.weightPct])).toEqual([
      ["world", 85],
      ["em", 15],
    ]);
    expect(two.lines[0]!.merged).toEqual([{ bucket: "small", why: "--max-funds 2" }]);
    const one = etfAllocation({ goal: "core", risk: 4, maxFunds: 1 });
    expect(one.lines.map((l) => [l.bucket.id, l.weightPct])).toEqual([["world", 100]]);
  });
  it("rounds by the largest remainder", () => {
    expect(etfRoundWeights([1, 1, 1])).toEqual([34, 33, 33]);
    expect(etfRoundWeights([52.5, 30, 10.5, 7]).reduce((s, x) => s + x, 0)).toBe(100);
  });
});

describe("the envelope", () => {
  it("keeps no bond bucket inside a PEA, and says why", () => {
    expect(etfPlacement(ETF_BUCKETS["euro-gov"]!, "pea")).toEqual({ inside: false, why: ETF_PEA_BOND_REASON });
    expect(etfPlacement(ETF_BUCKETS["euro-corp"]!, "pea").inside).toBe(false);
    expect(etfPlacement(ETF_BUCKETS.world!, "pea").inside).toBe(true);
    expect(etfPlacement(ETF_BUCKETS["euro-gov"]!, "cto").inside).toBe(true);
    expect(etfPlacement(ETF_BUCKETS["euro-gov"]!, "av").inside).toBe(true);
    expect(ETF_PEA_BOND_REASON).toMatch(/CTO or an assurance-vie/);
  });
  it("in a PEA, keeps a fund only on the issuer's flag or a name hint", () => {
    const flagged = fund("EURONEXT:CW8", { isin: "LU1681043599", country_code_fund: "LU" });
    const hinted = fund("EURONEXT:WPEA", { description: "iShares MSCI World Swap PEA UCITS ETF", isin: "IE0002XZSHO1" });
    const other = fund("EURONEXT:SWDA", { isin: "IE00B4L5Y983" });
    const facts = new Map<string, AmundiFacts>([["LU1681043599", { isin: "LU1681043599", pea: true, synthetic: true }]]);
    const r = etfScreenCandidates([flagged, hinted, other], ETF_BUCKETS.world!, ctx({ pea: true, facts }));
    expect(r.kept.map((c) => c.m.ticker)).toEqual(["EURONEXT:CW8", "EURONEXT:WPEA"]);
    expect(r.kept[0]!.pea.value).toBe("eligible (issuer flag)");
    expect(r.kept[1]!.pea.hint).toBe(true);
    expect(r.dropped).toEqual({ pea: 1 });
  });
});

describe("the fund screen", () => {
  it("leaves out US-domiciled funds for an EU resident (PRIIPs), and keeps them where the jurisdiction allows", () => {
    const us = fund("XETR:URTH", { isin: "US4642863926", country_code_fund: "US", ucits_compliant_flag: "0" });
    const eu = fund("XETR:EUNL", { isin: "IE00B4L5Y983" });
    const r = etfScreenCandidates([us, eu], ETF_BUCKETS.world!, ctx());
    expect(r.kept.map((c) => c.m.ticker)).toEqual(["XETR:EUNL"]);
    expect(r.dropped).toEqual({ ucits: 1 });
    // Even a fund the screener flags UCITS is left out when it is US-domiciled.
    expect(etfScreenCandidates([us], ETF_BUCKETS.world!, ctx({ ucits: false })).dropped).toEqual({ priips: 1 });
    expect(etfScreenCandidates([us], ETF_BUCKETS.world!, ctx({ ucits: false, priips: false })).kept).toHaveLength(1);
    // A listing on a venue the router cannot map is never proposed.
    expect(etfScreenCandidates([fund("NYSE:URTH", { isin: "US4642863926" })], ETF_BUCKETS.world!, ctx({ ucits: false, priips: false })).kept).toHaveLength(0);
  });
  it("drops the wrong index, leveraged, hedged, small, young funds and the wrong distribution, counting each", () => {
    const rows = [
      fund("XETR:OK1"),
      fund("XETR:MOM", { index_tracked: "MSCI World Momentum" }),
      fund("XETR:LEV", { leveraged_flag: "Leveraged" }),
      fund("XETR:HDG", { currency_hedged_flag: "1", index_tracked: "MSCI World Index" }),
      fund("XETR:SML", { aum: 50e6 }),
      fund("XETR:NEW", { launch_date: "2026-06-01" }),
      fund("XETR:DIS", { dividend_treatment: "Distributes" }),
    ];
    const r = etfScreenCandidates(rows, ETF_BUCKETS.world!, ctx({ distribution: "acc" }));
    expect(r.kept.map((c) => c.m.ticker)).toEqual(["XETR:OK1"]);
    expect(r.dropped).toEqual({ index: 1, leveraged: 1, hedged: 1, aum: 1, age: 1, distribution: 1 });
    expect(r.younger).toEqual(["XETR:NEW"]);
    expect(etfScreenCandidates(rows, ETF_BUCKETS.world!, ctx({ distribution: "acc", hedged: true })).kept).toHaveLength(2);
  });
  it("requires a euro fund for a euro bond bucket, and falls back to ESG versions only when the plain index has none", () => {
    const usd = fund("XETR:AGGU", { index_tracked: "Bloomberg Euro Aggregate Treasury Index - EUR", etf_fund_currency: "USD" });
    const eur = fund("XETR:VGEA", { index_tracked: "Bloomberg Euro Aggregate Treasury Index - EUR - Benchmark TR Net", etf_fund_currency: "EUR" });
    expect(etfScreenCandidates([usd, eur], ETF_BUCKETS["euro-gov"]!, ctx()).kept.map((c) => c.m.ticker)).toEqual(["XETR:VGEA"]);
    const esg = fund("EURONEXT:PAEEM", { index_tracked: "MSCI EM ex Egypt ESG Broad CTB Select Index - Benchmark TR Net", isin: "FR0013412020" });
    const asia = fund("EURONEXT:ASIA", { index_tracked: "MSCI EM Asia ESG Screened", isin: "FR0013412038" });
    const r = etfScreenCandidates([esg, asia], ETF_BUCKETS.em!, ctx());
    expect(r.variants).toBe(true);
    expect(r.kept.map((c) => c.m.ticker)).toEqual(["EURONEXT:PAEEM"]);
    const plain = fund("XETR:EIMI", { index_tracked: "MSCI EM (Emerging Markets) IMI", isin: "IE00BKM4GZ66" });
    const both = etfScreenCandidates([esg, plain], ETF_BUCKETS.em!, ctx());
    expect(both.variants).toBe(false);
    expect(both.kept.map((c) => c.m.ticker)).toEqual(["XETR:EIMI"]);
  });
  it("keeps one listing per fund, a venue the router maps, in the wanted currency", () => {
    const a = fund("BSESOF:VGWD", { isin: "IE00B8GKDB10" });
    const b = fund("XETR:VGWD", { isin: "IE00B8GKDB10" });
    const r = etfScreenCandidates([a, b], ETF_BUCKETS.world!, ctx());
    expect(r.kept.map((c) => c.m.ticker)).toEqual(["XETR:VGWD"]);
    expect(etfYahooSymbol("XETR:EUNL")).toBe("EUNL.DE");
    expect(etfYahooSymbol("EURONEXT:VWCE-ETFP")).toBeUndefined();
  });
});

describe("the fund score", () => {
  it("orders by cost, size, tracking against same-index same-currency peers, and age", () => {
    const cheapBig = fund("XETR:A", { expense_ratio: 0.05, aum: 20e9, "nav_total_return.1Y": 17.1 });
    const dear = fund("XETR:B", { expense_ratio: 0.45, aum: 20e9, "nav_total_return.1Y": 16.7 });
    const small = fund("XETR:C", { expense_ratio: 0.05, aum: 150e6, "nav_total_return.1Y": 17.0 });
    const young = fund("XETR:D", { expense_ratio: 0.05, aum: 20e9, "nav_total_return.1Y": 17.0, launch_date: "2023-01-01" });
    const kept = etfScreenCandidates([dear, small, young, cheapBig], ETF_BUCKETS.world!, ctx()).kept;
    const s = etfScoreCandidates(kept);
    expect(s.map((x) => x.m.ticker)).toEqual(["XETR:A", "XETR:D", "XETR:C", "XETR:B"]);
    const a = s[0]!;
    expect(a.parts.cost).toBeCloseTo(0.9, 6);
    expect(a.parts.size).toBe(1);
    // A's gap: 17.1 − median(16.7, 17.0, 17.0) = +0.1 pt.
    expect(a.gap).toBeCloseTo(0.1, 6);
    expect(a.parts.tracking).toBeCloseTo(0.6, 6);
    expect(a.score).toBeCloseTo(40 * 0.9 + 30 + 20 * 0.6 + 10 * a.parts.age, 6);
    // No peer on the same index and fund currency → neutral tracking.
    const alone = etfScoreCandidates([kept.find((x) => x.m.ticker === "XETR:A")!]);
    expect(alone[0]!.gap).toBeUndefined();
    expect(alone[0]!.parts.tracking).toBe(0.5);
  });
});

describe("catalogue words", () => {
  it("maps --exposure and --focus to TradingView's values", () => {
    expect(etfExposureOf("europe")).toBe("Europe");
    expect(etfExposureOf("north america")).toBe("North America");
    expect(etfExposureOf("Emerging markets")).toBe("Emerging markets");
    expect(etfExposureOf("mars")).toBeUndefined();
    expect(etfFocusOf("large cap")).toEqual({ value: "Large cap", known: true });
    expect(etfFocusOf("Quantum")).toEqual({ value: "Quantum", known: false });
  });
});

describe("etf fixtures — browsing and proposing", () => {
  it("browses the bond catalogue in EUR: fixed income only, no leveraged fund, largest first", async () => {
    const r = await withFixture("etf-find-bond-eur", () => etfFind("", { asset: "bond", currency: "EUR", limit: 10 }));
    const pts = r.datasets.flatMap((d) => d.points);
    const ranks = pts.filter((p) => p.key.endsWith(".etf.find.rank"));
    expect(ranks).toHaveLength(10);
    const tickers = ranks.map((p) => p.key.replace(".etf.find.rank", ""));
    for (const t of tickers) {
      expect(pts.find((p) => p.key === `${t}.tv.asset_class.tr`)?.value).toBe("Fixed income");
      expect(pts.find((p) => p.key === `${t}.tv.leveraged_flag`)?.value).toBe("Non-leveraged");
      expect(pts.find((p) => p.key === `${t}.tv.currency`)?.value).toBe("EUR");
    }
    const aums = tickers.map((t) => pts.find((p) => p.key === `${t}.tv.aum`)!.value as number);
    expect([...aums].sort((a, b) => b - a)).toEqual(aums);
    expect(r.datasets[0]!.notes.join(" ")).toMatch(/leveraged and inverse funds left out/);
  });
  it("proposes for a PEA at risk 4: equity inside, the bonds outside and said so, every weight an [E#], TARGETS.json for rebalance", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    const dir = mkdtempSync(join(tmpdir(), "us-etf-propose-"));
    const r = await withFixture("etf-propose-pea", () => etfPropose(dir, { goal: "core", envelope: "pea", risk: 4, maxFunds: 4, now: clockNow() }));
    expect(r.equityPct).toBe(55);
    expect(r.lines.reduce((s, l) => s + l.weightPct, 0)).toBe(100);
    const bonds = r.lines.find((l) => l.bucket === "euro-gov")!;
    expect(bonds.envelope).toBe("cto-or-av");
    expect(bonds.weightPct).toBe(45);
    expect(r.impossible.join(" ")).toMatch(/no bond fund is eligible/);
    for (const l of r.lines.filter((x) => x.envelope === "pea")) expect(l.pick).toBeDefined();
    const store = EvidenceStore.load(dir)!;
    for (const l of r.lines) {
      expect(store.byKey(`ETF.propose.weight.${l.bucket}`)?.value).toBe(l.weightPct);
      if (l.pick) expect(typeof store.byKey(`${l.pick.ticker}.etf.propose.score`)?.value).toBe("number");
    }
    // Inside the PEA every pick carries the issuer's flag or a name hint; none is US-domiciled.
    for (const l of r.lines.filter((x) => x.envelope === "pea"))
      expect(String(store.byKey(`${l.pick!.ticker}.etf.pea`)?.value)).toMatch(/eligible \(issuer flag\)|hint/);
    for (const l of r.lines) if (l.pick) expect(store.byKey(`${l.pick.ticker}.etf.domicile`)?.value).not.toBe("US");
    // TARGETS.json is what `portfolio rebalance --targets` parses.
    const targets = parseTargets(readFileSync(join(dir, "TARGETS.json"), "utf8"));
    expect(targets).toEqual(r.targets);
    expect(Object.values(targets).reduce((s, x) => s + x, 0)).toBe(100);
    const md = readFileSync(join(dir, "PROPOSAL.md"), "utf8");
    expect(md).toContain("## What the PEA cannot hold");
    expect(md).toContain("## The convention (assumptions)");
    expect(md).toContain("## Runbook");
    expect(md).toContain("--kind etf");
    expect(md).toContain("<<<UNTRUSTED_DATA");
    expect(existsSync(join(dir, "evidence.json"))).toBe(true);
    // A replay gives the same ids.
    const dir2 = mkdtempSync(join(tmpdir(), "us-etf-propose-"));
    await withFixture("etf-propose-pea", () => etfPropose(dir2, { goal: "core", envelope: "pea", risk: 4, maxFunds: 4, now: clockNow() }));
    expect(EvidenceStore.load(dir2)!.items.map((i) => [i.id, i.key])).toEqual(store.items.map((i) => [i.id, i.key]));
  });
  it("refuses without a risk score, pointing at the questionnaire", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    const dir = mkdtempSync(join(tmpdir(), "us-etf-propose-"));
    await expect(etfPropose(dir, { goal: "core", envelope: "cto", maxFunds: 4, now: NOW })).rejects.toThrow(/profile suitability|--risk/);
  });
});
