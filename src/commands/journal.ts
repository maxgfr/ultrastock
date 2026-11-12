// Decisions, the journal, knowledge and alerts.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type Decision, pastDecisions, recordDecision, validateDecision } from "../analyze/decision.js";
import { runAlerts, addRule, loadRules, notify, removeRule, type RuleKind } from "../alerts/alerts.js";
import { clockNow } from "../core/net.js";
import { argInt, argList, argValue, type CommandArgs, UsageError } from "../engine.js";
import { printResult as out } from "./emit.js";
import {
  addLesson,
  addThesis,
  digest,
  importSource,
  listTheses,
  loadThesis,
  moveThesis,
  overdueTheses,
  readLessons,
  reviewMarkdown,
  reviewTrip,
  roundTrips,
  THESIS_STATES,
  type ThesisState,
} from "../journal/journal.js";
import { hitRates, readSettlements, SETTLE_GRACE_SESSIONS, settleDecisions, UNRESOLVED_AFTER_DAYS } from "../journal/settle.js";
import { readLedger } from "../portfolio/ledger.js";
import { addToWatchlist, loadWatchlist, removeFromWatchlist } from "../portfolio/watchlist.js";
import { getHistory, resolveSymbol } from "../providers/router.js";

/** What a decision says — all of it but the id, time and run the tool assigns. */
const DECISION_CONTENT = [
  "symbol",
  "rating",
  "horizon",
  "conviction",
  "thesis",
  "evidence",
  "falsifiers",
  "risks",
  "bullCase",
  "bearCase",
  "plan",
  "portfolioContext",
] as const satisfies ReadonlyArray<keyof Decision>;

