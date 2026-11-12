import { describe, expect, it, vi } from "vitest";
import { addRule, loadRules, removeRule, runAlerts } from "../src/alerts/alerts.js";
import type { ActivityOptions } from "../src/people/activity.js";
import type { PersonFiling, PersonRef } from "../src/people/types.js";

// What the source lists: the newest filing first. A filing the rule has seen is listed, not read.
let listed: PersonFiling[] = [];
const asked: ActivityOptions[] = [];
vi.mock("../src/people/activity.js", () => ({
  personActivity: async (ref: PersonRef, o: ActivityOptions) => {
    asked.push({ ...o, skip: new Set(o.skip) });
    return {
      ref,
      filings: listed.map((f) => (o.skip?.has(f.id) ? { ...f, trades: [], read: false } : f)),
      notes: [],
      provenance: { source: "house-clerk", url: "", fetchedAt: "" },
    };
  },
}));

const filing = (id: string, filed: string): PersonFiling => ({
  id,
  source: "house",
  form: "House PTR",
  filed,
  url: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${id}.pdf`,
  read: true,
  trades: [{ asset: "NVDA", ticker: "NVDA", side: "buy", code: "P", date: "2026-10-01", amountLow: 1_000_001, amountHigh: 5_000_000 }],
});

describe("a person alert", () => {
  it("fires once per new filing, from where the follow started, and reads only what it has not seen", async () => {
    for (const r of loadRules()) removeRule(r.id);
    const who: PersonRef = { source: "house", id: "Hon. Jane Doe", name: "Hon. Jane Doe" };
    listed = [filing("20030001", "2026-10-02")];
    const rule = addRule({ kind: "person", person: who, seen: ["20030001"] }, new Date("2026-10-03T00:00:00Z"));
    // An expression rule beside it is not run by a person-only check.
    addRule({ kind: "expr", symbol: "X", expr: "close > 1" }, new Date("2026-10-03T00:00:01Z"));

    expect((await runAlerts(new Date("2026-10-04T00:00:00Z"), { kinds: ["person"] })).events).toEqual([]);

    listed = [filing("20030002", "2026-11-06"), filing("20030001", "2026-10-02")];
    const { events, errors } = await runAlerts(new Date("2026-11-07T00:00:00Z"), { kinds: ["person"] });
    expect(errors).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe(
      "Hon. Jane Doe: House PTR filed 2026-11-06 — 1 buy(s), 0 sale(s); largest: buy NVDA $1,000,001–$5,000,000 https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20030002.pdf",
    );
    expect([...asked.at(-1)!.skip!]).toEqual(["20030001"]);

    expect((await runAlerts(new Date("2026-11-08T00:00:00Z"), { kinds: ["person"] })).events).toEqual([]);
    const saved = loadRules().find((r) => r.id === rule.id)!;
    expect(saved).toMatchObject({ kind: "person", person: who, seen: ["20030001", "20030002"], firedAt: "2026-11-07T00:00:00.000Z" });
    expect(() => addRule({ kind: "person" })).toThrow(/needs who to follow/);
  });
});
