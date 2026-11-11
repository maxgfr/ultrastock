// Portfolio, plans, tickets and paper trading.
import { parsePredictionSymbol, predictionQuote } from "../trading/prediction.js";
import { importCommand } from "./import.js";
import { PORTFOLIO_ANALYTICS_ACTIONS, portfolioAnalyticsCommand } from "./portfolio-analytics.js";
import { PORTFOLIO_STORE_ACTIONS, portfolioStoreCommand } from "./portfolio-store.js";
import { resolve } from "node:path";
import { EvidenceStore } from "../core/evidence.js";
import { clockNow } from "../core/net.js";
import { type Limits, loadProfile } from "../core/profile.js";
import { argList, argValue, type CommandArgs, mapLimit, UsageError } from "../engine.js";
import { printResult as out } from "./emit.js";
import { appendTransactions, type Book, buildBook, readLedger, type Transaction, type TxType, valueBook, xirr } from "../portfolio/ledger.js";
import { getQuote, resolveSymbol } from "../providers/router.js";
import {
  breakerState,
  closedTradeResults,
  contributions,
  type EquityPoint,
  INCOMPLETE_VALUATION,
  readEquity,
  recordEquity,
  transfersAcross,
} from "../trading/breaker.js";
import { fxToBase, gateContextFor } from "../trading/context.js";
import { paperSubmit, paperSweep, readiness } from "../trading/paper.js";
import { planTrade, tradeContextMarkdown } from "../trading/plan.js";
import { historicalFx } from "../tax/inputs.js";
import { riskGate } from "../trading/riskgate.js";
import { createTicket, listTickets, loadTicket, recordCheck, transition } from "../trading/tickets.js";

