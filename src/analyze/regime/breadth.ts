// Breadth and sector tables from TradingView's screener (unofficial, delayed):
// large caps per market, read back from the scan dataset's points into rows,
// then counted (% above the 200-day) or grouped by sector. TradingView's
// sector names are external text: they are only used through the fixed table
// below (its labels are ours); a sector outside it is counted under "other".
import type { Dataset } from "../../core/datasets.js";
import { mapLimit } from "../../engine.js";
import { tradingviewScan, type TvFilter } from "../../providers/markets/tradingview.js";
import { FETCH_CONCURRENCY } from "./common.js";

/** The euro-area markets read for European breadth (≈ the Euro Stoxx's home markets). */
export const EU_MARKETS = ["france", "germany", "netherlands", "italy", "spain"] as const;
/** Large-cap floors: US $10 bn, Europe €5 bn (in the market's own currency, as TradingView reports it). */
export const US_LARGE_CAP = 10e9;
export const EU_LARGE_CAP = 5e9;
/** Rows read per market (largest first) — Germany, the largest, has ≈ 70 primary listings above €5 bn. */
export const EU_ROWS_PER_MARKET = 300;

/** Primary common-stock listings above a market cap: no ADRs on a second venue, no preferreds, no funds. */
export const largeCapFilter = (cap: number): TvFilter[] => [
  { left: "market_cap_basic", operation: "greater", right: cap },
  { left: "type", operation: "equal", right: "stock" },
  { left: "is_primary", operation: "equal", right: true },
];

export interface TvStockRow {
  ticker: string;
  values: Record<string, number | string | boolean>;
}

/** Rows back from a tradingviewScan dataset (`<EXCHANGE:TICKER>.tv.<column>` points), in first-seen order. */
export function rowsFromScan(ds: Dataset): TvStockRow[] {
  const rows = new Map<string, TvStockRow>();
  for (const p of ds.points) {
    const at = p.key.lastIndexOf(".tv.");
    if (at < 0) continue;
    const ticker = p.key.slice(0, at);
    const col = p.key.slice(at + 4);
    let row = rows.get(ticker);
    if (!row) rows.set(ticker, (row = { ticker, values: {} }));
    row.values[col] = p.value;
  }
  return [...rows.values()];
}

/** Share of rows closing above their 200-day average (rows missing either value are left out). */
export function shareAbove200(rows: readonly TvStockRow[]): { above: number; total: number; pct?: number } {
  let above = 0;
  let total = 0;
  for (const r of rows) {
    const c = r.values.close;
    const s = r.values.SMA200;
    if (typeof c !== "number" || typeof s !== "number" || !(s > 0)) continue;
    total++;
    if (c > s) above++;
  }
  return { above, total, pct: total ? (above / total) * 100 : undefined };
}

/**
 * % of stocks above their 200-day as a −1…+1 regime signal: 50 % is neutral,
 * 80 % or more is +1, 20 % or less is −1, linear in between.
 */
export const breadthSignal = (pct: number) => Math.max(-1, Math.min(1, (pct - 50) / 30));

/** Large caps of several markets, ≤ FETCH_CONCURRENCY scans at a time; a market that fails is named. */
export async function largeCapRows(
  markets: readonly string[],
  cap: number,
  columns: readonly string[],
): Promise<{ rows: Array<TvStockRow & { market: string }>; datasets: Dataset[]; failed: string[] }> {
  const res = await mapLimit(markets, FETCH_CONCURRENCY, async (m) => {
    try {
      return {
        m,
        ds: await tradingviewScan(m, {
          filter: largeCapFilter(cap),
          columns,
          sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
          range: [0, EU_ROWS_PER_MARKET],
        }),
      };
    } catch (e) {
      return { m, error: (e as Error).message };
    }
  });
  const rows: Array<TvStockRow & { market: string }> = [];
  const datasets: Dataset[] = [];
  const failed: string[] = [];
  for (const r of res) {
    if ("ds" in r && r.ds) {
      datasets.push(r.ds);
      rows.push(...rowsFromScan(r.ds).map((x) => ({ ...x, market: r.m })));
    } else failed.push(`TradingView ${r.m}: ${"error" in r ? r.error : "no answer"}`);
  }
  return { rows, datasets, failed };
}

/** US large caps above their 200-day by counting two screens (all, and close > SMA200) — two light calls instead of 700 rows. */
export async function usBreadthCount(): Promise<{ above: number; total: number; pct?: number; ds: Dataset }> {
  const base = largeCapFilter(US_LARGE_CAP);
  const all = await tradingviewScan("america", { filter: base, columns: ["close"], range: [0, 1] });
  const up = await tradingviewScan("america", {
    filter: [...base, { left: "close", operation: "greater", right: "SMA200" }],
    columns: ["close"],
    range: [0, 1],
  });
  const total = Number(all.points.find((p) => p.key === "TV.america.scan.matches")?.value ?? 0);
  const above = Number(up.points.find((p) => p.key === "TV.america.scan.matches")?.value ?? 0);
  return { above, total, pct: total > 0 ? (above / total) * 100 : undefined, ds: up };
}

/**
 * TradingView's sector taxonomy → our key and label. Only these names are
 * used in keys and labels; `side` feeds the rotation reading.
 */
export const TV_SECTORS: Record<string, { id: string; label: string; side: "defensive" | "cyclical" | "neutral" }> = {
  "Commercial Services": { id: "commercialServices", label: "commercial services", side: "cyclical" },
  Communications: { id: "communications", label: "communications", side: "defensive" },
  "Consumer Durables": { id: "consumerDurables", label: "consumer durables", side: "cyclical" },
  "Consumer Non-Durables": { id: "consumerNonDurables", label: "consumer non-durables", side: "defensive" },
  "Consumer Services": { id: "consumerServices", label: "consumer services", side: "cyclical" },
  "Distribution Services": { id: "distributionServices", label: "distribution services", side: "neutral" },
  "Electronic Technology": { id: "electronicTechnology", label: "electronic technology", side: "cyclical" },
  "Energy Minerals": { id: "energyMinerals", label: "energy minerals", side: "neutral" },
  Finance: { id: "finance", label: "finance", side: "cyclical" },
  "Health Services": { id: "healthServices", label: "health services", side: "defensive" },
  "Health Technology": { id: "healthTechnology", label: "health technology", side: "defensive" },
  "Industrial Services": { id: "industrialServices", label: "industrial services", side: "cyclical" },
  Miscellaneous: { id: "miscellaneous", label: "miscellaneous", side: "neutral" },
  "Non-Energy Minerals": { id: "nonEnergyMinerals", label: "non-energy minerals", side: "cyclical" },
  "Process Industries": { id: "processIndustries", label: "process industries", side: "cyclical" },
  "Producer Manufacturing": { id: "producerManufacturing", label: "producer manufacturing", side: "cyclical" },
  "Retail Trade": { id: "retailTrade", label: "retail trade", side: "cyclical" },
  "Technology Services": { id: "technologyServices", label: "technology services", side: "cyclical" },
  Transportation: { id: "transportation", label: "transportation", side: "cyclical" },
  Utilities: { id: "utilities", label: "utilities", side: "defensive" },
  Government: { id: "government", label: "government", side: "neutral" },
};
