// From what a provider returned to the one shape the scores read
// (FinancialPeriod), keeping track of WHICH evidence each field came from —
// so a Piotroski score can cite the very [E#] it was computed from.
//
// Official filings (SEC XBRL, ESEF) come first; maxgfr/crible fills the fields
// a filing did not tag (current assets, receivables, PP&E…), and each filled
// field is recorded as such.
import type { EvidenceItem } from "../core/evidence.js";
import type { FinancialPeriod } from "./fundamentals.js";

type Field = Exclude<keyof FinancialPeriod, "end">;

/** SEC / ESEF metric ids → period fields. */
const FILING_FIELDS: Record<string, Field> = {
  revenue: "revenue",
  costOfRevenue: "costOfRevenue",
  grossProfit: "grossProfit",
  sga: "sga",
  operatingIncome: "operatingIncome",
  netIncome: "netIncome",
  epsDiluted: "eps",
  operatingCashFlow: "operatingCashFlow",
  capex: "capex",
  shareBasedCompensation: "shareBasedComp",
  dividendsPaid: "dividendsPaid",
  pretaxIncome: "pretaxIncome",
  incomeTax: "incomeTax",
  interestExpense: "interestExpense",
  depreciation: "depreciation",
  assets: "totalAssets",
  liabilities: "totalLiabilities",
  equity: "equity",
  cash: "cash",
  debt: "totalDebt",
  currentAssets: "currentAssets",
  currentLiabilities: "currentLiabilities",
  receivables: "receivables",
  inventory: "inventory",
  ppe: "ppe",
  retainedEarnings: "retainedEarnings",
  longTermDebtNoncurrent: "longTermDebt",
  // The year's weighted average count stands in when no period-end count is filed (IFRS filings rarely tag one);
  // the latest reported count, when there is one, replaces it on the newest year.
  weightedAverageShares: "sharesOutstanding",
};

/** crible period columns → period fields. */
export const CRIBLE_FIELDS: Record<string, Field> = {
  revenue: "revenue",
  cost_of_goods_sold: "costOfRevenue",
  gross_profit: "grossProfit",
  sga_expenses: "sga",
  operating_income: "operatingIncome",
  earnings_before_interest_and_taxes: "ebit",
  ebitda: "ebitda",
  income_before_tax: "pretaxIncome",
  income_tax_expense: "incomeTax",
  net_income: "netIncome",
  interest_expense: "interestExpense",
  depreciation_and_amortization: "depreciation",
  shares_outstanding_end: "sharesOutstanding",
  total_assets: "totalAssets",
  current_assets: "currentAssets",
  current_liabilities: "currentLiabilities",
  cash_and_equivalents: "cash",
  accounts_receivable: "receivables",
  inventory: "inventory",
  net_ppe: "ppe",
  total_debt: "totalDebt",
  long_term_debt: "longTermDebt",
  total_liabilities: "totalLiabilities",
  total_equity: "equity",
  retained_earnings: "retainedEarnings",
  operating_cashflow: "operatingCashFlow",
  capital_expenditure: "capex",
  dividends_paid: "dividendsPaid",
};

export interface SourcedPeriod {
  period: FinancialPeriod;
  /** Evidence id behind each field. */
  ids: Partial<Record<Field, string>>;
  /** Fields filled from crible rather than a filing. */
  filled: Field[];
}

/**
 * Annual periods from registered filing evidence (keys `<SYM>.fund.<metric>.FY<year>`),
 * newest first. The latest share count (`…sharesOutstanding.latest`) is put on the newest year.
 */
export function periodsFromFilingEvidence(items: readonly EvidenceItem[], symbol: string): SourcedPeriod[] {
  const byYear = new Map<string, SourcedPeriod>();
  const prefix = `${symbol}.fund.`;
  let shares: EvidenceItem | undefined;
  for (const it of items) {
    if (!it.key.startsWith(prefix) || typeof it.value !== "number") continue;
    const rest = it.key.slice(prefix.length);
    if (rest === "sharesOutstanding.latest") {
      shares = it;
      continue;
    }
    const m = /^([A-Za-z]+)\.FY(\d{4})$/.exec(rest);
    if (!m) continue;
    const field = FILING_FIELDS[m[1]!];
    if (!field) continue;
    const year = m[2]!;
    const sp = byYear.get(year) ?? { period: { end: it.asOf ?? `${year}-12-31` }, ids: {}, filled: [] };
    if (field === "revenue" && it.asOf) sp.period.end = it.asOf;
    (sp.period as unknown as Record<string, number>)[field] = it.value;
    sp.ids[field] = it.id;
    byYear.set(year, sp);
  }
  const out = [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([, v]) => v);
  if (shares && out[0]) {
    out[0].period.sharesOutstanding = shares.value as number;
    out[0].ids.sharesOutstanding = shares.id;
  }
  return out;
}

/** Periods from crible's company history (newest first); `register` turns a value into an evidence id. */
export function periodsFromCrible(
  periods: ReadonlyArray<Record<string, unknown>>,
  register: (field: string, period: string, value: number) => string,
): SourcedPeriod[] {
  return periods
    .filter((p) => typeof p.period === "string")
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))
    .map((p) => {
      const sp: SourcedPeriod = { period: { end: String(p.period) }, ids: {}, filled: [] };
      for (const [col, field] of Object.entries(CRIBLE_FIELDS)) {
        const v = p[col];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        (sp.period as unknown as Record<string, number>)[field] = v;
        sp.ids[field] = register(col, String(p.period), v);
      }
      return sp;
    });
}

/**
 * Fill the gaps of filing periods with crible periods of the same fiscal year
 * end (± 10 days); crible years newer than the newest filing (a report not yet
 * in the filing repository) come first, wholly marked as filled.
 */
export function fillGaps(filings: SourcedPeriod[], crible: readonly SourcedPeriod[]): SourcedPeriod[] {
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 10 * 86_400_000;
  const whole = (c: SourcedPeriod): SourcedPeriod => ({ ...c, filled: Object.keys(c.ids) as Field[] });
  if (!filings.length) return crible.map(whole);
  const newest = filings[0]!.period.end;
  const newer = crible.filter((c) => Date.parse(c.period.end) > Date.parse(newest) + 10 * 86_400_000).map(whole);
  for (const f of filings) {
    const c = crible.find((x) => near(x.period.end, f.period.end));
    if (!c) continue;
    for (const [field, id] of Object.entries(c.ids) as Array<[Field, string]>) {
      if ((f.period as unknown as Record<string, unknown>)[field] !== undefined) continue;
      (f.period as unknown as Record<string, unknown>)[field] = (c.period as unknown as Record<string, unknown>)[field];
      f.ids[field] = id;
      f.filled.push(field);
    }
  }
  return [...newer, ...filings];
}

/** Compound annual growth of a field over the periods available (newest first), as a fraction. */
export function growthOf(periods: readonly SourcedPeriod[], field: Field, years = 3): number | undefined {
  const vals = periods.map((p) => (p.period as unknown as Record<string, number | undefined>)[field]);
  const n = Math.min(years, vals.length - 1);
  if (n < 1) return undefined;
  const a = vals[0];
  const b = vals[n];
  if (a === undefined || b === undefined || a <= 0 || b <= 0) return undefined;
  return (a / b) ** (1 / n) - 1;
}
