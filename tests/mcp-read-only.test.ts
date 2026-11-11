// A tool the MCP server annotates read-only writes nothing: `journal review|digest` read the ledger, and a ledger read
// migrates a local store on an older schema — unless the command is told it runs for a read-only tool.
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { setLedgerBackend, sqliteSupported, storePath } from "../src/core/db.js";
import { mcpAdapter, type RunOptions } from "../src/mcp.js";
import { readLedgerWithoutWriting } from "../src/portfolio/ledger.js";

afterEach(() => {
  delete process.env.ULTRASTOCK_READ_ONLY;
  readLedgerWithoutWriting(false);
  setLedgerBackend("jsonl");
});

/** Run the CLI in-process; returns stdout and stderr, and the code a process.exit would have carried. */
async function cli(argv: string[]): Promise<{ out: string; err: string; code?: number }> {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    err += String(c);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw Object.assign(new Error("exit"), { exitCode: code });
  }) as never);
  try {
    await main(argv);
    return { out, err };
  } catch (e) {
    return { out, err, code: (e as { exitCode?: number }).exitCode ?? 99 };
  } finally {
    vi.restoreAllMocks();
  }
}

describe("mcp read-only tools", () => {
  it("run their command told it is read-only, and only those", async () => {
    const seen: Array<[string, boolean | undefined]> = [];
    const adapter = mcpAdapter(async (argv, _signal, opts?: RunOptions) => {
      seen.push([argv[0]!, opts?.readOnly]);
      return "{}";
    });
    await adapter.callTool("journal", { action: "review" }, undefined as never);
    await adapter.callTool("quote", { symbol: "NVDA", out: "/tmp/r" }, undefined as never);
    expect(seen).toEqual([
      ["journal", true],
      ["quote", false],
    ]);
  });

  it.skipIf(!sqliteSupported())("`journal review` run for a read-only tool does not migrate a store on an older schema", async () => {
    process.env.ULTRASTOCK_HOME = mkdtempSync(join(tmpdir(), "mcp-read-only-"));
    // A store at version 0 (an empty file).
    setLedgerBackend("sqlite");
    writeFileSync(storePath(), "");
    process.env.ULTRASTOCK_READ_ONLY = "1";
    const r = await cli(["journal", "review", "--json"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/older schema and this command never writes/);
    expect(statSync(storePath()).size).toBe(0);
  });
});
