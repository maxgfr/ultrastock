// European (IFRS) fundamentals from ESEF annual reports — the issuer's own
// tagged filing, collected by XBRL International at filings.xbrl.org (keyless
// JSON:API) and converted to xBRL-JSON there:
//
//   filings     https://filings.xbrl.org/api/filings?filter[entity.identifier]=<LEI>&sort=-period_end
//   entities    https://filings.xbrl.org/api/entities?filter=[{"name":"name","op":"ilike","val":"%lvmh%"}]
//   the report  https://filings.xbrl.org<json_url>   (xBRL-JSON: one object per fact)
//
// The figures are the issuer's (official); the repository is not the issuer's
// officially appointed mechanism and lags it — often weeks, sometimes a year —
// and `date_added` is when the report reached the repository, which is what a
// point-in-time `asOf` filters on. Annual reports only (ESEF does not cover
// half-years). Consolidated figures are the facts with no dimension beyond
// concept/entity/period/unit; segment and equity-component breakdowns are not.
// xBRL-JSON writes a date as the following midnight ("2025-01-01T00:00:00" is
// the end of 2024-12-31), undone here. A report with its notes block-tagged
// weighs megabytes: the parsed metrics are cached, a filing never changes.
import { cachedJson, TTL } from "../../core/cache.js";
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { isIsin, leiForIsin } from "./gleif.js";
import { daysBetween, shiftIsoDay } from "./util.js";

export const ESEF_SOURCE = "esef";
const BASE = "https://filings.xbrl.org";

export interface EsefFiling {
  id: string;
  lei: string;
  periodEnd: string;
  country: string;
  /** When the report was added to filings.xbrl.org (YYYY-MM-DD) — not the issuer's publication date. */
  added: string;
  jsonUrl?: string;
  viewerUrl?: string;
  errors: number;
}

type FilingsJson = {
  data?: Array<{
    id?: string;
    attributes?: {
      period_end?: string;
      country?: string;
      fxo_id?: string;
      date_added?: string;
      json_url?: string | null;
      viewer_url?: string | null;
      error_count?: number;
    };
  }>;
};

/** The filings index → filings, latest period first. */
export function parseEsefFilings(json: FilingsJson): EsefFiling[] {
  return (json.data ?? [])
    .flatMap((d) => {
      const a = d.attributes;
      if (!d.id || !a?.period_end) return [];
      return [
        {
          id: d.id,
          lei: (a.fxo_id ?? "").split("-")[0] ?? "",
          periodEnd: a.period_end,
          country: a.country ?? "",
          added: (a.date_added ?? "").slice(0, 10),
          ...(a.json_url ? { jsonUrl: `${BASE}${a.json_url}` } : {}),
          ...(a.viewer_url ? { viewerUrl: `${BASE}${a.viewer_url}` } : {}),
          errors: a.error_count ?? 0,
        },
      ];
    })
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.added.localeCompare(a.added));
}

interface IfrsDef {
  id: string;
  label: string;
  kind: "flow" | "instant";
  concepts: string[];
}

