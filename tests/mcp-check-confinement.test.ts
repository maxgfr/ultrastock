// MCP: "a tool call never gets to read an arbitrary file of the user's" (src/mcp.ts). `check`'s answer must sit inside
// `run`, but `run` is any directory the caller names: naming an ancestor of the file made it "inside", and the command
// then only needed an evidence.json there — which every tool that takes `out` writes wherever it is told.
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAnswer } from "../src/check.js";
import { type Dataset, registerDatasets } from "../src/core/datasets.js";
import { mcpAdapter } from "../src/mcp.js";

/** What `ultrastock check <run> <answer> --json` prints, run from the source instead of the bundle. */
const runSource = async (argv: string[]): Promise<string> => {
  const { readFileSync } = await import("node:fs");
  const [cmd, dir, file] = argv;
  if (cmd !== "check") throw new Error(`unexpected command ${argv.join(" ")}`);
  return JSON.stringify(checkAnswer(dir!, readFileSync(file!, "utf8")));
};

const quote: Dataset = {
  kind: "quote",
  title: "MC.PA",
  points: [{ key: "MC.PA.close", label: "LVMH close", value: 383, unit: "EUR" }],
  provenance: { source: "euronext", fetchedAt: "2026-11-10T17:35:00.000Z", official: true },
  notes: [],
};

const said = async (args: Record<string, unknown>): Promise<string> => {
  try {
    return (await mcpAdapter(runSource).callTool("check", args, undefined as never)).text;
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
};

describe("mcp check: the answer file", () => {
  it("does not quote a file of the user's that is no answer of a run", async () => {
    // The user's home, with private notes two levels down. Nothing here is a run.
    const userHome = realpathSync(mkdtempSync(join(tmpdir(), "mcp-home-")));
    const secret = join(userHome, "private", "vault", "notes.md");
    mkdirSync(join(userHome, "private", "vault"), { recursive: true });
    writeFileSync(secret, "- bank card PIN 4821, online banking code 771934\n- recovery phrase: tulip anchor 9 velvet 42 harbor\n");

    // Call 1 — any tool given `out` writes its evidence there: `quote {symbol, out: <home>}`. What that call does to the
    // directory is done here without the network: registerDatasets is the function `quote --out` registers through.
    registerDatasets(userHome, [quote]);

    // Call 2 — `check {run: <home>, answer: <home>/private/vault/notes.md}`.
    const text = await said({ run: userHome, answer: secret });
    expect(text).not.toContain("4821");
    expect(text).not.toContain("771934");
    expect(text).not.toContain("tulip anchor");
  }, 60_000);

  it("does not quote a note made a run by writing evidence into its folder", async () => {
    // Call 1 makes the notes' own folder a "run"; the notes were there before it.
    const vault = realpathSync(mkdtempSync(join(tmpdir(), "mcp-vault-")));
    const notes = join(vault, "notes.md");
    writeFileSync(notes, "- bank card PIN 4821\n");
    const before = new Date(Date.now() - 3_600_000);
    utimesSync(notes, before, before);
    registerDatasets(vault, [quote]);
    const text = await said({ run: vault, answer: notes });
    expect(text).toMatch(/^refused: .*before the run was created/);
    expect(text).not.toContain("4821");
  });

  it("refuses a run that is no run, the home directory or a root", async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "mcp-plain-")));
    writeFileSync(join(plain, "answer.md"), "Close 383 € [E1].\n");
    expect(await said({ run: plain, answer: join(plain, "answer.md") })).toMatch(/^refused: .*holds no evidence\.json/);
    expect(await said({ run: homedir(), answer: join(homedir(), "answer.md") })).toMatch(/^refused: .*home directory/);
    expect(await said({ run: dirname(homedir()), answer: join(dirname(homedir()), "answer.md") })).toMatch(/^refused: .*home directory/);
  });

  it("checks an answer written at the top of a run after its tools", async () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), "mcp-run-")));
    registerDatasets(run, [quote]);
    writeFileSync(join(run, "answer.md"), "LVMH closed at 383 € [E1].\n");
    const text = await said({ run, answer: join(run, "answer.md") });
    expect(JSON.parse(text)).toMatchObject({ claims: 1, problems: [] });
    mkdirSync(join(run, "drafts"));
    writeFileSync(join(run, "drafts", "answer.md"), "LVMH closed at 383 € [E1].\n");
    expect(await said({ run, answer: join(run, "drafts", "answer.md") })).toMatch(/^refused: .*top of the run directory/);
    writeFileSync(join(run, "answer.json"), "{}");
    expect(await said({ run, answer: join(run, "answer.json") })).toMatch(/^refused: .*\.md or \.txt/);
  });
});
