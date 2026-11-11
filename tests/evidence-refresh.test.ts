// A figure read again with the same value is as fresh as its last read: `check --max-age` must not call it stale.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAnswer, NOTE_KINDS } from "../src/check.js";
import { type Dataset, registerDatasets } from "../src/core/datasets.js";
import { EvidenceStore } from "../src/core/evidence.js";

/** The problems that fail the check (notes left out). */
function failing(dir: string, answer: string, opts: { maxAgeMs?: number; now?: Date } = {}): string[] {
  const r = checkAnswer(dir, answer, { now: new Date("2026-11-11T10:00:00Z"), ...opts });
  if ("error" in r) throw new Error(r.error);
  return r.problems.filter((p) => !NOTE_KINDS.has(p.kind)).map((p) => `${p.kind}: ${p.message}`);
}

describe("evidence: a figure read again with the same value is as fresh as its last read", () => {
  const rate = (fetchedAt: string, asOf: string): Dataset => ({
    kind: "rates",
    title: "ECB policy rates",
    points: [{ key: "ecb.dfr", label: "ECB deposit facility rate", value: 2, unit: "%" }],
    provenance: { source: "ecb", fetchedAt, asOf, official: true },
    notes: [],
  });

  it("FF8 — `check --max-age` does not call stale a figure the run has just read again, and its as-of day follows", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-evidence-refresh-"));
    // Monday: `rates --out <run>`. Friday: the same command on the same run — the rate has not moved.
    const first = registerDatasets(dir, [rate("2026-11-02T08:00:00.000Z", "2026-11-02")])[0]!.ids[0]!;
    const again = registerDatasets(dir, [rate("2026-11-06T08:00:00.000Z", "2026-11-06")])[0]!.ids[0]!;
    expect(again).toBe(first); // the id is kept, as documented
    // The run was refreshed an hour ago: neither stale, nor dated four days back.
    const now = new Date("2026-11-06T09:00:00Z");
    expect(failing(dir, `The ECB deposit rate is 2 % as of 2026-11-06 [${first}].`, { now, maxAgeMs: 24 * 3_600_000 })).toEqual([]);
  });

  it("FF8 (the cause) — the register keeps the first read's fetchedAt and asOf", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-evidence-refresh-"));
    const id = registerDatasets(dir, [rate("2026-11-02T08:00:00.000Z", "2026-11-02")])[0]!.ids[0]!;
    registerDatasets(dir, [rate("2026-11-06T08:00:00.000Z", "2026-11-06")]);
    const item = EvidenceStore.load(dir)!.get(id)!;
    expect({ fetchedAt: item.fetchedAt, asOf: item.asOf }).toEqual({ fetchedAt: "2026-11-06T08:00:00.000Z", asOf: "2026-11-06" });
  });

  it("does not move an item back to an older read", () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-refresh-"));
    const id = registerDatasets(dir, [rate("2026-11-06T08:00:00.000Z", "2026-11-06")])[0]!.ids[0]!;
    registerDatasets(dir, [rate("2026-11-02T08:00:00.000Z", "2026-11-02")]);
    const item = EvidenceStore.load(dir)!.get(id)!;
    expect({ fetchedAt: item.fetchedAt, asOf: item.asOf }).toEqual({ fetchedAt: "2026-11-06T08:00:00.000Z", asOf: "2026-11-06" });
  });

  it("gives the same key and value in another unit or under another label an id of its own, leaving the cited one as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-refresh-"));
    const base = { key: "x.cap", value: 2, source: "test", fetchedAt: "2026-11-02T08:00:00.000Z", official: true };
    const ids = EvidenceStore.update(dir, (s) => [
      s.add({ ...base, label: "X market cap", unit: "EUR" }),
      s.add({ ...base, label: "X market cap", unit: "USD", fetchedAt: "2026-11-06T08:00:00.000Z" }),
      s.add({ ...base, label: "X float", unit: "USD", fetchedAt: "2026-11-06T08:00:00.000Z" }),
      s.add({ ...base, label: "X float", unit: "USD", fetchedAt: "2026-11-07T08:00:00.000Z" }),
    ]);
    expect(ids).toEqual(["E1", "E2", "E3", "E3"]);
    const store = EvidenceStore.load(dir)!;
    expect(store.get("E1")).toMatchObject({ unit: "EUR", label: "X market cap", fetchedAt: "2026-11-02T08:00:00.000Z" });
    expect(store.get("E3")).toMatchObject({ unit: "USD", label: "X float", fetchedAt: "2026-11-07T08:00:00.000Z" });
  });
});
