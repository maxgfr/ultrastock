import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPTHS, withBudget } from "../src/analyze/full.js";
import { PEER_EUROPE, peerCountries } from "../src/analyze/peers.js";
import { extendedValuation } from "../src/analyze/valuation-extra.js";
import { commandArgs, datasetsOf, emitDatasets } from "../src/commands/emit.js";
import type { Dataset } from "../src/core/datasets.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { setNetMode } from "../src/core/net.js";
import { contentHash } from "../src/engine.js";
import { peersDataset } from "../src/analyze/peers.js";

const ds = (title: string): Dataset => ({
  kind: "t",
  title,
  points: [{ key: `${title}.x`, label: title, value: 1 }],
  provenance: { source: "t", fetchedAt: "2026-10-26T00:00:00.000Z", official: false },
  notes: [],
});

describe("full depth", () => {
  it("is a depth", () => {
    expect(DEPTHS).toEqual(["quick", "standard", "deep", "full"]);
  });

  it("declares a slice over its budget unavailable instead of waiting", async () => {
    await expect(withBudget(new Promise(() => {}), 20, "options")).rejects.toThrow(/options took longer than 0 s/);
    await expect(withBudget(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });

  it("captures a command's datasets without printing, concurrent captures kept apart", async () => {
    const write = process.stdout.write;
    let printed = "";
    process.stdout.write = ((s: string) => {
      printed += s;
      return true;
    }) as typeof process.stdout.write;
    try {
      const slow = (title: string, ms: number) => async () => {
        await new Promise((r) => setTimeout(r, ms));
        emitDatasets(commandArgs("x", []), [ds(title)], false);
      };
      const [a, b] = await Promise.all([datasetsOf(slow("a", 15)), datasetsOf(slow("b", 1))]);
      expect(a.map((d) => d.title)).toEqual(["a"]);
      expect(b.map((d) => d.title)).toEqual(["b"]);
    } finally {
      process.stdout.write = write;
    }
    expect(printed).toBe("");
  });

  it("draws peers from the region, by country", () => {
    expect(peerCountries("US")).toEqual(["US", "CA"]);
    expect(peerCountries("FR")).toBe(PEER_EUROPE);
    expect(peerCountries("CH")).toContain("DE");
    expect(peerCountries("JP")).toEqual(["JP"]);
  });
});

describe("extended valuation", () => {
  const fetchedAt = "2026-10-26T00:00:00.000Z";
  function runWith(items: Array<{ key: string; value: number; unit?: string }>): string {
    const dir = mkdtempSync(join(tmpdir(), "us-full-"));
    const store = EvidenceStore.open(dir, { subject: "X.PA" });
    for (const i of items) store.add({ ...i, label: i.key, source: "t", fetchedAt, official: true });
    store.save();
    return dir;
  }

  it("registers residual income, the dividend discount value and the WACC from the valuation's own evidence", () => {
    const dir = runWith([
      { key: "X.PA.quote.price", value: 100, unit: "EUR" },
      { key: "X.PA.coe", value: 8, unit: "%" },
      { key: "X.PA.quality.roe", value: 0.15, unit: "ratio" },
      { key: "X.PA.quality.payoutRatio", value: 0.5, unit: "ratio" },
      { key: "X.PA.mult.pb", value: 2, unit: "x" },
      { key: "X.PA.mult.dividendYield", value: 0.03, unit: "ratio" },
      { key: "X.PA.mult.marketCap", value: 1e9, unit: "EUR" },
      { key: "X.PA.quality.netDebt", value: 2.5e8, unit: "EUR" },
      { key: "EA.aaa.10Y", value: 3, unit: "%" },
    ]);
    const r = extendedValuation(dir, "X.PA");
    expect(r.count).toBe(5);
    const store = EvidenceStore.load(dir)!;
    const ddm = store.byKey("X.PA.val.ddm")!;
    // g = min(0.15 × 0.5, 3 %, 8 % − 1 pt) = 3 %; D1 = 3 × 1.03; value = 3.09 / 0.05
    expect(ddm.value).toBeCloseTo(61.8, 6);
    expect(ddm.derivedFrom).toEqual(expect.arrayContaining(["E1", "E2", "E6"]));
    const w = store.byKey("X.PA.val.wacc")!.value as number;
    // 0.8 × 8 % + 0.2 × 4.5 % × 0.75
    expect(w).toBeCloseTo(7.075, 6);
    expect((store.byKey("X.PA.val.residualIncome")!.value as number) > 50).toBe(true);
  });

  it("skips a model whose input is missing, and says so", () => {
    const dir = runWith([
      { key: "X.PA.quote.price", value: 100, unit: "EUR" },
      { key: "X.PA.coe", value: 8, unit: "%" },
    ]);
    const r = extendedValuation(dir, "X.PA");
    expect(r.count).toBe(0);
    expect(r.notes.join(" ")).toMatch(/residual income skipped.*dividend discount model skipped.*WACC skipped/);
  });
});

describe("peers", () => {
  it("collapses ADR lines, leaves the subject's group out and prices it against the peers' median", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-peers-"));
    mkdirSync(join(dir, "crible"), { recursive: true });
    const record = (args: string[], value: unknown) => {
      const call = ["cli", ...args];
      writeFileSync(join(dir, "crible", `${contentHash(JSON.stringify(call)).slice(0, 20)}.json`), JSON.stringify({ call, value: JSON.stringify(value) }));
    };
    const me = { symbol: "MC.PA", name: "LVMH SE", country: "FR", industry: "Luxury", isin: "FR0000121014", price_to_earnings_ratio: 18, period: "2025-12-31" };
    record(["screen", "symbol = 'MC.PA'", "--format", "json", "--limit", "1", "--offset", "0"], { total: 1, rows: [me] });
    const peer = (symbol: string, name: string, pe: number, extra: Record<string, unknown> = {}) => ({
      symbol,
      name,
      country: "FR",
      isin: "FR1",
      cap_eur: 1e10,
      price_to_earnings_ratio: pe,
      ...extra,
    });
    record(
      [
        "screen",
        "industry = 'Luxury' AND primary_listing = true AND country IN (" + PEER_EUROPE.map((c) => `'${c}'`).join(", ") + ")",
        "--format",
        "json",
        "--limit",
        "30",
        "--offset",
        "0",
        "--sort",
        "-cap_eur",
      ],
      {
        total: 6,
        rows: [
          { ...me, cap_eur: 2e11 },
          peer("MOHF.MU", "LVMH SE", 18, { isin: "US5024413065" }),
          peer("RMS.PA", "Hermes International", 30),
          peer("HESAY", "Hermes International ADR", 30, { isin: "US42751Q1058", exchange: "PNK" }),
          peer("CFR.SW", "Richemont", 24, { country: "CH" }),
          peer("KER.PA", "Kering", 20),
          peer("BAD.PA", "Mismatch", 0.04),
        ],
      },
    );
    setNetMode({ kind: "fixture", dir });
    try {
      const d = (await peersDataset("MC.PA"))!;
      const names = d.points.filter((p) => /\.name$/.test(p.key)).map((p) => String(p.value));
      expect(names).toEqual(["Hermes International (RMS.PA, FR)", "Richemont (CFR.SW, CH)", "Kering (KER.PA, FR)", "Mismatch (BAD.PA, FR)"]);
      const at = (k: string) => d.points.find((p) => p.key === `MC.PA.peers.${k}`)?.value;
      expect(at("median.price_to_earnings_ratio")).toBe(24); // the 0.04 P/E is a mismatch, not a peer's price
      expect(at("premium.price_to_earnings_ratio")).toBeCloseTo(-25, 9);
    } finally {
      setNetMode({ kind: "live" });
    }
  });
});
