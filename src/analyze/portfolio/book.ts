// The book every portfolio analysis starts from: the ledger's open positions
// (one line per symbol, its envelopes kept), marked to market with a quote per
// symbol and the ECB reference rates, each figure registered as an input — the
// ledger quantities, the quotes, the rates — and the values and weights
// derived from them. Positions are aggregated by symbol across envelopes: a
// share held in the PEA and in the CTO is one exposure.
import type { Dataset, Point } from "../../core/datasets.js";
import type { EnvelopeType, Profile } from "../../core/profile.js";
import { loadProfile } from "../../core/profile.js";
import { mapLimit } from "../../engine.js";
import { type Book, buildBook, readLedger, type Transaction } from "../../portfolio/ledger.js";
import { ecbFx } from "../../providers/macro/ecb.js";
import { frankfurterLatest } from "../../providers/macro/frankfurter.js";
import { yahooFxRates } from "../../providers/markets/yahoo.js";
import { getQuote, type Resolved, resolveSymbol } from "../../providers/router.js";
import type { AssetKind, Instrument } from "../../providers/types.js";
import type { Findings } from "./findings.js";

/** Stablecoins are converted at the US dollar rate (said in the notes). */
const AS_USD = new Set(["USDT", "USDC", "FDUSD"]);

/** At most this many symbols are priced per run (polite fan-out; the rest are reported). */
export const MAX_SYMBOLS = 30;

export type AssetClass = "equity" | "etf" | "fund" | "crypto" | "index" | "unknown";

export interface HoldingAccount {
  account: string;
  envelope: EnvelopeType | "unknown";
  quantity: number;
  averageCost: number;
}

export interface Holding {
  symbol: string;
  currency: string;
  quantity: number;
  /** Weighted average cost across envelopes (PMP), trade currency. */
  averageCost: number;
  accounts: HoldingAccount[];
  resolved?: Resolved;
  instrument?: Instrument;
  assetClass: AssetClass;
  isin?: string;
  price?: number;
  /** The last session's change, % (only when the book was loaded with `dayChange`). */
  changePct?: number;
  /** Units of base per one unit of the trade currency. */
  fx?: number;
  valueBase?: number;
  /** % of the whole portfolio, cash included. */
  weightPct?: number;
  /** Evidence keys of the quantity, the quote, the rate and the derived value. */
  keys: { quantity: string; price?: string; change?: string; fx?: string; value?: string; weight?: string };
}

export interface MarkedBook {
  profile: Profile;
  bookName: string;
  now: Date;
  txs: Transaction[];
  book: Book;
  holdings: Holding[];
  cash: Array<{ account: string; currency: string; amount: number; amountBase?: number }>;
  cashBase: number;
  totalBase: number;
  base: string;
  /** Base per unit of each currency. */
  rates: Record<string, number>;
  keys: { cash: string; total: string; fx: Record<string, string> };
}

const kindToClass = (k: AssetKind | undefined): AssetClass => (k === "index" ? "index" : (k ?? "unknown"));

/** The envelope type of a ledger account: the profile's declaration, else read from the id ("pea", "cto"), else unknown. */
export function envelopeOf(profile: Profile, account: string): EnvelopeType | "unknown" {
  const env = profile.envelopes.find((e) => e.id === account);
  if (env) return env.type;
  const id = account.toLowerCase();
  if (/pea-?pme/.test(id)) return "PEA-PME";
  if (/\bpea\b|^pea/.test(id)) return "PEA";
  if (/cto|ibkr|degiro|boursorama|trade/.test(id)) return "CTO";
  if (/\bav\b|assurance|vie/.test(id)) return "AV";
  if (/\bper\b/.test(id)) return "PER";
  if (/crypto|kraken|binance|coinbase|bitstamp/.test(id)) return "CRYPTO";
  return "unknown";
}