const num = (v: string | undefined, flag: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${flag} takes a number, not "${v}"`);
  return n;
};
const bookOf = (args: CommandArgs) => {
  const b = argValue(args, "book") ?? "real";
  if (b !== "real" && b !== "paper") throw new UsageError("--book is real or paper");
  return b;
};

/** Mark a book to market (quotes and ECB rates) and record an equity snapshot (only when every position is priced). */
export async function markBook(book: string) {
  const profile = loadProfile();
  if (!profile) throw new Error("no profile: run `ultrastock profile init` first");
  const now = clockNow();
  const txs = readLedger(book);
  const b = buildBook(txs);
  const held = b.positions.filter((p) => p.quantity > 0);
  const prices: Record<string, number> = {};
  const sources: Record<string, string> = {};
  const notes: string[] = [];
  await mapLimit([...new Set(held.map((p) => p.symbol))], 4, async (s) => {
    try {
      if (parsePredictionSymbol(s)) {
        prices[s] = (await predictionQuote(s)).price;
        sources[s] = "prediction-market";
      } else {
        const q = await getQuote(await resolveSymbol(s), now);
        prices[s] = q.price;
        sources[s] = q.provenance.source;
      }
    } catch (e) {
      notes.push(`could not price ${s}: ${(e as Error).message}`);
    }
  });
  const fx = await fxToBase([...held.map((p) => p.currency), ...b.cash.map((c) => c.currency)], profile.baseCurrency);
  const v = valueBook(b, prices, fx.rates, profile.baseCurrency);
  // A valuation that left a position (or a rate) out is not what the book was worth: the breaker would take it for a
  // loss, then measure the next day from it. No point is recorded then.
  if (v.missing.length) notes.push(INCOMPLETE_VALUATION);
  // Never on a fixture's clock: recordEquity writes on the wall clock only, and the notes say so.
  else if (
    v.totalBase > 0 &&
    !recordEquity(
      book,
      v.totalBase,
      now,
      contributions(txs, fx.rates, profile.baseCurrency, (m) => notes.push(m)),
    )
  )
    notes.push("replaying or recording a fixture: the equity curve is not written");
  return { profile, txs, book: b, valued: v, fxRates: fx.rates, sources, notes: [...notes, ...fx.notes, ...v.missing.map((m) => `missing ${m}`)], now };
}

/** How `bookPerformance` converts a deposit or a withdrawal: units of `base` per one unit of a currency on a date, and how the rates were read. */
export interface FlowRates {
  base: string;
  rate: (currency: string, date: string) => number | undefined;
  notes: string[];
}

const isFlow = (t: Transaction) => t.type === "deposit" || t.type === "withdrawal";

/**
 * The ECB rate of each deposit's and withdrawal's own date (the tax engine's
 * `historicalFx`), read once for `bookPerformance`. A book funded in its base
 * currency only sends no request. Never throws: a read that fails (offline, a
 * fixture without it) leaves the lookup empty and says why, and the XIRR is
 * then not computed — never computed on amounts taken as base currency.
 */
export async function flowRates(txs: readonly Transaction[], base: string, now: Date): Promise<FlowRates> {
  // Deposits, withdrawals, and transfers in with a price (one from outside counts at its value).
  const flows = txs.filter((t) => isFlow(t) || (t.type === "transfer-in" && t.price !== undefined));
  const foreign = [...new Set(flows.map((t) => t.currency.toUpperCase()))].filter((c) => c !== base);
  if (!foreign.length) return { base, rate: () => undefined, notes: [] };
  const from = flows.map((t) => t.date.slice(0, 10)).sort()[0]!;
  try {
    const { fx, notes } = await historicalFx(base, foreign, from, now.toISOString().slice(0, 10));
    return { base, rate: fx, notes };
  } catch (e) {
    return { base, rate: () => undefined, notes: [`ECB rates for ${foreign.join(", ")} unavailable (${(e as Error).message.split("\n")[0]})`] };
  }
}

/**
 * The `perf` figures of a book valued at `totalBase` now: the money-weighted
 * return (XIRR) on its deposits and withdrawals, each converted to the base
 * currency at the rate of its own date (`fx`), the realised P&L (average
 * cost) and the dividends — summed across currencies, as `perf` prints them,
 * and per currency — and the circuit breaker read on `curve`. Pure: the
 * caller reads the rates and decides which equity curve it reads, and nothing
 * is written here. A flow without a rate leaves the XIRR undefined, with a
 * note naming it: a return computed on a wrong amount is worse than none.
 */
export function bookPerformance(
  txs: readonly Transaction[],
  book: Book,
  totalBase: number,
  curve: readonly EquityPoint[],
  limits: Limits,
  now: Date,
  fx: FlowRates,
) {
  const xirrNotes = [...fx.notes];
  const flows: Array<{ date: string; amount: number }> = [];
  const missing = new Set<string>();
  for (const t of txs.filter(isFlow)) {
    const date = t.date.slice(0, 10);
    const currency = t.currency.toUpperCase();
    const rate = currency === fx.base ? 1 : fx.rate(currency, date);
    if (rate === undefined) missing.add(`${currency} on ${date}`);
    else flows.push({ date, amount: -(t.amount ?? 0) * rate });
  }
  // A transfer between two of the user's accounts moves nothing in or out of the book. One from outside with a price
  // brought that value in: a contribution, like a deposit of it.
  const across = transfersAcross(txs);
  let unpriced = false;
  for (const { t, units } of across.in) {
    if (t.price === undefined) {
      unpriced = true;
      continue;
    }
    const date = t.date.slice(0, 10);
    const currency = t.currency.toUpperCase();
    const rate = currency === fx.base ? 1 : fx.rate(currency, date);
    if (rate === undefined) missing.add(`${currency} on ${date}`);
    else flows.push({ date, amount: -units * t.price * rate });
  }
  if (missing.size)
    xirrNotes.push(`XIRR not computed: no ${fx.base} rate for ${[...missing].join(", ")} — taking those amounts as ${fx.base} would give a wrong return`);
  if (unpriced)
    xirrNotes.push(
      "transfers in from outside without a price are not counted as contributions: the value they brought reads as return, so the XIRR overstates it (give them a price to count them)",
    );
  if (across.out.length)
    xirrNotes.push("transfers out to outside are not counted as withdrawals: the value they took out reads as a loss, so the XIRR understates it");
  flows.push({ date: now.toISOString().slice(0, 10), amount: totalBase });
  const byCurrency: Record<string, { realized: number; dividends: number }> = {};
  for (const p of book.positions) {
    const c = (byCurrency[p.currency] ??= { realized: 0, dividends: 0 });
    c.realized += p.realizedPmp;
    c.dividends += p.dividends;
  }
  return {
    xirr: missing.size ? undefined : xirr(flows),
    xirrNotes,
    realized: book.positions.reduce((s, p) => s + p.realizedPmp, 0),
    dividends: book.positions.reduce((s, p) => s + p.dividends, 0),
    byCurrency,
    breaker: breakerState(curve, closedTradeResults(txs), limits, now),
  };
}

export async function portfolioCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "show", ...rest] = args.positional;
  const book = bookOf(args);
  if (sub === "import") return importCommand(args, asJson);
  if ((PORTFOLIO_STORE_ACTIONS as readonly string[]).includes(sub)) return portfolioStoreCommand(args, asJson, markBook);
  if ((PORTFOLIO_ANALYTICS_ACTIONS as readonly string[]).includes(sub)) return portfolioAnalyticsCommand(args, asJson);
  if (sub === "deposit" || sub === "withdraw") {
    const [account, amountRaw] = rest;
    const amount = num(amountRaw, "amount");
    if (!account || amount === undefined || amount <= 0)
      throw new UsageError(`usage: ultrastock portfolio ${sub} <account> <amount> [--currency EUR] [--date YYYY-MM-DD] [--book real|paper]`);
    const r = await appendTransactions(
      [
        {
          date: argValue(args, "date") ?? clockNow().toISOString().slice(0, 10),
          type: sub === "deposit" ? "deposit" : "withdrawal",
          account,
          amount: sub === "deposit" ? amount : -amount,
          currency: (argValue(args, "currency") ?? loadProfile()?.baseCurrency ?? "EUR").toUpperCase(),
          origin: "manual",
        },
      ],
      book,
    );
    return out(asJson, r, `${r.added.length ? "recorded" : "already recorded"}: ${sub} ${amount} on ${account} (${book} book)`);
  }
  if (sub === "add") {
    // portfolio add buy|sell|dividend|fee|interest|tax|split --account … --symbol … --quantity … --price … --amount … --fee … --currency … --date …
    const type = rest[0] as TxType | undefined;
    const types: TxType[] = ["buy", "sell", "dividend", "fee", "interest", "tax", "split", "transfer-in", "transfer-out"];
    if (!type || !types.includes(type))
      throw new UsageError(
        `usage: ultrastock portfolio add ${types.join("|")} --account <id> [--symbol] [--quantity] [--price] [--amount] [--fee] [--currency] [--date] [--book]`,
      );
    const account = argValue(args, "account");
    if (!account) throw new UsageError("--account is required");
    const r = await appendTransactions(
      [
        {
          date: argValue(args, "date") ?? clockNow().toISOString().slice(0, 10),
          type,
          account,
          symbol: argValue(args, "symbol")?.toUpperCase(),
          quantity: num(argValue(args, "quantity"), "quantity"),
          price: num(argValue(args, "price"), "price"),
          amount: num(argValue(args, "amount"), "amount"),
          fee: num(argValue(args, "fee"), "fee"),
          currency: (argValue(args, "currency") ?? loadProfile()?.baseCurrency ?? "EUR").toUpperCase(),
          origin: "manual",
        },
      ],
      book,
    );
    return out(asJson, r, `${r.added.length ? "recorded" : "already recorded"}: ${type} on ${account} (${book} book)`);
  }
  if (sub === "show") {
    const m = await markBook(book);
    const dir = argValue(args, "out");
    if (dir) {
      const store = EvidenceStore.open(resolve(dir), { subject: `portfolio:${book}` });
      const fetchedAt = m.now.toISOString();
      const base = { source: "ultrastock-ledger", fetchedAt, asOf: fetchedAt.slice(0, 10), official: false };
      store.add({
        ...base,
        key: `PORTFOLIO.${book}.total`,
        label: `portfolio total (${book} book)`,
        value: Number(m.valued.totalBase.toFixed(2)),
        unit: m.profile.baseCurrency,
      });
      store.add({
        ...base,
        key: `PORTFOLIO.${book}.cash`,
        label: `cash (${book} book)`,
        value: Number(m.valued.cashBase.toFixed(2)),
        unit: m.profile.baseCurrency,
      });
      for (const p of m.valued.positions) {
        if (p.valueBase !== undefined)
          store.add({
            ...base,
            key: `PORTFOLIO.${book}.${p.account}.${p.symbol}.value`,
            label: `${p.symbol} position value (${p.account})`,
            value: Number(p.valueBase.toFixed(2)),
            unit: m.profile.baseCurrency,
          });
        if (p.weightPct !== undefined)
          store.add({
            ...base,
            key: `PORTFOLIO.${book}.${p.account}.${p.symbol}.weight`,
            label: `${p.symbol} weight (${p.account})`,
            value: Number(p.weightPct.toFixed(4)),
            unit: "%",
          });
        if (p.unrealizedPct !== undefined)
          store.add({
            ...base,
            key: `PORTFOLIO.${book}.${p.account}.${p.symbol}.unrealizedPct`,
            label: `${p.symbol} unrealised gain vs average cost (${p.account})`,
            value: Number(p.unrealizedPct.toFixed(4)),
            unit: "%",
          });
      }
      store.save();
    }
    const lines = [
      `${book} book — total ${m.valued.totalBase.toFixed(2)} ${m.profile.baseCurrency}, cash ${m.valued.cashBase.toFixed(2)}`,
      ...m.valued.positions.map(
        (p) =>
          `  ${p.account.padEnd(10)} ${p.symbol.padEnd(10)} ${String(p.quantity).padStart(12)} @ avg ${p.averageCost.toFixed(4)} ${p.currency}  last ${p.price ?? "?"}  ${p.unrealizedPct !== undefined ? `${p.unrealizedPct >= 0 ? "+" : ""}${p.unrealizedPct.toFixed(2)} %` : ""}  weight ${p.weightPct?.toFixed(2) ?? "?"} %`,
      ),
      ...m.book.cash.map((c) => `  ${c.account.padEnd(10)} cash ${c.currency} ${c.amount.toFixed(2)}`),
      ...m.notes.map((n) => `  note: ${n}`),
    ];
    return out(
      asJson,
      { book, total: m.valued.totalBase, cash: m.valued.cashBase, positions: m.valued.positions, cashByAccount: m.book.cash, notes: m.notes },
      lines.join("\n"),
    );
  }
  if (sub === "perf") {
    const m = await markBook(book);
    const rates = await flowRates(m.txs, m.profile.baseCurrency, m.now);
    const {
      xirr: irr,
      xirrNotes,
      realized,
      dividends,
      breaker: br,
    } = bookPerformance(m.txs, m.book, m.valued.totalBase, readEquity(book), m.profile.limits, m.now, rates);
    return out(
      asJson,
      { book, xirr: irr, xirrNotes, realized, dividends, breaker: br, total: m.valued.totalBase },
      [
        `${book} book — total ${m.valued.totalBase.toFixed(2)} ${m.profile.baseCurrency}`,
        `  money-weighted return (XIRR) ${irr === undefined ? `n/a (${xirrNotes.length ? "see the notes" : "needs deposits and time"})` : `${(irr * 100).toFixed(2)} % a year`}`,
        ...xirrNotes.map((n) => `  note: ${n}`),
        `  realised (average cost) ${realized.toFixed(2)}, dividends ${dividends.toFixed(2)} (in each position's currency)`,
        `  circuit breaker: ${br.tripped ? `TRIPPED — ${br.reason} (until ${br.until})` : "not tripped"}; drawdown ${br.drawdownPct?.toFixed(2) ?? "?"} %, size multiplier ${br.sizeMultiplier}`,
      ].join("\n"),
    );
  }
  throw new UsageError("usage: ultrastock portfolio show|perf|deposit|withdraw|add|import|db|track|history|news [--book real|paper]");
}

