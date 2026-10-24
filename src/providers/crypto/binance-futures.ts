// Positioning on Binance USDT-margined perpetual futures — keyless, official
// for the venue (the deepest crypto derivatives book), real time:
//
//   /fapi/v1/premiumIndex?symbol=             mark and index price, last funding rate, next funding time
//   /fapi/v1/fundingRate?symbol=&limit=       funding history (every 8 h on most pairs)
//   /fapi/v1/openInterest?symbol=             open interest now, in coins
//   /futures/data/openInterestHist            open interest history (coins and USD), last 30 days only
//   /futures/data/globalLongShortAccountRatio share of accounts net long vs net short
//   /futures/data/topLongShortPositionRatio   the same for the top 20 % of traders by margin, by position size
//   /futures/data/takerlongshortRatio         taker buy vs sell volume
//
// The /futures/data endpoints keep 30 days and allow 1000 requests / 5 min per
// IP. Binance refuses some jurisdictions with HTTP 451 (the US among them):
// that is a definitive refusal, reported as such, never routed around.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";

const BASE = "https://fapi.binance.com";
export const SOURCE = "binance-futures";
const PACE = { hostIntervalMs: 250 };

export type RatioPeriod = "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";

/** BTC → BTCUSDT, ETH-USDT → ETHUSDT: the USDT-M perpetual for a user symbol. */
export function perpSymbol(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[-/_]/g, "");
  if (s.endsWith("USDT") || s.endsWith("USDC")) return s;
  return `${s.replace(/USD$/, "")}USDT`;
}

/** The coin a perpetual is on: BTCUSDT → BTC. */
const baseOf = (pair: string) => pair.replace(/(USDT|USDC)$/, "");

/** The ProviderError for a failed call: 451 is a jurisdiction refusal, 400 an unknown symbol. */
export function futuresFailure(status: number, pair: string, path: string, error?: string): ProviderError {
  if (status === 451)
    return new ProviderError(
      SOURCE,
      `Binance refuses requests from this location (HTTP 451) for ${pair}: futures data is unavailable in this jurisdiction from here — not circumvented`,
      451,
    );
  if (status === 400) return new ProviderError(SOURCE, `${pair} is not a Binance USDT-M perpetual`, 400);
  return new ProviderError(SOURCE, `${path} for ${pair} failed (${status}${error ? `, ${error}` : ""})`, status);
}

