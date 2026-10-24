// The option-chain shape shared by every options source (CBOE for US listed
// options, Deribit for crypto), and the per-expiry summary computed from it:
// at-the-money implied volatility, put/call open-interest and volume ratios,
// total open interest. One shape, so analytics (skew, term structure, max
// pain, gamma exposure) are written once.
import type { Dataset, Point } from "../../core/datasets.js";

export interface OptionContract {
  /** The venue's contract name: an OCC symbol (AAPL261023C00110000) or a Deribit name (BTC-27DEC26-100000-C). */
  contract: string;
  root: string;
  /** Expiry date, YYYY-MM-DD. */
  expiry: string;
  right: "call" | "put";
  strike: number;
  bid?: number;
  ask?: number;
  last?: number;
  mark?: number;
  /** Implied volatility, annualised, in percent (40.4 = 40.4 %). */
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  openInterest: number;
  volume: number;
  /** The underlying the contract prices off (a per-expiry future on Deribit). */
  underlyingPrice?: number;
}

export interface OptionChain {
  /** The underlying as the user knows it: AAPL, SPX, BTC. */
  underlying: string;
  underlyingPrice: number;
  /** The currency strikes are in. */
  strikeCurrency: string;
  /** The currency premiums are quoted in (BTC on Deribit's inverse options). */
  premiumCurrency: string;
  /** When the chain was true (ISO timestamp or date). */
  asOf: string;
  contracts: OptionContract[];
  provenance: Dataset["provenance"];
  notes: string[];
}

export interface ExpirySummary {
  expiry: string;
  daysToExpiry: number;
  /** Strike nearest the underlying, and the mean of the call and put IV there (percent). */
  atmStrike?: number;
  atmIv?: number;
  callOi: number;
  putOi: number;
  callVolume: number;
  putVolume: number;
  /** put OI / call OI; undefined when no call is open. */
  putCallOi?: number;
  putCallVolume?: number;
  totalOi: number;
}

const DAY = 86_400_000;

/** One summary per expiry, nearest first. `now` sets days to expiry. */
export function summarizeChain(chain: Pick<OptionChain, "contracts" | "underlyingPrice">, now: Date): ExpirySummary[] {
  const byExpiry = new Map<string, OptionContract[]>();
  for (const c of chain.contracts) {
    const list = byExpiry.get(c.expiry);
    if (list) list.push(c);
    else byExpiry.set(c.expiry, [c]);
  }
  const out: ExpirySummary[] = [];
  for (const [expiry, cs] of [...byExpiry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sum = (right: OptionContract["right"], f: (c: OptionContract) => number) => cs.filter((c) => c.right === right).reduce((s, c) => s + f(c), 0);
    const callOi = sum("call", (c) => c.openInterest);
    const putOi = sum("put", (c) => c.openInterest);
    const callVolume = sum("call", (c) => c.volume);
    const putVolume = sum("put", (c) => c.volume);
    const spot = cs.find((c) => c.underlyingPrice)?.underlyingPrice ?? chain.underlyingPrice;
    let atmStrike: number | undefined;
    for (const c of cs) if (atmStrike === undefined || Math.abs(c.strike - spot) < Math.abs(atmStrike - spot)) atmStrike = c.strike;
    const ivs = cs.filter((c) => c.strike === atmStrike && c.iv !== undefined && c.iv > 0).map((c) => c.iv!);
    out.push({
      expiry,
      daysToExpiry: Math.max(0, Math.round((Date.parse(`${expiry}T00:00:00Z`) - now.getTime()) / DAY)),
      ...(atmStrike !== undefined ? { atmStrike } : {}),
      ...(ivs.length ? { atmIv: ivs.reduce((a, b) => a + b, 0) / ivs.length } : {}),
      callOi,
      putOi,
      callVolume,
      putVolume,
      ...(callOi > 0 ? { putCallOi: putOi / callOi } : {}),
      ...(callVolume > 0 ? { putCallVolume: putVolume / callVolume } : {}),
      totalOi: callOi + putOi,
    });
  }
  return out;
}

/**
 * The chain as evidence: the underlying, chain-wide totals and, per expiry
 * (the nearest `maxExpiries`), ATM IV, put/call ratios and open interest.
 * Keys: `<UND>.opt.<expiry>.atm_iv`, `<UND>.opt.<expiry>.pc_oi`, `<UND>.opt.oi.total`.
 */
export function chainDataset(chain: OptionChain, source: string, now: Date, maxExpiries = 12): Dataset {
  const u = chain.underlying;
  const summaries = summarizeChain(chain, now);
  const asOf = chain.asOf.slice(0, 10);
  const totalCallOi = summaries.reduce((s, e) => s + e.callOi, 0);
  const totalPutOi = summaries.reduce((s, e) => s + e.putOi, 0);
  const totalCallVol = summaries.reduce((s, e) => s + e.callVolume, 0);
  const totalPutVol = summaries.reduce((s, e) => s + e.putVolume, 0);
  const points: Point[] = [
    { key: `${u}.opt.underlying`, label: `${u} underlying price (${source})`, value: chain.underlyingPrice, unit: chain.strikeCurrency },
    { key: `${u}.opt.oi.total`, label: `${u} total option open interest`, value: totalCallOi + totalPutOi, unit: "contracts" },
    { key: `${u}.opt.volume.total`, label: `${u} total option volume`, value: totalCallVol + totalPutVol, unit: "contracts" },
  ];
  if (totalCallOi > 0)
    points.push({
      key: `${u}.opt.pc_oi`,
      label: `${u} put/call open-interest ratio (all expiries)`,
      value: totalPutOi / totalCallOi,
      unit: "ratio",
      formula: "Σ put OI / Σ call OI",
    });
  if (totalCallVol > 0)
    points.push({
      key: `${u}.opt.pc_volume`,
      label: `${u} put/call volume ratio (all expiries)`,
      value: totalPutVol / totalCallVol,
      unit: "ratio",
      formula: "Σ put volume / Σ call volume",
    });
  for (const e of summaries.slice(0, maxExpiries)) {
    const k = `${u}.opt.${e.expiry}`;
    const at = `${u} ${e.expiry} expiry`;
    if (e.atmIv !== undefined)
      points.push({
        key: `${k}.atm_iv`,
        label: `${at} ATM implied volatility (strike ${e.atmStrike})`,
        value: e.atmIv,
        unit: "%",
        formula: "mean of call and put IV at the strike nearest the underlying",
      });
    if (e.putCallOi !== undefined)
      points.push({ key: `${k}.pc_oi`, label: `${at} put/call open-interest ratio`, value: e.putCallOi, unit: "ratio", formula: "put OI / call OI" });
    if (e.putCallVolume !== undefined)
      points.push({ key: `${k}.pc_volume`, label: `${at} put/call volume ratio`, value: e.putCallVolume, unit: "ratio", formula: "put volume / call volume" });
    points.push({ key: `${k}.oi`, label: `${at} open interest`, value: e.totalOi, unit: "contracts" });
    points.push({ key: `${k}.dte`, label: `${at} days to expiry`, value: e.daysToExpiry, unit: "days" });
  }
  const notes = [...chain.notes];
  if (summaries.length > maxExpiries) notes.push(`${summaries.length} expiries listed; the nearest ${maxExpiries} are summarised`);
  return {
    kind: "options",
    title: `${u} option chain summary (${source})`,
    subject: u,
    points: points.map((p) => ({ ...p, asOf: p.asOf ?? asOf })),
    provenance: chain.provenance,
    notes,
  };
}
