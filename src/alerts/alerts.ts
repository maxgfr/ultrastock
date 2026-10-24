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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atr, ema, macd, rsi, sma } from "../analytics/indicators.js";
import { compileExpr, evaluateExpr, exprVariables } from "../core/expr.js";
import { clockNow, fetchText } from "../core/net.js";
import { homeDir } from "../core/paths.js";
import { contentHash, env, writeFileAtomic } from "../engine.js";
import { buildBook, readLedger } from "../portfolio/ledger.js";
import { secFilings } from "../providers/fundamentals/sec.js";
import { getHistory, resolveSymbol } from "../providers/router.js";
import type { Bar } from "../providers/types.js";
import { listTickets } from "../trading/tickets.js";

export type RuleKind = "expr" | "8k" | "stops";

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
  /** Event ids already notified (8-K accession numbers, stop keys). */
  seen?: string[];
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

export function addRule(input: { kind: RuleKind; symbol?: string; expr?: string; message?: string }, now = new Date()): AlertRule {
  if (input.kind === "expr") {
    if (!input.symbol || !input.expr) throw new Error("an expression alert needs a symbol and a condition");
    const unknown = exprVariables(compileExpr(input.expr)).filter((v) => !(ALERT_VARIABLES as readonly string[]).includes(v));
    if (unknown.length) throw new Error(`unknown variable(s) ${unknown.join(", ")} — available: ${ALERT_VARIABLES.join(", ")}`);
  }
  if (input.kind === "8k" && !input.symbol) throw new Error("an 8-K alert needs a US symbol");
  const rules = loadRules();
  const rule: AlertRule = {
    id: `a-${contentHash(`${input.kind}|${input.symbol ?? ""}|${input.expr ?? ""}|${now.toISOString()}`).slice(0, 10)}`,
    ...input,
    symbol: input.symbol?.toUpperCase(),
    createdAt: now.toISOString(),
  };
  rules.push(rule);
  saveRules(rules);
  return rule;
}

export function removeRule(id: string): boolean {
  const rules = loadRules();
  const kept = rules.filter((r) => r.id !== id);
  saveRules(kept);
  return kept.length !== rules.length;
}

/** Evaluate one expression rule on bars; pure. Returns the new state and the event when it fires. */
export function evaluateRule(rule: AlertRule, bars: readonly Bar[], at: string): { rule: AlertRule; event?: AlertEvent; value?: boolean } {
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
    event: fire
      ? { rule: rule.id, symbol: rule.symbol, at, message: rule.message ?? `${rule.symbol}: ${rule.expr} is now true (bar ${bars[i]!.date})`, values }
      : undefined,
  };
}

/** Run every rule once; fires only on edges and unseen events. */
export async function runAlerts(now = clockNow()): Promise<{ events: AlertEvent[]; errors: string[] }> {
  const rules = loadRules();
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
      } else if (rule.kind === "stops") {
        // Every open position with a stop from its entry ticket, real and paper books.
        const seen = new Set(rule.seen ?? []);
        const stops = new Map(
          listTickets((t) => t.status === "filled" && t.order.side === "buy" && t.order.stop !== undefined).map((t) => [
            `${t.order.account}|${t.order.symbol}`,
            t,
          ]),
        );
        for (const bookName of ["real", "paper"]) {
          for (const p of buildBook(readLedger(bookName)).positions.filter((x) => x.quantity > 0)) {
            const t = stops.get(`${p.account}|${p.symbol}`);
            if (!t) continue;
            const bars = await barsOf(p.symbol);
            const last = bars[bars.length - 1]!;
            const key = `${bookName}|${p.account}|${p.symbol}|${t.order.stop}`;
            if (last.low <= t.order.stop! && !seen.has(key)) {
              seen.add(key);
              events.push({
                rule: rule.id,
                symbol: p.symbol,
                at,
                message: `${p.symbol} (${bookName}, ${p.account}) traded at or below its stop ${t.order.stop} on ${last.date} (low ${last.low}) — act on the plan`,
                values: { low: last.low, stop: t.order.stop! },
              });
            }
          }
        }
        rules[k] = { ...rule, seen: [...seen].slice(-200) };
      }
    } catch (e) {
      errors.push(`${rule.id} (${rule.symbol ?? rule.kind}): ${(e as Error).message}`);
    }
  }
  saveRules(rules);
  return { events, errors };
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
    const ok = /^https:\/\//.test(h) && allow.some((a) => h.startsWith(a));
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