export async function planCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0];
  if (!sym)
    throw new UsageError("usage: ultrastock plan <symbol> --account <id> [--entry n] [--stop n] [--target a,b] [--venue paper] [--ticket] [--out <dir>]");
  const account = argValue(args, "account");
  if (!account) throw new UsageError("--account names the envelope the order would go to (a profile envelope id, e.g. pea or ibkr)");
  const targets = argList(args, "target").map((t) => num(t, "target")!);
  const p = await planTrade({
    symbol: sym,
    account,
    entry: num(argValue(args, "entry"), "entry"),
    stop: num(argValue(args, "stop"), "stop"),
    targets: targets.length ? targets : undefined,
    venue: argValue(args, "venue") ?? "paper",
  });
  const dir = argValue(args, "out");
  if (dir) {
    const store = EvidenceStore.open(resolve(dir), { subject: p.symbol });
    const base = { source: "ultrastock-plan", fetchedAt: clockNow().toISOString(), official: false, asOf: clockNow().toISOString().slice(0, 10) };
    const k = `${p.symbol}.plan`;
    store.add({ ...base, key: `${k}.entry`, label: `${p.symbol} planned entry (limit)`, value: p.entry, unit: p.currency });
    store.add({ ...base, key: `${k}.stop`, label: `${p.symbol} planned stop`, value: p.stop, unit: p.currency, formula: p.stopMethod });
    p.targets.forEach((t, i) =>
      store.add({ ...base, key: `${k}.target${i + 1}`, label: `${p.symbol} target ${i + 1} (${p.rewardRisk[i]!.toFixed(1)}R)`, value: t, unit: p.currency }),
    );
    store.add({ ...base, key: `${k}.quantity`, label: `${p.symbol} planned quantity`, value: p.quantity, unit: "units", formula: p.sizingReasons.join("; ") });
    if (p.riskPct !== undefined)
      store.add({ ...base, key: `${k}.riskPct`, label: `${p.symbol} risk to the stop, % of the portfolio`, value: Number(p.riskPct.toFixed(4)), unit: "%" });
    store.add({ ...base, key: `${k}.positionPct`, label: `${p.symbol} position size, % of the portfolio`, value: Number(p.positionPct.toFixed(4)), unit: "%" });
    store.add({ ...base, key: `${k}.verdict`, label: `${p.symbol} plan verdict`, value: p.verdict });
    store.save();
  }
  let ticketId: string | undefined;
  if (args.bools.has("ticket")) {
    if (p.quantity <= 0) throw new Error(`no ticket: ${p.verdict} — the size is zero (${p.sizingReasons.at(-1)})`);
    const t = createTicket(p.order, { run: dir ? resolve(dir) : undefined, note: `plan: stop ${p.stopMethod}; targets ${p.targets.join(", ")}` });
    await recordCheck(t.id, p.gate);
    ticketId = t.id;
  }
  out(
    asJson,
    { ...p, ticket: ticketId },
    `${tradeContextMarkdown(p)}${ticketId ? `ticket ${ticketId}: ${p.gate.verdict === "pass" ? "checked — `ultrastock paper submit` executes it on paper" : "blocked by the risk gate"}\n` : ""}`,
  );
}

