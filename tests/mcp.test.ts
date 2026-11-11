import { describe, expect, it } from "vitest";
import { createServer } from "../src/engine.js";
import { argvFor, mcpAdapter, serveMcp, TOOLS } from "../src/mcp.js";

const tool = (n: string) => TOOLS.find((t) => t.name === n)!;

describe("MCP tools", () => {
  it("submit nothing, store no key and edit no profile or ledger, and say what they write", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(TOOLS.filter((t) => t.writes).map((t) => t.name)).toEqual(["analyze", "research", "portfolio", "portfolio_news", "calc", "plan"]);
    for (const t of TOOLS) expect(t.command[0]).not.toMatch(/^(broker|paper|profile|decide|watch|knowledge)$/);
    expect(TOOLS.find((t) => t.command[0] === "portfolio")!.params.action!.enum).not.toContain("add");
    // The local store: read-only tools only — no db init/export/off, no track, no --mark-seen.
    expect(tool("portfolio_db").params.action!.enum).toEqual(["status", "query"]);
    expect(Object.keys(tool("portfolio_news").params)).not.toContain("mark-seen");
    for (const t of TOOLS.filter((x) => x.command[0] === "portfolio")) expect(t.command[1] ?? "", t.name).not.toMatch(/^(track|add|import|deposit|withdraw)$/);
    expect(argvFor(tool("portfolio_db"), { action: "query", sql: "select count(*) from transactions" })).toEqual([
      "portfolio",
      "db",
      "query",
      "select count(*) from transactions",
      "--json",
    ]);
    const decls = mcpAdapter(async () => "").listTools("2025-06-18" as never);
    const hints = (n: string) => decls.find((d) => d.name === n)!.annotations!;
    expect(hints("plan").readOnlyHint).toBe(false);
    // A run written (analyze, calc), an equity reading appended for the breaker (portfolio show|perf), a cache filled.
    for (const n of ["analyze", "calc", "portfolio", "portfolio_news", "research"]) expect(hints(n).readOnlyHint, n).toBe(false);
    for (const n of ["analyze", "portfolio", "portfolio_news", "research", "plan"]) expect(hints(n).idempotentHint, n).toBe(false);
    // calc registers the same [E#] again for the same formula on the same evidence.
    expect(hints("calc").idempotentHint).toBe(true);
    // A tool given a run directory writes its evidence there.
    expect(hints("quote").readOnlyHint).toBe(false);
    for (const n of ["history", "evidence", "check", "journal", "portfolio_db", "watchlist_list"])
      expect(hints(n), n).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });

  it("refuse a null or empty required argument, and a list element a flag would split", () => {
    expect(() => argvFor(tool("calc"), { run: "/tmp/r", formula: null, label: "x" })).toThrow(/formula is required/);
    expect(() => argvFor(tool("stats"), { symbols: [] })).toThrow(/symbols is required/);
    expect(() => argvFor(tool("morning"), { symbols: ["ALO.PA,NVDA"] })).toThrow(/comma/);
    expect(argvFor(tool("morning"), { symbols: ["ALO.PA", "NVDA"] })).toEqual(["morning", "--symbols=ALO.PA,NVDA", "--json"]);
  });

  it("read an answer or a search-results file only inside the run it is given with", async () => {
    const { mkdtempSync, writeFileSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const run = mkdtempSync(join(tmpdir(), "us-mcp-run-"));
    writeFileSync(join(run, "answer.md"), "x");
    expect(argvFor(tool("check"), { run, answer: join(run, "answer.md") })).toEqual(["check", run, join(run, "answer.md"), "--json"]);
    expect(() => argvFor(tool("check"), { run, answer: "/etc/passwd" })).toThrow(/inside the run/);
    expect(() => argvFor(tool("check"), { run, answer: join(run, "..", "elsewhere.md") })).toThrow(/inside the run/);
    symlinkSync("/etc/passwd", join(run, "link.md"));
    expect(() => argvFor(tool("check"), { run, answer: join(run, "link.md") })).toThrow(/inside the run/);
    expect(() => argvFor(tool("research"), { out: run, "web-results": "/etc/passwd" })).toThrow(/inside the run/);
    writeFileSync(join(run, "hits.json"), "[]");
    expect(argvFor(tool("research"), { out: run, "web-results": join(run, "hits.json") })).toContain(`--web-results=${join(run, "hits.json")}`);
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
    expect(argvFor(tool("research"), { "web-results": "/tmp/r/ws.json", out: "/tmp/r" })).toEqual([
      "research",
      "--web-results=/tmp/r/ws.json",
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
    expect(argvFor(tool("etf"), { action: "find", asset: "bond", currency: "EUR" })).toEqual(["etf", "find", "--asset=bond", "--currency=EUR", "--json"]);
    expect(argvFor(tool("etf"), { action: "propose", envelope: "pea", risk: 5, amount: 10000, out: "/tmp/run" })).toEqual([
      "etf",
      "propose",
      "--envelope=pea",
      "--risk=5",
      "--amount=10000",
      "--out=/tmp/run",
      "--json",
    ]);
    expect(TOOLS.find((t) => t.name === "etf")!.writes).toBeUndefined();
    expect(tool("analyze").params.depth!.enum).toContain("full");
  });
});

describe("research hits inline", () => {
  it("hands the agent's hits to the command as a temporary --web-results file", async () => {
    const { readFileSync } = await import("node:fs");
    let seen: unknown;
    const adapter = mcpAdapter(async (argv) => {
      const flag = argv.find((a) => a.startsWith("--web-results="))!;
      seen = { argv, hits: JSON.parse(readFileSync(flag.slice("--web-results=".length), "utf8")) };
      return "{}";
    });
    await adapter.callTool("research", { out: "/tmp/r", hits: [{ url: "https://a.test", angle: "risks" }] }, {} as never);
    const s = seen as { argv: string[]; hits: unknown };
    expect(s.argv[0]).toBe("research");
    expect(s.argv.at(-1)).toBe("--json");
    expect(s.hits).toEqual([{ url: "https://a.test", angle: "risks" }]);
  });
});
