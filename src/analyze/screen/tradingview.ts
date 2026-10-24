// `screen --engine tradingview`: a preset's filters sent to TradingView's
// scanner (unofficial, delayed), one market or several merged ("europe" runs
// each country market in turn), then sorted, limited and shown as one dataset
// whose points are the scanner's own figures per match (keys
// `<EXCHANGE:TICKER>.tv.<column>`), names and sectors untrusted.
//
// What is computed here rather than read is labelled with its formula: the
// rank of each match, the magic formula's ranks, the distance from the 52-week
// high. Thresholds on money amounts (market cap, AUM) are in each listing's
// own currency — a merged multi-country screen compares SEK with EUR as is,
// and says so.
import type { Dataset, Point } from "../../core/datasets.js";
import { mapLimit } from "../../engine.js";
import { ecbFx } from "../../providers/macro/ecb.js";
import { tradingviewScan, type TvFilter } from "../../providers/markets/tradingview.js";
import { ProviderError } from "../../providers/types.js";
import { baseFilters, EUROPE_MARKETS, TV_COLUMNS, type TvPreset } from "./presets.js";

/** One scanned instrument: its ticker, the market it came from and its points by column. */
export interface TvMatch {
  ticker: string;
  market: string;
  points: Map<string, Point>;
  /** Figures computed here (ranks, derived ratios), shown after the scanner's. */
  derived: Point[];
}

/** The rows of a `tradingviewScan` dataset, rebuilt from its `<ticker>.tv.<column>` keys, in scan order. */
export function scanMatches(ds: Dataset, market: string): TvMatch[] {
  const byTicker = new Map<string, TvMatch>();
  for (const p of ds.points) {
    const at = p.key.indexOf(".tv.");
    if (at < 0) continue;
    const ticker = p.key.slice(0, at);
    let m = byTicker.get(ticker);
    if (!m) byTicker.set(ticker, (m = { ticker, market, points: new Map(), derived: [] }));
    m.points.set(p.key.slice(at + 4), p);
  }
  return [...byTicker.values()];
}

export const matchNumber = (m: TvMatch, col: string): number | undefined => {
  const v = m.points.get(col)?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** Sort by one column (or a figure computed from the row); rows without it go last. Stable. */
export function sortMatches(matches: readonly TvMatch[], sortBy: string | ((m: TvMatch) => number | undefined), order: "asc" | "desc"): TvMatch[] {
  const dir = order === "asc" ? 1 : -1;
  const value = typeof sortBy === "string" ? (m: TvMatch) => matchNumber(m, sortBy) : sortBy;
  return [...matches].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === undefined || y === undefined) return x === undefined ? (y === undefined ? 0 : 1) : -1;
    return (x - y) * dir;
  });
}

/** Keep the first listing of each ISIN (an ETF trades on several exchanges); rows without an ISIN are kept. */
export function dedupeByIsin(matches: readonly TvMatch[]): TvMatch[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    const isin = m.points.get("isin")?.value;
    if (typeof isin !== "string") return true;
    if (seen.has(isin)) return false;
    seen.add(isin);
    return true;
  });
}

/** Rank 1 = best; ties share the better rank. */
function ranks(values: readonly number[], higherIsBetter: boolean): number[] {
  return values.map((v) => 1 + values.filter((w) => (higherIsBetter ? w > v : w < v)).length);
}

/**
 * Greenblatt's ranking over a pool: earnings yield = 100 / (EV/EBIT), rank by
 * it and by return on capital (here ROIC), add the two ranks, lowest first.
 * Rows lacking either figure are dropped (the scanner filter already requires both).
 */
