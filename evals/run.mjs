#!/usr/bin/env node
// ultrastock evals, run against the BUILT bundle (scripts/ultrastock.mjs) — the
// thing users install — never against the source.
//
// Each case is one instrument with a recorded fixture (assets/fixtures/<name>/,
// the raw HTTP answers its sources gave once):
//   mc-pa     a Euronext equity, answered in French (decimal commas, €, −)
//   nvda      a US equity from an unofficial source, answered with a table
//   btcusdt   a crypto pair, 24/7, closed daily bars only
//
// offline  replays the fixture: `analyze` must produce the expected evidence,
//          the case's `calc`s must register the expected ids, the good answer
//          must pass `check` and the bad one must fail it with exactly the
//          expected number of problems. Deterministic, no network — CI runs it.
// network  runs `analyze` live and asserts the same evidence keys exist and
//          that every source still answers in the shape the parsers expect.
//          Report-only: upstreams change and throttle; never gates a PR.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = join(root, "scripts", "ultrastock.mjs");
const suite = process.argv.includes("--suite") ? process.argv[process.argv.indexOf("--suite") + 1] : "offline";
if (suite !== "offline" && suite !== "network") {
  console.error(`evals: --suite must be offline or network, not "${suite}"`);
  process.exit(2);
}

// Never read or write the user's own state while evaluating.
const scratch = mkdtempSync(join(tmpdir(), "ultrastock-evals-"));
const env = { ...process.env, ULTRASTOCK_HOME: join(scratch, "home"), ULTRASTOCK_CACHE_DIR: join(scratch, "cache") };

/** Run the bundle; returns exit status and parsed JSON stdout. */
function cli(args) {
  try {
    const out = execFileSync(process.execPath, [bundle, ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000, env });
    return { status: 0, json: JSON.parse(out) };
  } catch (e) {
    let json;
    try {
      json = JSON.parse(e.stdout ?? "");
    } catch {
      /* not JSON: a usage error */
    }
    return { status: e.status ?? 1, json, stderr: String(e.stderr ?? "") };
  }
}

const NOTES = new Set(["inert", "unsourced"]);
let failed = 0;
let passed = 0;
const ok = (cond, what) => {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`);
};

for (const name of readdirSync(join(here, "cases")).sort()) {
  const dir = join(here, "cases", name);
  const spec = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
  console.log(`${name} — ${spec.kind}`);
  const run = mkdtempSync(join(scratch, `${name}-`));
  const source = suite === "offline" ? ["--fixture", join(root, spec.fixture)] : [];
  const a = cli(["analyze", spec.symbol, "--out", run, ...source]);
  ok(a.status === 0, `analyze ${spec.symbol} (${a.status === 0 ? `${a.json.evidence} evidence, as of ${a.json.asOf}` : a.stderr.trim()})`);
  if (a.status !== 0) continue;
  ok(a.json.evidence >= spec.expect.evidenceMin, `at least ${spec.expect.evidenceMin} evidence items (got ${a.json.evidence})`);
  const ev = cli(["evidence", run]);
  const keys = new Set((ev.json?.items ?? []).map((i) => i.key));
  const missing = spec.expect.keys.filter((k) => !keys.has(k));
  ok(missing.length === 0, `evidence keys present (${missing.length ? `missing ${missing.join(", ")}` : spec.expect.keys.join(", ")})`);
  if (suite !== "offline") continue;

  for (const c of spec.calcs) {
    const r = cli(["calc", run, c.formula, "--label", c.label, ...(c.unit ? ["--unit", c.unit] : [])]);
    ok(r.status === 0 && r.json?.id === c.expectId, `calc ${c.formula} → ${c.expectId} (got ${r.json?.id ?? r.stderr.trim()})`);
  }
  const good = cli(["check", run, join(dir, "answer.good.md")]);
  const goodFails = (good.json?.problems ?? []).filter((p) => !NOTES.has(p.kind));
  ok(good.status === 0 && goodFails.length === spec.answers.good, `good answer passes check (${goodFails.map((p) => p.message).join("; ") || "clean"})`);
  const bad = cli(["check", run, join(dir, "answer.bad.md")]);
  const badFails = (bad.json?.problems ?? []).filter((p) => !NOTES.has(p.kind));
  ok(
    bad.status === 1 && badFails.length === spec.answers.bad,
    `bad answer fails check with ${spec.answers.bad} problems (got ${badFails.length}${badFails.length !== spec.answers.bad ? `: ${badFails.map((p) => p.message).join("; ")}` : ""})`,
  );
}

if (suite === "network") {
  console.log("sources — one live call per family");
  const { checks } = JSON.parse(readFileSync(join(here, "sources.json"), "utf8"));
  for (const c of checks) {
    const run = mkdtempSync(join(scratch, "src-"));
    const r = cli([...c.args, "--out", run]);
    const keys = (cli(["evidence", run]).json?.items ?? []).map((i) => i.key);
    const missing = c.keys.filter((k) => !keys.some((x) => x.startsWith(k)));
    ok(
      r.status === 0 && missing.length === 0,
      `${c.args.join(" ")} (${r.status === 0 ? (missing.length ? `missing ${missing.join(", ")}` : `${keys.length} evidence`) : r.stderr.trim().slice(0, 160)})`,
    );
  }
}

console.log(`\nevals (${suite}): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
