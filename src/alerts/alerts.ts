// Alerts: rules written in the safe expression language over a symbol's latest
// closed bars and indicators, plus event rules (an important 8-K, a stop hit by
// an open position). A rule fires on the EDGE — once when its condition becomes
// true — and re-arms when the condition is false again, so `watch run` can be
// scheduled every few minutes (cron, launchd, an agent loop) without repeating
// itself. State lives in ULTRASTOCK_HOME/state/alerts.json.
//
// Notifications go to stdout always; to an ntfy topic or a webhook only when
// the user configured one, and webhooks only to URLs on an allowlist. A rule's
// message is the user's text; external text never becomes part of a rule.
import { upcomingEventAlerts } from "../analyze/events/run.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atr, ema, macd, rsi, sma } from "../analytics/indicators.js";
import { compileExpr, evaluateExpr, exprVariables } from "../core/expr.js";
import { withFileLockSync } from "../core/lock.js";
import { clockNow, fetchText } from "../core/net.js";
import { homeDir } from "../core/paths.js";
import { contentHash, env, writeFileAtomic } from "../engine.js";
import { buildBook, lineOpenedAt, readLedger, type Transaction } from "../portfolio/ledger.js";
import { secFilings } from "../providers/fundamentals/sec.js";
import { getHistory, resolveSymbol } from "../providers/router.js";
import type { Bar, PriceSeries } from "../providers/types.js";
import { filledAt, listTickets, type Ticket } from "../trading/tickets.js";

export type RuleKind = "expr" | "8k" | "stops" | "events";

export interface AlertRule {
  id: string;
  kind: RuleKind;
  symbol?: string;
  /** For "expr": a condition such as `close < sma200 and rsi14 < 30`. */
  expr?: string;
  message?: string;
  createdAt: string;
  /** The condition's value at the last run: a fire needs false (or unknown) → true. */
  last?: boolean;
  firedAt?: string;
  /** Event ids already notified (8-K accession numbers, stop keys, market events). */
  seen?: string[];
  /** For "events": how far ahead to look, and the least share of the book (%) an event must touch. */
  days?: number;
  minWeight?: number;
}

export interface AlertEvent {
  rule: string;
  symbol?: string;
  at: string;
  message: string;
  values?: Record<string, number>;
}

const statePath = () => join(homeDir(), "state", "alerts.json");

export function loadRules(): AlertRule[] {
  return existsSync(statePath()) ? (JSON.parse(readFileSync(statePath(), "utf8")) as AlertRule[]) : [];
}
function saveRules(rules: AlertRule[]): void {
  mkdirSync(join(homeDir(), "state"), { recursive: true });
  writeFileAtomic(statePath(), `${JSON.stringify(rules, null, 2)}\n`, 0o600);
}
/** Read, change and write the rules under a lock, so a `watch add`, `watch rm` and `watch run` never undo each other. */
function updateRules<T>(change: (rules: AlertRule[]) => { rules: AlertRule[]; result: T }): T {
  return withFileLockSync(`${statePath()}.lock`, () => {
    const { rules, result } = change(loadRules());
    saveRules(rules);
    return result;
  });
}

/** The variables an expression rule may read. */
export const ALERT_VARIABLES = [
  "close",
  "open",
  "high",
  "low",
  "volume",
  "change_pct",
  "ret5d",
  "ret20d",
  "rsi14",
  "sma20",
  "sma50",
  "sma200",
  "ema21",
  "atr14",
  "macd",
  "macd_signal",
  "macd_hist",
  "high52w",
  "low52w",
  "volume_ratio",
] as const;

/** Every variable as an aligned series over the bars. */
export function alertSeries(bars: readonly Bar[]): Record<string, Array<number | undefined>> {
  const c = bars.map((b) => b.close);
  const m = macd(c);
  const vol20 = sma(
    bars.map((b) => b.volume ?? 0),
    20,
  );
  return {
    close: c,
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    volume: bars.map((b) => b.volume),
    change_pct: c.map((v, i) => (i ? (v / c[i - 1]! - 1) * 100 : undefined)),
    ret5d: c.map((v, i) => (i >= 5 ? (v / c[i - 5]! - 1) * 100 : undefined)),
    ret20d: c.map((v, i) => (i >= 20 ? (v / c[i - 20]! - 1) * 100 : undefined)),
    rsi14: rsi(c, 14),
    sma20: sma(c, 20),
    sma50: sma(c, 50),
    sma200: sma(c, 200),
    ema21: ema(c, 21),
    atr14: atr(bars, 14),
    macd: m.map((x) => x?.macd),
    macd_signal: m.map((x) => x?.signal),
    macd_hist: m.map((x) => x?.histogram),
    high52w: bars.map((_, i) => (i >= 251 ? Math.max(...bars.slice(i - 251, i + 1).map((b) => b.high)) : undefined)),
    low52w: bars.map((_, i) => (i >= 251 ? Math.min(...bars.slice(i - 251, i + 1).map((b) => b.low)) : undefined)),
    volume_ratio: bars.map((b, i) => (vol20[i] ? (b.volume ?? 0) / vol20[i]! : undefined)),
  };
}

