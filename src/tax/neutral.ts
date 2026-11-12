// The neutral facts report: what a return in any country needs from the
// ledger, and nothing a country's law decides. For each disposal of the year —
// date, asset, quantity, proceeds, and the cost both under FIFO and under the
// weighted average, with the acquisition date(s) and holding period of the
// FIFO lots; the income received (dividends, interest, staking and other
// rewards) with what was withheld; the fees. Every amount is in the base
// currency at its own date's rate (the same `fx` input as the engines).
//
// It computes NO tax: the rules the agent researched for the country and the
// year are shown beside the facts, and applying them (rates, exemptions,
// holding periods, loss rules) is the agent's job — confirmed by a
// professional. Choices it cannot avoid are named, never hidden:
// - lots are pooled per asset across the user's accounts (a security by its
//   ISIN, or by its ticker in one account whose rows carry none, or several;
//   a crypto-asset by its base whatever the pair); a move between two
//   of the user's accounts is neither a disposal nor an acquisition;
// - a crypto-to-crypto trade (stablecoins included) is listed as the disposal
//   of what was given and the acquisition of what was received, marked
//   `exchange`, for the country's rule to decide;
// - the cost method the researched `costMethod` names alone and plainly is
//   marked `chosen` (a text naming both, or excluding one, marks neither);
//   both are always shown.
import type { Envelope } from "../core/profile.js";
import type { Transaction } from "../portfolio/ledger.js";
import {
  addDays,
  chronological,
  day,
  envelopeOf,
  type Fx,
  gross,
  isConvertLeg,
  isCryptoTx,
  isFiat,
  isStablecoin,
  round2,
  securityKeys,
  splitPair,
  yearOf,
} from "./regime.js";
import type { RuleSet } from "./rules.js";

export interface NeutralInput {
  year: number;
  transactions: readonly Transaction[];
  envelopes: readonly Envelope[];
  /** Units of `currency` per one unit of a currency on a date. */
  fx: Fx;
  /** The base currency every amount is reported in. */
  currency: string;
  /** The researched rules shown beside the facts (and `costMethod` read from them). */
  rules?: RuleSet;
}

export interface LotSlice {
  acquired: string;
  quantity: number;
  cost: number;
  heldDays: number;
}

export interface NeutralDisposal {
  date: string;
  account: string;
  envelope: string;
  asset: string;
  symbol?: string;
  crypto: boolean;
  quantity: number;
  /** Net of the disposal fee. */
  proceeds: number;
  fees: number;
  /** What was received: the fiat currency, or the crypto-asset of an exchange. */
  received: string;
  /** A trade of one crypto-asset for another (stablecoins included): taxable or deferred by the country's rule. */
  exchange: boolean;
  costFifo: number;
  costAverage: number;
  gainFifo: number;
  gainAverage: number;
  /** The FIFO lots the disposal took, oldest first. */
  lots: LotSlice[];
  acquiredFirst?: string;
  acquiredLast?: string;
  heldDaysMin?: number;
  heldDaysMax?: number;
  notes: string[];
}

export interface NeutralIncome {
  date: string;
  account: string;
  envelope: string;
  kind: "dividend" | "interest" | "reward";
  symbol?: string;
  /** In the base currency; undefined when the ledger holds no value for it (a reward booked without a price). */
  amount?: number;
  /** Tax withheld on the same payment (same day, account and symbol), in the base currency. */
  withheld: number;
  notes: string[];
}

export interface NeutralCharge {
  date: string;
  account: string;
  symbol?: string;
  /** Positive when paid, negative when refunded, in the base currency. */
  amount: number;
  kind: "withholding" | "account fee";
}