export async function ticketCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "list", id] = args.positional;
  if (sub === "list") {
    const status = argValue(args, "status");
    const ts = listTickets((t) => !status || t.status === status);
    return out(
      asJson,
      ts,
      ts
        .map(
          (t) =>
            `${t.id}  ${t.status.padEnd(9)} ${t.order.side} ${t.order.quantity} ${t.order.symbol} @ ${t.order.price} stop ${t.order.stop ?? "-"} (${t.order.venue}, ${t.order.account})`,
        )
        .join("\n") || "no tickets",
    );
  }
  if (!id) throw new UsageError(`usage: ultrastock ticket ${sub} <ticket-id>`);
  if (sub === "show") {
    const t = loadTicket(id);
    return out(asJson, t, JSON.stringify(t, null, 2));
  }
  if (sub === "check") {
    const t = loadTicket(id);
    const built = await gateContextFor(t.order, { ticketId: id });
    const gate = riskGate(t.order, built.ctx);
    const after = await recordCheck(id, gate);
    if (gate.verdict !== "pass") process.exitCode = 1;
    return out(
      asJson,
      { ticket: after, notes: built.notes },
      [
        `${id}: ${after.status}`,
        ...gate.checks.map((c) => `  ${c.status.toUpperCase()} ${c.code}: ${c.reason}`),
        ...built.notes.map((n) => `  note: ${n}`),
      ].join("\n"),
    );
  }
  if (sub === "cancel") {
    // A submitted order is cancelled at its venue (`broker cancel`); a closed ticket has nothing left to cancel.
    const after = await transition(
      id,
      "cancelled",
      "cancelled by the user",
      undefined,
      undefined,
      ["draft", "checked", "blocked", "working"],
      (status) => `ticket ${id} is ${status}: nothing to cancel`,
    );
    return out(asJson, after, `${id}: cancelled`);
  }
  throw new UsageError("usage: ultrastock ticket list|show|check|cancel [<ticket-id>]");
}

