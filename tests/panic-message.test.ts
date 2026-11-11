// `broker panic` tells the user what the kill switch it sets lets through. Live, nothing goes to a venue under it — a
// sell included (live.ts refuses KILL_SWITCH before any other check); on paper, the gate lets risk-reducing orders pass.
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerCommand } from "../src/commands/broker.js";
import { homeDir } from "../src/core/paths.js";
import { killSwitchPath } from "../src/trading/riskgate.js";

afterEach(() => rmSync(killSwitchPath(), { force: true }));

describe("broker panic", () => {
  it("says no live order goes, not even a sell, and only paper lets risk-reducing orders through", async () => {
    rmSync(homeDir(), { recursive: true, force: true });
    let printed = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      printed += String(s);
      return true;
    });
    try {
      await brokerCommand({ command: "broker", positional: ["panic"], values: {}, bools: new Set() }, false);
    } finally {
      write.mockRestore();
    }
    expect(printed).toMatch(/kill switch ON/);
    expect(printed).not.toMatch(/— only risk-reducing orders pass;/);
    expect(printed).toMatch(/no live order goes to a venue, not even a sell/);
    expect(printed).toMatch(/on paper, only risk-reducing orders pass/);
  });
});
