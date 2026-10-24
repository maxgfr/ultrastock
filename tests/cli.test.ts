import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOOL_FLAGS, COMMANDS, HELP, parseDuration, VALUE_FLAGS } from "../src/cli.js";

describe("cli", () => {
  it("documents every command and flag in --help", () => {
    for (const c of COMMANDS) expect(HELP).toMatch(new RegExp(`ultrastock ${c}\\b`));
    for (const f of [...VALUE_FLAGS, ...BOOL_FLAGS]) expect(HELP).toContain(`--${f}`);
  });
  it("parses --max-age durations and refuses others", () => {
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("36h")).toBe(36 * 3_600_000);
    expect(parseDuration("3d")).toBe(3 * 86_400_000);
    expect(() => parseDuration("soon")).toThrow(/duration/);
  });
  it("keeps the skill's commands in step with the CLI", () => {
    const skill = readFileSync(join(import.meta.dirname, "..", "skills", "ultrastock", "SKILL.md"), "utf8");
    for (const c of COMMANDS) expect(skill).toContain(c);
  });
});
