// The profile ratchet once live trading has been approved: never off, never late.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandArgs } from "../src/commands/emit.js";
import { profileCommand, profileRatchetOn } from "../src/commands/profile.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, loadProfile, requestProfileChange, saveProfile } from "../src/core/profile.js";
import { currentLimits, effectiveLimits, LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";

const set = async (field: string, value: string) => {
  const w = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await profileCommand(commandArgs("profile", ["set", field, value]), true);
  } finally {
    w.mockRestore();
  }
};

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
});

describe("profile ratchet once live trading was approved", () => {
  it("is on as soon as an approved venue switch-on has matured, before any broker command has run", async () => {
    // The only way a venue is ever switched on: a loosening, approved by code, 24 hours ago.
    requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
    // No `broker status|limits|submit` has run since it matured: the stored `current` still says "no venue".
    await set("jurisdiction", "US");
    await set("limits.maxDailyLossPct", "50");
    // Live trading IS on: the limits in force list the venue, so the next `broker submit` passes VENUE_OFF.
    expect(effectiveLimits(0).limits.venues).toEqual(["kraken"]);
    expect(loadProfile()).toMatchObject({ jurisdiction: "FR", limits: { maxDailyLossPct: 2 } });
  });

  it("stays on when the venues are switched off (a tightening: no code, at once)", async () => {
    requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
    effectiveLimits(0);
    expect(profileRatchetOn()).toBe(true);
    // `broker limits set --venues none`: a tightening, applied at once without any code.
    expect(requestLimits({ ...currentLimits(), venues: [] }, false)).toMatchObject({ applied: true });
    await set("limits.maxDailyLossPct", "50");
    await set("jurisdiction", "US");
    // Live trading "has been switched on" once: lowering a guard must still take a code that names it.
    expect(loadProfile()).toMatchObject({ jurisdiction: "FR", limits: { maxDailyLossPct: 2 } });
  });

  it("does not let the currency the limits and the equity curve are counted in change at once", () => {
    const p = defaultProfile("FR", "EUR");
    // live-limits maxOrder/maxDaily are "in the base currency" and the breaker compares equity figures recorded in it.
    expect(requestProfileChange(p, "baseCurrency", "USD", { ratchet: true })).toMatchObject({ applied: false });
  });
});