/** IFRS concept fallbacks, in order (ifrs-full prefix implied). */
export const ESEF_METRICS: IfrsDef[] = [
  { id: "revenue", label: "revenue", kind: "flow", concepts: ["Revenue", "RevenueFromContractsWithCustomers"] },
  { id: "grossProfit", label: "gross profit", kind: "flow", concepts: ["GrossProfit"] },
  { id: "operatingIncome", label: "operating profit", kind: "flow", concepts: ["ProfitLossFromOperatingActivities"] },
  { id: "netIncome", label: "net income attributable to owners", kind: "flow", concepts: ["ProfitLossAttributableToOwnersOfParent"] },
  { id: "profitLoss", label: "net income incl. minorities", kind: "flow", concepts: ["ProfitLoss"] },
  { id: "epsBasic", label: "basic EPS", kind: "flow", concepts: ["BasicEarningsLossPerShare"] },
  { id: "epsDiluted", label: "diluted EPS", kind: "flow", concepts: ["DilutedEarningsLossPerShare"] },
  { id: "operatingCashFlow", label: "operating cash flow", kind: "flow", concepts: ["CashFlowsFromUsedInOperatingActivities"] },
  {
    id: "capex",
    label: "capital expenditure",
    kind: "flow",
    concepts: [
      "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
      "PurchaseOfPropertyPlantAndEquipment",
      "PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets",
    ],
  },
  {
    id: "dividendsPaid",
    label: "dividends paid",
    kind: "flow",
    concepts: ["DividendsPaidClassifiedAsFinancingActivities", "DividendsPaidToEquityHoldersOfParentClassifiedAsFinancingActivities", "DividendsPaid"],
  },
  { id: "researchAndDevelopment", label: "R&D expense", kind: "flow", concepts: ["ResearchAndDevelopmentExpense"] },
  { id: "weightedAverageShares", label: "weighted average shares", kind: "flow", concepts: ["WeightedAverageShares"] },
  { id: "assets", label: "total assets", kind: "instant", concepts: ["Assets"] },
  { id: "liabilities", label: "total liabilities", kind: "instant", concepts: ["Liabilities"] },
  { id: "equity", label: "total equity", kind: "instant", concepts: ["Equity"] },
  { id: "equityParent", label: "equity attributable to owners", kind: "instant", concepts: ["EquityAttributableToOwnersOfParent"] },
  { id: "cash", label: "cash and equivalents", kind: "instant", concepts: ["CashAndCashEquivalents"] },
  { id: "costOfRevenue", label: "cost of sales", kind: "flow", concepts: ["CostOfSales"] },
  { id: "sga", label: "selling, general and administrative expense", kind: "flow", concepts: ["SellingGeneralAndAdministrativeExpense", "DistributionCosts"] },
  { id: "pretaxIncome", label: "profit before tax", kind: "flow", concepts: ["ProfitLossBeforeTax"] },
  { id: "incomeTax", label: "income tax expense", kind: "flow", concepts: ["IncomeTaxExpenseContinuingOperations"] },
  { id: "interestExpense", label: "finance costs", kind: "flow", concepts: ["FinanceCosts", "InterestExpense"] },
  {
    id: "depreciation",
    label: "depreciation and amortisation",
    kind: "flow",
    concepts: ["DepreciationAndAmortisationExpense", "DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss", "AdjustmentsForDepreciationAndAmortisationExpense"],
  },
  { id: "currentAssets", label: "current assets", kind: "instant", concepts: ["CurrentAssets"] },
  { id: "currentLiabilities", label: "current liabilities", kind: "instant", concepts: ["CurrentLiabilities"] },
  { id: "receivables", label: "trade receivables", kind: "instant", concepts: ["TradeAndOtherCurrentReceivables", "CurrentTradeReceivables"] },
  { id: "inventory", label: "inventories", kind: "instant", concepts: ["Inventories"] },
  { id: "ppe", label: "property, plant and equipment", kind: "instant", concepts: ["PropertyPlantAndEquipment"] },
  { id: "retainedEarnings", label: "retained earnings", kind: "instant", concepts: ["RetainedEarnings"] },
  { id: "longTermDebtNoncurrent", label: "non-current borrowings", kind: "instant", concepts: ["NoncurrentBorrowings", "LongtermBorrowings"] },
];

export interface IfrsValue {
  period: string;
  start?: string;
  end: string;
  value: number;
  /** EUR, USD… for amounts (per share for EPS), "shares" for counts. */
  unit: string;
  concept: string;
  decimals?: number;
  formula?: string;
}

export interface IfrsMetric {
  id: string;
  label: string;
  values: IfrsValue[];
}

type XbrlJson = { facts?: Record<string, { value?: string | number | null; decimals?: number; dimensions?: Record<string, string> }> };

const CORE_DIMS = new Set(["concept", "entity", "period", "unit", "language", "noteId"]);
/** "2025-01-01T00:00:00" → "2024-12-31": xBRL-JSON's midnight-after convention. */
const dayOf = (s: string) => (/T00:00:00/.test(s) ? shiftIsoDay(s.slice(0, 10), -1) : s.slice(0, 10));

interface Fact {
  concept: string;
  start?: string;
  end: string;
  value: number;
  unit: string;
  decimals?: number;
}

/** Consolidated numeric facts (no dimension beyond the core ones), deduplicated. */
export function consolidatedFacts(json: XbrlJson): Fact[] {
  const out = new Map<string, Fact>();
  for (const f of Object.values(json.facts ?? {})) {
    const d = f.dimensions ?? {};
    if (!d.concept || !d.period || !d.unit || Object.keys(d).some((k) => !CORE_DIMS.has(k))) continue;
    const value = typeof f.value === "number" ? f.value : Number(f.value);
    if (f.value === null || f.value === undefined || !Number.isFinite(value)) continue;
    const [a, b] = d.period.split("/");
    const fact: Fact = {
      concept: d.concept,
      ...(b ? { start: a!.slice(0, 10) } : {}),
      end: dayOf(b ?? a!),
      value,
      unit: d.unit
        .split("/")
        .map((u) => u.replace(/^iso4217:/, "").replace(/^xbrli:/, ""))
        .join("/"),
      ...(typeof f.decimals === "number" ? { decimals: f.decimals } : {}),
    };
    const key = `${fact.concept}|${fact.start ?? ""}|${fact.end}|${fact.unit}`;
    if (!out.has(key)) out.set(key, fact);
  }
  return [...out.values()];
}

