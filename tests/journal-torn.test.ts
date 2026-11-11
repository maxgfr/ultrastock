import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { journalDir, pastDecisions } from "../src/analyze/decision.js";
import { homeDir } from "../src/core/paths.js";
import { readDecisions, readSettlements } from "../src/journal/settle.js";

beforeEach(() => rmSync(homeDir(), { recursive: true, force: true }));

describe("the decision journal after a crash mid-append", () => {
  it("reads past a last line cut short, and still refuses a corrupt line in the middle", () => {
    mkdirSync(journalDir(), { recursive: true });
    const decisions = join(journalDir(), "decisions.jsonl");
    appendFileSync(decisions, `${JSON.stringify({ id: "d-1", symbol: "MC.PA", rating: "buy" })}\n`);
    appendFileSync(decisions, '{"id":"d-2","symbol":"MC.P'); // the append that never returned
    const warnings: string[] = [];
    expect(readDecisions((w) => warnings.push(w)).map((d) => d.id)).toEqual(["d-1"]);
    expect(warnings.join(" ")).toMatch(/cut short/);
    expect(pastDecisions("MC.PA").map((d) => d.id)).toEqual(["d-1"]);
    // A line written whole and broken since is corruption, not a crash: it stays an error.
    const settlements = join(journalDir(), "settlements.jsonl");
    appendFileSync(settlements, "{broken}\n");
    appendFileSync(settlements, `${JSON.stringify({ decisionId: "d-1", horizon: 5 })}\n`);
    expect(() => readSettlements()).toThrow(/line 1: unreadable/);
    expect(existsSync(`${decisions}.torn`)).toBe(false);
  });
});
