// Fundamental scores and valuation, from one normalised shape of financial
// statements whatever their source (SEC companyfacts, ESEF filings, crible).
// Every score returns its components with a reason each, so an answer can say
// WHY a company scores 7/9, and a missing input is reported as missing — a
// criterion that cannot be computed is never silently scored as a pass or a fail.

/** One fiscal period, in the reporting currency. Undefined = not reported. */
export interface FinancialPeriod {
  /** Period end, YYYY-MM-DD. */
  end: string;
  revenue?: number;
  costOfRevenue?: number;
  grossProfit?: number;
  sga?: number;
  operatingIncome?: number;
  ebit?: number;
  ebitda?: number;
  interestExpense?: number;
  pretaxIncome?: number;
  incomeTax?: number;
  netIncome?: number;
  depreciation?: number;
  operatingCashFlow?: number;
  capex?: number;
  shareBasedComp?: number;
  dividendsPaid?: number;
  totalAssets?: number;
  currentAssets?: number;
  currentLiabilities?: number;
  totalLiabilities?: number;
  longTermDebt?: number;
  totalDebt?: number;
  cash?: number;
  receivables?: number;
  inventory?: number;
  ppe?: number;
  retainedEarnings?: number;
  equity?: number;
  sharesOutstanding?: number;
  /** Diluted EPS. */
  eps?: number;
}

export interface Criterion {
  id: string;
  label: string;
  /** true pass, false fail, undefined not computable. */
  pass?: boolean;
  value?: number;
  reason: string;
}

export interface Score {
  name: string;
  value: number;
  max?: number;
  /** How many components could be computed. */
  computed: number;
  components: Criterion[];
  verdict: string;
}

const div = (a?: number, b?: number) => (a === undefined || b === undefined || b === 0 ? undefined : a / b);
const fcfOf = (p: FinancialPeriod) => (p.operatingCashFlow !== undefined && p.capex !== undefined ? p.operatingCashFlow - Math.abs(p.capex) : undefined);
const gross = (p: FinancialPeriod) => p.grossProfit ?? (p.revenue !== undefined && p.costOfRevenue !== undefined ? p.revenue - p.costOfRevenue : undefined);
const f2 = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(3));

/**
 * Piotroski F-score (2000), nine binary tests on profitability, leverage and
 * efficiency, current year `cur` against the prior year `prev`. 8–9 strong,
 * 0–2 weak. Criteria that cannot be computed are excluded and counted.
 */
