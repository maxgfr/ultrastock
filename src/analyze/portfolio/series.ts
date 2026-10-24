// The price windows the analyses read, fetched politely and registered: one
// input point per series (its last close, the window in the formula, the
// source's provenance), so every figure computed from a series cites it.
import { mapLimit } from "../../engine.js";
import type { Resolved } from "../../providers/router.js";
import type { Findings } from "./findings.js";
import { type Closes, closesOf, dailyHistory, ecbDailyRates, iso, toBase } from "./history.js";

const DAY = 86_400_000;

export interface BaseSeries {
  symbol: string;
  /** Closes in the base currency (EUR). */
  closes: Closes;
  /** Closes in the listing's currency. */
  local: Closes;
  currency: string;
  /** The registered input point of the series. */
  key: string;
  fxKey?: string;
}

/**
 * Daily closes over the last `days` calendar days for each symbol, converted
 * to EUR with the ECB's daily rates; failures go to the notes. `tag` names the
 * window in the keys ("hist1y", "hist5y").
 */
export async function baseHistories(
  items: ReadonlyArray<{ symbol: string; resolved: Resolved }>,
  days: number,
  tag: string,
  f: Findings,
  now: Date,
): Promise<Map<string, BaseSeries>> {
  const from = new Date(now.getTime() - days * DAY);
  const fetched = await mapLimit(items, 4, async (it) => {
    try {
      return { series: await dailyHistory(it.resolved, from, now, now) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  // Register in the callers' order (stable evidence ids on a replay).
  const got = new Map<string, { local: Closes; currency: string; key: string }>();
  items.forEach((it, i) => {
    const r = fetched[i]!;
    if ("error" in r) {
      f.note(`no ${tag} history for ${it.symbol}: ${r.error}`);
      return;
    }
    const s = r.series;
    const local = closesOf(s);
    if (local.length < 2) {
      f.note(`no ${tag} history for ${it.symbol}: fewer than two closes in the window`);
      return;
    }
    const first = local[0]!;
    const last = local[local.length - 1]!;
    const key = `${it.symbol}.${tag}.lastClose`;
    f.input({
      kind: "history",
      title: `${it.symbol} daily closes since ${iso(from)}`,
      subject: it.symbol,
      points: [
        {
          key,
          label: `${it.symbol} last daily close of the window`,
          value: last.close,
          unit: s.instrument.currency,
          asOf: last.date,
          formula: `${local.length} daily closes from ${first.date} (${first.close}) to ${last.date}${s.adjusted ? ", split-adjusted" : ""}`,
        },
      ],
      provenance: { ...s.provenance, asOf: last.date },
      notes: s.notes,
    });
    if (first.date > iso(new Date(from.getTime() + 10 * DAY))) f.note(`${it.symbol}: history starts ${first.date}, later than the ${iso(from)} asked for`);
    got.set(it.symbol, { local, currency: s.instrument.currency, key });
  });
  const ccys = [...new Set([...got.values()].map((g) => g.currency))];
  let rates = new Map<string, Map<string, number>>();
  let fxKeys: Record<string, string> = {};
  if (ccys.some((c) => c !== "EUR")) {
    try {
      const r = await ecbDailyRates(ccys, Math.ceil((days * 5) / 7) + 15);
      rates = r.rates;
      if (r.dataset) {
        f.input(r.dataset);
        fxKeys = Object.fromEntries(r.dataset.points.map((p) => [p.key.split(".")[2]!, p.key]));
      }
    } catch (e) {
      f.note(`ECB daily rates unavailable (${(e as Error).message}): non-EUR series stay in their own currency`);
    }
  }
  const out = new Map<string, BaseSeries>();
  for (const it of items) {
    const g = got.get(it.symbol);
    if (!g) continue;
    const fxc = g.currency === "USDT" || g.currency === "USDC" || g.currency === "FDUSD" ? "USD" : g.currency;
    const r = g.currency === "EUR" ? undefined : rates.get(g.currency);
    if (g.currency !== "EUR" && !r) f.note(`${it.symbol}: no daily ${g.currency} rate — its returns are in ${g.currency}, not EUR`);
    out.set(it.symbol, { symbol: it.symbol, closes: toBase(g.local, r), local: g.local, currency: g.currency, key: g.key, fxKey: fxKeys[fxc] });
  }
  return out;
}
