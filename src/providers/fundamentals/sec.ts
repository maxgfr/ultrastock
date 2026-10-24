// SEC EDGAR — the issuer's own filings, read from the regulator's keyless JSON
// APIs (official):
//
//   ticker ↔ CIK      https://www.sec.gov/files/company_tickers.json            (cached a week)
//   XBRL facts        https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
//   filing history    https://data.sec.gov/submissions/CIK##########.json      (the last ~1000 filings)
//   full-text search  https://efts.sec.gov/LATEST/search-index?q=…&forms=…    (2001 onward)
//
// Fair access: at most 10 requests a second (paced at 120 ms here) and a
// User-Agent that declares who is calling — ideally an e-mail, set with
// ULTRASTOCK_SEC_CONTACT. The shared `politeUa()` is NOT used: EDGAR answers
// 403 "Undeclared Automated Tool" to any User-Agent containing "github.com",
// which that one carries. An IP that exceeds the pace is blocked for ~10 min.
//
// Point in time: every XBRL value keeps the date it was filed; `asOf` keeps
// only what had been filed by then, so a back-test cannot read a restatement
// from its future. Amended or restated values for the same period are
// deduplicated by keeping the latest filing still visible at `asOf`.
// Form 4 insiders and 13F holdings live in sec-insiders.ts and sec-13f.ts.
import { cachedJson, TTL } from "../../core/cache.js";
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow, fetchJson, fetchText, type NetResponse } from "../../core/net.js";
import { VERSION } from "../../version.js";
import { ProviderError } from "../types.js";
import { daysBetween, isoDayOf, shiftIsoDay } from "./util.js";

export const SEC_SOURCE = "sec-edgar";

/** The User-Agent EDGAR accepts: the tool and, when set, the operator's contact (an e-mail, as the SEC asks). */
export function secUserAgent(): string {
  const contact = process.env.ULTRASTOCK_SEC_CONTACT?.trim();
  return `ultrastock/${VERSION}${contact ? ` ${contact}` : ""}`;
}

function secRefusal(url: string, res: NetResponse): ProviderError {
  const throttled = /Rate Threshold/i.test(res.body ?? "");
  const undeclared = /Undeclared Automated Tool/i.test(res.body ?? "");
  const why = throttled
    ? "request rate threshold exceeded — EDGAR blocks the IP for about 10 minutes"
    : undeclared
      ? "EDGAR refused the User-Agent — set ULTRASTOCK_SEC_CONTACT to an e-mail address"
      : res.status === 404
        ? "not found"
        : `HTTP ${res.status}${res.error ? `, ${res.error}` : ""}`;
  return new ProviderError(SEC_SOURCE, `${url}: ${why}`, throttled ? 429 : res.status);
}

/** GET an EDGAR JSON document, paced and identified; 403 pages are told apart (undeclared tool vs. pace exceeded). */
export async function secJson<T>(url: string) {
  const res = await fetchJson<T>(url, { userAgent: secUserAgent(), hostIntervalMs: 120 });
  if (!res.ok || res.data === undefined) throw secRefusal(url, res);
  return { ...res, data: res.data };
}

/** GET an EDGAR document as text (an XML filing), paced and identified. */
export async function secText(url: string): Promise<NetResponse> {
  const res = await fetchText(url, { userAgent: secUserAgent(), hostIntervalMs: 120, accept: "application/xml,text/xml,*/*" });
  if (!res.ok) throw secRefusal(url, res);
  return res;
}

export const padCik = (cik: number) => String(cik).padStart(10, "0");
export const archiveBase = (cik: number, accession: string) => `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}`;

// ─── ticker ↔ CIK ──────────────────────────────────────────────────────────

export interface SecCompany {
  cik: number;
  ticker: string;
  title: string;
}

/** company_tickers.json ({"0": {cik_str, ticker, title}, …}) → by upper-case ticker. */
export function parseSecTickerMap(json: unknown): Record<string, SecCompany> {
  const out: Record<string, SecCompany> = {};
  if (!json || typeof json !== "object") return out;
  for (const row of Object.values(json as Record<string, { cik_str?: number; ticker?: string; title?: string }>)) {
    if (typeof row?.cik_str !== "number" || !row.ticker) continue;
    const ticker = row.ticker.toUpperCase();
    if (!out[ticker]) out[ticker] = { cik: row.cik_str, ticker, title: row.title ?? "" };
  }
  return out;
}

/** "BRK.B" → "BRK-B": EDGAR writes share classes with a dash. */
export const secTickerForm = (s: string) => s.trim().toUpperCase().replace(/\.US$/, "").replace(/[./]/g, "-");