export function piotroski(cur: FinancialPeriod, prev: FinancialPeriod): Score {
  const roa = div(cur.netIncome, prev.totalAssets ?? cur.totalAssets);
  const roaPrev = div(prev.netIncome, prev.totalAssets);
  const lev = div(cur.longTermDebt, cur.totalAssets);
  const levPrev = div(prev.longTermDebt, prev.totalAssets);
  const cr = div(cur.currentAssets, cur.currentLiabilities);
  const crPrev = div(prev.currentAssets, prev.currentLiabilities);
  const gm = div(gross(cur), cur.revenue);
  const gmPrev = div(gross(prev), prev.revenue);
  const at = div(cur.revenue, prev.totalAssets ?? cur.totalAssets);
  const atPrev = div(prev.revenue, prev.totalAssets);
  const c = (id: string, label: string, pass: boolean | undefined, value: number | undefined, reason: string): Criterion => ({
    id,
    label,
    pass,
    value,
    reason,
  });
  const components: Criterion[] = [
    c("roa", "positive return on assets", roa === undefined ? undefined : roa > 0, roa, roa === undefined ? "net income or assets missing" : `ROA ${f2(roa)}`),
    c(
      "cfo",
      "positive operating cash flow",
      cur.operatingCashFlow === undefined ? undefined : cur.operatingCashFlow > 0,
      cur.operatingCashFlow,
      cur.operatingCashFlow === undefined ? "operating cash flow missing" : `CFO ${f2(cur.operatingCashFlow)}`,
    ),
    c(
      "droa",
      "ROA improved",
      roa === undefined || roaPrev === undefined ? undefined : roa > roaPrev,
      roa,
      roa === undefined || roaPrev === undefined ? "two years of ROA needed" : `ROA ${f2(roaPrev)} → ${f2(roa)}`,
    ),
    c(
      "accrual",
      "cash flow exceeds net income (quality of earnings)",
      cur.operatingCashFlow === undefined || cur.netIncome === undefined ? undefined : cur.operatingCashFlow > cur.netIncome,
      cur.operatingCashFlow,
      cur.operatingCashFlow === undefined || cur.netIncome === undefined
        ? "CFO or net income missing"
        : `CFO ${f2(cur.operatingCashFlow)} vs NI ${f2(cur.netIncome)}`,
    ),
    c(
      "dlever",
      "long-term leverage fell",
      lev === undefined || levPrev === undefined ? undefined : lev <= levPrev,
      lev,
      lev === undefined || levPrev === undefined ? "debt or assets missing" : `LTD/assets ${f2(levPrev)} → ${f2(lev)}`,
    ),
    c(
      "dliquid",
      "current ratio rose",
      cr === undefined || crPrev === undefined ? undefined : cr > crPrev,
      cr,
      cr === undefined || crPrev === undefined ? "current items missing" : `current ratio ${f2(crPrev)} → ${f2(cr)}`,
    ),
    c(
      "eq_offer",
      "no new shares issued",
      cur.sharesOutstanding === undefined || prev.sharesOutstanding === undefined ? undefined : cur.sharesOutstanding <= prev.sharesOutstanding * 1.001,
      cur.sharesOutstanding,
      cur.sharesOutstanding === undefined || prev.sharesOutstanding === undefined
        ? "share counts missing"
        : `shares ${f2(prev.sharesOutstanding)} → ${f2(cur.sharesOutstanding)}`,
    ),
    c(
      "dmargin",
      "gross margin rose",
      gm === undefined || gmPrev === undefined ? undefined : gm > gmPrev,
      gm,
      gm === undefined || gmPrev === undefined ? "gross profit missing" : `gross margin ${f2(gmPrev)} → ${f2(gm)}`,
    ),
    c(
      "dturn",
      "asset turnover rose",
      at === undefined || atPrev === undefined ? undefined : at > atPrev,
      at,
      at === undefined || atPrev === undefined ? "revenue or assets missing" : `asset turnover ${f2(atPrev)} → ${f2(at)}`,
    ),
  ];
  const computed = components.filter((x) => x.pass !== undefined);
  const value = computed.filter((x) => x.pass).length;
  return {
    name: "Piotroski F-score",
    value,
    max: computed.length,
    computed: computed.length,
    components,
    verdict:
      computed.length < 7 ? "incomplete — too few criteria computable" : value >= 8 ? "strong" : value >= 5 ? "average" : value >= 3 ? "weak" : "very weak",
  };
}

/**
 * Altman Z-score. `model` "manufacturer" is the 1968 public-manufacturer Z
 * (distress < 1.81 < grey < 2.99 < safe); "non-manufacturer" is Z″ (1995),
 * fit for services and non-US firms (distress < 1.1 < grey < 2.6 < safe).
 * Banks and insurers are out of scope for both.
 */
export function altmanZ(p: FinancialPeriod, marketCap: number | undefined, model: "manufacturer" | "non-manufacturer" = "non-manufacturer"): Score {
  const wc = p.currentAssets !== undefined && p.currentLiabilities !== undefined ? p.currentAssets - p.currentLiabilities : undefined;
  const ta = p.totalAssets;
  const x1 = div(wc, ta);
  const x2 = div(p.retainedEarnings, ta);
  const x3 = div(p.ebit ?? p.operatingIncome, ta);
  const x4 = model === "manufacturer" ? div(marketCap, p.totalLiabilities) : div(p.equity, p.totalLiabilities);
  const x5 = div(p.revenue, ta);
  const parts: Array<[string, string, number | undefined, number]> =
    model === "manufacturer"
      ? [
          ["x1", "working capital / assets", x1, 1.2],
          ["x2", "retained earnings / assets", x2, 1.4],
          ["x3", "EBIT / assets", x3, 3.3],
          ["x4", "market cap / liabilities", x4, 0.6],
          ["x5", "sales / assets", x5, 1.0],
        ]
      : [
          ["x1", "working capital / assets", x1, 6.56],
          ["x2", "retained earnings / assets", x2, 3.26],
          ["x3", "EBIT / assets", x3, 6.72],
          ["x4", "book equity / liabilities", x4, 1.05],
        ];
  const components = parts.map(([id, label, v, w]) => ({
    id,
    label,
    value: v,
    pass: undefined,
    reason: v === undefined ? `${label}: missing` : `${label} ${f2(v)} × ${w}`,
  }));
  const complete = parts.every(([, , v]) => v !== undefined);
  const z = complete ? parts.reduce((s, [, , v, w]) => s + v! * w, 0) : Number.NaN;
  const [lo, hi] = model === "manufacturer" ? [1.81, 2.99] : [1.1, 2.6];
  return {
    name: model === "manufacturer" ? "Altman Z-score" : "Altman Z″-score",
    value: z,
    computed: parts.filter(([, , v]) => v !== undefined).length,
    components,
    verdict: !complete ? "incomplete" : z < lo ? "distress zone" : z < hi ? "grey zone" : "safe zone",
  };
}