async function get<T>(path: string, pair: string): Promise<{ data: T; url: string; fetchedAt: string }> {
  const res = await fetchJson<T>(`${BASE}${path}`, PACE);
  if (!res.ok || res.data === undefined) throw futuresFailure(res.status, pair, path.split("?")[0]!, res.error);
  return { data: res.data, url: res.url, fetchedAt: res.fetchedAt };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

/** Funding as a percent per interval, and annualised over `intervalsPerYear` (3 × 365 for 8-hourly funding). */
export function premiumPoints(p: PremiumIndex, intervalsPerYear = 3 * 365): Point[] {
  const b = baseOf(p.symbol);
  const mark = Number(p.markPrice);
  const index = Number(p.indexPrice);
  const funding = Number(p.lastFundingRate) * 100;
  const asOf = isoDay(p.time);
  return [
    { key: `${b}.deriv.mark.binance`, label: `${p.symbol} perpetual mark price (Binance)`, value: mark, unit: "USDT", asOf },
    { key: `${b}.deriv.index.binance`, label: `${p.symbol} index price (Binance)`, value: index, unit: "USDT", asOf },
    {
      key: `${b}.deriv.basis.binance`,
      label: `${p.symbol} perpetual premium over index (Binance)`,
      value: ((mark - index) / index) * 100,
      unit: "%",
      asOf,
      formula: "(mark − index) / index × 100",
    },
    { key: `${b}.deriv.funding.binance`, label: `${p.symbol} current funding rate per 8h (Binance)`, value: funding, unit: "%", asOf },
    {
      key: `${b}.deriv.funding.binance.annualized`,
      label: `${p.symbol} funding rate annualised (Binance)`,
      value: funding * intervalsPerYear,
      unit: "%",
      asOf,
      formula: `funding % per interval × ${intervalsPerYear}`,
    },
    { key: `${b}.deriv.funding.binance.next`, label: `${p.symbol} next funding time (Binance)`, value: new Date(p.nextFundingTime).toISOString(), asOf },
  ].filter((pt) => typeof pt.value === "string" || Number.isFinite(pt.value));
}

/** The mean funding over a history, in percent per interval. */
export function meanFunding(rows: ReadonlyArray<{ fundingRate: string }>): number | undefined {
  const xs = rows.map((r) => Number(r.fundingRate)).filter(Number.isFinite);
  return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 : undefined;
}

export interface RatioRow {
  longShortRatio?: string;
  longAccount?: string;
  shortAccount?: string;
  buySellRatio?: string;
  buyVol?: string;
  sellVol?: string;
  timestamp: number;
}

/**
 * Positioning on a USDT-M perpetual: mark/index/funding, funding history,
 * open interest (now and its 30-day change), the long/short ratios and the
 * taker buy/sell ratio. Each endpoint is its own dataset.
 */
export async function binanceFuturesPositioning(symbol: string, opts: { period?: RatioPeriod; days?: number; fundingLimit?: number } = {}): Promise<Dataset[]> {
  const pair = perpSymbol(symbol);
  const b = baseOf(pair);
  const period = opts.period ?? "1d";
  const days = Math.min(30, opts.days ?? 30);
  const prov = (r: { url: string; fetchedAt: string }, asOf?: string) => ({
    source: SOURCE,
    url: r.url,
    fetchedAt: r.fetchedAt,
    delay: "realtime",
    official: true,
    ...(asOf ? { asOf } : {}),
  });
  const out: Dataset[] = [];

  const prem = await get<PremiumIndex>(`/fapi/v1/premiumIndex?symbol=${pair}`, pair);
  const fund = await get<Array<{ fundingTime: number; fundingRate: string }>>(`/fapi/v1/fundingRate?symbol=${pair}&limit=${opts.fundingLimit ?? 90}`, pair);
  const fp = premiumPoints(prem.data);
  const mean = meanFunding(fund.data);
  const lastFunding = fund.data[fund.data.length - 1];
  if (mean !== undefined && lastFunding)
    fp.push({
      key: `${b}.deriv.funding.binance.mean`,
      label: `${pair} mean funding rate over the last ${fund.data.length} intervals (since ${isoDay(fund.data[0]!.fundingTime)})`,
      value: mean,
      unit: "%",
      asOf: isoDay(lastFunding.fundingTime),
      formula: "mean of settled funding rates × 100",
    });
  out.push({
    kind: "derivatives",
    title: `${pair} perpetual: price and funding (Binance)`,
    subject: b,
    points: fp,
    provenance: prov(prem, isoDay(prem.data.time)),
    notes: ["positive funding: longs pay shorts (demand for leverage on the long side)"],
  });

  const oi = await get<{ openInterest: string; time: number }>(`/fapi/v1/openInterest?symbol=${pair}`, pair);
  const hist = await get<Array<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }>>(
    `/futures/data/openInterestHist?symbol=${pair}&period=1d&limit=${days}`,
    pair,
  );
  const oiPoints: Point[] = [
    { key: `${b}.deriv.oi.binance`, label: `${pair} open interest (Binance)`, value: Number(oi.data.openInterest), unit: b, asOf: isoDay(oi.data.time) },
  ];
  const h0 = hist.data[0];
  const h1 = hist.data[hist.data.length - 1];
  if (h1)
    oiPoints.push({
      key: `${b}.deriv.oi.binance.usd`,
      label: `${pair} open interest value (Binance, daily)`,
      value: Number(h1.sumOpenInterestValue),
      unit: "USD",
      asOf: isoDay(h1.timestamp),
    });
  if (h0 && h1 && h0 !== h1 && Number(h0.sumOpenInterest) > 0)
    oiPoints.push({
      key: `${b}.deriv.oi.binance.change`,
      label: `${pair} open interest change since ${isoDay(h0.timestamp)} (Binance)`,
      value: (Number(h1.sumOpenInterest) / Number(h0.sumOpenInterest) - 1) * 100,
      unit: "%",
      asOf: isoDay(h1.timestamp),
      formula: "(OI last / OI first − 1) × 100, in coins",
    });
  out.push({
    kind: "derivatives",
    title: `${pair} open interest (Binance)`,
    subject: b,
    points: oiPoints,
    provenance: prov(oi, isoDay(oi.data.time)),
    notes: ["open interest in coins; the USD value is Binance's daily snapshot"],
  });

  const ratios: Array<[string, string, string, string]> = [
    ["globalLongShortAccountRatio", "ls.accounts", "long/short account ratio (all accounts)", "longShortRatio"],
    ["topLongShortPositionRatio", "ls.top", "long/short position ratio (top traders)", "longShortRatio"],
    ["takerlongshortRatio", "taker", "taker buy/sell volume ratio", "buySellRatio"],
  ];
  const rp: Point[] = [];
  let rprov: ReturnType<typeof prov> | undefined;
  for (const [ep, key, what, field] of ratios) {
    const r = await get<RatioRow[]>(`/futures/data/${ep}?symbol=${pair}&period=${period}&limit=2`, pair);
    rprov ??= prov(r);
    const last = r.data[r.data.length - 1];
    const v = last ? Number(last[field as keyof RatioRow]) : Number.NaN;
    if (!last || !Number.isFinite(v)) continue;
    rp.push({ key: `${b}.deriv.${key}.binance`, label: `${pair} ${what}, ${period} (Binance)`, value: v, unit: "ratio", asOf: isoDay(last.timestamp) });
    if (last.longAccount !== undefined)
      rp.push({
        key: `${b}.deriv.${key}.binance.long`,
        label: `${pair} share long, ${what} (Binance)`,
        value: Number(last.longAccount) * 100,
        unit: "%",
        asOf: isoDay(last.timestamp),
      });
  }
  if (rp.length && rprov)
    out.push({
      kind: "derivatives",
      title: `${pair} long/short and taker ratios (Binance)`,
      subject: b,
      points: rp,
      provenance: rprov,
      notes: ["ratios describe Binance's own users only; a crowded side is a contrarian signal at best, not a forecast"],
    });
  return out;
}
