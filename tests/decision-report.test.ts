import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type Decision, journalDir, pastDecisions, recordDecision, validateDecision } from "../src/analyze/decision.js";
import { deltaMarkdown, deltaRuns } from "../src/analyze/delta.js";
import { commandArgs } from "../src/commands/emit.js";
import { decideCommand } from "../src/commands/journal.js";
import { EvidenceStore } from "../src/core/evidence.js";
import { markdownToHtml, priceSvg, renderReport } from "../src/report/html.js";

const base = { source: "euronext", fetchedAt: "2026-10-23T18:00:00Z", official: true };
function run(values: Record<string, number | string>) {
  const dir = mkdtempSync(join(tmpdir(), "us-dr-"));
  const s = EvidenceStore.open(dir, { subject: "MC.PA" });
  for (const [key, value] of Object.entries(values)) s.add({ ...base, key, label: key, value, unit: typeof value === "number" ? "EUR" : undefined });
  s.save();
  return dir;
}
const good = {
  symbol: "MC.PA",
  run: "x",
  decidedAt: "2026-10-24T10:00:00Z",
  rating: "overweight",
  horizon: "months",
  conviction: 3,
  thesis: "Quality franchise at a 40 % discount to its high, with the trend turning.",
  evidence: ["E1", "[E2]"],
  falsifiers: ["a close below 375 EUR"],
  risks: ["China demand"],
  portfolioContext: "flat",
  plan: { side: "buy", entry: 383, stop: 365, targets: [420, 455], sizePct: 4 },
};

describe("decisions", () => {
  it("accepts a complete decision and normalises its evidence ids", () => {
    const dir = run({ "MC.PA.close": 383, "MC.PA.trend": "downtrend" });
    const r = validateDecision(good, dir);
    expect(r.problems).toEqual([]);
    expect(r.decision!.evidence).toEqual(["E1", "E2"]);
    const rec = recordDecision(r.decision!, dir);
    expect(existsSync(rec.file)).toBe(true);
    expect(readFileSync(rec.journal, "utf8")).toMatch(/\[2026-10-24 \| MC\.PA \| overweight \| conviction 3 \| pending \| d-[0-9a-f]{12}\]/);
    expect(pastDecisions("MC.PA")[0]!.rating).toBe("overweight");
  });
  it("refuses unknown evidence, no falsifier, a stop on the wrong side and a contradictory plan", () => {
    const dir = run({ "MC.PA.close": 383 });
    const r = validateDecision({ ...good, evidence: ["E9"], falsifiers: [], rating: "sell", plan: { ...good.plan, stop: 400 } }, dir);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" | ")).toMatch(/E9 is not in the run/);
    expect(r.problems.join(" | ")).toMatch(/falsifiers/);
    expect(r.problems.join(" | ")).toMatch(/wrong side/);
    expect(r.problems.join(" | ")).toMatch(/contradicts/);
    expect(validateDecision({ ...good, plan: { ...good.plan, stop: undefined } }, dir).problems.join(" ")).toMatch(/stop is required/);
    expect(validateDecision("nope", dir).ok).toBe(false);
  });
  it("dates a new decision by the clock, never by its file, and records a re-run of the same file once", async () => {
    const decide = async (dir: string, body: object) => {
      const file = join(dir, "decision.json");
      writeFileSync(file, JSON.stringify(body));
      let out = "";
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
        out += String(c);
        return true;
      });
      try {
        await decideCommand(commandArgs("decide", [dir, file]), true);
      } finally {
        spy.mockRestore();
      }
      return { out: JSON.parse(out), file: JSON.parse(readFileSync(file, "utf8")) as Decision };
    };
    const journal = () =>
      readFileSync(join(journalDir(), "decisions.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Decision);
    const dir = run({ "MC.PA.close": 383, "MC.PA.trend": "downtrend" });
    const before = Date.now();
    // Backdated to January, it would be settled against prices already known.
    const forged = await decide(dir, { ...good, symbol: "FORGED.PA", decidedAt: "2026-01-02", id: "d-forged", run: "/elsewhere" });
    expect(Date.parse(forged.file.decidedAt)).toBeGreaterThanOrEqual(before);
    expect(forged.file.id).not.toBe("d-forged");
    expect(forged.file.run).toBe(dir);
    expect(forged.out.notes.join(" ")).toMatch(/decidedAt "2026-01-02" ignored.*id "d-forged" ignored/);
    expect(
      journal()
        .filter((d) => d.symbol === "FORGED.PA")
        .map((d) => [d.id, d.decidedAt]),
    ).toEqual([[forged.file.id, forged.file.decidedAt]]);
    // decide again on the file it wrote back: the same decision, neither a second entry nor a new date.
    const again = await decide(dir, forged.file);
    expect(again.out).toMatchObject({ id: forged.file.id, alreadyRecorded: true });
    expect(journal().filter((d) => d.symbol === "FORGED.PA")).toHaveLength(1);
    // The recorded id and time over other content is neither that decision nor a new one: refused, the journal untouched.
    const edited = await decide(dir, { ...forged.file, conviction: 5, thesis: "A thesis rewritten after the fact, to look right." });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(edited.out.ok).toBe(false);
    expect(edited.out.alreadyRecorded).toBeUndefined();
    expect(edited.out.problems.join(" ")).toMatch(new RegExp(`${forged.file.id} .*conviction, thesis`));
    expect(journal().filter((d) => d.symbol === "FORGED.PA")).toHaveLength(1);
    // The recorded id under another time is not that decision: a new one, dated now.
    const moved = await decide(dir, { ...forged.file, decidedAt: "2026-01-02T00:00:00.000Z" });
    expect(moved.file.id).not.toBe(forged.file.id);
    expect(Date.parse(moved.file.decidedAt)).toBeGreaterThanOrEqual(before);
    expect(journal().filter((d) => d.symbol === "FORGED.PA")).toHaveLength(2);
  });
});