/**
 * Beneish M-score (1999, eight variables): above −1.78 flags a likely earnings
 * manipulator. A screen for questions to ask, not an accusation.
 */
export function beneishM(cur: FinancialPeriod, prev: FinancialPeriod): Score {
  const dsri = div(div(cur.receivables, cur.revenue), div(prev.receivables, prev.revenue));
  const gmi = div(div(gross(prev), prev.revenue), div(gross(cur), cur.revenue));
  const aq = (p: FinancialPeriod) =>
    p.currentAssets !== undefined && p.ppe !== undefined && p.totalAssets ? 1 - (p.currentAssets + p.ppe) / p.totalAssets : undefined;
  const aqi = div(aq(cur), aq(prev));
  const sgi = div(cur.revenue, prev.revenue);
  const depr = (p: FinancialPeriod) => (p.depreciation !== undefined && p.ppe !== undefined ? p.depreciation / (p.depreciation + p.ppe) : undefined);
  const depi = div(depr(prev), depr(cur));
  const sgai = div(div(cur.sga, cur.revenue), div(prev.sga, prev.revenue));
  const lvgi = div(div(cur.totalLiabilities, cur.totalAssets), div(prev.totalLiabilities, prev.totalAssets));
  const tata = cur.netIncome !== undefined && cur.operatingCashFlow !== undefined ? div(cur.netIncome - cur.operatingCashFlow, cur.totalAssets) : undefined;
  const parts: Array<[string, string, number | undefined, number]> = [
    ["dsri", "days' sales in receivables index", dsri, 0.92],
    ["gmi", "gross margin index", gmi, 0.528],
    ["aqi", "asset quality index", aqi, 0.404],
    ["sgi", "sales growth index", sgi, 0.892],
    ["depi", "depreciation index", depi, 0.115],
    ["sgai", "SG&A index", sgai, -0.172],
    ["lvgi", "leverage index", lvgi, -0.327],
    ["tata", "total accruals to assets", tata, 4.679],
  ];
  const complete = parts.every(([, , v]) => v !== undefined);
  const m = complete ? -4.84 + parts.reduce((s, [, , v, w]) => s + v! * w, 0) : Number.NaN;
  return {
    name: "Beneish M-score",
    value: m,
    computed: parts.filter(([, , v]) => v !== undefined).length,
    components: parts.map(([id, label, v, w]) => ({ id, label, value: v, reason: v === undefined ? `${label}: missing` : `${label} ${f2(v)} × ${w}` })),
    verdict: !complete ? "incomplete" : m > -1.78 ? "possible manipulation — read the notes to the accounts" : "unlikely manipulator",
  };
}

export interface QualityMetrics {
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;
  fcf?: number;
  fcfMargin?: number;
  /** FCF after share-based compensation, the cash owners actually get. */
  fcfAfterSbc?: number;
  /** FCF / net income: above 1 is cash-backed earnings. */
  cashConversion?: number;
  roe?: number;
  roa?: number;
  /** NOPAT / (debt + equity − cash), NOPAT = EBIT × (1 − tax rate). */
  roic?: number;
  netDebt?: number;
  netDebtToEbitda?: number;
  interestCoverage?: number;
  currentRatio?: number;
  /** Sloan accrual ratio (NI − CFO) / assets: high values predict weak future returns. */
  accrualRatio?: number;
  payoutRatio?: number;
  /** FCF over dividends paid: below 1, the dividend is not covered by cash. */
  dividendCover?: number;
}

