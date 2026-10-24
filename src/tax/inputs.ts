// What the tax engine needs from the network, fetched once per report: ECB
// reference rates for every currency of the ledger over its whole history
// (the rate of each transaction's date, the last fixing before a weekend),
// the crypto portfolio's value at each taxable disposal (holdings replayed
// from the ledger, priced at that day's close on Binance), and today's
// prices for the harvest scan.
import { fetchJson } from "../core/net.js";
import type { Envelope } from "../core/profile.js";
import type { Transaction } from "../portfolio/ledger.js";
import { getHistory, getQuote, resolveSymbol } from "../providers/router.js";
import { day, envelopeOf, type Fx, gross, isFiat, isStablecoin, splitPair } from "./regime.js";

const FRANKFURTER = "https://api.frankfurter.dev/v1";

/** Rates for `currencies` into `base` from `from` to `to`, as a lookup (last fixing at or before the date). */
export async function historicalFx(base: string, currencies: readonly string[], from: string, to: string): Promise<{ fx: Fx; notes: string[] }> {
  const want = [...new Set(currencies.map((c) => (isStablecoin(c) ? (c.startsWith("EUR") ? "EUR" : "USD") : c.toUpperCase())))].filter(
    (c) => c !== base && isFiat(c),
  );
  const table = new Map<string, Array<[string, number]>>();
  const notes: string[] = [];
  if (want.length) {
    const start = new Date(Date.parse(`${from}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    const res = await fetchJson<{ rates: Record<string, Record<string, number>> }>(`${FRANKFURTER}/${start}..${to}?base=${base}&symbols=${want.join(",")}`, {
      maxBytes: 16 * 1024 * 1024,
    });
    if (!res.ok || !res.data) throw new Error(`ECB rates via Frankfurter unavailable (${res.status}): the tax report needs them`);
    for (const d of Object.keys(res.data.rates).sort())
      for (const [c, v] of Object.entries(res.data.rates[d] ?? {})) {
        const list = table.get(c) ?? [];
        // Frankfurter gives units of c per one base; the engine wants base per one c.
        list.push([d, 1 / v]);
        table.set(c, list);
      }
    notes.push(`ECB reference rates (via Frankfurter) for ${want.join(", ")} → ${base}, ${start} to ${to}; a weekend or holiday takes the previous fixing`);
  }
  const fx: Fx = (currency, date) => {
    const c = currency.toUpperCase();
    if (c === base) return 1;
    const list = table.get(c);
    if (!list?.length) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    if (list[0]![0] > date) return undefined;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid]![0] <= date) lo = mid;
      else hi = mid - 1;
    }
    return list[lo]![1];
  };
  return { fx, notes };
}

/** Crypto holdings by asset just before transaction `upTo` (ledger order). */
export function cryptoHoldings(txs: readonly Transaction[], envelopes: readonly Envelope[], upTo?: Transaction): Map<string, number> {
  const h = new Map<string, number>();
  const add = (a: string, q: number) => h.set(a, (h.get(a) ?? 0) + q);
  const sorted = txs.map((t, i) => ({ t, i })).sort((a, b) => day(a.t.date).localeCompare(day(b.t.date)) || a.i - b.i);
  for (const { t } of sorted) {
    if (t === upTo) break;
    if (upTo && day(t.date) > day(upTo.date)) break;
    if (envelopeOf(t.account, envelopes, t.symbol).type !== "CRYPTO") continue;
    const q = t.quantity ?? 0;
    const cur = t.currency.toUpperCase();
    if (t.type === "buy" || t.type === "sell") {
      const { base } = splitPair(t.symbol ?? "", cur);
      const sign = t.type === "buy" ? 1 : -1;
      add(base, sign * q);
      if (!isFiat(cur)) add(cur, -sign * gross(t) - (t.fee ?? 0));
    } else if (t.type === "transfer-in" || t.type === "transfer-out") {
      add(splitPair(t.symbol ?? cur, cur).base, (t.type === "transfer-in" ? 1 : -1) * q);
    } else if (!isFiat(cur) && typeof t.amount === "number") add(cur, t.amount);
  }
  for (const [k, v] of h) if (Math.abs(v) < 1e-12) h.delete(k);
  return h;
}

/**
 * A valuer for the French global formula: the portfolio's value (in fx's currency) at each
 * taxable disposal. Each asset is priced at its daily close on the disposal day
 * (USDT pair, converted with the ECB USD rate); stablecoins at their peg.
 */
export async function cryptoValuer(
  txs: readonly Transaction[],
  envelopes: readonly Envelope[],
  dates: readonly string[],
  fx: Fx,
): Promise<{ value: (date: string, tx?: Transaction) => number | undefined; notes: string[] }> {
  const notes: string[] = [];
  if (!dates.length) return { value: () => undefined, notes };
  const assets = new Set<string>();
  for (const t of txs) {
    if (envelopeOf(t.account, envelopes, t.symbol).type !== "CRYPTO") continue;
    if (t.symbol) assets.add(splitPair(t.symbol, t.currency).base);
    if (!isFiat(t.currency)) assets.add(t.currency.toUpperCase());
  }
  const first = [...dates].sort()[0]!;
  const last = [...dates].sort().at(-1)!;
  const closes = new Map<string, Map<string, number>>();
  for (const a of assets) {
    if (isStablecoin(a)) continue;
    try {
      const series = await getHistory(await resolveSymbol(`${a}USDT`), {
        from: new Date(Date.parse(`${first}T00:00:00Z`) - 5 * 86_400_000),
        to: new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000),
      });
      closes.set(a, new Map(series.bars.map((b) => [b.date.slice(0, 10), b.close])));
    } catch (e) {
      notes.push(`${a}: no USDT price history (${(e as Error).message}) — the portfolio value omits it`);
    }
  }
  notes.push(
    "crypto portfolio valued at each asset's daily close (USDT pair, ECB USD rate) on the disposal day — the law asks for the value at the moment of the disposal: keep the platforms' statements",
  );
  const value = (date: string, tx?: Transaction) => {
    const h = cryptoHoldings(txs, envelopes, tx);
    const usd = fx("USD", date);
    if (usd === undefined) return undefined;
    let total = 0;
    for (const [a, q] of h) {
      if (q <= 0) continue;
      if (isStablecoin(a)) {
        total += q * (a.startsWith("EUR") ? (fx("EUR", date) ?? 1) : usd);
        continue;
      }
      const m = closes.get(a);
      if (!m) return undefined;
      let px: number | undefined;
      for (let i = 0; i < 6 && px === undefined; i++) px = m.get(new Date(Date.parse(`${date}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10));
      if (px === undefined) return undefined;
      total += q * px * usd;
    }
    return total;
  };
  return { value, notes };
}

/** Today's price of each symbol in its own currency; failures are named. */
export async function currentPrices(symbols: readonly string[]): Promise<{ prices: Record<string, number>; notes: string[] }> {
  const prices: Record<string, number> = {};
  const notes: string[] = [];
  for (const s of symbols) {
    try {
      prices[s.toUpperCase()] = (await getQuote(await resolveSymbol(s))).price;
    } catch (e) {
      notes.push(`${s}: no price (${(e as Error).message})`);
    }
  }
  return { prices, notes };
}