export function addRule(
  input: { kind: RuleKind; symbol?: string; expr?: string; message?: string; days?: number; minWeight?: number },
  now = new Date(),
): AlertRule {
  if (input.kind === "expr") {
    if (!input.symbol || !input.expr) throw new Error("an expression alert needs a symbol and a condition");
    const unknown = exprVariables(compileExpr(input.expr)).filter((v) => !(ALERT_VARIABLES as readonly string[]).includes(v));
    if (unknown.length) throw new Error(`unknown variable(s) ${unknown.join(", ")} — available: ${ALERT_VARIABLES.join(", ")}`);
  }
  if (input.kind === "8k" && !input.symbol) throw new Error("an 8-K alert needs a US symbol");
  const rule: AlertRule = {
    id: `a-${contentHash(`${input.kind}|${input.symbol ?? ""}|${input.expr ?? ""}|${now.toISOString()}`).slice(0, 10)}`,
    ...input,
    symbol: input.symbol?.toUpperCase(),
    createdAt: now.toISOString(),
  };
  return updateRules((rules) => ({ rules: [...rules, rule], result: rule }));
}

export function removeRule(id: string): boolean {
  return updateRules((rules) => {
    const kept = rules.filter((r) => r.id !== id);
    return { rules: kept, result: kept.length !== rules.length };
  });
}

/** Evaluate one expression rule on bars; pure. Returns the new state and the event when it fires. */
export function evaluateRule(
  rule: AlertRule,
  bars: readonly Bar[],
  at: string,
): { rule: AlertRule; event?: AlertEvent; value?: boolean; values?: Record<string, number> } {
  const s = alertSeries(bars);
  const i = bars.length - 1;
  const v = evaluateExpr(compileExpr(rule.expr!), { get: (name, off) => s[name]?.[i + off] });
  const now = v === undefined ? undefined : typeof v === "boolean" ? v : v !== 0;
  if (now === undefined) return { rule, value: undefined };
  const fire = now && rule.last !== true;
  const values = Object.fromEntries(
    exprVariables(compileExpr(rule.expr!))
      .map((n) => [n, s[n]?.[i]])
      .filter(([, x]) => typeof x === "number"),
  ) as Record<string, number>;
  const next = { ...rule, last: now, firedAt: fire ? at : rule.firedAt };
  return {
    rule: next,
    value: now,
    values,
    event: fire
      ? { rule: rule.id, symbol: rule.symbol, at, message: rule.message ?? `${rule.symbol}: ${rule.expr} is now true (bar ${bars[i]!.date})`, values }
      : undefined,
  };
}

export interface PeekedAlert {
  rule: string;
  symbol: string;
  expr: string;
  message?: string;
  /** The bar the condition was read on. */
  bar: string;
  values: Record<string, number>;
  provenance: PriceSeries["provenance"];
}

/**
 * The expression rules whose condition is true on the latest bar, for the
 * symbols given (every rule when omitted). Read-only: the rules' edge state is
 * not saved, so a brief that peeks never eats an alert `watch run` would fire.
 */
export async function peekAlerts(now = clockNow(), symbols?: readonly string[]): Promise<{ hits: PeekedAlert[]; errors: string[] }> {
  const want = symbols ? new Set(symbols.map((s) => s.toUpperCase())) : undefined;
  const rules = loadRules().filter((r) => r.kind === "expr" && r.symbol && r.expr && (!want || want.has(r.symbol)));
  const hits: PeekedAlert[] = [];
  const errors: string[] = [];
  const series = new Map<string, PriceSeries>();
  for (const rule of rules) {
    try {
      if (!series.has(rule.symbol!))
        series.set(rule.symbol!, await getHistory(await resolveSymbol(rule.symbol!), { from: new Date(now.getTime() - 420 * 86_400_000), to: now }));
      const s = series.get(rule.symbol!)!;
      const r = evaluateRule(rule, s.bars, now.toISOString());
      if (r.value === true)
        hits.push({
          rule: rule.id,
          symbol: rule.symbol!,
          expr: rule.expr!,
          message: rule.message,
          bar: s.bars[s.bars.length - 1]!.date.slice(0, 10),
          values: r.values ?? {},
          provenance: s.provenance,
        });
    } catch (e) {
      errors.push(`${rule.id} (${rule.symbol}): ${(e as Error).message}`);
    }
  }
  return { hits, errors };
}