export function qualityMetrics(p: FinancialPeriod): QualityMetrics {
  const fcf = fcfOf(p);
  const taxRate = p.pretaxIncome && p.incomeTax !== undefined ? Math.min(0.5, Math.max(0, p.incomeTax / p.pretaxIncome)) : 0.25;
  const ebit = p.ebit ?? p.operatingIncome;
  const debt = p.totalDebt ?? p.longTermDebt;
  const invested = debt !== undefined && p.equity !== undefined ? debt + p.equity - (p.cash ?? 0) : undefined;
  const netDebt = debt !== undefined ? debt - (p.cash ?? 0) : undefined;
  const ebitda = p.ebitda ?? (ebit !== undefined && p.depreciation !== undefined ? ebit + p.depreciation : undefined);
  return {
    grossMargin: div(gross(p), p.revenue),
    operatingMargin: div(p.operatingIncome, p.revenue),
    netMargin: div(p.netIncome, p.revenue),
    fcf,
    fcfMargin: div(fcf, p.revenue),
    fcfAfterSbc: fcf !== undefined && p.shareBasedComp !== undefined ? fcf - p.shareBasedComp : undefined,
    cashConversion: div(fcf, p.netIncome),
    roe: div(p.netIncome, p.equity),
    roa: div(p.netIncome, p.totalAssets),
    roic: ebit !== undefined && invested && invested > 0 ? (ebit * (1 - taxRate)) / invested : undefined,
    netDebt,
    netDebtToEbitda: div(netDebt, ebitda),
    interestCoverage: div(ebit, p.interestExpense !== undefined ? Math.abs(p.interestExpense) : undefined),
    currentRatio: div(p.currentAssets, p.currentLiabilities),
    accrualRatio: p.netIncome !== undefined && p.operatingCashFlow !== undefined ? div(p.netIncome - p.operatingCashFlow, p.totalAssets) : undefined,
    payoutRatio: div(p.dividendsPaid !== undefined ? Math.abs(p.dividendsPaid) : undefined, p.netIncome),
    dividendCover: div(fcf, p.dividendsPaid !== undefined && p.dividendsPaid !== 0 ? Math.abs(p.dividendsPaid) : undefined),
  };
}

export interface Multiples {
  marketCap: number;
  enterpriseValue?: number;
  pe?: number;
  pb?: number;
  ps?: number;
  evToEbitda?: number;
  evToEbit?: number;
  evToFcf?: number;
  fcfYield?: number;
  earningsYield?: number;
  dividendYield?: number;
  /** Graham number √(22.5 × EPS × book value per share). */
  grahamNumber?: number;
  /** Greenblatt's magic-formula pair. */
  magicFormula?: { earningsYield?: number; returnOnCapital?: number };
  /** P/E over EPS growth in % (PEG), when a growth rate is given. */
  peg?: number;
}

export function multiples(p: FinancialPeriod, price: number, opts: { epsGrowthPct?: number } = {}): Multiples | undefined {
  if (!p.sharesOutstanding || !(price > 0)) return undefined;
  const marketCap = price * p.sharesOutstanding;
  const debt = p.totalDebt ?? p.longTermDebt;
  const ev = debt !== undefined ? marketCap + debt - (p.cash ?? 0) : undefined;
  const ebit = p.ebit ?? p.operatingIncome;
  const ebitda = p.ebitda ?? (ebit !== undefined && p.depreciation !== undefined ? ebit + p.depreciation : undefined);
  const fcf = fcfOf(p);
  const eps = p.eps ?? div(p.netIncome, p.sharesOutstanding);
  const bvps = div(p.equity, p.sharesOutstanding);
  const pe = eps && eps > 0 ? price / eps : undefined;
  // Greenblatt: EBIT / (net working capital + net fixed assets).
  const nwc = p.currentAssets !== undefined && p.currentLiabilities !== undefined ? p.currentAssets - p.currentLiabilities - (p.cash ?? 0) : undefined;
  const capital = nwc !== undefined && p.ppe !== undefined ? nwc + p.ppe : undefined;
  return {
    marketCap,
    enterpriseValue: ev,
    pe,
    pb: bvps && bvps > 0 ? price / bvps : undefined,
    ps: div(marketCap, p.revenue),
    evToEbitda: ebitda && ebitda > 0 ? div(ev, ebitda) : undefined,
    evToEbit: ebit && ebit > 0 ? div(ev, ebit) : undefined,
    evToFcf: fcf && fcf > 0 ? div(ev, fcf) : undefined,
    fcfYield: div(fcf, marketCap),
    earningsYield: div(ebit, ev),
    dividendYield: p.dividendsPaid !== undefined ? div(Math.abs(p.dividendsPaid), marketCap) : undefined,
    grahamNumber: eps && eps > 0 && bvps && bvps > 0 ? Math.sqrt(22.5 * eps * bvps) : undefined,
    magicFormula: { earningsYield: div(ebit, ev), returnOnCapital: capital && capital > 0 ? div(ebit, capital) : undefined },
    peg: pe !== undefined && opts.epsGrowthPct && opts.epsGrowthPct > 0 ? pe / opts.epsGrowthPct : undefined,
  };
}

// --- Valuation ------------------------------------------------------------------------