export function magicFormulaRank(pool: readonly TvMatch[], presetId = "magic-formula"): TvMatch[] {
  const rows = pool.filter((m) => (matchNumber(m, "enterprise_value_to_ebit_ttm") ?? 0) > 0 && matchNumber(m, "return_on_invested_capital") !== undefined);
  const ey = rows.map((m) => 100 / matchNumber(m, "enterprise_value_to_ebit_ttm")!);
  const roc = rows.map((m) => matchNumber(m, "return_on_invested_capital")!);
  const eyRank = ranks(ey, true);
  const rocRank = ranks(roc, true);
  const scored = rows.map((m, i) => {
    const asOf = m.points.get("enterprise_value_to_ebit_ttm")?.asOf;
    const base = `${m.ticker}.screen.${presetId}`;
    const pt = (key: string, label: string, value: number, unit: string, formula: string): Point => ({
      key: `${base}.${key}`,
      label: `${m.ticker} ${label}`,
      value,
      unit,
      formula,
      ...(asOf ? { asOf } : {}),
    });
    const combined = eyRank[i]! + rocRank[i]!;
    return {
      m: {
        ...m,
        derived: [
          ...m.derived,
          pt("earningsYield", "earnings yield EBIT/EV (TTM)", ey[i]!, "%", "100 / enterprise_value_to_ebit_ttm"),
          pt("earningsYieldRank", `earnings-yield rank of ${rows.length}`, eyRank[i]!, "rank", "1 = highest earnings yield in the pool"),
          pt("returnOnCapitalRank", `return-on-capital rank of ${rows.length}`, rocRank[i]!, "rank", "1 = highest return_on_invested_capital in the pool"),
          pt("combinedRank", "magic-formula combined rank", combined, "rank", "earningsYieldRank + returnOnCapitalRank (lower is better)"),
        ],
      },
      combined,
      ey: ey[i]!,
    };
  });
  scored.sort((a, b) => a.combined - b.combined || b.ey - a.ey);
  return scored.map((s) => s.m);
}

export interface FxRate {
  rate: number;
  date?: string;
}

/** ECB reference rates (units per euro) from an `ecbFx` dataset, by currency. */
export function ratesFromEcb(ds: Dataset): Map<string, FxRate> {
  const out = new Map<string, FxRate>([["EUR", { rate: 1 }]]);
  for (const p of ds.points) {
    const m = /^EUR\.fx\.([A-Z]{3})$/.exec(p.key);
    if (m && typeof p.value === "number" && p.value > 0) out.set(m[1]!, { rate: p.value, ...(p.asOf ? { date: p.asOf } : {}) });
  }
  return out;
}

/** A money column of a match in euros: its value divided by the ECB rate of its unit's currency. */
export function eurValue(m: TvMatch, col: string, rates: ReadonlyMap<string, FxRate>): number | undefined {
  const p = m.points.get(col);
  if (!p || typeof p.value !== "number" || !p.unit) return undefined;
  const r = rates.get(p.unit);
  return r ? p.value / r.rate : undefined;
}

/** The scanner markets behind a --market value: "europe" fans out, "crypto" is TradingView's one-row-per-coin market. */
export function scannerMarkets(market: string): string[] {
  const m = market.toLowerCase();
  if (m === "europe") return EUROPE_MARKETS;
  if (m === "crypto") return ["coin"];
  if (!/^[a-z0-9_]+$/.test(m))
    throw new ProviderError("tradingview", `"${market}" is not a TradingView scanner market (america, france, germany, uk, europe, crypto…)`, 400);
  return [m];
}

/** `field` ascending, `-field` descending (crible's convention). */
export function parseSort(sort: string | undefined, fallback: TvPreset["sort"]): TvPreset["sort"] {
  if (!sort) return fallback;
  const desc = sort.startsWith("-");
  const col = desc ? sort.slice(1) : sort;
  if (!/^[A-Za-z0-9_.|]+$/.test(col)) throw new ProviderError("tradingview", `--sort "${sort}" is not a column name (e.g. -market_cap_basic, RSI)`, 400);
  return { sortBy: col, sortOrder: desc ? "desc" : "asc" };
}

/** The shown points of one match, relabelled and given units from the preset's column table. */
function matchPoints(m: TvMatch, columns: readonly string[]): Point[] {
  const cur = m.points.get("currency")?.value;
  const fund = m.points.get("fundamental_currency_code")?.value;
  const out: Point[] = [];
  for (const col of columns) {
    const p = m.points.get(col);
    if (!p) continue;
    const info = TV_COLUMNS[col];
    const unit =
      p.unit ??
      (info?.unit === "price"
        ? typeof cur === "string"
          ? cur
          : undefined
        : info?.unit === "fundamental"
          ? typeof fund === "string"
            ? fund
            : typeof cur === "string"
              ? cur
              : undefined
          : info?.unit);
    out.push({ ...p, label: `${m.ticker} ${info?.label ?? col}`, ...(unit ? { unit } : {}) });
  }
  return out;
}

const HINT_KIND = 'ETF whose name contains "PEA" — hint only';

export interface TvScreenOptions {
  market?: string;
  limit?: number;
  sort?: string;
}

interface MarketScan {
  market: string;
  ds: Dataset;
  matches: TvMatch[];
}