const unitName = (u: string) => (u.endsWith("/shares") ? u.slice(0, -"/shares".length) : u);

/** Annual metrics from an ESEF xBRL-JSON report, per fiscal year (FY = the year the period ends). */
export function parseEsefReport(json: XbrlJson): { metrics: IfrsMetric[]; notes: string[] } {
  const facts = consolidatedFacts(json);
  const notes: string[] = [];
  const metrics: IfrsMetric[] = [];
  const pick = (concepts: string[], kind: "flow" | "instant"): IfrsValue[] => {
    const byPeriod = new Map<string, IfrsValue>();
    for (const c of concepts) {
      const concept = c.includes(":") ? c : `ifrs-full:${c}`;
      for (const f of facts) {
        if (f.concept !== concept) continue;
        if (kind === "flow" && (!f.start || Math.abs(daysBetween(f.start, f.end) - 365) > 25)) continue;
        if (kind === "instant" && f.start) continue;
        if (byPeriod.has(f.end)) continue;
        byPeriod.set(f.end, {
          period: `FY${f.end.slice(0, 4)}`,
          ...(f.start ? { start: f.start } : {}),
          end: f.end,
          value: f.value,
          unit: unitName(f.unit),
          concept,
          ...(f.decimals !== undefined ? { decimals: f.decimals } : {}),
        });
      }
    }
    return [...byPeriod.values()].sort((a, b) => b.end.localeCompare(a.end));
  };
  for (const def of ESEF_METRICS) {
    let values = pick(def.concepts, def.kind);
    if (!values.length && def.id === "liabilities") {
      const nc = pick(["NoncurrentLiabilities"], "instant");
      const cur = pick(["CurrentLiabilities"], "instant");
      values = nc.flatMap((n) => {
        const c = cur.find((x) => x.end === n.end && x.unit === n.unit);
        return c ? [{ ...n, value: n.value + c.value, concept: "derived", formula: "NoncurrentLiabilities + CurrentLiabilities" }] : [];
      });
    }
    if (values.length) metrics.push({ id: def.id, label: def.label, values });
    else notes.push(`${def.label}: not tagged with ${def.concepts.join(" | ")}`);
  }
  // Debt: total borrowings, else non-current + current.
  const total = pick(["Borrowings"], "instant");
  const debt = total.length
    ? total
    : (() => {
        const nc = pick(["NoncurrentBorrowings", "LongtermBorrowings", "NoncurrentPortionOfNoncurrentBorrowings"], "instant");
        const cur = pick(["CurrentBorrowings", "CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings", "ShorttermBorrowings"], "instant");
        return nc.map((n) => {
          const c = cur.find((x) => x.end === n.end && x.unit === n.unit);
          return {
            ...n,
            value: n.value + (c?.value ?? 0),
            concept: "derived",
            formula: c ? `${n.concept} + ${c.concept}` : `${n.concept} (no current borrowings tagged)`,
          };
        });
      })();
  if (debt.length) metrics.push({ id: "debt", label: "borrowings", values: debt });
  else notes.push("borrowings: not tagged with the standard IFRS concepts (issuers often use an extension, e.g. net financial debt)");
  const ocf = metrics.find((m) => m.id === "operatingCashFlow");
  const capex = metrics.find((m) => m.id === "capex");
  if (ocf && capex) {
    const values = ocf.values.flatMap((o) => {
      const c = capex.values.find((x) => x.end === o.end && x.unit === o.unit);
      return c ? [{ ...o, value: o.value - Math.abs(c.value), concept: "derived", formula: "operatingCashFlow − |capex|" }] : [];
    });
    if (values.length) metrics.push({ id: "freeCashFlow", label: "free cash flow", values });
  }
  return { metrics, notes };
}

/** Points `<S>.fund.<metric>.FY<year>` from parsed ESEF metrics. */
export function esefPoints(metrics: IfrsMetric[], subject: string, filing: Pick<EsefFiling, "added" | "periodEnd">): Point[] {
  return metrics.flatMap((m) =>
    m.values.map((v) => ({
      key: `${subject}.fund.${m.id}.${v.period}`,
      label: `${subject} ${m.label} ${v.period} (${v.concept === "derived" ? "derived" : v.concept}; ESEF report ${filing.periodEnd}, in repository since ${filing.added})`,
      value: v.value,
      unit: v.unit,
      asOf: v.end,
      ...(v.formula ? { formula: v.formula } : {}),
    })),
  );
}