export interface DcfInput {
  /** The cash flow of the base year (FCF to the firm, or to equity with `equityBased`). */
  baseCashFlow: number;
  /** Growth per year for the explicit stage(s): one rate per year. */
  growth: number[];
  terminalGrowth: number;
  discountRate: number;
  netDebt: number;
  shares: number;
  /** Discount free cash flow to equity at the cost of equity: net debt is then not subtracted. */
  equityBased?: boolean;
}

export interface DcfResult {
  enterpriseValue: number;
  equityValue: number;
  perShare: number;
  /** Share of the value that comes from the terminal value — over 75 %, the answer is mostly an assumption. */
  terminalShare: number;
  cashFlows: number[];
  presentValues: number[];
  terminalValue: number;
}

/** Discounted cash flow with an explicit growth path and a Gordon terminal value. */
export function dcf(input: DcfInput): DcfResult {
  const { baseCashFlow, growth, terminalGrowth: g, discountRate: r } = input;
  if (r <= g) throw new Error(`the discount rate (${r}) must exceed the terminal growth (${g})`);
  const cashFlows: number[] = [];
  let cf = baseCashFlow;
  for (const gr of growth) {
    cf *= 1 + gr;
    cashFlows.push(cf);
  }
  const presentValues = cashFlows.map((c, i) => c / (1 + r) ** (i + 1));
  const terminalValue = (cashFlows[cashFlows.length - 1]! * (1 + g)) / (r - g);
  const pvTerminal = terminalValue / (1 + r) ** cashFlows.length;
  const enterpriseValue = presentValues.reduce((a, b) => a + b, 0) + pvTerminal;
  const equityValue = input.equityBased ? enterpriseValue : enterpriseValue - input.netDebt;
  return {
    enterpriseValue,
    equityValue,
    perShare: equityValue / input.shares,
    terminalShare: pvTerminal / enterpriseValue,
    cashFlows,
    presentValues,
    terminalValue,
  };
}

/** The constant explicit-stage growth the current price implies (reverse DCF), by bisection. */
export function reverseDcf(price: number, input: Omit<DcfInput, "growth"> & { years: number }): number | undefined {
  const at = (g: number) => dcf({ ...input, growth: new Array(input.years).fill(g) }).perShare - price;
  let lo = -0.5;
  let hi = 1.0;
  if (at(lo) > 0 || at(hi) < 0) return undefined;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (at(m) > 0) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

/** Gordon growth dividend discount model: D1 / (r − g). */
export function gordonValue(nextDividend: number, discountRate: number, growth: number): number {
  if (discountRate <= growth) throw new Error("the discount rate must exceed the dividend growth");
  return nextDividend / (discountRate - growth);
}

/** Residual income value per share: book + Σ (ROE − r)·book discounted, then a fading terminal (fit for banks and insurers). */
export function residualIncome(bookPerShare: number, roe: number[], costOfEquity: number, payoutRatio: number, persistence = 0.6): number {
  let book = bookPerShare;
  let value = bookPerShare;
  let ri = 0;
  roe.forEach((x, i) => {
    ri = (x - costOfEquity) * book;
    value += ri / (1 + costOfEquity) ** (i + 1);
    book += x * book * (1 - payoutRatio);
  });
  // Abnormal returns fade at `persistence` per year after the explicit years.
  value += (ri * persistence) / (1 + costOfEquity - persistence) / (1 + costOfEquity) ** roe.length;
  return value;
}

/** Cost of equity by CAPM: rf + β × equity risk premium. */
export function capm(riskFree: number, beta: number, equityRiskPremium: number): number {
  return riskFree + beta * equityRiskPremium;
}

/** Weighted average cost of capital, with after-tax debt. */
export function wacc(equity: number, debt: number, costOfEquity: number, costOfDebt: number, taxRate: number): number {
  const v = equity + debt;
  return (equity / v) * costOfEquity + (debt / v) * costOfDebt * (1 - taxRate);
}

export interface Scenario {
  name: string;
  probability: number;
  perShare: number;
}

/** Probability-weighted value of bull/base/bear scenarios, and the margin of safety at `price`. */
export function scenarioValue(scenarios: readonly Scenario[], price: number): { expected: number; marginOfSafety: number; downside: number } {
  const total = scenarios.reduce((s, x) => s + x.probability, 0);
  if (Math.abs(total - 1) > 1e-6) throw new Error(`scenario probabilities sum to ${total}, not 1`);
  const expected = scenarios.reduce((s, x) => s + x.probability * x.perShare, 0);
  return { expected, marginOfSafety: expected / price - 1, downside: Math.min(...scenarios.map((s) => s.perShare)) / price - 1 };
}