/**
 * Run a preset over one or several markets: one dataset, matches sorted and
 * limited — plus the ECB rates dataset when a money-valued sort had to compare
 * listings in several currencies (sorted on euro values).
 */
export async function tradingviewScreen(preset: TvPreset, opts: TvScreenOptions = {}): Promise<Dataset[]> {
  const marketArg = (opts.market ?? preset.defaultMarket).toLowerCase();
  const markets = scannerMarkets(marketArg);
  if (markets[0] === "coin" && !preset.crypto)
    throw new ProviderError(
      "tradingview",
      `preset ${preset.id} screens ${preset.assets === "etf" ? "ETFs" : "stocks"}; on --market crypto only "momentum" applies`,
      400,
    );
  const limit = opts.limit ?? 25;
  const sort = parseSort(opts.sort, preset.sort);
  const crypto = markets[0] === "coin";
  const swapCap = (c: string) => (crypto && c === "market_cap_basic" ? "market_cap_calc" : c);
  const shown = [...new Set(["description", "close", ...preset.columns.map(swapCap), swapCap(sort.sortBy)])];
  const columns = [...new Set([...shown, "currency", "fundamental_currency_code", "isin"])];
  const sortBy = swapCap(sort.sortBy);
  const fetchRows = preset.pool ?? (preset.assets === "etf" ? limit * 3 : limit);
  const notes: string[] = [];
  const failures: string[] = [];

  const scanOne = async (market: string, filter: TvFilter[], over: { columns?: string[]; sort?: TvPreset["sort"] } = {}): Promise<MarketScan | undefined> => {
    try {
      const ds = await tradingviewScan(market, {
        filter,
        columns: over.columns ?? columns,
        sort: over.sort ?? { sortBy, sortOrder: sort.sortOrder },
        range: [0, fetchRows],
      });
      return { market, ds, matches: scanMatches(ds, market) };
    } catch (e) {
      if (markets.length === 1) throw e;
      failures.push(`${market}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const scans = (await mapLimit(markets, 4, (market) => scanOne(market, [...baseFilters(preset.assets, market), ...preset.filter]))).filter(
    (s): s is MarketScan => s !== undefined,
  );
  if (!scans.length) throw new ProviderError("tradingview", `no market answered — ${failures.join("; ")}`, 0);

  let matches = scans.flatMap((s) => s.matches);
  // A money sort over several currencies compares euros, at ECB reference rates (registered alongside).
  const moneySort = TV_COLUMNS[sortBy]?.unit === "price" || TV_COLUMNS[sortBy]?.unit === "fundamental";
  const sortCcys = new Set(matches.map((m) => m.points.get(sortBy)?.unit).filter((u): u is string => typeof u === "string"));
  let fx: Dataset | undefined;
  let rates: Map<string, FxRate> | undefined;
  if (preset.id !== "magic-formula" && moneySort && sortCcys.size > 1) {
    try {
      fx = await ecbFx(
        [...sortCcys].filter((c) => c !== "EUR"),
        5,
      );
      rates = ratesFromEcb(fx);
    } catch (e) {
      failures.push(`ECB reference rates (${(e as Error).message}) — sorted on raw values in mixed currencies`);
    }
  }
  if (preset.id === "magic-formula") matches = magicFormulaRank(matches, preset.id);
  else matches = sortMatches(matches, rates ? (m) => eurValue(m, sortBy, rates!) : sortBy, sort.sortOrder);
  if (preset.assets === "etf") matches = dedupeByIsin(matches);
  const total = scans.reduce((n, s) => n + Number(s.ds.points.find((p) => p.key.endsWith(".scan.matches"))?.value ?? 0), 0);
  const picked = matches.slice(0, limit);

  // PEA: ETFs whose name mentions PEA, listed in Paris — a hint, never a verdict.
  let hints: TvMatch[] = [];
  const hintColumns = ["description", "close", "isin", "aum", "expense_ratio"];
  if (preset.id === "pea-candidates" && (marketArg === "europe" || marketArg === "france")) {
    const etf = await scanOne(
      "france",
      [
        { left: "typespecs", operation: "has", right: ["etf"] },
        { left: "description", operation: "match", right: "PEA" },
      ],
      { columns: [...hintColumns, "currency", "fundamental_currency_code"], sort: { sortBy: "aum", sortOrder: "desc" } },
    ).catch((e: Error) => {
      failures.push(`france ETFs: ${e.message}`);
      return undefined;
    });
    hints = dedupeByIsin(sortMatches(etf?.matches ?? [], "aum", "desc")).slice(0, limit);
    if (etf) notes.push(`${hints.length} ETF(s) listed in Paris whose name contains "PEA" — a naming hint only, not proof of PEA eligibility`);
  }

  const first = scans[0]!.ds;
  const day = first.provenance.asOf ?? first.provenance.fetchedAt.slice(0, 10);
  const points: Point[] = [
    {
      key: `TV.${marketArg}.screen.${preset.id}.matches`,
      label: `TradingView ${marketArg} matches for screen ${preset.id}`,
      value: total,
      unit: "count",
      asOf: day,
      ...(scans.length > 1 ? { formula: `sum of the scanner's match counts over ${scans.map((s) => s.market).join(", ")}` } : {}),
    },
  ];
  const rankLabel =
    preset.id === "magic-formula" ? "combined magic-formula rank, then earnings yield" : `${sortBy} ${sort.sortOrder === "asc" ? "ascending" : "descending"}`;
  const push = (list: TvMatch[], cols: readonly string[], kind?: string) =>
    list.forEach((m, i) => {
      const base = `${m.ticker}.screen.${preset.id}`;
      points.push({
        key: `${base}.rank`,
        label: `${m.ticker} position in screen ${preset.id}`,
        value: i + 1,
        unit: "rank",
        asOf: day,
        formula: `order by ${rankLabel}`,
      });
      if (kind) points.push({ key: `${base}.kind`, label: `${m.ticker} kind of match`, value: kind, asOf: day });
      points.push(...matchPoints(m, cols), ...m.derived);
      const sp = m.points.get(sortBy);
      const r = rates && sp?.unit ? rates.get(sp.unit) : undefined;
      if (rates && kind !== HINT_KIND && sp && sp.unit !== "EUR" && r) {
        const eur = eurValue(m, sortBy, rates);
        if (eur !== undefined)
          points.push({
            key: `${base}.${sortBy}.EUR`,
            label: `${m.ticker} ${TV_COLUMNS[sortBy]?.label ?? sortBy} in euros`,
            value: eur,
            unit: "EUR",
            asOf: day,
            formula: `${m.ticker}.tv.${sortBy} / EUR.fx.${sp.unit} (ECB reference rate${r.date ? ` of ${r.date}` : ""})`,
          });
      }
      if (preset.id === "breakout-52w") {
        const close = matchNumber(m, "close");
        const high = matchNumber(m, "price_52_week_high");
        if (close !== undefined && high)
          points.push({
            key: `${base}.fromHigh`,
            label: `${m.ticker} distance from the 52-week high`,
            value: (close / high - 1) * 100,
            unit: "%",
            asOf: day,
            formula: "(close / price_52_week_high − 1) × 100",
          });
      }
    });
  if (preset.id === "pea-candidates") {
    push(picked, shown, "stock of an EU/EEA company — candidate, confirm PEA eligibility with the broker");
    push(hints, hintColumns, HINT_KIND);
  } else push(picked, shown);

  notes.push(`showing ${picked.length} of ${total} matches${scans.length > 1 ? ` across ${scans.length} markets` : ""}, ordered by ${rankLabel}`);
  if (preset.id === "pea-candidates") notes.push("candidates: PEA eligibility must be confirmed with the broker");
  for (const a of preset.approximations ?? []) notes.push(`approximation: ${a}`);
  const currencies = new Set(picked.map((m) => m.points.get("currency")?.value).filter((c) => typeof c === "string"));
  if (rates) notes.push(`${sortBy} compared in euros at ECB reference rates (dataset "ECB euro foreign exchange reference rates")`);
  if (currencies.size > 1)
    notes.push(
      `listings in ${currencies.size} currencies (${[...currencies].join(", ")}): money thresholds (market cap, AUM) apply in each listing's own currency, without FX conversion`,
    );
  if (!picked.some((m) => matchNumber(m, sortBy) !== undefined) && picked.length && preset.id !== "magic-formula")
    notes.push(`no match carries a value for the sort column "${sortBy}" — check the column name`);
  for (const f of failures) notes.push(`unavailable — ${f}`);
  notes.push("unofficial endpoint (TradingView's screener backend); delayed snapshot");

  const screen: Dataset = {
    kind: "screen",
    title: `Screen ${preset.id} — TradingView ${marketArg}`,
    subject: marketArg,
    points,
    provenance: { ...first.provenance, asOf: day },
    notes,
  };
  return fx ? [screen, fx] : [screen];
}
