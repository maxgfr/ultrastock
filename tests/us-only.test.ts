import { describe, expect, it } from "vitest";
import { analystCommand, dividendsCommand, shortCommand } from "../src/commands/fundamentals.js";
import { UsageError } from "../src/engine.js";

const args = (sym: string) => ({ command: "x", positional: [sym], values: {}, bools: new Set<string>() });

describe("US-only commands", () => {
  it("refuse a European listing before asking Nasdaq, and say where to look instead", async () => {
    await expect(dividendsCommand(args("TTE.PA"), false)).rejects.toThrow(UsageError);
    await expect(dividendsCommand(args("tte.pa"), false)).rejects.toThrow(/fundamentals TTE\.PA/);
    await expect(shortCommand(args("MC.PA"), false)).rejects.toThrow(/AMF/);
    await expect(analystCommand(args("SAP.DE"), false)).rejects.toThrow(/not a US listing/);
  });
});
