// Portfolio income, the pure part: dividends the ledger recorded (all time and
// the last 12 months), the forward 12-month estimate per holding from a
// per-share rate (Nasdaq's annualised dividend for US listings, else the
// trailing 12 months' per-share dividends Yahoo lists), and the yield on cost.
// A forward figure is an estimate: dividends get cut, raised and skipped.
import type { Transaction } from "../../portfolio/ledger.js";

/** Dividends recorded in the ledger per symbol (trade currency): all time and over the 12 months before `asOf`. */
export function ledgerDividends(
  txs: readonly Transaction[],
  asOf: string,
): Map<string, { currency: string; total: number; last12m: number; count12m: number }> {
  const cutoff = new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  const out = new Map<string, { currency: string; total: number; last12m: number; count12m: number }>();
  for (const t of txs) {
    if (t.type !== "dividend" || !t.symbol || typeof t.amount !== "number") continue;
    const e = out.get(t.symbol) ?? { currency: t.currency, total: 0, last12m: 0, count12m: 0 };
    e.total += t.amount;
    if (t.date.slice(0, 10) > cutoff && t.date.slice(0, 10) <= asOf) {
      e.last12m += t.amount;
      e.count12m++;
    }
    out.set(t.symbol, e);
  }
  return out;
}

/** Σ per-share dividends with an ex-date in the 12 months up to `asOf`. */
export function trailingPerShare(divs: ReadonlyArray<{ date: string; amount: number }>, asOf: string): { sum: number; count: number } {
  const cutoff = new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  const inWindow = divs.filter((d) => d.date > cutoff && d.date <= asOf);
  return { sum: inWindow.reduce((s, d) => s + d.amount, 0), count: inWindow.length };
}

/** Forward income = units × annual per-share rate; yield on cost = rate ÷ average cost; current yield = rate ÷ price (all fractions). */
export function incomeFigures(units: number, rate: number, averageCost: number, price: number | undefined) {
  return {
    forward: units * rate,
    yieldOnCost: averageCost > 0 ? rate / averageCost : Number.NaN,
    currentYield: price && price > 0 ? rate / price : Number.NaN,
  };
}
