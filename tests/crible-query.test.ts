import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { peersDataset } from "../src/analyze/peers.js";
import { cribleFundamentals } from "../src/commands/fundamentals.js";
import { setNetMode } from "../src/core/net.js";
import { cribleString } from "../src/providers/external/crible.js";
import { contentHash } from "../src/engine.js";

/** Record crible `screen` answers for exactly these queries (limit 1 as the lookups ask, unless the query names its tail). */
function recordScreens(answers: Record<string, unknown[]>, tails: Record<string, string[]> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "us-crible-q-"));
  mkdirSync(join(dir, "crible"), { recursive: true });
  for (const [query, rows] of Object.entries(answers)) {
    const call = ["cli", "screen", query, "--format", "json", ...(tails[query] ?? ["--limit", "1", "--offset", "0"])];
    writeFileSync(
      join(dir, "crible", `${contentHash(JSON.stringify(call)).slice(0, 20)}.json`),
      JSON.stringify({ call, value: JSON.stringify({ total: rows.length, rows }) }),
    );
  }
  return dir;
}

describe("crible string literals", () => {
  afterEach(() => setNetMode({ kind: "live" }));

  it("escapes a quote and a backslash the way crible's DSL reads them back", () => {
    // crible v0.17 (src/crible/dsl/parser.py): '(?:[^'\\]|\\.)*', then \' → ' and \\ → \.
    expect(cribleString("MC.PA")).toBe("'MC.PA'");
    expect(cribleString("Dr. Reddy's")).toBe("'Dr. Reddy\\'s'");
    expect(cribleString("a\\b")).toBe("'a\\\\b'");
    expect(cribleString("x\\'")).toBe("'x\\\\\\''");
  });

  it("fundamentals looks a symbol with a quote up as that symbol, not a stripped one", async () => {
    setNetMode({ kind: "fixture", dir: recordScreens({ "symbol = 'O\\'X'": [{ symbol: "O'X", period: "2025-12-31", piotroski_f: 7 }] }) });
    const ds = await cribleFundamentals("O'X", "USD");
    expect(ds.points.length).toBeGreaterThan(0);
  });

  it("peers quotes the symbol, the industry and every country through the same literal", async () => {
    const group = "industry = 'Banks\\\\Regional' AND primary_listing = true AND country IN ('X\\'Y')";
    const dir = recordScreens(
      {
        "symbol = 'O\\'X'": [{ symbol: "O'X", name: "O'X Corp", industry: "Banks\\Regional", country: "X'Y" }],
        [group]: [{ symbol: "PEER", name: "Peer Bank", industry: "Banks\\Regional", country: "X'Y", price_to_earnings_ratio: 9 }],
      },
      { [group]: ["--limit", "30", "--offset", "0", "--sort", "-cap_eur"] },
    );
    setNetMode({ kind: "fixture", dir });
    await expect(peersDataset("O'X")).resolves.toBeDefined();
  });
});
