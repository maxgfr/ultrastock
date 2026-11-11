import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { markBook } from "../src/commands/trading.js";
import { setNetMode } from "../src/core/net.js";
import { homeDir } from "../src/core/paths.js";
import { defaultProfile, saveProfile } from "../src/core/profile.js";
import { appendTransactions } from "../src/portfolio/ledger.js";
import { breakerState, readEquity, recordEquity } from "../src/trading/breaker.js";

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

describe("the equity curve and a replayed or forged clock", () => {
  const forgedDir = (recordedAt: string) => {
    const dir = mkdtempSync(join(tmpdir(), "us-review-fixture-"));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ recordedAt }));
    return dir;
  };

  it("`portfolio show --fixture` writes no equity point: the breaker must not be blinded by a point dated in the future", async () => {
    const profile = defaultProfile("FR", "EUR");
    saveProfile(profile);
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 10_000, currency: "EUR", origin: "manual" }], "real");
    recordEquity("real", 10_000, new Date(Date.now() - 2 * 86_400_000));
    // `ultrastock portfolio show --fixture <dir>` with a hand-made fixture.json.
    setNetMode({ kind: "fixture", dir: forgedDir("2031-01-01T00:00:00.000Z") });
    try {
      await markBook("real");
    } finally {
      setNetMode({ kind: "live" });
    }
    // The market then takes 10 % off the book today: a real valuation, written by a real `ticket check`.
    const now = new Date();
    recordEquity("real", 9000, now);
    // -10 % on the day against a 2 % daily limit: tripped — unless the last point of the curve is the forged one.
    expect(breakerState(readEquity("real"), [], profile.limits, now)).toMatchObject({ tripped: true });
  });

  it("`portfolio show --fixture` appends nothing dated by the fixture to the real book's curve", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 10_000, currency: "EUR", origin: "manual" }], "real");
    setNetMode({ kind: "fixture", dir: forgedDir("2031-01-01T00:00:00.000Z") });
    try {
      await markBook("real");
    } finally {
      setNetMode({ kind: "live" });
    }
    expect(readEquity("real")).toEqual([]);
  });

  it("`portfolio show --record` into a directory that already holds a fixture.json writes no point either", async () => {
    saveProfile(defaultProfile("FR", "EUR"));
    await appendTransactions([{ date: "2026-10-01", type: "deposit", account: "cto", amount: 10_000, currency: "EUR", origin: "manual" }], "real");
    setNetMode({ kind: "record", dir: forgedDir("2020-01-01T00:00:00.000Z") });
    try {
      await markBook("real");
    } finally {
      setNetMode({ kind: "live" });
    }
    expect(readEquity("real")).toEqual([]);
  });
});
