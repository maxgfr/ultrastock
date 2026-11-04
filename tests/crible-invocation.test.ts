import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brewCrible, brewKegVersion, CRIBLE_TAG, cribleInvocation, servesPin } from "../src/providers/external/crible.js";

const pinned = CRIBLE_TAG.slice(1);
const [major, minor, patch] = pinned.split(".").map(Number) as [number, number, number];

/** A fake Homebrew prefix: Cellar/crible/<version>/bin/crible, linked from bin/. */
function brewPrefix(root: string, version: string): string {
  const keg = join(root, "Cellar", "crible", version, "bin");
  mkdirSync(keg, { recursive: true });
  writeFileSync(join(keg, "crible"), "#!/bin/sh\n");
  chmodSync(join(keg, "crible"), 0o755);
  mkdirSync(join(root, "bin"), { recursive: true });
  symlinkSync(join(keg, "crible"), join(root, "bin", "crible"));
  return join(root, "bin");
}

describe("a Homebrew crible", () => {
  let root: string;
  const saved = { path: process.env.PATH, cmd: process.env.ULTRASTOCK_CRIBLE_CMD };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "us-brew-"));
    delete process.env.ULTRASTOCK_CRIBLE_CMD;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env.PATH = saved.path;
    if (saved.cmd === undefined) delete process.env.ULTRASTOCK_CRIBLE_CMD;
    else process.env.ULTRASTOCK_CRIBLE_CMD = saved.cmd;
  });

  it("reads the version from the keg path, revision dropped", () => {
    expect(brewKegVersion("/opt/homebrew/Cellar/crible/0.17.0/bin/crible")).toBe("0.17.0");
    expect(brewKegVersion("/home/linuxbrew/.linuxbrew/Cellar/crible/0.17.2_1/bin/crible")).toBe("0.17.2");
    expect(brewKegVersion("/Users/me/.local/bin/crible")).toBeUndefined();
  });

  it("serves the pin at the same minor and at least the pinned patch", () => {
    expect(servesPin("0.17.0", "v0.17.0")).toBe(true);
    expect(servesPin("0.17.3", "v0.17.0")).toBe(true);
    expect(servesPin("0.17.0", "v0.17.1")).toBe(false);
    expect(servesPin("0.18.0", "v0.17.0")).toBe(false);
    expect(servesPin("1.17.0", "v0.17.0")).toBe(false);
  });

  it("runs the Homebrew crible of the pinned version instead of uvx", () => {
    const bin = brewPrefix(root, pinned);
    process.env.PATH = [bin, saved.path].join(delimiter);
    expect(brewCrible()).toEqual({ path: join(bin, "crible"), version: pinned });
    const inv = cribleInvocation();
    expect(inv).toMatchObject({ cmd: join(bin, "crible"), args: [], via: "brew" });
  });

  it("falls back to uvx, and says why, when the Homebrew crible is another minor", () => {
    const bin = brewPrefix(root, `${major}.${minor + 1}.0`);
    process.env.PATH = [bin, saved.path].join(delimiter);
    const inv = cribleInvocation();
    expect(inv.via).toBe("uvx");
    expect(inv.args).toContain(`git+https://github.com/maxgfr/crible@${CRIBLE_TAG}`);
    expect(inv.note).toMatch(/not the pinned/);
  });

  it("only looks at the first crible on PATH, and ULTRASTOCK_CRIBLE_CMD wins over all", () => {
    const own = join(root, "own");
    mkdirSync(own);
    writeFileSync(join(own, "crible"), "#!/bin/sh\n");
    const bin = brewPrefix(join(root, "brew"), `${major}.${minor}.${patch}`);
    process.env.PATH = [own, bin].join(delimiter);
    expect(brewCrible()).toBeUndefined();
    process.env.ULTRASTOCK_CRIBLE_CMD = "crible --flag";
    expect(cribleInvocation()).toEqual({ cmd: "crible", args: ["--flag"], via: "env" });
  });
});