export interface NeutralReport {
  country: string;
  year: number;
  currency: string;
  costMethod: { researched?: string; chosen?: "fifo" | "average" };
  disposals: NeutralDisposal[];
  income: NeutralIncome[];
  charges: NeutralCharge[];
  totals: {
    disposals: number;
    exchanges: number;
    proceeds: number;
    costFifo: number;
    costAverage: number;
    gainFifo: number;
    gainAverage: number;
    tradeFees: number;
    dividends: number;
    interest: number;
    rewards: number;
    withheld: number;
    accountFees: number;
  };
  rules?: RuleSet;
  warnings: string[];
}

/** How long two legs of a move between the user's own accounts may be apart (statement timing, not a tax rule). */
const TRANSIT_DAYS = 30;
const REWARD_NOTE = /\b(staking|rewards?|airdrops?|interest|income|distribution|rebate|cashback|bonus|mining|launchpool|referral)\b/i;
const EPS = 1e-12;
const DAY_MS = 86_400_000;

const FIFO_WORDS = /\bfifo\b|first[\s-]*in[\s,-]*first[\s-]*out|premier[\s-]*entr/i;
const AVERAGE_WORDS = /average|weighted|\bpmp\b|moyen|pond[ée]r/i;
/** A word that excludes or qualifies a method ("FIFO is not allowed", "pas de FIFO", "except…"). */
const NEGATION_WORDS =
  /\b(?:not|no|never|nor|except|excluding|excluded|prohibited|forbidden|disallowed|instead|rather|unless|pas|sans|ni|sauf|interdite?s?|exclue?s?|non)\b|\bn['’]/i;

/**
 * "fifo" / "average" when the researched costMethod text names that method alone, plainly; else undefined: a text
 * that names both, or excludes or qualifies one, is applied as described (both shown, neither marked).
 */
export function chosenMethod(text: unknown): "fifo" | "average" | undefined {
  if (typeof text !== "string" || NEGATION_WORDS.test(text)) return undefined;
  const fifo = FIFO_WORDS.test(text);
  const average = AVERAGE_WORDS.test(text);
  return fifo && !average ? "fifo" : average && !fifo ? "average" : undefined;
}

interface Pool {
  lots: Array<{ acquired: string; quantity: number; perUnit: number }>;
  quantity: number;
  cost: number;
}

export function neutralReport(input: NeutralInput): NeutralReport {
  const base = input.currency.toUpperCase();
  const warnings: string[] = [];
  const researched = input.rules?.facts.costMethod?.value;
  const chosen = chosenMethod(researched);
  if (!input.rules?.facts.costMethod)
    warnings.push("costMethod is not researched: the cost is shown under FIFO and the weighted average, neither is marked as the law's");
  else if (!chosen)
    warnings.push(
      `costMethod "${String(researched)}" does not name FIFO or the weighted average alone and plainly: apply it as described — both costs are shown, neither is marked`,
    );

  const value = (t: Transaction, amount: number, currency = t.currency): number => {
    if (amount === 0) return 0;
    let c = currency.toUpperCase();
    if (isStablecoin(c)) c = c.startsWith("EUR") ? "EUR" : "USD";
    if (c === base) return amount;
    const rate = input.fx(c, day(t.date));
    if (rate === undefined)
      throw new Error(`no ${c}→${base} rate for ${day(t.date)} (transaction ${t.id}) — the report needs every amount converted at its date`);
    return amount * rate;
  };

  // A security is one account's ticker whatever ISINs it carries, linked across accounts and tickers by its ISIN (a row
  // without one never takes another account's: securityKeys); a crypto-asset is the base of its pair.
  const securityOf = securityKeys(input.transactions);
  const crypto = (t: Transaction) => isCryptoTx(t, input.envelopes);
  const assetOf = (t: Transaction): string => (crypto(t) ? splitPair(t.symbol ?? t.currency, t.currency).base : securityOf(t));

  const history = chronological(input.transactions.filter((t) => yearOf(t.date) <= input.year));
  // Moves between the user's own accounts: each unpriced transfer-in takes the transfer-outs of the same asset from
  // another account in the days before it (or the same day, in either order).
  const matched = new Map<Transaction, number>();
  const outs = history.filter((t) => t.type === "transfer-out");
  for (const t of history) {
    if (t.type !== "transfer-in" || t.price !== undefined || REWARD_NOTE.test(t.note ?? "")) continue;
    let need = t.quantity ?? 0;
    for (const o of outs) {
      if (need <= EPS) break;
      if (o.account === t.account || assetOf(o) !== assetOf(t)) continue;
      if (day(o.date) > day(t.date) || day(t.date) > addDays(day(o.date), TRANSIT_DAYS)) continue;
      const left = (o.quantity ?? 0) - (matched.get(o) ?? 0);
      if (left <= EPS) continue;
      const q = Math.min(need, left);
      matched.set(o, (matched.get(o) ?? 0) + q);
      matched.set(t, (matched.get(t) ?? 0) + q);
      need -= q;
    }
  }

  const pools = new Map<string, Pool>();
  const pool = (a: string) => {
    let p = pools.get(a);
    if (!p) pools.set(a, (p = { lots: [], quantity: 0, cost: 0 }));
    return p;
  };
  const acquire = (asset: string, date: string, quantity: number, cost: number) => {
    if (quantity <= EPS) return;
    const p = pool(asset);
    p.lots.push({ acquired: date, quantity, perUnit: cost / quantity });
    p.quantity += quantity;
    p.cost += cost;
  };
  /** Take `quantity` out of the pool: the FIFO slices and the average cost of what left. */
  const take = (asset: string, date: string, quantity: number): { slices: LotSlice[]; average: number; short: number } => {
    const p = pool(asset);
    const slices: LotSlice[] = [];
    let left = quantity;
    while (left > EPS && p.lots.length) {
      const l = p.lots[0]!;
      const q = Math.min(left, l.quantity);
      slices.push({ acquired: l.acquired, quantity: q, cost: q * l.perUnit, heldDays: Math.round((Date.parse(date) - Date.parse(l.acquired)) / DAY_MS) });
      l.quantity -= q;
      left -= q;
      if (l.quantity <= EPS) p.lots.shift();
    }
    const held = Math.min(quantity, p.quantity);
    const average = p.quantity > EPS ? (p.cost / p.quantity) * held : 0;
    p.cost -= average;
    p.quantity -= held;
    if (p.quantity <= EPS) {
      p.quantity = 0;
      p.cost = 0;
    }
    return { slices, average, short: left > 1e-9 ? left : 0 };
  };

  const disposals: NeutralDisposal[] = [];
  const income: NeutralIncome[] = [];
  const charges: NeutralCharge[] = [];
  let tradeFees = 0;
  const splitDone = new Set<string>();
  const inYear = (t: Transaction) => yearOf(t.date) === input.year;
  const where = (t: Transaction) => ({ date: day(t.date), account: t.account, envelope: envelopeOf(t.account, input.envelopes, t.symbol, t.isin).type });

  const dispose = (
    t: Transaction,
    asset: string,
    quantity: number,
    proceeds: number,
    fees: number,
    received: string,
    exchange: boolean,
    isCrypto: boolean,
    notes: string[] = [],
  ) => {
    const d = day(t.date);
    const { slices, average, short } = take(asset, d, quantity);
    if (!inYear(t)) return;
    const n = [...notes];
    if (short) {
      n.push(`${round2(short * 1e6) / 1e6} ${asset} sold beyond the recorded acquisitions: no cost for them — import the history`);
      warnings.push(`${asset} disposed on ${d}: ${round2(short * 1e6) / 1e6} more than the ledger's acquisitions (cost 0 for them)`);
    }
    const costFifo = slices.reduce((a, s) => a + s.cost, 0);
    const days = slices.map((s) => s.heldDays);
    disposals.push({
      ...where(t),
      asset,
      symbol: t.symbol,
      crypto: isCrypto,
      quantity: round2(quantity * 1e8) / 1e8,
      proceeds: round2(proceeds),
      fees: round2(fees),
      received,
      exchange,
      costFifo: round2(costFifo),
      costAverage: round2(average),
      gainFifo: round2(proceeds - costFifo),
      gainAverage: round2(proceeds - average),
      lots: slices.map((s) => ({ ...s, quantity: round2(s.quantity * 1e8) / 1e8, cost: round2(s.cost) })),
      acquiredFirst: slices[0]?.acquired,
      acquiredLast: slices.at(-1)?.acquired,
      heldDaysMin: days.length ? Math.min(...days) : undefined,
      heldDaysMax: days.length ? Math.max(...days) : undefined,
      notes: n,
    });
  };

  for (const t of history) {
    const isCrypto = crypto(t);
    const d = day(t.date);
    if (t.type === "buy" || t.type === "sell") {
      const q = t.quantity ?? 0;
      if (!isCrypto) {
        const asset = assetOf(t);
        const w = value(t, gross(t));
        const f = value(t, t.fee ?? 0);
        if (inYear(t)) tradeFees += f;
        if (t.type === "buy") acquire(asset, d, q, w + f);
        else dispose(t, asset, q, w - f, f, t.currency.toUpperCase(), false, false);
        continue;
      }
      const b = splitPair(t.symbol ?? t.currency, t.currency).base;
      const quote = t.currency.toUpperCase();
      const bFiat = isFiat(b);
      const qFiat = isFiat(quote);
      // What changed hands, fee aside, valued from the fiat (or stablecoin) side when there is one.
      const w = bFiat && !qFiat && !isStablecoin(quote) ? value(t, q, b) : value(t, gross(t));
      const f = value(t, t.fee ?? 0);
      if (inYear(t)) tradeFees += f;
      const convert = isConvertLeg(t);
      if (t.type === "buy") {
        if (!bFiat) acquire(b, d, q, w + f);
        if (!qFiat) dispose(t, quote, gross(t) + (t.fee ?? 0), w + f, f, b, !bFiat, true, [`${quote} given for ${q} ${b}`]);
      } else {
        if (!bFiat)
          dispose(t, b, q, w - f, f, convert ? "crypto (convert)" : quote, convert || !qFiat, true, convert ? [`${t.note}: no fiat changed hands`] : []);
        if (!qFiat) acquire(quote, d, gross(t) - (t.fee ?? 0), w - f);
      }
      continue;
    }
    if (t.type === "split") {
      const asset = assetOf(t);
      const once = `${asset}|${d}|${t.quantity ?? 1}`;
      if (splitDone.has(once)) continue;
      splitDone.add(once);
      const r = t.quantity ?? 1;
      const p = pool(asset);
      for (const l of p.lots) {
        l.quantity *= r;
        l.perUnit /= r;
      }
      p.quantity *= r;
      continue;
    }
    if (t.type === "transfer-in" || t.type === "transfer-out") {
      const asset = assetOf(t);
      const q = t.quantity ?? 0;
      const own = matched.get(t) ?? 0;
      const rest = q - own;
      if (rest <= EPS) continue;
      if (t.type === "transfer-out") {
        take(asset, d, rest);
        if (inYear(t))
          warnings.push(
            `${rest} ${asset} left ${t.account} on ${d} with no transfer-in to another of your accounts: listed as gone, not as a disposal — say what it was (a gift, a payment, a sale elsewhere)`,
          );
        continue;
      }
      const reward = REWARD_NOTE.test(t.note ?? "");
      if (t.price !== undefined) {
        acquire(asset, d, rest, value(t, rest * t.price));
        if (reward && inYear(t))
          income.push({ ...where(t), kind: "reward", symbol: t.symbol, amount: round2(value(t, rest * t.price)), withheld: 0, notes: [t.note ?? "reward"] });
        continue;
      }
      acquire(asset, d, rest, 0);
      if (!inYear(t)) continue;
      if (reward)
        income.push({
          ...where(t),
          kind: "reward",
          symbol: t.symbol,
          withheld: 0,
          notes: [`${t.note}: ${rest} ${asset} received without a price — its value when received is not in the ledger (cost 0 here)`],
        });
      else
        warnings.push(
          `${rest} ${asset} arrived in ${t.account} on ${d} with no price and no matching transfer-out: cost 0 — give its original cost as the transfer-in's price`,
        );
      continue;
    }
    if (!inYear(t)) {
      // Crypto paid as interest grows the holding even in an earlier year.
      if ((t.type === "interest" || t.type === "dividend") && isCrypto && !isFiat(t.currency) && typeof t.amount === "number")
        acquire(t.currency.toUpperCase(), d, t.amount, value(t, t.amount));
      continue;
    }
    if (t.type === "dividend" || t.type === "interest") {
      const amount = value(t, t.amount ?? 0);
      // Paid in a crypto-asset, a stablecoin included: the holding is acquired at its value that day, as in an earlier
      // year (a stablecoin's disposals are listed: spending it later has that cost).
      const paidInCrypto = isCrypto && !isFiat(t.currency);
      const coin = paidInCrypto && !isStablecoin(t.currency);
      if (paidInCrypto && typeof t.amount === "number") acquire(t.currency.toUpperCase(), d, t.amount, amount);
      income.push({
        ...where(t),
        kind: coin ? "reward" : t.type,
        symbol: t.symbol,
        amount: round2(amount),
        withheld: 0,
        notes: paidInCrypto ? [`paid in ${t.currency}: valued at that day's rate, and a holding acquired at that value`] : [],
      });
    } else if (t.type === "tax") {
      // A tax row is the cash it moved: negative when withheld, positive when handed back.
      charges.push({ date: d, account: t.account, symbol: t.symbol, amount: round2(-value(t, t.amount ?? 0)), kind: "withholding" });
    } else if (t.type === "fee") {
      charges.push({ date: d, account: t.account, symbol: t.symbol, amount: round2(-value(t, t.amount ?? 0)), kind: "account fee" });
    }
  }
  for (const i of income) {
    const w = charges.filter((c) => c.kind === "withholding" && c.date === i.date && c.account === i.account && (c.symbol ?? "") === (i.symbol ?? ""));
    i.withheld = round2(w.reduce((a, c) => a + c.amount, 0));
  }
  const sum = <T>(xs: readonly T[], f: (x: T) => number | undefined) => round2(xs.reduce((a, x) => a + (f(x) ?? 0), 0));
  const totals = {
    disposals: disposals.length,
    exchanges: disposals.filter((x) => x.exchange).length,
    proceeds: sum(disposals, (x) => x.proceeds),
    costFifo: sum(disposals, (x) => x.costFifo),
    costAverage: sum(disposals, (x) => x.costAverage),
    gainFifo: sum(disposals, (x) => x.gainFifo),
    gainAverage: sum(disposals, (x) => x.gainAverage),
    tradeFees: round2(tradeFees),
    dividends: sum(
      income.filter((x) => x.kind === "dividend"),
      (x) => x.amount,
    ),
    interest: sum(
      income.filter((x) => x.kind === "interest"),
      (x) => x.amount,
    ),
    rewards: sum(
      income.filter((x) => x.kind === "reward"),
      (x) => x.amount,
    ),
    withheld: sum(
      charges.filter((x) => x.kind === "withholding"),
      (x) => x.amount,
    ),
    accountFees: sum(
      charges.filter((x) => x.kind === "account fee"),
      (x) => x.amount,
    ),
  };
  if (income.some((i) => i.amount === undefined))
    warnings.push("some rewards have no value in the ledger: their income is unknown — give each transfer-in its value when received");
  return {
    country: input.rules?.country ?? "",
    year: input.year,
    currency: base,
    costMethod: { researched: typeof researched === "string" ? researched : undefined, chosen },
    disposals,
    income,
    charges,
    totals,
    rules: input.rules,
    warnings,
  };
}
