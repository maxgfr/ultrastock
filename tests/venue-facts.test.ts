// The venues domain of the researched-facts store: a template with every key and
// no value, the latest file on or before today read, a stale fee unknown.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { homeDir } from "../src/core/paths.js";
import { accountKey, latestVenueFacts, VENUE_SPEC, venueFact, venueTemplate } from "../src/trading/venue-facts.js";
import { installTestVenueFacts } from "./helpers/venue-facts.js";

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

describe("venues facts", () => {
  it("a template lists every key with no value, and says ultrastock holds no fee", () => {
    const t = venueTemplate("FR", new Date("2026-11-01T00:00:00Z")) as { _about: string; date: string; facts: Record<string, { value: unknown }> };
    expect(t.date).toBe("2026-11-01");
    expect(Object.keys(t.facts)).toEqual(VENUE_SPEC.map((s) => s.key));
    expect(Object.values(t.facts).every((f) => f.value === null)).toBe(true);
    expect(t._about).toMatch(/ultrastock contains no venue fee/);
  });

  it("reads the latest file dated on or before today; a future one is not used", () => {
    installTestVenueFacts({ date: "2026-01-05", values: { "binance.spot.fees": { maker: 0.002, taker: 0.002 } } });
    installTestVenueFacts({ date: "2026-03-01", values: { "binance.spot.fees": { maker: 0.001, taker: 0.001 } } });
    expect(latestVenueFacts("FR", new Date("2026-02-01T00:00:00Z"))?.date).toBe("2026-01-05");
    const r = venueFact<{ maker: number }>("binance.spot.fees", { country: "FR", now: new Date("2026-04-01T00:00:00Z") });
    expect("missing" in r ? r.missing : r.value.maker).toBe(0.001);
    expect(latestVenueFacts("FR", new Date("2025-12-31T00:00:00Z"))).toBeUndefined();
  });

  it("a fee verified more than a year ago reads as unknown, and says what to research", () => {
    installTestVenueFacts({ date: "2024-01-05" });
    const r = venueFact("binance.spot.fees", { country: "FR", now: new Date("2026-11-01T00:00:00Z") });
    expect("missing" in r && r.missing).toMatch(
      /does not hold binance\.spot\.fees as current \(binance\.spot\.fees verified 2024-01-05, older than 365 days\).*facts research venues --country FR/,
    );
    expect(accountKey("pea-bourso")).toBe("account.peabourso");
  });
});
