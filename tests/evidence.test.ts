import { mkdtempSync } from "node:fs";
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