/** The CIK for a ticker (or a CIK given as digits, passed through). */
export async function secCompany(tickerOrCik: string): Promise<{ cik: number; ticker?: string; title?: string }> {
  const s = tickerOrCik.trim().replace(/^CIK/i, "");
  if (/^\d{1,10}$/.test(s)) return { cik: Number(s) };
  const ticker = secTickerForm(s);
  const map = await cachedJson("sec:company_tickers", TTL.reference, async () =>
    parseSecTickerMap((await secJson("https://www.sec.gov/files/company_tickers.json")).data),
  );
  const hit = map?.[ticker];
  if (!map) throw new ProviderError(SEC_SOURCE, "ticker map unavailable (offline and not cached)", 0);
  if (!hit) throw new ProviderError(SEC_SOURCE, `no SEC registrant with ticker ${ticker}`, 404);
  return hit;
}

// ─── XBRL company facts ────────────────────────────────────────────────────

interface RawFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number | null;
  fp?: string | null;
  form: string;
  filed: string;
}
type FactsJson = { cik?: number; entityName?: string; facts?: Record<string, Record<string, { units?: Record<string, RawFact[]> }>> };

export interface FactValue {
  /** "FY2025", "FY2026Q2", "TTM", or "latest". */
  period: string;
  start?: string;
  end: string;
  value: number;
  unit: string;
  concept: string;
  form: string;
  /** The filing date of the value used — the point-in-time stamp. */
  filed: string;
  accn: string;
  formula?: string;
}

export interface MetricSeries {
  id: string;
  label: string;
  unit: string;
  kind: "flow" | "instant";
  annual: FactValue[];
  quarterly: FactValue[];
  ttm?: FactValue;
}

export interface SecFundamentals {
  cik: number;
  entityName: string;
  asOf?: string;
  metrics: MetricSeries[];
  notes: string[];
}

interface MetricDef {
  id: string;
  label: string;
  kind: "flow" | "instant";
  unit: "USD" | "USD/shares" | "shares";
  concepts: string[];
  ns?: string;
}