/**
 * Was the ticket filled since the line was last opened on `since`? A time
 * compares as written. A date-only opening on a day the line was also sold
 * out holds no hour: a fill that day may be the line sold, so only a later
 * day counts — or the ticket's own row, booked after that day's last exit.
 * The morning brief reads a line's stop by this same rule.
 */
export function filledSinceOpened(t: Ticket, since: string, lineRows: readonly Transaction[]): boolean {
  const at = filledAt(t);
  if (since.length > 10) return at >= since;
  const day = lineRows.filter((r) => r.date.slice(0, 10) === since);
  let lastExit = -1;
  day.forEach((r, i) => {
    if (r.type === "sell" || r.type === "transfer-out") lastExit = i;
  });
  if (lastExit < 0) return at >= since;
  return at.slice(0, 10) > since || day.slice(lastExit + 1).some((r) => r.origin === `ticket:${t.id}`);
}

/**
 * Does a ticket carry its stop onto the line? A buy with a stop that bought something: filled, or filled in part and
 * then cancelled, expired or still working — the shares it bought are held under that stop all the same.
 */
export const carriesStop = (t: Ticket): boolean =>
  t.order.side === "buy" && t.order.stop !== undefined && (t.status === "filled" || t.fills.some((f) => f.quantity > 0));

/**
 * Did this bar trade after the fill? A daily bar dated the fill's day holds the hours before the fill too — its low
 * may be the very dip the stop was set under — so only a later day counts; a bar with a time counts when it opens
 * after the fill.
 */
function tradedAfter(b: Bar, fill: string): boolean {
  if (b.date.length > 10) {
    const [at, filled] = [Date.parse(b.date), Date.parse(fill)];
    if (Number.isFinite(at) && Number.isFinite(filled)) return at > filled;
  }
  return b.date.slice(0, 10) > fill.slice(0, 10);
}

/** Run every rule once; fires only on edges and unseen events. */
export async function runAlerts(now = clockNow()): Promise<{ events: AlertEvent[]; errors: string[] }> {
  const read = loadRules();
  const rules = [...read];
  const events: AlertEvent[] = [];
  const errors: string[] = [];
  const at = now.toISOString();
  const barsCache = new Map<string, Bar[]>();
  const barsOf = async (sym: string) => {
    if (!barsCache.has(sym))
      barsCache.set(sym, (await getHistory(await resolveSymbol(sym), { from: new Date(now.getTime() - 420 * 86_400_000), to: now })).bars);
    return barsCache.get(sym)!;
  };
  for (let k = 0; k < rules.length; k++) {
    const rule = rules[k]!;
    try {
      if (rule.kind === "expr") {
        const r = evaluateRule(rule, await barsOf(rule.symbol!), at);
        rules[k] = r.rule;
        if (r.event) events.push(r.event);
      } else if (rule.kind === "8k") {
        const ds = await secFilings(rule.symbol!, { forms: ["8-K"], days: 7, limit: 10 });
        const seen = new Set(rule.seen ?? []);
        for (const p of ds.points) {
          if (!/\[important\]/.test(p.label) || seen.has(p.key)) continue;
          seen.add(p.key);
          events.push({ rule: rule.id, symbol: rule.symbol, at, message: `${rule.symbol}: ${p.label}` });
        }
        rules[k] = { ...rule, seen: [...seen].slice(-200) };
      } else if (rule.kind === "events") {
        // Elections and rate decisions ahead that touch the book: once per event.
        const seen = new Set(rule.seen ?? []);
        for (const ev of await upcomingEventAlerts({ days: rule.days, minWeight: rule.minWeight, now })) {
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
          events.push({ rule: rule.id, at, message: rule.message ? `${rule.message} — ${ev.message}` : ev.message });
        }
        rules[k] = { ...rule, seen: [...seen].slice(-200) };
      } else if (rule.kind === "stops") {
        // Every open position with a stop from its entry ticket, real and paper books. A ticket protects only the line its
        // fill was booked to (a row of this book's line says `ticket:<id>`), and only the position held now — filled since
        // the line was last opened; of those, the one filled last gives the stop, whatever order they were created in.
        // Only the bars that traded after that fill can hit it: a low from before the stop existed is no stop hit.
        const seen = new Set(rule.seen ?? []);
        const stops = listTickets(carriesStop);
        for (const bookName of ["real", "paper"]) {
          const book = buildBook(readLedger(bookName));
          const opened = lineOpenedAt(book.transactions);
          for (const p of book.positions.filter((x) => x.quantity > 0)) {
            // One line's history that cannot be read (a delisted name) is its own error: the other lines are still checked.
            try {
              const since = opened.get(`${p.account}|${p.symbol}`) ?? "";
              const rows = book.transactions.filter((r) => r.account === p.account && r.symbol === p.symbol);
              const booked = new Set(rows.map((r) => r.origin));
              const t = stops
                .filter((x) => booked.has(`ticket:${x.id}`) && filledSinceOpened(x, since, rows))
                .reduce<Ticket | undefined>((best, x) => (!best || filledAt(x) > filledAt(best) ? x : best), undefined);
              if (!t) continue;
              // Once per protecting ticket and line opening: a line sold out and reopened through a new ticket at the same
              // level is a new position under a new stop, and is alerted on again.
              const key = `${bookName}|${p.account}|${p.symbol}|${t.id}|${since}`;
              if (seen.has(key)) continue;
              const fill = filledAt(t);
              const hit = (await barsOf(p.symbol)).find((b) => tradedAfter(b, fill) && b.low <= t.order.stop!);
              if (!hit) continue;
              seen.add(key);
              events.push({
                rule: rule.id,
                symbol: p.symbol,
                at,
                message: `${p.symbol} (${bookName}, ${p.account}) traded at or below its stop ${t.order.stop} on ${hit.date} (low ${hit.low}) — act on the plan`,
                values: { low: hit.low, stop: t.order.stop! },
              });
            } catch (e) {
              errors.push(`${rule.id} (stops, ${p.symbol} in ${bookName} ${p.account}): ${(e as Error).message}`);
            }
          }
        }
        rules[k] = { ...rule, seen: [...seen].slice(-200) };
      }
    } catch (e) {
      errors.push(`${rule.id} (${rule.symbol ?? rule.kind}): ${(e as Error).message}`);
    }
  }
  // The run spans network calls: a rule added or removed meanwhile is in the file, not in `rules`.
  // Only the rules the run changed are written over, and only if they still exist.
  const changed = new Map(rules.filter((r, k) => r !== read[k]).map((r) => [r.id, r]));
  updateRules((current) => ({ rules: current.map((r) => changed.get(r.id) ?? r), result: undefined }));
  return { events, errors };
}

