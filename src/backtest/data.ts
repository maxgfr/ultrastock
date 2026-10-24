// Bars for a backtest, through the price router, with the window each source
// can actually serve:
//   - Euronext keeps about two years: a longer window is read from Yahoo
//     (through the router, unofficial, split-adjusted) and the run says so;
//   - Nasdaq's API serves ten years of US daily bars (Yahoo stands in on failure);
//   - Binance REST pages 1000 bars a request: a window longer than 1000 bars
//     goes to the owner's bulk exporter (binance-historical) when it is
//     installed, else to the REST pager (slower, same bars);
//   - funding for perpetual backtests: Binance USDT-M settlement history
//     (/fapi/v1/fundingRate, 1000 settlements a page). Binance refuses some
//     jurisdictions with HTTP 451 — a refusal, reported, never routed around.
import { fetchJson } from "../core/net.js";
import { perpSymbol } from "../providers/crypto/binance-futures.js";
import { binanceHistoricalInfo, bulkKlines } from "../providers/external/binance-historical.js";
import { resolveYahoo } from "../providers/markets/yahoo.js";
import { getHistory, type Resolved, resolveSymbol } from "../providers/router.js";
import { type Interval, type PriceSeries, ProviderError } from "../providers/types.js";
import type { FundingEvent } from "./simulate.js";

const INTERVAL_MS: Record<Interval, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000 };
const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface BarRequest {
  from: Date;
  to: Date;
  interval: Interval;
}

/** The bars of one symbol over the window, with notes on where they came from. */
export async function loadBars(raw: string, req: BarRequest): Promise<{ resolved: Resolved; series: PriceSeries }> {
  const resolved = await resolveSymbol(raw);
  const inst = resolved.instrument;
  if (inst.market === "crypto") {
    const expected = Math.ceil((req.to.getTime() - req.from.getTime()) / INTERVAL_MS[req.interval]);
    if (expected > 1000) {
      const info = binanceHistoricalInfo();
      if (info.installed && info.compatible) {
        const { bars } = await bulkKlines({ pair: inst.venueId, interval: req.interval, start: req.from, end: req.to });
        if (bars.length)
          return {
            resolved,
            series: {
              instrument: inst,
              interval: req.interval,
              bars,
              adjusted: false,
              provenance: { source: "binance", url: "https://data.binance.vision/", fetchedAt: new Date(req.to).toISOString(), delay: "eod", official: true },
              notes: [...resolved.notes, `${bars.length} ${req.interval} bars from the binance-historical bulk export (${info.version ?? "?"})`],
            },
          };
      }
      const series = await getHistory(resolved, req);
      series.notes.push(
        `${series.bars.length} ${req.interval} bars paged from the Binance REST API (1000 a request)${info.installed ? "" : " — install binance-historical for long windows"}`,
      );
      return { resolved, series };
    }
    return { resolved, series: await getHistory(resolved, req) };
  }
  const series = await getHistory(resolved, req);
  const wanted = isoDay(new Date(req.from.getTime() + 7 * DAY));
  if (inst.market === "euronext" && series.bars[0] && series.bars[0].date > wanted) {
    // Euronext stopped short of the window: read it from Yahoo through the router, and say so.
    try {
      const y = await resolveYahoo(inst.symbol);
      const longer = await getHistory({ instrument: { ...y, market: "europe" }, notes: [] }, req);
      if (longer.bars[0] && longer.bars[0].date < series.bars[0].date) {
        return {
          resolved,
          series: {
            ...longer,
            instrument: inst,
            provenance: { ...longer.provenance, fallbackFrom: "euronext" },
            notes: [
              ...longer.notes,
              `Euronext keeps about two years (its bars start ${series.bars[0].date}); the window from ${isoDay(req.from)} was read from Yahoo instead — unofficial, split-adjusted`,
            ],
          },
        };
      }
    } catch (e) {
      series.notes.push(`Euronext keeps about two years and Yahoo could not stand in for the longer window (${(e as Error).message})`);
    }
  }
  return { resolved, series };
}

interface FundingRow {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

/** Binance USDT-M funding settlements between two instants, oldest first. */
export async function fundingHistory(symbol: string, from: Date, to: Date): Promise<{ events: FundingEvent[]; url: string; fetchedAt: string; pair: string }> {
  const pair = perpSymbol(symbol);
  const events: FundingEvent[] = [];
  let start = from.getTime();
  let firstUrl = "";
  let fetchedAt = "";
  for (let page = 0; page < 40 && start < to.getTime(); page++) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&startTime=${start}&endTime=${to.getTime()}&limit=1000`;
    const res = await fetchJson<FundingRow[]>(url, { hostIntervalMs: 250 });
    if (!res.ok || !Array.isArray(res.data)) {
      if (res.status === 451)
        throw new ProviderError("binance-futures", `Binance refuses funding history from this location (HTTP 451) for ${pair} — not circumvented`, 451);
      throw new ProviderError("binance-futures", `funding history for ${pair} failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
    }
    if (!firstUrl) {
      firstUrl = res.url;
      fetchedAt = res.fetchedAt;
    }
    for (const r of res.data) {
      const rate = Number(r.fundingRate);
      if (Number.isFinite(rate)) events.push({ time: r.fundingTime, rate });
    }
    if (res.data.length < 1000) break;
    start = res.data[res.data.length - 1]!.fundingTime + 1;
  }
  return { events, url: firstUrl, fetchedAt, pair };
}
