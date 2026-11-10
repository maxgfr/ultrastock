import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mcpToolCall } from "../src/providers/external/crible.js";

/** A stand-in MCP server: a node process running `script`, with `reply(id, result)` and the lines it reads on stdin. */
const server = (script: string) =>
  spawn(
    process.execPath,
    [
      "-e",
      `const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
       const onLine = (fn) => { let buf = ""; process.stdin.on("data", (c) => { buf += c; let nl; while ((nl = buf.indexOf("\\n")) >= 0) { fn(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } }); };
       ${script}`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

describe("crible MCP client", () => {
  it("initialises, calls the tool and returns its JSON result", async () => {
    const child = server(`onLine((m) => {
      if (m.id === 1) reply(1, { protocolVersion: "2025-06-18" });
      if (m.id === 2) reply(2, { content: [{ type: "text", text: JSON.stringify({ symbol: m.params.arguments.symbol, tool: m.params.name }) }] });
    });`);
    expect(await mcpToolCall(child, "company", { symbol: "MC.PA" }, 5000)).toEqual({ symbol: "MC.PA", tool: "company" });
  });

  it("rejects, instead of crashing the process, when the server writes a line that is not JSON", async () => {
    const child = server(`onLine((m) => { if (m.id === 1) process.stdout.write("{ a log line that only looks like JSON\\n"); });`);
    await expect(mcpToolCall(child, "company", { symbol: "MC.PA" }, 5000)).rejects.toThrow(/not JSON/);
  });

  it("rejects when the tool's text result is not JSON", async () => {
    const child = server(`onLine((m) => {
      if (m.id === 1) reply(1, {});
      if (m.id === 2) reply(2, { content: [{ type: "text", text: "Traceback (most recent call last)" }] });
    });`);
    await expect(mcpToolCall(child, "stats", {}, 5000)).rejects.toThrow(/not JSON/);
  });

  it("reports a server that stops before answering, with what it said, without waiting for the timeout", async () => {
    const started = Date.now();
    const child = server(`process.stderr.write("error: no dataset in the data directory\\n"); process.exit(3);`);
    await expect(mcpToolCall(child, "company", { symbol: "MC.PA" }, 60_000)).rejects.toThrow(/stopped before answering company \(exit 3\): error: no dataset/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("times out on a server that never answers", async () => {
    const child = server(`setInterval(() => {}, 1000);`);
    await expect(mcpToolCall(child, "company", {}, 300)).rejects.toThrow(/did not answer company within 300 ms/);
  });
});