/**
 * Is the webhook under an allowlist entry? Same origin, and the entry's path a
 * whole-segment prefix of the hook's. A plain string prefix would let
 * "https://hooks.example.com" admit "https://hooks.example.com.evil.net/".
 */
export function webhookAllowed(hook: string, entry: string): boolean {
  let h: URL;
  let a: URL;
  try {
    h = new URL(hook);
    a = new URL(entry);
  } catch {
    return false;
  }
  if (h.origin !== a.origin || h.username || h.password) return false;
  const base = a.pathname.endsWith("/") ? a.pathname : `${a.pathname}/`;
  return h.pathname === a.pathname || h.pathname.startsWith(base);
}

/** Configured notification channels: an ntfy topic URL (with a token for a private topic) and allowlisted webhooks. */
export function channels(): { ntfy?: { url: string; token?: string }; webhooks: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const ntfyUrl = env("NTFY_URL");
  const token = env("NTFY_TOKEN");
  if (ntfyUrl && !token)
    warnings.push(
      "ULTRASTOCK_NTFY_URL is set without ULTRASTOCK_NTFY_TOKEN: a public ntfy topic can be read by anyone who guesses it — your positions would leak",
    );
  const allow = (env("WEBHOOK_ALLOWLIST") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const hooks = (env("WEBHOOK_URLS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const webhooks = hooks.filter((h) => {
    const ok = /^https:\/\//.test(h) && allow.some((a) => webhookAllowed(h, a));
    if (!ok) warnings.push(`webhook ${h} is not https or not on ULTRASTOCK_WEBHOOK_ALLOWLIST: not used`);
    return ok;
  });
  return { ntfy: ntfyUrl && token ? { url: ntfyUrl, token } : undefined, webhooks, warnings };
}

/** Send events to the configured channels. Never throws: a failed delivery is reported. */
export async function notify(events: readonly AlertEvent[]): Promise<string[]> {
  if (!events.length) return [];
  const ch = channels();
  const report = [...ch.warnings];
  const text = events.map((e) => e.message).join("\n");
  if (ch.ntfy) {
    const r = await fetchText(ch.ntfy.url, {
      method: "POST",
      json: { message: text },
      headers: { authorization: `Bearer ${ch.ntfy.token}` },
      retries: 0,
      timeoutMs: 10_000,
    });
    report.push(r.ok ? "sent to ntfy" : `ntfy failed (${r.status})`);
  }
  for (const h of ch.webhooks) {
    const r = await fetchText(h, { method: "POST", json: { source: "ultrastock", events }, retries: 0, timeoutMs: 10_000 });
    report.push(r.ok ? `sent to ${new URL(h).host}` : `webhook ${new URL(h).host} failed (${r.status})`);
  }
  return report;
}
