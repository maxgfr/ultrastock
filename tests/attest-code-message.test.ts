// An approval code is bound to exactly what it approves, and the out-of-band message is the only thing the
// user reads before typing it. `broker code limits --attest kraken` binds the code to "the user attests this key has
// no withdrawal right" (the ATTEST guard of live.ts:245) — and the message must say so.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issued: Array<{ subject: string; binding: string; what: string }> = [];
vi.mock("../src/trading/otp.js", async (original) => {
  const real = await original<typeof import("../src/trading/otp.js")>();
  return {
    ...real,
    // The real channels are the user's desktop and terminal: only what would be sent is kept.
    issueCode: async (subject: string, binding: string, what: string) => {
      issued.push({ subject, binding, what });
      return { sentTo: ["capture"], expiresAt: new Date(Date.now() + 120_000).toISOString() };
    },
  };
});

import { brokerCommand } from "../src/commands/broker.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { describeLimitsChange, effectiveLimits, limitsBinding, LOOSEN_DELAY_MS, requestLimits } from "../src/trading/limits.js";

beforeEach(() => {
  rmSync(homeDir(), { recursive: true, force: true });
  saveProfile(defaultProfile("FR", "EUR"));
  issued.length = 0;
});

describe("the message that carries a limits code", () => {
  it("says the code attests a key has no withdrawal right", async () => {
    // Kraken is already switched on; its key's rights cannot be asked, so live orders wait on the user's attestation.
    requestLimits({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: [] }, true, new Date(Date.now() - LOOSEN_DELAY_MS - 1000));
    expect(effectiveLimits(0).limits.venues).toEqual(["kraken"]); // matured, and written back to the stored limits
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await brokerCommand({ command: "broker", positional: ["code", "limits"], values: { attest: "kraken" }, bools: new Set() }, true);
    } finally {
      write.mockRestore();
    }
    expect(issued).toHaveLength(1);
    // The code is bound to the attestation…
    expect(issued[0]!.binding).toBe(limitsBinding({ maxOrder: 250, maxDaily: 500, venues: ["kraken"], attestedNoWithdraw: ["kraken"] }));
    // …so what the user reads must name it. It reads "live limits 250/order, 500/day, venues kraken": the limits in force.
    expect(issued[0]!.what).toMatch(/attest|withdraw/i);
  });

  it("names every limit that moves from the ones in force", () => {
    const cur = { maxOrder: 250, maxDaily: 500, venues: ["kraken" as const], attestedNoWithdraw: [] };
    const what = describeLimitsChange(cur, { maxOrder: 1000, maxDaily: 500, venues: ["kraken", "binance"], attestedNoWithdraw: ["kraken"] });
    expect(what).toMatch(/order limit 250 → 1000/);
    expect(what).not.toMatch(/daily limit/);
    expect(what).toMatch(/ON for binance/);
    expect(what).toMatch(/ATTEST that the kraken key cannot withdraw/);
    expect(describeLimitsChange(cur, cur)).toMatch(/unchanged/);
    expect(describeLimitsChange({ ...cur, attestedNoWithdraw: ["kraken"] }, { ...cur, venues: [] })).toMatch(
      /off for kraken.*withdraw your attestation for kraken/,
    );
  });
});
