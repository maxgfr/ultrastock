import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calcEvidence } from "../src/calc.js";
import { EvidenceStore, formatEvidence, formatNumber } from "../src/core/evidence.js";

const base = { source: "euronext", fetchedAt: "2026-10-23T18:00:00Z", official: true };

describe("EvidenceStore", () => {
  it("numbers items in order, keeps ids stable on re-adds and round-trips to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-ev-"));
    const s = EvidenceStore.open(dir, { subject: "MC.PA" });
    expect(s.add({ ...base, key: "a", label: "A", value: 1.5 })).toBe("E1");
    expect(s.add({ ...base, key: "b", label: "B", value: 2 })).toBe("E2");
    expect(s.add({ ...base, key: "a", label: "A", value: 1.5 })).toBe("E1");
    expect(s.add({ ...base, key: "a", label: "A", value: 1.6 })).toBe("E3");
    expect(s.byKey("a")!.id).toBe("E3");
    s.save();
    const back = EvidenceStore.load(dir)!;
    expect(back.items.map((i) => i.id)).toEqual(["E1", "E2", "E3"]);
    expect(back.subject).toBe("MC.PA");
    expect(() => s.add({ ...base, key: "n", label: "N", value: Number.NaN })).toThrow();
  });
  it("dates a derived figure as its stalest input: as of its oldest as-of day, read when its oldest input was", () => {
    const s = EvidenceStore.open(mkdtempSync(join(tmpdir(), "us-ev-")));
    const price = s.add({ ...base, key: "px", label: "price", value: 383, asOf: "2026-10-23", fetchedAt: "2026-10-23T18:00:00Z" });
    const eps = s.add({ ...base, key: "eps", label: "EPS FY2025", value: 25, asOf: "2025-12-31", fetchedAt: "2026-10-24T08:00:00Z", official: false });
    const id = s.addDerived("pe", "P/E", 15.32, "x", [price, eps], "px / eps");
    expect(s.get(id)).toMatchObject({ asOf: "2025-12-31", fetchedAt: "2026-10-23T18:00:00Z", official: false, derivedFrom: [price, eps] });
  });
  it("formats an item with its provenance", () => {
    expect(formatEvidence({ ...base, id: "E1", key: "k", label: "LVMH close", value: 383, unit: "EUR", asOf: "2026-10-23", delay: "eod" })).toBe(
      "[E1] LVMH close = 383 EUR (euronext, as of 2026-10-23, eod)",
    );
    expect(formatNumber(1234.56789)).toBe("1234.57");
    expect(formatNumber(0.000123456)).toBe("0.000123");
  });
});

describe("calc", () => {
  const run = () => {
    const dir = mkdtempSync(join(tmpdir(), "us-calc-"));
    const s = EvidenceStore.open(dir);
    s.add({ ...base, key: "close", label: "close", value: 383, unit: "EUR", asOf: "2026-10-23" });
    s.add({ ...base, key: "low", label: "low", value: 375.65, unit: "EUR", asOf: "2026-10-22", official: false, fetchedAt: "2026-10-22T18:00:00Z" });
    s.add({ ...base, key: "trend", label: "trend", value: "downtrend" });
    s.save();
    return dir;
  };
  it("registers a derived figure with conservative provenance", () => {
    const dir = run();
    const r = calcEvidence(dir, "(E1 / E2 - 1) * 100", { label: "above low", unit: "%" });
    expect(r.id).toBe("E4");
    expect(r.value).toBeCloseTo(1.9566, 3);
    expect(r.item).toMatchObject({ source: "calc", derivedFrom: ["E1", "E2"], official: false, fetchedAt: "2026-10-22T18:00:00Z", asOf: "2026-10-22" });
    expect(EvidenceStore.load(dir)!.get("E4")!.formula).toBe("(E1 / E2 - 1) * 100");
  });
  it("refuses missing, non-numeric and non-evidence variables, and bare constants", () => {
    const dir = run();
    expect(() => calcEvidence(dir, "E9 * 2", { label: "x" })).toThrow(/not in this run/);
    expect(() => calcEvidence(dir, "E3 * 2", { label: "x" })).toThrow(/not a number/);
    expect(() => calcEvidence(dir, "close * 2", { label: "x" })).toThrow(/not an evidence id/);
    expect(() => calcEvidence(dir, "2 * 3", { label: "x" })).toThrow(/at least one evidence id/);
    expect(() => calcEvidence(dir, "E1 / (E2 - E2)", { label: "x" })).toThrow(/finite/);
  });
});

describe("a store kept open across a long run", () => {
  it("keeps what another command registered meanwhile, and every id it handed out", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-merge-"));
    EvidenceStore.update(dir, (s) => s.add({ ...base, key: "close", label: "close", value: 383, unit: "EUR" }));
    // `analyze` opens the run and registers figures for a while, without saving.
    const long = EvidenceStore.open(dir);
    const mine = [long.add({ ...base, key: "a", label: "A", value: 1 }), long.add({ ...base, key: "b", label: "B", value: 2 })];
    // Meanwhile an agent's `calc` registers a figure of its own on the same run.
    const theirs = calcEvidence(dir, "E1 * 2", { label: "double" }).id;
    expect(mine).not.toContain(theirs);
    // The long run saves at its end, then goes on.
    long.save();
    const later = long.add({ ...base, key: "c", label: "C", value: 3 });
    long.save();
    const back = EvidenceStore.load(dir)!;
    const ids = back.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(back.get(theirs)).toMatchObject({ value: 766, label: "double" });
    expect(back.get(mine[0]!)).toMatchObject({ key: "a", value: 1 });
    expect(back.get(mine[1]!)).toMatchObject({ key: "b", value: 2 });
    expect(back.get(later)).toMatchObject({ key: "c", value: 3 });
    expect([theirs, ...mine]).not.toContain(later);
    // A calc after the save numbers after everything already handed out.
    const next = calcEvidence(dir, "E1 * 3", { label: "triple" }).id;
    expect([theirs, ...mine, later]).not.toContain(next);
  });
  it("numbers a run alone contiguously, whatever it registers, and leaves no reservation behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-merge-"));
    const s = EvidenceStore.open(dir);
    for (let i = 0; i < 150; i++) s.add({ ...base, key: `k${i}`, label: `K${i}`, value: i });
    s.save();
    expect(EvidenceStore.load(dir)!.items.map((i) => i.id)).toEqual(Array.from({ length: 150 }, (_, i) => `E${i + 1}`));
    expect(readdirSync(dir).sort()).toEqual(["evidence.json"]);
    expect(calcEvidence(dir, "E1 + E2", { label: "sum" }).id).toBe("E151");
    expect(existsSync(join(dir, "evidence.json.lock"))).toBe(false);
  });
});