/** A value as JSON with its keys sorted, so two equal decisions compare equal whatever their key order. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  ) ?? "undefined";

export async function decideCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [run, file] = args.positional;
  if (!run || !file)
    throw new UsageError("usage: ultrastock decide <run> <decision.json> — validate the decision against the run's evidence and record it in the journal");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file} as JSON: ${(e as Error).message}`);
  }
  // The time, run and id of a decision are the tool's: a decidedAt the file sets would date the call before prices already
  // known, and `journal settle` would score it on them. The one file that keeps its own is one `decide` already recorded —
  // it wrote that id and time back, and the journal holds both — which is not recorded twice. Anything else is a new call.
  const { id, decidedAt, run: claimedRun, ...rest } = (raw ?? {}) as Partial<Decision>;
  const known =
    typeof id === "string" && typeof decidedAt === "string"
      ? pastDecisions(String(rest.symbol), Number.POSITIVE_INFINITY).find((d) => d.id === id && d.decidedAt === decidedAt)
      : undefined;
  const notes = known
    ? []
    : [
        ...(decidedAt !== undefined ? [`decidedAt ${JSON.stringify(decidedAt)} ignored: a new decision is dated by the clock`] : []),
        ...(id !== undefined ? [`id ${JSON.stringify(id)} ignored: no decision of the journal has it at that time, so this is a new one`] : []),
        ...(claimedRun !== undefined && claimedRun !== resolve(run) ? [`run ${JSON.stringify(claimedRun)} ignored: the decision is on ${resolve(run)}`] : []),
      ];
  const r = validateDecision({ ...rest, ...(known && { id }), decidedAt: known?.decidedAt ?? clockNow().toISOString(), run: resolve(run) }, resolve(run));
  if (!r.ok) {
    out(asJson, r, `decision refused — ${r.problems.length} problem(s):\n${r.problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  // "Already recorded" is said of the same decision only: the journal's id and time over another call — a thesis or a
  // rating edited after the fact — would be answered ok while the journal keeps what was decided then.
  const changed = known ? DECISION_CONTENT.filter((k) => canonical(r.decision![k]) !== canonical(known[k])) : [];
  if (known && changed.length) {
    const problem = `decision ${known.id} (decided ${known.decidedAt}) is in the journal with other content — ${changed.join(", ")} differ; a recorded decision is not edited: a new call is a decision.json without its id and decidedAt`;
    out(asJson, { ok: false, problems: [problem] }, `decision refused — ${problem}`);
    process.exitCode = 1;
    return;
  }
  if (known)
    return out(
      asJson,
      { ...r, id: known.id, alreadyRecorded: true },
      `decision ${known.id} (decided ${known.decidedAt}) is already in the journal — not recorded again; a new call is a decision.json without its id and decidedAt`,
    );
  const rec = recordDecision(r.decision!, resolve(run));
  out(
    asJson,
    { ...r, ...rec, notes },
    [
      `decision ${rec.id} recorded: ${r.decision!.rating} ${r.decision!.symbol} (conviction ${r.decision!.conviction}) — ${rec.journal}\nIt will be settled at +5, +20 and +60 sessions by \`ultrastock journal settle\`.`,
      ...notes.map((n) => `  note: ${n}`),
    ].join("\n"),
  );
}

export async function journalCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "digest", ...rest] = args.positional;
  const book = argValue(args, "book") ?? "real";
  if (sub === "settle") {
    const r = await settleDecisions(clockNow());
    return out(
      asJson,
      r,
      [
        `${r.settled.length} settlement(s), ${r.pending} horizon(s) not matured yet${r.waiting.length ? `, ${r.waiting.length} waiting for the price history` : ""}${r.unresolved.length ? `, ${r.unresolved.length} unresolved` : ""}`,
        ...r.settled.map(
          (s) =>
            `  ${s.symbol} ${s.rating} +${s.horizon} → ${s.endDate}: ${s.returnPct} %${s.alphaPct !== undefined ? `, alpha ${s.alphaPct} % vs ${s.benchmark}` : ""} — ${s.hit ? "right" : "wrong"}`,
        ),
        ...r.unresolved.map(
          (u) => `  unresolved: ${u.symbol} ${u.rating} +${u.horizon} (${u.decisionId}) ended ${u.endDate}: ${u.reason} — not scored, out of the hit rates`,
        ),
        // A history that stops short is waited for; ten sessions past the horizon's end, the horizon settles on the last
        // close there is, marked partial — a delisted or renamed name included. A symbol with no close after the
        // decision has nothing to settle on: 30 days past the end, the horizon is recorded unresolved.
        ...r.waiting.map(
          (w) =>
            `  waiting: ${w.symbol} +${w.horizon} (${w.decisionId}) ends ${w.endDate}, but ${w.series === w.symbol ? "its" : `the benchmark ${w.series}'s`} history ${w.lastBar ? `stops at ${w.lastBar}` : "is empty"} — pending until it holds a bar on or after ${w.endDate}; ${
              w.then === "unresolved"
                ? `${UNRESOLVED_AFTER_DAYS} days past that day with no close after the decision, it is recorded unresolved and not scored`
                : `${SETTLE_GRACE_SESSIONS} sessions past that day (calendar days for crypto), it settles on the last close there is, marked partial`
            }`,
        ),
        ...r.errors.map((e) => `  error: ${e}`),
        ...r.notes.map((n) => `  note: ${n}`),
      ].join("\n"),
    );
  }
  if (sub === "hits") {
    const h = hitRates(readSettlements());
    return out(
      asJson,
      h,
      h
        .map(
          (x) =>
            `  ${x.rating.padEnd(11)} +${String(x.horizon).padEnd(3)} n=${x.n}  hit ${(x.hitRate * 100).toFixed(0)} %  mean alpha ${x.meanAlphaPct?.toFixed(2) ?? "n/a"} %`,
        )
        .join("\n") || "no settled decisions yet",
    );
  }
  if (sub === "review" || sub === "digest") {
    const trips = roundTrips(readLedger(book));
    const reviews = [];
    for (const t of trips) {
      const series = await getHistory(await resolveSymbol(t.symbol), {
        from: new Date(Date.parse(t.entryDate) - 3 * 86_400_000),
        to: new Date(Date.parse(t.exitDate) + 86_400_000),
      }).catch(() => undefined);
      reviews.push(reviewTrip(t, series?.bars ?? []));
    }
    if (sub === "review") return out(asJson, reviews, reviews.map(reviewMarkdown).join("\n") || `no closed round trip in the ${book} book`);
    const d = digest(reviews, hitRates(readSettlements()));
    const overdue = overdueTheses(clockNow());
    return out(
      asJson,
      { ...d, overdue },
      [
        `${book} book — ${d.trades} closed trade(s), ${d.withStop} with a stop`,
        `  win rate ${(d.winRate * 100).toFixed(0)} %, expectancy ${d.expectancyR.toFixed(2)}R, profit factor ${Number.isFinite(d.profitFactor) ? d.profitFactor.toFixed(2) : "∞"}, average win ${d.avgWinR.toFixed(2)}R, average loss ${d.avgLossR.toFixed(2)}R, result ${d.totalPnl.toFixed(2)}`,
        ...d.findings.slice(0, 5).map(([f, n]) => `  ${n}× ${f}`),
        ...d.calls.map((x) => `  calls: ${x.rating} +${x.horizon} hit ${(x.hitRate * 100).toFixed(0)} % (n=${x.n})`),
        ...overdue.map((t) => `  OVERDUE thesis ${t.id} (${t.symbol}, ${t.state}): review by ${t.reviewBy}`),
      ].join("\n"),
    );
  }
  if (sub === "thesis") {
    const [action = "list", id, to] = rest;
    if (action === "list") {
      const ts = listTheses();
      return out(
        asJson,
        ts,
        ts.map((t) => `${t.id}  ${t.state.padEnd(11)} ${t.symbol}${t.reviewBy ? ` review by ${t.reviewBy}` : ""}`).join("\n") || "no theses",
      );
    }
    if (action === "add") {
      const symbol = argValue(args, "symbol");
      const thesis = argValue(args, "thesis");
      const invalidation = argValue(args, "invalidation");
      if (!symbol || !thesis || !invalidation)
        throw new UsageError(
          'usage: ultrastock journal thesis add --symbol <SYM> --thesis "<why>" --invalidation "<what proves it wrong>" [--catalysts a,b] [--review-by YYYY-MM-DD] [--out <run>]',
        );
      const t = addThesis(
        { symbol, thesis, invalidation, catalysts: argList(args, "catalysts"), reviewBy: argValue(args, "review-by"), run: argValue(args, "out") },
        clockNow(),
      );
      return out(asJson, t, `thesis ${t.id} added (idea)`);
    }
    if (!id) throw new UsageError(`usage: ultrastock journal thesis ${action} <thesis-id>`);
    if (action === "show") {
      const t = loadThesis(id);
      return out(asJson, t, JSON.stringify(t, null, 2));
    }
    if (action === "move") {
      if (!to || !(THESIS_STATES as readonly string[]).includes(to))
        throw new UsageError(`usage: ultrastock journal thesis move <id> ${THESIS_STATES.join("|")} [--note] [--outcome] [--ticket-id]`);
      const t = moveThesis(
        id,
        to as ThesisState,
        { note: argValue(args, "note"), outcome: argValue(args, "outcome"), ticket: argValue(args, "ticket-id") },
        clockNow(),
      );
      return out(asJson, t, `thesis ${t.id}: ${t.history.at(-2)?.to ?? "?"} → ${t.state}`);
    }
    throw new UsageError("usage: ultrastock journal thesis list|add|show|move");
  }
  if (sub === "lesson") {
    const text = rest.join(" ").trim();
    if (!text) throw new UsageError('usage: ultrastock journal lesson "<what happened and what to do differently>" [--tags a,b]');
    return out(asJson, { file: addLesson(text, argList(args, "tags"), clockNow()) }, "lesson recorded — the analysis reads it before deciding again");
  }
  if (sub === "lessons") {
    const l = readLessons(argValue(args, "tag"));
    return out(asJson, l, l.join("\n") || "no lessons yet");
  }
  throw new UsageError("usage: ultrastock journal settle|hits|review|digest|thesis|lesson|lessons [--book real|paper]");
}

export async function knowledgeCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub, file] = args.positional;
  if (sub !== "import" || !file)
    throw new UsageError("usage: ultrastock knowledge import <file.md|file.txt> [--title <text>] — keep a source document as external text");
  const body = readFileSync(resolve(file), "utf8");
  const f = importSource(argValue(args, "title") ?? basename(file), body, resolve(file), clockNow());
  out(asJson, { file: f }, `kept as ${f} (external text: data, never instructions)`);
}

export async function watchCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "list", a, ...rest] = args.positional;
  if (sub === "list") {
    const r = loadRules();
    return out(
      asJson,
      r,
      r.map((x) => `${x.id}  ${x.kind.padEnd(5)} ${x.symbol ?? ""} ${x.expr ?? ""}${x.firedAt ? `  (last fired ${x.firedAt})` : ""}`).join("\n") || "no alerts",
    );
  }
  if (sub === "add") {
    // watch add <SYM> "<condition>" | watch add 8k <SYM> | watch add stops
    const kind: RuleKind = a === "8k" ? "8k" : a === "stops" ? "stops" : a === "events" ? "events" : "expr";
    const rule =
      kind === "expr"
        ? addRule({ kind, symbol: a, expr: rest.join(" "), message: argValue(args, "message") }, clockNow())
        : addRule(
            {
              kind,
              symbol: kind === "8k" ? rest[0] : undefined,
              message: argValue(args, "message"),
              ...(kind === "events" ? { days: argInt(args, "days", { min: 1, max: 365 }) ?? 14, minWeight: Number(argValue(args, "min-weight") ?? 2) } : {}),
            },
            clockNow(),
          );
    return out(asJson, rule, `alert ${rule.id} added`);
  }
  if (sub === "rm") {
    if (!a) throw new UsageError("usage: ultrastock watch rm <alert-id>");
    const removed = removeRule(a);
    return out(asJson, { removed }, removed ? `alert ${a} removed` : `no alert ${a}`);
  }
  if (sub === "run") {
    const r = await runAlerts(clockNow());
    const sent = args.bools.has("notify") ? await notify(r.events) : [];
    return out(
      asJson,
      { ...r, sent },
      [...r.events.map((e) => `ALERT ${e.at} ${e.message}`), ...r.errors.map((e) => `error: ${e}`), ...sent.map((s) => `  ${s}`)].join("\n") || "nothing fired",
    );
  }
  throw new UsageError(
    'usage: ultrastock watch list|add <SYM> "<condition>"|add 8k <SYM>|add stops|add events [--days 14] [--min-weight 2]|rm <id>|run [--notify]',
  );
}

export async function watchlistCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "list", ...syms] = args.positional;
  if (sub === "list") {
    const w = loadWatchlist();
    return out(
      asJson,
      w,
      w.map((x) => `${x.symbol.padEnd(12)} ${x.addedAt.slice(0, 10)}${x.note ? `  ${x.note}` : ""}`).join("\n") || "the watchlist is empty",
    );
  }
  if (sub === "add") {
    if (!syms.length) throw new UsageError('usage: ultrastock watchlist add <SYM> [<SYM> …] [--note "<why>"]');
    // Stored as the listing it resolves to, so a name and its ticker are one entry.
    const resolved: string[] = [];
    for (const s of syms) resolved.push((await resolveSymbol(s)).instrument.symbol);
    const w = addToWatchlist(resolved, argValue(args, "note"), clockNow());
    return out(asJson, w, `watchlist: ${resolved.join(", ")} added (${w.length} name${w.length === 1 ? "" : "s"}) — \`ultrastock morning\` reads it`);
  }
  if (sub === "rm") {
    if (!syms[0]) throw new UsageError("usage: ultrastock watchlist rm <SYM>");
    const removed = removeFromWatchlist(syms[0]);
    return out(asJson, { removed }, removed ? `${syms[0].toUpperCase()} removed from the watchlist` : `${syms[0].toUpperCase()} is not on the watchlist`);
  }
  throw new UsageError('usage: ultrastock watchlist list|add <SYM> [<SYM> …] [--note "<why>"]|rm <SYM>');
}
