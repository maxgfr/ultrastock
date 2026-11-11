// ce27cbd — "The ratchet is now on as soon as live trading has ever been approved for a venue (in force,
// waiting out its 24 hours, or switched off since) … switching every venue off — a tightening, with no code — must not
// lift it." A tightening made while the approval is still waiting (or matured but not yet written back by a broker
// command) must neither drop the pending approval without a trace nor lift the ratchet with it.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { profileCommand, profileRatchetOn } from "../src/commands/profile.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, loadProfile, saveProfile } from "../src/core/profile.js";
import { effectiveLimits, LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
});

const run = async (...positional: string[]) => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await profileCommand({ command: "profile", positional, values: {}, bools: new Set() }, true);
  } finally {
    write.mockRestore();
  }
};

describe("the profile ratchet, once a venue was approved by code", () => {
  it("is not lifted by a code-free tightening of the live limits", async () => {
    // The user approved Kraken with a code: `broker limits set --venues kraken --code …` (in force in 24 hours).
    expect(requestLimits({ venues: ["kraken"] }, true)).toMatchObject({ applied: false, effectiveAt: expect.any(String) });
    expect(profileRatchetOn()).toBe(true);
    await run("set", "limits.maxDailyLossPct", "50");
    expect(loadProfile()!.limits.maxDailyLossPct).toBe(2); // held: a code and 24 hours

    // No code: `broker limits set --max-order 249` — a tightening, applied at once.
    expect(requestLimits({ maxOrder: 249 }, false)).toEqual({ applied: true });

    // Live trading was approved for a venue and "switched off since": the profile still ratchets…
    expect.soft(profileRatchetOn()).toBe(true);
    // …so the daily loss stop cannot go from 2 % to 50 %, nor the investor to another country, without a code.
    await run("set", "limits.maxDailyLossPct", "50");
    await run("set", "jurisdiction", "US");
    expect.soft(loadProfile()!.limits.maxDailyLossPct).toBe(2);
    expect.soft(loadProfile()!.jurisdiction).toBe("FR");
  });

  it("holds, and the venue stays on, when the approval has matured but no broker command wrote it back yet", async () => {
    // Approved 25 hours ago: in force by the clock. Only `effectiveLimits` (status, limits, submit) writes that back.
    requestLimits({ venues: ["kraken"] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 3_600_000));
    // The first broker command since happens to be a tightening: `broker limits set --max-order 249` (broker.ts:128-157
    // goes straight to requestLimits, which merges the change over the stored, not-yet-matured limits).
    expect(requestLimits({ maxOrder: 249 }, false)).toEqual({ applied: true });
    // Only the order limit was tightened: Kraken, approved and matured, is still on, and the profile still ratchets.
    expect.soft(effectiveLimits(0).limits).toMatchObject({ maxOrder: 249, venues: ["kraken"] });
    expect.soft(profileRatchetOn()).toBe(true);
  });

  it("keeps a waiting venue, tightened alongside, and leaves a trace when a tightening empties it", () => {
    requestLimits({ maxDaily: 2500, venues: ["kraken"] }, true);
    // `--max-daily 400`: the waiting approval is cut down to it, Kraken still waits.
    expect(requestLimits({ maxDaily: 400 }, false)).toEqual({ applied: true });
    expect(effectiveLimits(1000).pending?.limits).toMatchObject({ maxOrder: 250, maxDaily: 400, venues: ["kraken"] });
    // `--venues none`: nothing is left of it beyond what is in force — dropped, with a trace, and the ratchet holds.
    expect(requestLimits({ venues: [] }, false)).toEqual({ applied: true });
    expect(effectiveLimits(0).pending).toBeUndefined();
    expect(profileRatchetOn()).toBe(true);
  });
});