/** Concept fallbacks, in order: the first concept that reports a period wins that period. */
export const SEC_METRICS: MetricDef[] = [
  {
    id: "revenue",
    label: "revenue",
    kind: "flow",
    unit: "USD",
    concepts: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"],
  },
  { id: "grossProfit", label: "gross profit", kind: "flow", unit: "USD", concepts: ["GrossProfit"] },
  { id: "operatingIncome", label: "operating income", kind: "flow", unit: "USD", concepts: ["OperatingIncomeLoss"] },
  { id: "netIncome", label: "net income", kind: "flow", unit: "USD", concepts: ["NetIncomeLoss", "ProfitLoss"] },
  { id: "epsDiluted", label: "diluted EPS", kind: "flow", unit: "USD/shares", concepts: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"] },
  {
    id: "operatingCashFlow",
    label: "operating cash flow",
    kind: "flow",
    unit: "USD",
    concepts: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  },
  {
    id: "capex",
    label: "capital expenditure",
    kind: "flow",
    unit: "USD",
    concepts: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  },
  {
    id: "shareBasedCompensation",
    label: "share-based compensation",
    kind: "flow",
    unit: "USD",
    concepts: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
  },
  { id: "dividendsPaid", label: "dividends paid", kind: "flow", unit: "USD", concepts: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"] },
  {
    id: "researchAndDevelopment",
    label: "R&D expense",
    kind: "flow",
    unit: "USD",
    concepts: ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost"],
  },
  { id: "assets", label: "total assets", kind: "instant", unit: "USD", concepts: ["Assets"] },
  { id: "liabilities", label: "total liabilities", kind: "instant", unit: "USD", concepts: ["Liabilities"] },
  {
    id: "equity",
    label: "stockholders' equity",
    kind: "instant",
    unit: "USD",
    concepts: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  },
  {
    id: "cash",
    label: "cash and equivalents",
    kind: "instant",
    unit: "USD",
    concepts: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  },
  { id: "costOfRevenue", label: "cost of revenue", kind: "flow", unit: "USD", concepts: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"] },
  { id: "sga", label: "SG&A expense", kind: "flow", unit: "USD", concepts: ["SellingGeneralAndAdministrativeExpense"] },
  {
    id: "pretaxIncome",
    label: "pre-tax income",
    kind: "flow",
    unit: "USD",
    concepts: [
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ],
  },
  { id: "incomeTax", label: "income tax expense", kind: "flow", unit: "USD", concepts: ["IncomeTaxExpenseBenefit"] },
  {
    id: "interestExpense",
    label: "interest expense",
    kind: "flow",
    unit: "USD",
    concepts: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
  },
  {
    id: "depreciation",
    label: "depreciation and amortisation",
    kind: "flow",
    unit: "USD",
    concepts: ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet", "Depreciation"],
  },
  { id: "currentAssets", label: "current assets", kind: "instant", unit: "USD", concepts: ["AssetsCurrent"] },
  { id: "currentLiabilities", label: "current liabilities", kind: "instant", unit: "USD", concepts: ["LiabilitiesCurrent"] },
  { id: "receivables", label: "accounts receivable", kind: "instant", unit: "USD", concepts: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"] },
  { id: "inventory", label: "inventory", kind: "instant", unit: "USD", concepts: ["InventoryNet"] },
  { id: "ppe", label: "net property, plant and equipment", kind: "instant", unit: "USD", concepts: ["PropertyPlantAndEquipmentNet"] },
  { id: "retainedEarnings", label: "retained earnings", kind: "instant", unit: "USD", concepts: ["RetainedEarningsAccumulatedDeficit"] },
  {
    id: "longTermDebtNoncurrent",
    label: "long-term debt (non-current)",
    kind: "instant",
    unit: "USD",
    concepts: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
  },
];

const DEBT_TOTAL = ["LongTermDebt", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities"];
const DEBT_NONCURRENT = ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"];
const DEBT_CURRENT = ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"];

const FORM_OK = /^(10-K|10-KT|10-Q|10-QT|20-F|40-F)(\/A)?$/;
const ANNUAL_FORM = /^(10-K|10-KT|20-F|40-F)(\/A)?$/;

interface Picked {
  rec: RawFact;
  concept: string;
  formula?: string;
}

/** Per period ("start|end"), the value from the latest filing visible at `asOf`, across `concepts` in priority order. */
function pickPeriods(facts: FactsJson["facts"], ns: string, concepts: string[], unit: string, asOf?: string): Map<string, Picked> {
  const out = new Map<string, Picked>();
  for (const concept of concepts) {
    const rows = facts?.[ns]?.[concept]?.units?.[unit];
    if (!Array.isArray(rows)) continue;
    const byPeriod = new Map<string, RawFact[]>();
    for (const rec of rows) {
      if (!rec?.end || typeof rec.val !== "number" || !FORM_OK.test(rec.form ?? "") || (asOf && rec.filed > asOf)) continue;
      const key = `${rec.start ?? ""}|${rec.end}`;
      byPeriod.set(key, [...(byPeriod.get(key) ?? []), rec]);
    }
    for (const [k, recs] of byPeriod) {
      if (out.has(k)) continue;
      // The latest filing's value wins (restatements); its stamp is the first
      // filing that reported that same value — when it became known.
      const latest = recs.reduce((a, b) => (b.filed > a.filed ? b : a));
      const first = recs.filter((r) => r.val === latest.val).reduce((a, b) => (b.filed < a.filed ? b : a));
      out.set(k, { rec: first, concept });
    }
  }
  return out;
}

interface PeriodLabel {
  fy: number;
  fp: string;
}

/**
 * Fiscal labels by period end: a filing's primary period is the latest end among
 * its duration facts, and its `fy`/`fp` name that period. The `fy` on a fact
 * names the FILING, not the fact's period (a 10-K's comparative year carries
 * the new year's fy), hence this detour.
 */
function fiscalLabels(facts: FactsJson["facts"], asOf?: string): Map<string, PeriodLabel> {
  const primary = new Map<string, { end: string; fy: number; fp: string; form: string; filed: string }>();
  for (const concept of Object.values(facts?.["us-gaap"] ?? {})) {
    for (const rows of Object.values(concept.units ?? {})) {
      for (const r of rows) {
        if (!r.start || !r.fy || !r.fp || !FORM_OK.test(r.form ?? "") || (asOf && r.filed > asOf) || daysBetween(r.start, r.end) < 80) continue;
        const p = primary.get(r.accn);
        if (!p || r.end > p.end) primary.set(r.accn, { end: r.end, fy: r.fy, fp: r.fp, form: r.form, filed: r.filed });
      }
    }
  }
  const out = new Map<string, PeriodLabel & { filed: string }>();
  for (const p of primary.values()) {
    const label = { fy: p.fy, fp: ANNUAL_FORM.test(p.form) ? "FY" : p.fp, filed: p.filed };
    const prev = out.get(p.end);
    if (!prev || p.filed < prev.filed) out.set(p.end, label);
  }
  return out;
}

const annualName = (end: string, labels: Map<string, PeriodLabel>) => {
  const l = labels.get(end);
  return l?.fp === "FY" ? `FY${l.fy}` : `FY${end.slice(0, 4)}`;
};
const quarterName = (end: string, labels: Map<string, PeriodLabel>) => {
  const l = labels.get(end);
  if (!l) return `Q${end}`;
  return l.fp === "FY" ? `FY${l.fy}Q4` : `FY${l.fy}${l.fp}`;
};

/** The later of two ISO days (string order is date order). */
const laterDay = (a: string, b: string) => (a.localeCompare(b) >= 0 ? a : b);

const toValue = (p: Picked, period: string, unit: string): FactValue => ({
  period,
  ...(p.rec.start ? { start: p.rec.start } : {}),
  end: p.rec.end,
  value: p.rec.val,
  unit,
  concept: p.concept,
  form: p.rec.form,
  filed: p.rec.filed,
  accn: p.rec.accn,
  ...(p.formula ? { formula: p.formula } : {}),
});

/** Annual, discrete-quarter and trailing-twelve-month values of a flow metric. */
function flowSeries(picked: Map<string, Picked>, unit: string, labels: Map<string, PeriodLabel>, years: number, quarters: number) {
  // Per-share figures do not add up across quarters: no YTD differences, no TTM sum.
  const additive = unit !== "USD/shares";
  const annual: Picked[] = [];
  const quarter = new Map<string, Picked>();
  const ytd = new Map<string, Picked[]>();
  for (const p of picked.values()) {
    if (!p.rec.start) continue;
    const days = daysBetween(p.rec.start, p.rec.end);
    if (days >= 340 && days <= 390) annual.push(p);
    if (days >= 80 && days <= 100) quarter.set(p.rec.end, p);
    if (additive && days >= 80 && days <= 390) ytd.set(p.rec.start, [...(ytd.get(p.rec.start) ?? []), p]);
  }
  // Cash-flow statements are year-to-date in 10-Qs, and Q4 is never filed on its
  // own: a missing discrete quarter is the difference of two YTD figures.
  for (const group of ytd.values()) {
    group.sort((a, b) => a.rec.end.localeCompare(b.rec.end));
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1]!;
      const b = group[i]!;
      const step = daysBetween(a.rec.end, b.rec.end);
      if (step < 80 || step > 100 || quarter.has(b.rec.end)) continue;
      const filed = laterDay(a.rec.filed, b.rec.filed);
      quarter.set(b.rec.end, {
        concept: b.concept,
        rec: { ...b.rec, start: shiftIsoDay(a.rec.end, 1), val: b.rec.val - a.rec.val, filed },
        formula: `${b.concept} ${b.rec.start}..${b.rec.end} − ${a.rec.start}..${a.rec.end}`,
      });
    }
  }
  const qs = [...quarter.values()].sort((a, b) => a.rec.end.localeCompare(b.rec.end));
  let ttm: FactValue | undefined;
  const last4 = qs.slice(-4);
  const contiguous = last4.length === 4 && last4.every((q, i) => i === 0 || ((d) => d >= 1 && d <= 4)(daysBetween(last4[i - 1]!.rec.end, q.rec.start!)));
  if (additive && contiguous) {
    const names = last4.map((q) => quarterName(q.rec.end, labels));
    const lastQ = last4[3]!;
    ttm = {
      period: "TTM",
      start: last4[0]!.rec.start,
      end: lastQ.rec.end,
      value: last4.reduce((s, q) => s + q.rec.val, 0),
      unit,
      concept: lastQ.concept,
      form: lastQ.rec.form,
      filed: last4.reduce((m, q) => laterDay(m, q.rec.filed), ""),
      accn: lastQ.rec.accn,
      formula: `sum of ${names.join(" + ")}`,
    };
  }
  return {
    annual: annual
      .sort((a, b) => b.rec.end.localeCompare(a.rec.end))
      .slice(0, years)
      .map((p) => toValue(p, annualName(p.rec.end, labels), unit)),
    quarterly: qs
      .reverse()
      .slice(0, quarters)
      .map((p) => toValue(p, quarterName(p.rec.end, labels), unit)),
    ttm,
  };
}

/** Fiscal-year-end balances and the latest quarter-end balance of an instant metric. */
function instantSeries(picked: Map<string, Picked>, unit: string, labels: Map<string, PeriodLabel>, years: number) {
  const byEnd = new Map<string, Picked>();
  for (const p of picked.values()) {
    const prev = byEnd.get(p.rec.end);
    if (labels.has(p.rec.end) && (!prev || p.rec.filed > prev.rec.filed)) byEnd.set(p.rec.end, p);
  }
  const ends = [...byEnd.keys()].sort().reverse();
  const annual = ends.filter((e) => labels.get(e)?.fp === "FY").slice(0, years);
  const latest = ends[0];
  return {
    annual: annual.map((e) => toValue(byEnd.get(e)!, annualName(e, labels), unit)),
    quarterly: latest && !annual.includes(latest) ? [toValue(byEnd.get(latest)!, quarterName(latest, labels), unit)] : [],
  };
}

/** Total debt: LongTermDebt where reported, else non-current + current maturities. */
function debtPeriods(facts: FactsJson["facts"], asOf?: string): Map<string, Picked> {
  const total = pickPeriods(facts, "us-gaap", DEBT_TOTAL, "USD", asOf);
  const nonCurrent = pickPeriods(facts, "us-gaap", DEBT_NONCURRENT, "USD", asOf);
  const current = pickPeriods(facts, "us-gaap", DEBT_CURRENT, "USD", asOf);
  const out = new Map(total);
  for (const [k, nc] of nonCurrent) {
    if (out.has(k)) continue;
    const cur = current.get(k);
    out.set(k, {
      concept: nc.concept,
      rec: { ...nc.rec, val: nc.rec.val + (cur?.rec.val ?? 0), filed: laterDay(nc.rec.filed, cur?.rec.filed ?? "") },
      formula: cur ? `${nc.concept} + ${cur.concept}` : `${nc.concept} (no current portion reported)`,
    });
  }
  return out;
}

const minus = (a: FactValue, b: FactValue, period: string): FactValue => ({
  period,
  ...(a.start ? { start: a.start } : {}),
  end: a.end,
  value: a.value - b.value,
  unit: a.unit,
  concept: "derived",
  form: a.form,
  filed: laterDay(a.filed, b.filed),
  accn: a.accn,
  formula: "operatingCashFlow − capex",
});

/**
 * Normalize a companyfacts document into key metrics: the last `years` fiscal
 * years, the last `quarters` discrete quarters, and TTM where four contiguous
 * quarters exist — only from filings made on or before `asOf` when given.
 */
export function parseCompanyFacts(json: FactsJson, opts: { years?: number; quarters?: number; asOf?: string } = {}): SecFundamentals {
  const years = opts.years ?? 4;
  const quarters = opts.quarters ?? 4;
  const facts = json.facts;
  const labels = fiscalLabels(facts, opts.asOf);
  const notes: string[] = [];
  const metrics: MetricSeries[] = [];
  for (const def of SEC_METRICS) {
    const picked = pickPeriods(facts, def.ns ?? "us-gaap", def.concepts, def.unit, opts.asOf);
    const s = def.kind === "flow" ? flowSeries(picked, def.unit, labels, years, quarters) : instantSeries(picked, def.unit, labels, years);
    if (s.annual.length || s.quarterly.length) metrics.push({ id: def.id, label: def.label, unit: def.unit, kind: def.kind, ...s });
    else notes.push(`${def.label}: not reported under ${def.concepts.join(" | ")}`);
  }
  const debt = instantSeries(debtPeriods(facts, opts.asOf), "USD", labels, years);
  if (debt.annual.length || debt.quarterly.length) metrics.push({ id: "debt", label: "long-term debt incl. current", unit: "USD", kind: "instant", ...debt });
  else notes.push("long-term debt: not reported (LongTermDebt, LongTermDebtNoncurrent…) — may be debt-free or use another concept");

  const ocf = metrics.find((m) => m.id === "operatingCashFlow");
  const capex = metrics.find((m) => m.id === "capex");
  if (ocf && capex) {
    const match = (xs: FactValue[], ys: FactValue[]) =>
      xs.flatMap((x) => {
        const y = ys.find((v) => v.end === x.end && v.start === x.start);
        return y ? [minus(x, y, x.period)] : [];
      });
    const ttm = ocf.ttm && capex.ttm && ocf.ttm.end === capex.ttm.end ? minus(ocf.ttm, capex.ttm, "TTM") : undefined;
    metrics.push({
      id: "freeCashFlow",
      label: "free cash flow",
      unit: "USD",
      kind: "flow",
      annual: match(ocf.annual, capex.annual),
      quarterly: match(ocf.quarterly, capex.quarterly),
      ...(ttm ? { ttm } : {}),
    });
  }

  const shares =
    pickPeriods(facts, "dei", ["EntityCommonStockSharesOutstanding"], "shares", opts.asOf).size > 0
      ? pickPeriods(facts, "dei", ["EntityCommonStockSharesOutstanding"], "shares", opts.asOf)
      : pickPeriods(facts, "us-gaap", ["CommonStockSharesOutstanding"], "shares", opts.asOf);
  const lastShares = [...shares.values()].sort((a, b) => b.rec.end.localeCompare(a.rec.end) || b.rec.filed.localeCompare(a.rec.filed))[0];
  if (lastShares)
    metrics.push({
      id: "sharesOutstanding",
      label: "shares outstanding",
      unit: "shares",
      kind: "instant",
      annual: [],
      quarterly: [toValue(lastShares, "latest", "shares")],
    });
  else notes.push("shares outstanding: not reported in the cover page (multi-class issuers report per class)");
  if (facts?.["ifrs-full"]) notes.push("this registrant files IFRS (20-F/40-F): us-gaap metrics may be missing — the ifrs-full namespace is not mapped here");
  return { cik: json.cik ?? 0, entityName: json.entityName ?? "", ...(opts.asOf ? { asOf: opts.asOf } : {}), metrics, notes };
}

const unitOf = (u: string) => (u === "USD/shares" ? "USD" : u);

/** Points for a normalized fundamentals result: `<T>.fund.<metric>.<FY2025|FY2026Q2|TTM|latest>`. */
export function secFundamentalsPoints(f: SecFundamentals, subject: string): Point[] {
  const points: Point[] = [];
  for (const m of f.metrics) {
    for (const v of [...m.annual, ...m.quarterly, ...(m.ttm ? [m.ttm] : [])]) {
      const how = v.formula ? (v.concept === "derived" || v.period === "TTM" ? "derived" : "derived from YTD") : v.concept;
      const stamp = v.formula ? `latest input filed ${v.filed}` : `${v.form} filed ${v.filed}`;
      points.push({
        key: `${subject}.fund.${m.id}.${v.period}`,
        label: `${subject} ${m.label} ${v.period} (${how}; ${stamp})`,
        value: v.value,
        unit: unitOf(v.unit),
        asOf: v.end,
        ...(v.formula ? { formula: v.formula } : {}),
      });
    }
  }
  return points;
}

/** Key metrics from the SEC's XBRL company facts, point-in-time when `asOf` (YYYY-MM-DD) is given. */
export async function secFundamentals(
  tickerOrCik: string,
  opts: { years?: number; quarters?: number; asOf?: string; subject?: string } = {},
): Promise<Dataset> {
  const co = await secCompany(tickerOrCik);
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padCik(co.cik)}.json`;
  const got = await cachedJson(`sec:facts:${co.cik}:${opts.years ?? 4}:${opts.quarters ?? 4}:${opts.asOf ?? ""}`, TTL.fundamentals, async () => {
    const res = await secJson<FactsJson>(url);
    return { parsed: parseCompanyFacts(res.data, { years: opts.years, quarters: opts.quarters, asOf: opts.asOf }), fetchedAt: res.fetchedAt };
  });
  if (!got) throw new ProviderError(SEC_SOURCE, `company facts for CIK ${co.cik} unavailable (offline and not cached)`, 0);
  const subject = opts.subject ?? co.ticker ?? `CIK${co.cik}`;
  const points = secFundamentalsPoints(got.parsed, subject);
  if (!points.length) throw new ProviderError(SEC_SOURCE, `no us-gaap key metrics for CIK ${co.cik}${opts.asOf ? ` filed by ${opts.asOf}` : ""}`, 404);
  return {
    kind: "fundamentals",
    title: `${subject} key metrics (SEC XBRL)${opts.asOf ? ` as filed by ${opts.asOf}` : ""}`,
    subject,
    points,
    provenance: { source: SEC_SOURCE, url, fetchedAt: got.fetchedAt, delay: "filing", official: true },
    notes: [
      "values as reported in 10-K/10-Q XBRL; each label carries the filing date (point-in-time); restatements resolved to the latest filing visible",
      ...got.parsed.notes,
    ],
  };
}

// ─── submissions: filing history, 8-K items ────────────────────────────────

export interface SecFiling {
  accession: string;
  form: string;
  filingDate: string;
  reportDate?: string;
  items: string[];
  primaryDocument: string;
  /** The filing's index page. */
  url: string;
  /** The primary document as rendered by EDGAR. */
  docUrl: string;
}

export interface SecSubmissions {
  cik: number;
  name: string;
  tickers: string[];
  filings: SecFiling[];
}

type SubmissionsJson = {
  cik?: string;
  name?: string;
  tickers?: string[];
  filings?: { recent?: Record<string, Array<string | number>> };
};

/** submissions JSON (column arrays under filings.recent) → filings, newest first. */
export function parseSubmissions(json: SubmissionsJson): SecSubmissions {
  const cik = Number(json.cik ?? 0);
  const r = json.filings?.recent ?? {};
  const col = (k: string, i: number) => String(r[k]?.[i] ?? "");
  const n = r.accessionNumber?.length ?? 0;
  const filings: SecFiling[] = [];
  for (let i = 0; i < n; i++) {
    const accession = col("accessionNumber", i);
    const primaryDocument = col("primaryDocument", i);
    const base = archiveBase(cik, accession);
    filings.push({
      accession,
      form: col("form", i),
      filingDate: col("filingDate", i),
      ...(col("reportDate", i) ? { reportDate: col("reportDate", i) } : {}),
      items: col("items", i)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      primaryDocument,
      url: `${base}/${accession}-index.htm`,
      docUrl: `${base}/${primaryDocument}`,
    });
  }
  filings.sort((a, b) => b.filingDate.localeCompare(a.filingDate));
  return { cik, name: json.name ?? "", tickers: json.tickers ?? [], filings };
}

/** Recent filings of a registrant (CIK). */
export async function secSubmissions(cik: number): Promise<SecSubmissions & { url: string; fetchedAt: string }> {
  const url = `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;
  const res = await secJson<SubmissionsJson>(url);
  return { ...parseSubmissions(res.data), url, fetchedAt: res.fetchedAt };
}

/** Form 8-K item numbers → names (General Instructions to Form 8-K). */
export const EIGHT_K_ITEMS: Record<string, string> = {
  "1.01": "Entry into a Material Definitive Agreement",
  "1.02": "Termination of a Material Definitive Agreement",
  "1.03": "Bankruptcy or Receivership",
  "1.04": "Mine Safety Reporting",
  "1.05": "Material Cybersecurity Incidents",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03": "Creation of a Direct Financial Obligation",
  "2.04": "Triggering Events That Accelerate a Financial Obligation",
  "2.05": "Costs Associated with Exit or Disposal Activities",
  "2.06": "Material Impairments",
  "3.01": "Notice of Delisting or Failure to Satisfy a Listing Rule",
  "3.02": "Unregistered Sales of Equity Securities",
  "3.03": "Material Modification to Rights of Security Holders",
  "4.01": "Changes in Registrant's Certifying Accountant",
  "4.02": "Non-Reliance on Previously Issued Financial Statements",
  "5.01": "Changes in Control of Registrant",
  "5.02": "Departure or Election of Directors or Officers",
  "5.03": "Amendments to Articles or Bylaws; Change in Fiscal Year",
  "5.04": "Temporary Suspension of Trading Under Employee Benefit Plans",
  "5.05": "Amendments to the Code of Ethics",
  "5.06": "Change in Shell Company Status",
  "5.07": "Submission of Matters to a Vote of Security Holders",
  "5.08": "Shareholder Director Nominations",
  "6.01": "ABS Informational and Computational Material",
  "6.02": "Change of Servicer or Trustee",
  "6.03": "Change in Credit Enhancement",
  "6.04": "Failure to Make a Required Distribution",
  "6.05": "Securities Act Updating Disclosure",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

/** The 8-K items worth an investor's attention: deals, results, distress, control, auditors, leadership, votes, disclosures. */
export const IMPORTANT_8K_ITEMS = new Set([
  "1.01",
  "1.03",
  "1.05",
  "2.01",
  "2.02",
  "2.04",
  "2.05",
  "2.06",
  "3.01",
  "4.01",
  "4.02",
  "5.01",
  "5.02",
  "5.07",
  "7.01",
  "8.01",
]);

export const isImportant8k = (f: Pick<SecFiling, "form" | "items">) => /^8-K/.test(f.form) && f.items.some((i) => IMPORTANT_8K_ITEMS.has(i));

/** Points for a filing list: `<T>.filing.<accession>` = form; 8-K items named in the label, [important] flagged. */
export function secFilingsPoints(filings: SecFiling[], subject: string): Point[] {
  return filings.map((f) => {
    const items = f.items.map((i) => `${i} ${EIGHT_K_ITEMS[i] ?? "item"}`).join("; ");
    return {
      key: `${subject}.filing.${f.accession}`,
      label: `${subject} ${f.form} filed ${f.filingDate}${f.reportDate ? ` for ${f.reportDate}` : ""}${items ? ` — ${items}` : ""}${isImportant8k(f) ? " [important]" : ""}`,
      value: f.form,
      asOf: f.filingDate,
      url: f.url,
    };
  });
}

/** Recent filings (optionally only some forms, e.g. ["8-K"]), filed within `days` of `now`. */
export async function secFilings(
  tickerOrCik: string,
  opts: { forms?: string[]; limit?: number; days?: number; now?: Date; subject?: string } = {},
): Promise<Dataset> {
  const co = await secCompany(tickerOrCik);
  const sub = await secSubmissions(co.cik);
  const since = opts.days ? isoDayOf(new Date((opts.now ?? clockNow()).getTime() - opts.days * 86_400_000)) : "";
  const forms = opts.forms?.map((f) => f.toUpperCase());
  const picked = sub.filings
    .filter((f) => (!forms || forms.some((x) => f.form === x || f.form === `${x}/A`)) && f.filingDate >= since)
    .slice(0, opts.limit ?? 20);
  if (!picked.length) throw new ProviderError(SEC_SOURCE, `no ${forms?.join("/") ?? ""} filings for CIK ${co.cik}${since ? ` since ${since}` : ""}`, 404);
  const subject = opts.subject ?? co.ticker ?? sub.tickers[0] ?? `CIK${co.cik}`;
  const important = picked.filter(isImportant8k).length;
  const points = secFilingsPoints(picked, subject);
  if (picked.some((f) => /^8-K/.test(f.form)))
    points.push({
      key: `${subject}.filings.8k.important.count`,
      label: `${subject} 8-Ks with an important item in this list`,
      value: important,
      unit: "count",
    });
  return {
    kind: "filings",
    title: `${subject} recent SEC filings`,
    subject,
    points,
    provenance: { source: SEC_SOURCE, url: sub.url, fetchedAt: sub.fetchedAt, delay: "filing", official: true, asOf: picked[0]!.filingDate },
    notes: [`important 8-K items: ${[...IMPORTANT_8K_ITEMS].join(", ")}`],
  };
}

// ─── full-text search ──────────────────────────────────────────────────────

export interface SecSearchHit {
  accession: string;
  form: string;
  fileDate: string;
  periodEnding?: string;
  /** Filer names as EDGAR displays them — external text. */
  names: string;
  /** The document's description — external text. */
  description: string;
  url: string;
}

type FtsJson = {
  hits?: {
    total?: { value?: number };
    hits?: Array<{
      _id?: string;
      _source?: {
        ciks?: string[];
        display_names?: string[];
        form?: string;
        file_date?: string;
        period_ending?: string;
        file_description?: string;
        file_type?: string;
      };
    }>;
  };
};

/** efts search-index answer → hits with their document URLs. */
export function parseFullTextSearch(json: FtsJson): { total: number; hits: SecSearchHit[] } {
  const hits: SecSearchHit[] = [];
  for (const h of json.hits?.hits ?? []) {
    const [accession, file] = (h._id ?? "").split(":");
    const s = h._source;
    const cik = Number(s?.ciks?.[0] ?? 0);
    if (!accession || !file || !s?.form || !cik) continue;
    hits.push({
      accession,
      form: s.form,
      fileDate: s.file_date ?? "",
      ...(s.period_ending ? { periodEnding: s.period_ending } : {}),
      names: (s.display_names ?? []).join("; "),
      description: s.file_description ?? s.file_type ?? "",
      url: `${archiveBase(cik, accession)}/${file}`,
    });
  }
  return { total: json.hits?.total?.value ?? hits.length, hits };
}

/** EDGAR full-text search (phrases in quotes), optionally by forms, over the last `days` (default 30). Titles are untrusted. */
export async function secFullTextSearch(query: string, opts: { forms?: string[]; days?: number; limit?: number; now?: Date } = {}): Promise<Dataset> {
  const now = opts.now ?? clockNow();
  const end = isoDayOf(now);
  const start = isoDayOf(new Date(now.getTime() - (opts.days ?? 30) * 86_400_000));
  const params = new URLSearchParams({ q: query, dateRange: "custom", startdt: start, enddt: end });
  if (opts.forms?.length) params.set("forms", opts.forms.join(","));
  const url = `https://efts.sec.gov/LATEST/search-index?${params}`;
  const res = await secJson<FtsJson>(url);
  const { total, hits } = parseFullTextSearch(res.data);
  const shown = hits.slice(0, opts.limit ?? 20);
  return {
    kind: "search",
    title: `SEC full-text search ${start}..${end}`,
    subject: "SEC",
    points: [
      { key: "SEC.search.total", label: `SEC full-text hits ${start}..${end}`, value: total, unit: "count", asOf: end },
      ...shown.map((h, i) => ({
        key: `SEC.search.${h.accession}.${i}`,
        label: `SEC full-text hit ${h.form} filed ${h.fileDate}`,
        value: `${h.names} — ${h.description}`,
        untrusted: true,
        asOf: h.fileDate,
        url: h.url,
      })),
    ],
    provenance: { source: SEC_SOURCE, url, fetchedAt: res.fetchedAt, delay: "filing", official: true },
    notes: total > shown.length ? [`showing ${shown.length} of ${total} hits (one hit per matching document, exhibits included)`] : [],
  };
}