export async function paperCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub = "book", id] = args.positional;
  if (sub === "submit") {
    if (!id) throw new UsageError("usage: ultrastock paper submit <ticket-id>");
    const r = await paperSubmit(id, clockNow());
    return out(
      asJson,
      r,
      r.outcome.kind === "fill"
        ? `${id}: filled ${r.outcome.fill.quantity} at ${r.outcome.fill.price} (fee ${r.outcome.fill.fee.toFixed(2)}) — ${r.outcome.fill.method}${r.outcome.note ? `\n  note: ${r.outcome.note}` : ""}`
        : `${id}: working — ${r.outcome.reason}`,
    );
  }
  if (sub === "sweep") {
    const r = await paperSweep(clockNow());
    return out(asJson, r, r.map((x) => `${x.id}: ${x.result}`).join("\n") || "no working paper orders");
  }
  if (sub === "readiness") {
    const txs = readLedger("paper");
    const trades = closedTradeResults(txs);
    const r = readiness(trades, readEquity("paper"), txs.find((t) => t.type === "buy")?.date, clockNow());
    return out(
      asJson,
      r,
      [
        `ready for real money: ${r.ready ? "YES (a necessary condition, not a sufficient one)" : "not yet"}`,
        ...r.criteria.map((c) => `  ${c.pass ? "ok  " : "TODO"} ${c.reason}`),
      ].join("\n"),
    );
  }
  if (sub === "book") return portfolioCommand({ ...args, positional: ["show"], values: { ...args.values, book: "paper" } }, asJson);
  throw new UsageError("usage: ultrastock paper book|submit <ticket>|sweep|readiness");
}
