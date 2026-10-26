import { describe, expect, it } from "vitest";
import { createServer } from "../src/engine.js";
import { argvFor, mcpAdapter, serveMcp, TOOLS } from "../src/mcp.js";

const tool = (n: string) => TOOLS.find((t) => t.name === n)!;

describe("MCP tools", () => {
  it("are read-only except ticket creation, and none submits, stores keys or edits state", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(TOOLS.filter((t) => t.writes).map((t) => t.name)).toEqual(["plan"]);
    for (const t of TOOLS) expect(t.command[0]).not.toMatch(/^(broker|paper|profile|decide|watch|knowledge)$/);
    expect(TOOLS.find((t) => t.command[0] === "portfolio")!.params.action!.enum).not.toContain("add");
    const decls = mcpAdapter(async () => "").listTools("2025-06-18" as never);
    expect(decls.find((d) => d.name === "plan")!.annotations!.readOnlyHint).toBe(false);
    expect(decls.find((d) => d.name === "quote")!.annotations!.readOnlyHint).toBe(true);
  });

  it("map arguments to a command line, positionals first, and refuse unknown or flag-like values", () => {
    expect(argvFor(tool("analyze"), { symbol: "MC.PA", depth: "deep", out: "/tmp/r" })).toEqual(["analyze", "MC.PA", "--depth=deep", "--out=/tmp/r", "--json"]);
    expect(argvFor(tool("stats"), { symbols: ["MC.PA", "OR.PA"] })).toEqual(["stats", "MC.PA", "OR.PA", "--json"]);
    expect(argvFor(tool("backtest_review"), { strategy: "sma-cross", symbol: "BTCUSDT", years: 3 })).toEqual([
      "backtest",
      "review",
      "sma-cross",
      "BTCUSDT",
      "--years=3",
      "--json",
    ]);
    expect(argvFor(tool("plan"), { symbol: "MC.PA", account: "pea", ticket: true })).toEqual(["plan", "MC.PA", "--account=pea", "--ticket", "--json"]);
    expect(() => argvFor(tool("quote"), {})).toThrow(/symbol is required/);
    expect(() => argvFor(tool("quote"), { symbol: "--fixture=/x" })).toThrow(/may not start/);
    expect(() => argvFor(tool("quote"), { symbol: "NVDA", nope: 1 })).toThrow(/unknown argument/);
    expect(() => argvFor(tool("regime"), { market: "mars" })).toThrow(/one of/);
  });

  it("answer tools/list and tools/call through the engine's server", async () => {
    const calls: string[][] = [];
    const server = createServer(
      mcpAdapter(async (argv) => {
        calls.push(argv);
        return '{"ok":true}';
      }),
    );
    const replies: unknown[] = [];
    const send = (m: unknown) => replies.push(m);
    await server.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      } as never,
      send as never,
    );
    await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as never, send as never);
    await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "quote", arguments: { symbol: "NVDA" } } } as never, send as never);
    const list = replies.find((r) => (r as { id: number }).id === 2) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toContain("analyze");
    const call = replies.find((r) => (r as { id: number }).id === 3) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]!.text).toContain('"ok":true');
    expect(calls).toEqual([["quote", "NVDA", "--json"]]);
  });

  it("refuses HTTP without a strong bearer token", async () => {
    delete process.env.ULTRASTOCK_MCP_TOKEN;
    await expect(serveMcp({ transport: "http", token: "short" })).rejects.toThrow(/bearer token of 24\+ characters/);
    await expect(serveMcp({ transport: "smoke" })).rejects.toThrow(/stdio or http/);
  });
});

describe("maturity", () => {
  it("names every command", async () => {
    const { COMMANDS } = await import("../src/cli.js");
    const { MATURITY } = await import("../src/core/maturity.js");
    for (const c of COMMANDS) expect(MATURITY[c], c).toBeDefined();
    expect(MATURITY.broker).toBe("experimental");
  });
});

describe("1.1 tools", () => {
  it("map research, value and etf onto their commands, never value's --watch", () => {
    expect(argvFor(tool("research"), { subject: "MC.PA", focus: "results", out: "/tmp/r" })).toEqual([
      "research",
      "MC.PA",
      "--focus=results",
      "--out=/tmp/r",
      "--json",
    ]);
    expect(argvFor(tool("research"), { "web-results": "/tmp/ws.json", out: "/tmp/r" })).toEqual([
      "research",
      "--web-results=/tmp/ws.json",
      "--out=/tmp/r",
      "--json",
    ]);
    expect(argvFor(tool("value"), { style: "deep-value", region: "pea", "min-cap-eur": 1e9 })).toEqual([
      "value",
      "--style=deep-value",
      "--region=pea",
      "--min-cap-eur=1000000000",
      "--json",
    ]);
    expect(() => argvFor(tool("value"), { watch: true })).toThrow(/unknown argument/);
    expect(argvFor(tool("etf"), { action: "find", target: "MSCI World", pea: true })).toEqual(["etf", "find", "MSCI World", "--pea", "--json"]);
    expect(tool("analyze").params.depth!.enum).toContain("full");
  });
});
