// Stress tests on today's weights, the pure part: historical windows replayed
// (each holding's own move over the window when it was listed then, a stated
// proxy otherwise) and parametric shocks. Moves are in each series' own
// currency over the window — the currency's own move is the separate USD shock.

/** Historical windows, peak to trough of the named episode. */
export const SCENARIOS = [
  { id: "gfc", label: "Global financial crisis", from: "2008-09-01", to: "2009-03-09" },
  { id: "covid", label: "COVID crash", from: "2020-02-19", to: "2020-03-23" },
  { id: "rates2022", label: "2022 rate shock", from: "2022-01-03", to: "2022-10-12" },
  { id: "crypto2022", label: "Crypto winter", from: "2021-11-10", to: "2022-11-21" },
] as const;
export type ScenarioId = (typeof SCENARIOS)[number]["id"];

/** Parametric shocks, each applied to the holdings it concerns (fractions). */
export const SHOCKS = {
  /** Every equity and equity fund falls 20 %. */
  equities: -0.2,
  /** Rates up one point: a bond fund loses duration × 1 %. */
  ratesUpPct: 1,
  /** The dollar loses 10 % against the euro: USD assets lose 10 % in EUR. */
  usd: -0.1,
  /** Crypto halves. */
  crypto: -0.5,
} as const;

/**
 * Modified duration assumed for a bond fund when no fund-level figure is read:
 * a short-dated fund (1–3 years) ≈ 2, otherwise ≈ 6, roughly an aggregate index.
 */
export function assumedDuration(name: string | undefined): number {
  return /\b(0-1|1-3|0-3)(?=\s*(y|yr|yrs|year|years|an|ans)?\b)|\bshort\b|\bcourt\b/i.test(name ?? "") ? 2 : 6;
}

/** A bond fund, read from its name (no classification source is keyless): bond, treasury, govt, aggregate, obligations. */
export const looksLikeBondFund = (name: string | undefined) =>
  /\b(bond|bonds|treasury|treasuries|govt|government|aggregate|obligation|oblig|credit|corporate|t-bill)\b/i.test(name ?? "");

export interface StressLine {
  symbol: string;
  weight: number;
  /** The move used over the window (fraction), and where it came from. */
  move?: number;
  basis: "own" | "proxy" | "shock" | "none";
  proxy?: string;
}

/** Σ wᵢ × moveᵢ over the lines that have a move; the weight without one is reported. */
export function replay(lines: readonly StressLine[]): { portfolio: number; covered: number; uncovered: number } {
  let portfolio = 0;
  let covered = 0;
  let uncovered = 0;
  for (const l of lines) {
    if (l.move === undefined) uncovered += l.weight;
    else {
      portfolio += l.weight * l.move;
      covered += l.weight;
    }
  }
  return { portfolio, covered, uncovered };
}

export interface ShockInput {
  symbol: string;
  weight: number;
  assetClass: string;
  currency: string;
  name?: string;
}

/** The parametric shocks on today's weights: the loss of each (fraction of the portfolio) and the lines hit. */
export function parametricShocks(items: readonly ShockInput[]): Array<{ id: string; label: string; impact: number; hit: string[]; formula: string }> {
  const equity = items.filter((i) => (i.assetClass === "equity" || i.assetClass === "etf" || i.assetClass === "fund") && !looksLikeBondFund(i.name));
  const bonds = items.filter((i) => (i.assetClass === "etf" || i.assetClass === "fund") && looksLikeBondFund(i.name));
  const usd = items.filter((i) => i.currency === "USD" || i.currency === "USDT" || i.currency === "USDC");
  const crypto = items.filter((i) => i.assetClass === "crypto");
  const sum = (xs: readonly ShockInput[], f: (x: ShockInput) => number) => xs.reduce((s, x) => s + x.weight * f(x), 0);
  return [
    {
      id: "equities",
      label: "equities −20 %",
      impact: sum(equity, () => SHOCKS.equities),
      hit: equity.map((i) => i.symbol),
      formula: "Σ equity and equity-fund weights × −20 %",
    },
    {
      id: "rates",
      label: "rates +1 point on bond funds",
      impact: sum(bonds, (b) => (-assumedDuration(b.name) * SHOCKS.ratesUpPct) / 100),
      hit: bonds.map((i) => i.symbol),
      formula: "Σ bond-fund weights × −(assumed duration × 1 %); duration 2 for 1–3-year funds, 6 otherwise",
    },
    {
      id: "usd",
      label: "USD −10 % vs EUR",
      impact: sum(usd, () => SHOCKS.usd),
      hit: usd.map((i) => i.symbol),
      formula: "Σ weights of USD-priced holdings and USD cash × −10 % (the currency's move, not the asset's)",
    },
    { id: "crypto", label: "crypto −50 %", impact: sum(crypto, () => SHOCKS.crypto), hit: crypto.map((i) => i.symbol), formula: "Σ crypto weights × −50 %" },
  ];
}
