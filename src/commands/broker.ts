// broker — live venues, behind every guard of trading/live.ts.
//
//   status | setup <venue> | balances | preview <ticket> | code <ticket> | submit <ticket>
//   reconcile <ticket> | cancel <ticket> | open | limits [set] | panic
//
// `--env test` (the default) is Binance's testnet, Kraken validate-only,
// Coinbase preview-only and IBKR's paper account; `--env live` is real money.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkMica } from "../core/jurisdiction.js";
import { clockNow } from "../core/net.js";
import { loadProfile } from "../core/profile.js";
import { argList, argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";
import { binanceAdapter } from "../trading/brokers/binance.js";
import { coinbaseAdapter } from "../trading/brokers/coinbase.js";
import { ibkrAdapter } from "../trading/brokers/ibkr.js";
import { kalshiAdapter } from "../trading/brokers/kalshi.js";
import { krakenAdapter } from "../trading/brokers/kraken.js";
import type { BrokerAdapter, Environment, Venue } from "../trading/brokers/types.js";
import { currentLimits, effectiveLimits, limitsBinding, type LiveLimits, requestLimits } from "../trading/limits.js";
import { CRYPTO_VENUES, liveActivity, liveCancel, liveSubmit, preconditions, reconcile, VENUES, venueSymbol } from "../trading/live.js";
import { issueCode, verifyCode } from "../trading/otp.js";
import { killSwitchPath, orderFingerprint } from "../trading/riskgate.js";
import { readCredentials, setupCommands } from "../trading/secrets.js";
import { audit, listTickets, loadTicket } from "../trading/tickets.js";

const USAGE =
  "usage: ultrastock broker status|setup <venue>|balances|preview <ticket>|code <ticket>|submit <ticket>|reconcile <ticket>|cancel <ticket>|open|limits [set]|panic [--venue binance|kraken|coinbase|ibkr|kalshi] [--env test|live] [--code <6 digits>] [--conid <id>] [--json]";

const out = (asJson: boolean, value: unknown, text: string): void => {
  process.stdout.write(asJson ? jsonLine(value) : text.endsWith("\n") ? text : `${text}\n`);
};

function venueOf(args: CommandArgs, fallback?: string): Venue {
  const v = (argValue(args, "venue") ?? fallback ?? "").toLowerCase();
  if (!(VENUES as string[]).includes(v)) throw new UsageError(`--venue is one of ${VENUES.join(", ")}`);
  return v as Venue;
}
function envOf(args: CommandArgs): Environment {
  const e = argValue(args, "env") ?? "test";
  if (e !== "test" && e !== "live") throw new UsageError("--env is test (testnet, validate-only, preview-only or paper account) or live");
  return e;
}

/** The adapter for a venue and environment, with the user's stored credentials. */
export function adapterFor(venue: Venue, env: Environment): BrokerAdapter {
  const c = readCredentials(venue, env);
  if (!c) throw new Error(`no ${venue} ${env} key stored: \`ultrastock broker setup ${venue} --env ${env}\` shows how to store one`);
  if (venue === "binance") return binanceAdapter({ env, creds: c.creds });
  if (venue === "kraken") return krakenAdapter({ env, creds: c.creds });
  if (venue === "coinbase") return coinbaseAdapter({ env, creds: c.creds });
  if (venue === "kalshi") return kalshiAdapter({ env, creds: c.creds });
  const caFile = process.env.ULTRASTOCK_IBKR_CA_FILE;
  if (!caFile) throw new Error("IBKR: set ULTRASTOCK_IBKR_CA_FILE to the gateway's certificate (PEM) — the connection is pinned to it, never left unverified");
  return ibkrAdapter({
    env,
    creds: c.creds,
    baseUrl: process.env.ULTRASTOCK_IBKR_URL,
    tls: { caFile, fingerprint256: process.env.ULTRASTOCK_IBKR_CERT_SHA256 },
  });
}

function nextLimits(args: CommandArgs, cur: LiveLimits): LiveLimits {
  const num = (f: string, d: number) => {
    const v = argValue(args, f);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${f} is an amount ≥ 0`);
    return n;
  };
  const venues = (f: string, d: Venue[]) => {
    const l = argList(args, f);
    if (!l.length) return d;
    if (l.length === 1 && l[0] === "none") return [];
    for (const v of l) if (!(VENUES as string[]).includes(v)) throw new UsageError(`--${f}: unknown venue ${v}`);
    return l as Venue[];
  };
  return {
    maxOrder: num("max-order", cur.maxOrder),
    maxDaily: num("max-daily", cur.maxDaily),
    venues: venues("venues", cur.venues),
    attestedNoWithdraw: venues("attest", cur.attestedNoWithdraw),
  };
}

export async function brokerCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "status", id] = args.positional;
  const now = clockNow();

  if (sub === "setup") {
    const venue = venueOf(args, id);
    const env = envOf(args);
    const lines = [
      `Store the ${venue} ${env} key yourself — ultrastock never takes a secret on its command line or in a chat:`,
      ...setupCommands(venue, env).map((c) => `  ${c}`),
      "",
      "Create the key with:",
      venue === "ibkr"
        ? "  no key: start IBKR's Client Portal Gateway, log in in your browser (paper account for --env test), and set ULTRASTOCK_IBKR_CA_FILE to the gateway's certificate PEM (and ULTRASTOCK_IBKR_CERT_SHA256 to pin its fingerprint)."
        : venue === "kalshi"
          ? `  a Kalshi API key (key id + RSA private key PEM)${env === "test" ? " from the demo exchange, demo.kalshi.co" : ""}; live orders also need your country to be "allowed" for Kalshi — France is not today.`
          : `  trading permission ONLY — no withdrawal, no transfer, no margin/futures; restrict it to your IP address if ${venue} allows it.${env === "test" && venue === "binance" ? " Testnet keys come from https://testnet.binance.vision." : ""}`,
      CRYPTO_VENUES.includes(venue) ? "  Then check the platform is authorised for your country: `ultrastock jurisdiction verify --venues " + venue + "`." : "",
    ].filter(Boolean);
    return out(asJson, { venue, env, commands: setupCommands(venue, env) }, lines.join("\n"));
  }

  if (sub === "limits") {
    const { fills } = liveActivity(now);
    if (id !== "set") {
      const e = effectiveLimits(fills, now);
      return out(
        asJson,
        { ...e, stored: currentLimits(), liveFills: fills },
        [
          `live limits (tier "${e.tier}", ${fills} live fill(s)): ${e.limits.maxOrder} per order, ${e.limits.maxDaily} per day`,
          `venues switched on: ${e.limits.venues.join(", ") || "none"}; key without withdrawal right attested for: ${e.limits.attestedNoWithdraw.join(", ") || "none"}`,
          e.pending ? `pending loosening, effective ${e.pending.effectiveAt}: ${JSON.stringify(e.pending.limits)}` : "",
          "Tightening applies at once; loosening needs `broker code limits …` then `broker limits set … --code`, and waits 24 hours.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    const next = nextLimits(args, currentLimits());
    const code = argValue(args, "code");
    const approved = code ? verifyCode("limits", limitsBinding(next), code, now).ok : false;
    if (code && !approved) throw new Error("the approval code does not match these limits (or expired): run `broker code limits` with the same flags");
    const r = requestLimits(next, approved, now);
    audit({ event: "live-limits", next, applied: r.applied, effectiveAt: r.effectiveAt });
    return out(
      asJson,
      r,
      r.applied ? "limits tightened — in force now" : r.effectiveAt ? `loosening approved — in force from ${r.effectiveAt}` : `not changed: ${r.reason}`,
    );
  }

  if (sub === "code") {
    if (id === "limits") {
      const next = nextLimits(args, currentLimits());
      const r = await issueCode(
        "limits",
        limitsBinding(next),
        `live limits ${next.maxOrder}/order, ${next.maxDaily}/day, venues ${next.venues.join(",") || "none"}`,
      );
      return out(
        asJson,
        r,
        `approval code sent to ${r.sentTo.join(", ")} (valid until ${r.expiresAt}). Then: ultrastock broker limits set … --code <code> (the same flags).`,
      );
    }
    if (!id) throw new UsageError("usage: ultrastock broker code <ticket-id> | code limits [--max-order] [--max-daily] [--venues] [--attest]");
    const t = loadTicket(id);
    if (t.status !== "checked") throw new Error(`ticket ${id} is ${t.status}: check it first (\`ultrastock ticket check ${id}\`)`);
    const o = t.order;
    const r = await issueCode(t.id, orderFingerprint(o), `${o.side} ${o.quantity} ${o.symbol} at ${o.price} ${o.currency} (${o.venue}, ticket ${t.id})`);
    return out(
      asJson,
      r,
      `approval code sent to ${r.sentTo.join(", ")} (valid until ${r.expiresAt}). The user types it: ultrastock broker submit ${t.id} --venue ${o.venue} --env <test|live> --code <code>`,
    );
  }

  if (sub === "panic") {
    // Stop everything new, then cancel what is working. Nothing is sold: closing positions is a decision.
    mkdirSync(dirname(killSwitchPath()), { recursive: true });
    if (!existsSync(killSwitchPath())) writeFileSync(killSwitchPath(), `kill switch set by \`broker panic\` at ${now.toISOString()}\n`);
    audit({ event: "panic" });
    const results: string[] = [];
    // ultrastock's own working orders are cancelled; anything else open at a venue is the user's, and left alone.
    for (const tid of pendingLive()) {
      const rec = (loadTicket(tid) as { live?: { venue: Venue; env: Environment } }).live;
      if (!rec) continue;
      try {
        const r = await liveCancel(tid, adapterFor(rec.venue, rec.env), now);
        results.push(`${tid} (${rec.venue} ${rec.env}) → ${r?.state ?? "nothing to cancel"}`);
      } catch (e) {
        results.push(`${tid} (${rec.venue} ${rec.env}): ${(e as Error).message} — cancel it on the venue`);
      }
    }
    if (!results.length) results.push("no ultrastock order is working at a venue");
    return out(
      asJson,
      { kill: killSwitchPath(), results },
      [`kill switch ON (${killSwitchPath()}) — only risk-reducing orders pass; remove the file yourself to resume`, ...results.map((r) => `  ${r}`)].join("\n"),
    );
  }

  if (sub === "status") {
    const env = envOf(args);
    const venues = argValue(args, "venue") ? [venueOf(args)] : VENUES;
    const profile = loadProfile();
    const { fills, todayNotional } = liveActivity(now);
    const lim = effectiveLimits(fills, now);
    const rows: Array<Record<string, unknown>> = [];
    for (const v of venues) {
      const c = readCredentials(v, env);
      const row: Record<string, unknown> = { venue: v, env, key: c ? c.source : "none", on: lim.limits.venues.includes(v) };
      if (CRYPTO_VENUES.includes(v) && profile && profile.jurisdiction !== "US")
        row.mica = await checkMica(v, profile.jurisdiction)
          .then((m) => (m.authorised.length ? `authorised (${m.authorised[0]!.homeState})` : "NOT in ESMA's register for your country"))
          .catch((e) => `register unavailable: ${(e as Error).message}`);
      if (c)
        try {
          const p = await adapterFor(v, env).permissions();
          row.permissions = `${p.canTrade ? "trade" : "no trade"}, ${p.canWithdraw ? "CAN WITHDRAW — refused" : "no withdrawal"} (${p.source})`;
        } catch (e) {
          row.permissions = `unreadable: ${(e as Error).message}`;
        }
      rows.push(row);
    }
    return out(
      asJson,
      { env, kill: existsSync(killSwitchPath()), limits: lim, liveFills: fills, todayNotional, venues: rows, liveSwitch: process.env.ULTRASTOCK_LIVE === "1" },
      [
        `env ${env} · kill switch ${existsSync(killSwitchPath()) ? "ON" : "off"} · ULTRASTOCK_LIVE ${process.env.ULTRASTOCK_LIVE === "1" ? "on" : "off"} · tier "${lim.tier}" (${lim.limits.maxOrder}/order, ${lim.limits.maxDaily}/day, ${todayNotional.toFixed(2)} used today)`,
        ...rows.map(
          (r) =>
            `  ${String(r.venue).padEnd(9)} key: ${r.key}${r.on ? "" : " · not switched on"}${r.mica ? ` · MiCA: ${r.mica}` : ""}${r.permissions ? ` · ${r.permissions}` : ""}`,
        ),
      ].join("\n"),
    );
  }

  if (sub === "balances" || sub === "open") {
    const venue = venueOf(args);
    const a = adapterFor(venue, envOf(args));
    if (sub === "balances") {
      const b = (await a.balances()).filter((x) => x.free + x.locked > 0);
      return out(asJson, b, b.map((x) => `  ${x.asset.padEnd(8)} free ${x.free}  locked ${x.locked}`).join("\n") || "no balance");
    }
    const o = await a.openOrders();
    return out(asJson, o, o.map((x) => `  ${x.clientOrderId} ${x.state} ${x.venueOrderId ?? ""}`).join("\n") || "no open order");
  }

  if (!id) throw new UsageError(USAGE);
  const t = loadTicket(id);
  const venue = venueOf(args, t.order.venue);
  const env = envOf(args);

  if (sub === "preview") {
    const a = adapterFor(venue, env);
    const sym = venueSymbol(venue, t.order.symbol, t.order.currency, argValue(args, "conid"));
    const pre = await preconditions({ ticket: t, venue, env, adapter: a, venueSym: sym, now });
    const p = await a.preview({
      symbol: sym,
      side: t.order.side,
      quantity: t.order.quantity,
      limitPrice: t.order.price,
      clientOrderId: "00000000-0000-4000-8000-000000000000",
    });
    const blocking = pre.refusals.filter((r) => r.code !== "CODE");
    return out(
      asJson,
      { venue, env, preview: p, refusals: blocking },
      [
        `${venue} ${env} preview of ${t.id}: ${p.ok ? "the venue accepts it" : `the venue refuses it — ${p.message ?? ""}`}`,
        ...(blocking.length
          ? ["ultrastock would still refuse to send it:", ...blocking.map((r) => `  ${r.code}: ${r.reason}`)]
          : ["every ultrastock condition holds except the approval code: `broker code` then `broker submit`"]),
      ].join("\n"),
    );
  }

  if (sub === "submit") {
    const a = adapterFor(venue, env);
    const sym = venueSymbol(venue, t.order.symbol, t.order.currency, argValue(args, "conid"));
    const r = await liveSubmit({ ticket: t, venue, env, adapter: a, venueSym: sym, code: argValue(args, "code"), now });
    if (r.refusals.length) {
      out(asJson, r, [`not sent — ${r.refusals.length} condition(s) unmet:`, ...r.refusals.map((x) => `  ${x.code}: ${x.reason}`)].join("\n"));
      process.exitCode = 1;
      return;
    }
    const res = r.result!;
    return out(
      asJson,
      r,
      `${t.id} → ${venue} ${env}: ${res.state}${res.venueOrderId ? ` (order ${res.venueOrderId})` : ""}${res.filledQuantity ? `, filled ${res.filledQuantity} at ${res.averagePrice}` : ""}${res.message ? ` — ${res.message}` : ""}${res.state === "unknown" ? `\nThe answer was lost: nothing will be resent. Run \`ultrastock broker reconcile ${t.id}\`.` : ""}`,
    );
  }

  if (sub === "reconcile") {
    const r = await reconcile(id, adapterFor(venue, env), now);
    return out(asJson, r, `${id}: ${r.note}`);
  }

  if (sub === "cancel") {
    const r = await liveCancel(id, adapterFor(venue, env), now);
    return out(
      asJson,
      r ?? {},
      r ? `${id}: ${r.state}${r.message ? ` — ${r.message}` : ""}` : `${id} never went to a venue: \`ultrastock ticket cancel ${id}\``,
    );
  }

  throw new UsageError(USAGE);
}

/** Tickets waiting on a venue answer — what `reconcile` should look at. */
export function pendingLive(): string[] {
  return listTickets((t) => t.status === "submitted").map((t) => t.id);
}