describe("delta", () => {
  it("reports flips, moves past the threshold, new and gone states", () => {
    const a = run({ p: 100, small: 100, trend: "downtrend", old: "x" });
    const b = run({ p: 112, small: 101, trend: "mixed", fresh: "y" });
    const d = deltaRuns(a, b, 5);
    expect(d.rows.map((r) => [r.kind, r.key])).toEqual([
      ["flipped", "trend"],
      ["moved", "p"],
      ["new", "fresh"],
      ["gone", "old"],
    ]);
    expect(d.rows[1]!.changePct).toBe(12);
    expect(deltaMarkdown(d, a, b)).toMatch(/\| flipped \| trend \| downtrend \| mixed \|/);
  });
});

describe("html report", () => {
  it("renders markdown safely and links citations to the evidence table", () => {
    const html = markdownToHtml(
      "# T\n\nPrice **383** [E1] <script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | [E2] |\n\n- one\n- [link](https://x.org)\n- [bad](javascript:alert(1))",
    );
    expect(html).toContain('<a class="cite" href="#E1">[E1]</a>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('<a href="https://x.org"');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("<table>");
    const dir = run({ "MC.PA.close": 383, "MC.PA.trend": "downtrend" });
    writeFileSync(
      join(dir, "bars.json"),
      JSON.stringify([
        { date: "2026-10-22", close: 380 },
        { date: "2026-10-23", close: 383 },
      ]),
    );
    const page = renderReport(dir, "# LVMH\n\nClose 383 EUR [E1].");
    expect(page).toMatch(/<tr id="E1">/);
    expect(page).not.toMatch(/<tr id="E2">/);
    expect(page).toContain("<svg");
    expect(priceSvg([])).toBe("");
  });
  it("links an evidence source only to an http(s) address", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-dr-"));
    const s = EvidenceStore.open(dir, { subject: "X" });
    // A feed item's link is external text: it must not become a script the page runs on a click.
    s.add({ ...base, key: "news.1", label: "headline", value: "Results beat", source: "feed", url: "javascript:alert(document.cookie)", untrusted: true });
    s.add({ ...base, key: "news.2", label: "headline", value: "Guidance raised", source: "wire", url: "https://example.org/a?x=1&y=2" });
    s.save();
    const page = renderReport(dir, "# X\n\nResults beat [E1], guidance raised [E2].");
    expect(page).not.toMatch(/href="javascript/i);
    expect(page).toMatch(/<tr id="E1">.*?<td>feed/);
    expect(page).toContain('<a href="https://example.org/a?x=1&amp;y=2" rel="noreferrer">wire</a>');
  });
});