async function filingsOf(lei: string) {
  const url = `${BASE}/api/filings?filter[entity.identifier]=${lei}&sort=-period_end&page[size]=20`;
  const res = await fetchJson<FilingsJson>(url, { accept: "application/vnd.api+json, application/json" });
  if (!res.ok || !res.data) throw new ProviderError(ESEF_SOURCE, `filings index failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  return { filings: parseEsefFilings(res.data), url, fetchedAt: res.fetchedAt };
}

export const isLei = (s: string) => /^[A-Z0-9]{18}\d{2}$/.test(s.trim().toUpperCase());

/**
 * IFRS key metrics from the latest ESEF annual report of an issuer (by LEI or
 * ISIN), or the latest one in the repository by `asOf` (YYYY-MM-DD).
 */
export async function esefFundamentals(id: string, opts: { asOf?: string; subject?: string } = {}): Promise<Dataset> {
  const v = id.trim().toUpperCase();
  const lei = isLei(v) ? v : isIsin(v) ? (await leiForIsin(v)).record.lei : undefined;
  if (!lei) throw new ProviderError(ESEF_SOURCE, `"${id}" is neither an LEI nor an ISIN — find the LEI by name first (esefEntities / gleifSearch)`, 400);
  const index = await filingsOf(lei);
  const filing = index.filings.find((f) => f.jsonUrl && (!opts.asOf || f.added <= opts.asOf));
  if (!filing?.jsonUrl)
    throw new ProviderError(ESEF_SOURCE, `no ESEF report for LEI ${lei} on filings.xbrl.org${opts.asOf ? ` added by ${opts.asOf}` : ""}`, 404);
  const jsonUrl = filing.jsonUrl;
  const got = await cachedJson(`esef:report:${filing.id}`, TTL.immutable, async () => {
    const res = await fetchJson<XbrlJson>(jsonUrl, { timeoutMs: 60_000 });
    if (!res.ok || !res.data)
      throw new ProviderError(ESEF_SOURCE, `report ${jsonUrl} unreadable (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
    return { ...parseEsefReport(res.data), fetchedAt: res.fetchedAt };
  });
  if (!got) throw new ProviderError(ESEF_SOURCE, `report ${jsonUrl} unavailable (offline and not cached)`, 0);
  const subject = opts.subject ?? (isIsin(v) ? v : lei);
  const points = esefPoints(got.metrics, subject, filing);
  if (!points.length) throw new ProviderError(ESEF_SOURCE, `no consolidated IFRS key metrics tagged in ${jsonUrl}`, 404);
  const newer = index.filings.filter((f) => f.periodEnd > filing.periodEnd).map((f) => f.periodEnd);
  return {
    kind: "fundamentals",
    title: `${subject} key metrics (ESEF annual report ${filing.periodEnd})`,
    subject,
    points,
    provenance: { source: ESEF_SOURCE, url: jsonUrl, fetchedAt: got.fetchedAt, delay: "filing", official: true, asOf: filing.periodEnd },
    notes: [
      `the issuer's ESEF report as collected by filings.xbrl.org (added ${filing.added}); the repository lags the issuer's own publication`,
      ...(filing.errors ? [`the repository's validator reported ${filing.errors} error(s) in this report`] : []),
      ...(newer.length ? [`newer report(s) excluded by asOf: ${newer.join(", ")}`] : []),
      ...got.notes,
    ],
  };
}

/** Entities on filings.xbrl.org whose name contains `name` (case-insensitive) → LEI candidates. */
export async function esefEntities(name: string): Promise<Dataset> {
  const filter = JSON.stringify([{ name: "name", op: "ilike", val: `%${name.trim()}%` }]);
  const url = `${BASE}/api/entities?filter=${encodeURIComponent(filter)}&page[size]=10`;
  const res = await fetchJson<{ data?: Array<{ attributes?: { identifier?: string; name?: string } }> }>(url, {
    accept: "application/vnd.api+json, application/json",
  });
  if (!res.ok || !res.data) throw new ProviderError(ESEF_SOURCE, `entity search failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  const rows = (res.data.data ?? []).flatMap((d) => (d.attributes?.identifier ? [{ lei: d.attributes.identifier, name: d.attributes.name ?? "" }] : []));
  if (!rows.length) throw new ProviderError(ESEF_SOURCE, `no ESEF filer whose name contains "${name}"`, 404);
  return {
    kind: "identifiers",
    title: "ESEF filers by name (filings.xbrl.org)",
    subject: "ESEF",
    points: rows.flatMap((r, i) => [
      { key: `ESEF.search.${i + 1}.lei`, label: `ESEF filer candidate ${i + 1} LEI`, value: r.lei },
      { key: `ESEF.search.${i + 1}.name`, label: `ESEF filer candidate ${i + 1} name`, value: r.name, untrusted: true },
    ]),
    provenance: { source: ESEF_SOURCE, url, fetchedAt: res.fetchedAt, official: true },
    notes: [],
  };
}