/** Group open positions by symbol, keeping each envelope's share. */
export function aggregateHoldings(book: Book, profile: Profile): Holding[] {
  const bySymbol = new Map<string, Holding>();
  for (const p of book.positions) {
    if (!(p.quantity > 0)) continue;
    let h = bySymbol.get(p.symbol);
    if (!h) {
      h = { symbol: p.symbol, currency: p.currency, quantity: 0, averageCost: 0, accounts: [], assetClass: "unknown", keys: { quantity: "" } };
      bySymbol.set(p.symbol, h);
    }
    h.averageCost = (h.averageCost * h.quantity + p.averageCost * p.quantity) / (h.quantity + p.quantity);
    h.quantity += p.quantity;
    h.accounts.push({ account: p.account, envelope: envelopeOf(profile, p.account), quantity: p.quantity, averageCost: p.averageCost });
  }
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * ECB reference rates (Frankfurter as fallback) for `currencies`, as datasets and
 * base-per-unit rates. A currency the ECB does not fix (TWD, SAR, QAR, ARS,
 * CLP, COP…) is read from Yahoo's EUR<CCY>=X quote instead — unofficial, and
 * said so in the notes.
 */
export async function referenceRates(
  currencies: readonly string[],
  base: string,
): Promise<{ datasets: Dataset[]; rates: Record<string, number>; keys: Record<string, string>; notes: string[] }> {
  const notes: string[] = [];
  const rates: Record<string, number> = { [base]: 1 };
  const keys: Record<string, string> = {};
  const datasets: Dataset[] = [];
  const want = [...new Set(currencies.map((c) => (AS_USD.has(c) ? "USD" : c)).filter((c) => c !== base))];
  if (currencies.some((c) => AS_USD.has(c))) notes.push("stablecoin amounts converted at the US dollar rate");
  if (!want.length) return { datasets, rates, keys, notes };
  if (base !== "EUR") throw new Error(`only a EUR base currency is supported for now (profile says ${base})`);
  const take = (ds: Dataset) => {
    for (const p of ds.points) {
      const m = /^EUR\.fx\.([A-Z]{3})$/.exec(p.key);
      if (m && typeof p.value === "number" && p.value > 0 && !rates[m[1]!]) {
        rates[m[1]!] = 1 / p.value;
        keys[m[1]!] = p.key;
      }
    }
    datasets.push({ ...ds, points: ds.points.filter((p) => /^EUR\.fx\.[A-Z]{3}$/.test(p.key)) });
  };
  const ds = await ecbFx(want, 5).catch((e: Error) => {
    notes.push(`ECB reference rates unavailable (${e.message}) — Frankfurter stood in`);
    return frankfurterLatest("EUR", want);
  });
  take(ds);
  const unfixed = want.filter((c) => !rates[c]);
  if (unfixed.length) {
    const y = await yahooFxRates("EUR", unfixed).catch((e: Error) => {
      notes.push(`Yahoo rates unavailable for ${unfixed.join(", ")} (${e.message})`);
      return undefined;
    });
    if (y?.points.length) {
      take(y);
      notes.push(`no ECB reference rate for ${unfixed.filter((c) => rates[c]).join(", ")}: Yahoo's EUR cross rate stood in (unofficial)`);
    }
  }
  for (const c of currencies)
    if (AS_USD.has(c) && rates.USD) {
      rates[c] = rates.USD;
      keys[c] = keys.USD!;
    }
  for (const c of want) if (!rates[c]) notes.push(`no ${c}→${base} rate: positions in ${c} are left out of the total`);
  return { datasets, rates, keys, notes };
}

/**
 * Load, price and weigh a book. Registers into `f`: the ledger dataset
 * (quantities, average costs, cash), one quote dataset per symbol, the FX
 * dataset, and the derived value and weight of every position and the total.
 * With `dayChange`, each quote dataset also carries the last session's change
 * (off by default: the other analyses' evidence ids stay as they were).
 */
export async function loadMarkedBook(bookName: string, f: Findings, now: Date, opts: { dayChange?: boolean } = {}): Promise<MarkedBook> {
  const profile = loadProfile();
  if (!profile) throw new Error("no profile: run `ultrastock profile init` first");
  const txs = readLedger(bookName);
  const book = buildBook(txs);
  const holdings = aggregateHoldings(book, profile);
  if (!holdings.length && !book.cash.length)
    throw new Error(`the ${bookName} book is empty — record a deposit and trades first (\`ultrastock portfolio deposit|add … --book ${bookName}\`)`);
  const day = now.toISOString().slice(0, 10);
  const P = `PORTFOLIO.${bookName}`;
  const ledgerPoints: Point[] = [];
  for (const h of holdings) {
    h.keys.quantity = `${P}.${h.symbol}.quantity`;
    ledgerPoints.push(
      { key: h.keys.quantity, label: `${h.symbol} units held (${bookName} book, all envelopes)`, value: Number(h.quantity.toPrecision(12)), unit: "units" },
      {
        key: `${P}.${h.symbol}.averageCost`,
        label: `${h.symbol} average cost (PMP, fees included)`,
        value: Number(h.averageCost.toPrecision(12)),
        unit: h.currency,
      },
    );
  }
  for (const c of book.cash)
    ledgerPoints.push({
      key: `${P}.cash.${c.account}.${c.currency}`,
      label: `cash on ${c.account} (${c.currency})`,
      value: Number(c.amount.toFixed(2)),
      unit: c.currency,
    });
  f.input({
    kind: "ledger",
    title: `${bookName} book — ledger positions and cash`,
    subject: `portfolio:${bookName}`,
    points: ledgerPoints,
    provenance: { source: "ultrastock-ledger", fetchedAt: now.toISOString(), official: false, asOf: day },
    notes: [`recomputed from ${txs.length} ledger transactions`],
  });

  const priced = holdings.slice(0, MAX_SYMBOLS);
  if (holdings.length > MAX_SYMBOLS)
    f.note(
      `only the first ${MAX_SYMBOLS} of ${holdings.length} symbols are priced (polite fan-out): ${holdings
        .slice(MAX_SYMBOLS)
        .map((h) => h.symbol)
        .join(", ")} left out`,
    );
  // Fetch concurrently, register in symbol order (stable evidence ids on a replay).
  const quotes = await mapLimit(priced, 4, async (h) => {
    try {
      const resolved = await resolveSymbol(h.symbol);
      return { resolved, quote: await getQuote(resolved, now) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  priced.forEach((h, i) => {
    const r = quotes[i]!;
    if ("error" in r) {
      f.note(`could not price ${h.symbol}: ${r.error}`);
      return;
    }
    h.resolved = r.resolved;
    h.instrument = r.resolved.instrument;
    h.assetClass = kindToClass(h.instrument.kind);
    h.isin = h.instrument.isin ?? book.transactions.find((t) => t.symbol === h.symbol && t.isin)?.isin;
    const q = r.quote;
    h.price = q.price;
    h.keys.price = `${h.symbol}.quote.price`;
    const change = opts.dayChange && q.changePct !== undefined && Number.isFinite(q.changePct);
    if (change) {
      h.changePct = q.changePct;
      h.keys.change = `${h.symbol}.quote.changePct`;
    }
    f.input({
      kind: "quote",
      title: `${h.symbol} quote`,
      subject: h.symbol,
      points: [
        { key: h.keys.price, label: `${h.symbol} latest price`, value: q.price, unit: q.instrument.currency },
        ...(change ? [{ key: h.keys.change!, label: `${h.symbol} change over the last session`, value: Number(q.changePct!.toFixed(4)), unit: "%" }] : []),
        { key: `${h.symbol}.instrument.kind`, label: `${h.symbol} instrument kind (${h.instrument.market} listing)`, value: h.instrument.kind },
        ...(h.isin ? [{ key: `${h.symbol}.instrument.isin`, label: `${h.symbol} ISIN`, value: h.isin }] : []),
      ],
      provenance: { ...q.provenance, asOf: q.at.slice(0, 10) },
      notes: q.notes,
    });
    if (q.instrument.currency !== h.currency)
      f.note(`${h.symbol}: quoted in ${q.instrument.currency} but booked in ${h.currency} — the quote currency is used`);
    h.currency = q.instrument.currency;
  });

  const base = profile.baseCurrency;
  const fx = await referenceRates([...holdings.map((h) => h.currency), ...book.cash.map((c) => c.currency)], base);
  for (const d of fx.datasets) f.input(d);
  f.note(...fx.notes);
  const cash = book.cash.map((c) => ({ ...c, amountBase: fx.rates[c.currency] !== undefined ? c.amount * fx.rates[c.currency]! : undefined }));
  const cashKeys = book.cash.map((c) => `${P}.cash.${c.account}.${c.currency}`);
  const cashFx = book.cash.map((c) => fx.keys[c.currency]).filter((k): k is string => !!k);
  const cashBase = cash.reduce((s, c) => s + (c.amountBase ?? 0), 0);
  const totalFrom: string[] = [...cashKeys, ...cashFx];
  let invested = 0;
  for (const h of holdings) {
    const rate = fx.rates[h.currency];
    if (h.price === undefined || rate === undefined) continue;
    h.fx = rate;
    h.keys.fx = fx.keys[h.currency];
    h.valueBase = h.quantity * h.price * rate;
    invested += h.valueBase;
    h.keys.value = f.derive(
      "positions",
      `${P}.${h.symbol}.value`,
      `${h.symbol} position value in ${base}`,
      Number(h.valueBase.toFixed(2)),
      base,
      [h.keys.quantity, h.keys.price!, ...(h.keys.fx ? [h.keys.fx] : [])],
      h.currency === base ? "units × price" : `units × price ÷ (${h.currency} per ${base})`,
    );
    if (h.keys.value) totalFrom.push(h.keys.value);
  }
  const totalBase = invested + cashBase;
  const cashKey = f.derive(
    "positions",
    `${P}.cashTotal`,
    `cash in ${base} (${bookName} book)`,
    Number(cashBase.toFixed(2)),
    base,
    [...cashKeys, ...cashFx, ...ledgerPoints.map((p) => p.key)],
    "Σ cash balances × rate to base",
  );
  const totalKey = f.derive(
    "positions",
    `${P}.total`,
    `portfolio total in ${base} (${bookName} book)`,
    Number(totalBase.toFixed(2)),
    base,
    totalFrom.length ? totalFrom : ledgerPoints.map((p) => p.key),
    "Σ position values + cash",
  );
  for (const h of holdings) {
    if (h.valueBase === undefined || !(totalBase > 0)) continue;
    h.weightPct = (h.valueBase / totalBase) * 100;
    h.keys.weight = f.derive(
      "positions",
      `${P}.${h.symbol}.weight`,
      `${h.symbol} weight in the portfolio`,
      Number(h.weightPct.toFixed(4)),
      "%",
      [h.keys.value!, totalKey!],
      "value ÷ total × 100",
    );
  }
  return {
    profile,
    bookName,
    now,
    txs,
    book,
    holdings,
    cash,
    cashBase,
    totalBase,
    base,
    rates: fx.rates,
    keys: { cash: cashKey ?? ledgerPoints[0]!.key, total: totalKey ?? ledgerPoints[0]!.key, fx: fx.keys },
  };
}
