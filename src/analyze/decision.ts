// The typed decision a multi-perspective analysis ends on — the portfolio
// manager's verdict — validated before it is recorded. It is a structured
// claim: a rating on a five-level scale, a horizon, the thesis, the [E#]
// evidence it rests on, what would prove it wrong, and (optionally) a trade
// plan. `decide` refuses a decision that cites evidence the run does not hold,
// has no falsifier, or plans a trade without a stop.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceStore } from "../core/evidence.js";
import { homeDir } from "../core/paths.js";
import { writeFileAtomic } from "../engine.js";

export const RATINGS = ["buy", "overweight", "hold", "underweight", "sell"] as const;
export type Rating = (typeof RATINGS)[number];
export const HORIZONS = ["days", "weeks", "months", "years"] as const;
export const DECISION_SCHEMA = 1;

export interface TradePlan {
  side: "buy" | "sell";
  entry: number;
  stop: number;
  targets: number[];
  /** Size as % of the portfolio. */
  sizePct: number;
  /** "limit" by default. */
  orderType?: "limit" | "market";
  validUntil?: string;
}

export interface Decision {
  schema: number;
  symbol: string;
  /** The run the decision was made on (its evidence). */
  run: string;
  decidedAt: string;
  rating: Rating;
  horizon: (typeof HORIZONS)[number];
  /** 1 (low) … 5 (high). */
  conviction: number;
  thesis: string;
  /** The evidence the thesis rests on. */
  evidence: string[];
  /** What would prove the thesis wrong — at least one, each observable. */
  falsifiers: string[];
  risks: string[];
  /** The bull and bear cases in one line each (from the debate). */
  bullCase?: string;
  bearCase?: string;
  plan?: TradePlan;
  /** "holding" / "flat" / "not-provided": the portfolio context the decision was made in. */
  portfolioContext: "holding" | "flat" | "not-provided";
}

export interface DecisionCheck {
  ok: boolean;
  problems: string[];
  decision?: Decision;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Validate a decision against its run's evidence. */
export function validateDecision(raw: unknown, runDir: string): DecisionCheck {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, problems: ["the decision is not a JSON object"] };
  const d = raw as Partial<Decision>;
  const store = EvidenceStore.load(runDir);
  if (!store) problems.push(`${runDir} holds no evidence — decide on a run made by \`analyze\``);
  if (typeof d.symbol !== "string" || !d.symbol) problems.push("symbol is missing");
  if (!RATINGS.includes(d.rating as Rating)) problems.push(`rating must be one of ${RATINGS.join(", ")}`);
  if (!HORIZONS.includes(d.horizon as (typeof HORIZONS)[number])) problems.push(`horizon must be one of ${HORIZONS.join(", ")}`);
  if (!isNum(d.conviction) || d.conviction < 1 || d.conviction > 5 || !Number.isInteger(d.conviction))
    problems.push("conviction is a whole number from 1 to 5");
  if (typeof d.thesis !== "string" || d.thesis.trim().length < 20) problems.push("thesis must say, in a sentence or more, why");
  if (!Array.isArray(d.evidence) || !d.evidence.length) problems.push("evidence lists the [E#] the thesis rests on — at least one");
  else if (store) for (const id of d.evidence) if (!store.get(String(id).replace(/[[\]]/g, ""))) problems.push(`evidence ${id} is not in the run`);
  if (!Array.isArray(d.falsifiers) || !d.falsifiers.some((f) => typeof f === "string" && f.trim().length > 5))
    problems.push("falsifiers: at least one observable event or level that would prove the thesis wrong");
  if (!Array.isArray(d.risks)) problems.push("risks is a list (it may be empty only if you can defend that)");
  if (!["holding", "flat", "not-provided"].includes(String(d.portfolioContext))) problems.push("portfolioContext is holding, flat or not-provided");
  const p = d.plan;
  if (p !== undefined) {
    if (p.side !== "buy" && p.side !== "sell") problems.push("plan.side is buy or sell");
    if (!isNum(p.entry) || p.entry <= 0) problems.push("plan.entry is a positive price");
    if (!isNum(p.stop) || p.stop <= 0) problems.push("plan.stop is required: a trade without a stop has no defined risk");
    else if (isNum(p.entry) && ((p.side === "buy" && p.stop >= p.entry) || (p.side === "sell" && p.stop <= p.entry)))
      problems.push("plan.stop is on the wrong side of the entry");
    if (!Array.isArray(p.targets) || !p.targets.every(isNum)) problems.push("plan.targets is a list of prices");
    if (!isNum(p.sizePct) || p.sizePct <= 0 || p.sizePct > 100) problems.push("plan.sizePct is the position size in % of the portfolio");
    if ((d.rating === "hold" || d.rating === "underweight" || d.rating === "sell") && p.side === "buy")
      problems.push(`a ${d.rating} rating with a buy plan contradicts itself`);
  }
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    problems: [],
    decision: { ...(d as Decision), schema: DECISION_SCHEMA, evidence: d.evidence!.map((e) => String(e).replace(/[[\]]/g, "")) },
  };
}

export function journalDir(): string {
  return join(homeDir(), "journal");
}

/**
 * Record a validated decision: `<run>/decision.json`, one line in
 * `journal/decisions.jsonl` and an entry in `journal/decisions.md`, pending
 * settlement (the journal settles it later against what the price did).
 */
export function recordDecision(d: Decision, runDir: string): { file: string; journal: string } {
  const file = join(runDir, "decision.json");
  writeFileAtomic(file, `${JSON.stringify(d, null, 2)}\n`);
  const dir = journalDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "decisions.jsonl"), `${JSON.stringify({ ...d, status: "pending" })}\n`, { mode: 0o600 });
  const md = join(dir, "decisions.md");
  const entry = [
    `## [${d.decidedAt.slice(0, 10)} | ${d.symbol} | ${d.rating} | conviction ${d.conviction} | pending]`,
    "",
    `DECISION: ${d.thesis}`,
    `EVIDENCE: ${d.evidence.map((e) => `[${e}]`).join(" ")} — run ${runDir}`,
    `FALSIFIERS: ${d.falsifiers.join("; ")}`,
    ...(d.plan ? [`PLAN: ${d.plan.side} at ${d.plan.entry}, stop ${d.plan.stop}, targets ${d.plan.targets.join(" / ")}, size ${d.plan.sizePct} %`] : []),
    "",
    "<!-- ENTRY_END -->",
    "",
  ].join("\n");
  if (!existsSync(md)) writeFileAtomic(md, "# Decision journal\n\nAppend-only. Each entry is settled later against the price (`journal settle`).\n\n");
  appendFileSync(md, entry);
  return { file, journal: md };
}

/** Previous decisions on a symbol, newest first — what the PM should read before deciding again. */
export function pastDecisions(symbol: string, limit = 5): Array<Decision & { status?: string; settlement?: unknown }> {
  const f = join(journalDir(), "decisions.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Decision & { status?: string })
    .filter((d) => d.symbol === symbol)
    .reverse()
    .slice(0, limit);
}
