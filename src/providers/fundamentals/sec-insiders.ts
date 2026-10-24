// SEC Form 4 — insiders' own reports of their trades in the issuer's stock
// (official, filed within two business days of the trade):
//
//   the list      data.sec.gov/submissions/CIK##########.json (forms 4, 4/A)
//   each filing   www.sec.gov/Archives/edgar/data/<cik>/<accession>/<form4.xml>
//
// The submissions list names the xsl-RENDERED document ("xslF345X06/form4.xml");
// the raw XML sits at the same path without the xsl directory, and the filing's
// index.json is the fallback when it does not. Only non-derivative rows are
// read. The signal is open-market BUYING (code P): sales (S) are mostly
// diversification and 10b5-1 plans, grants (A), exercises (M) and tax
// withholding (F) are compensation mechanics. Several distinct insiders buying
// within 30 days (a cluster) is the pattern worth flagging.
import type { Dataset, Point } from "../../core/datasets.js";
import { clockNow } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { archiveBase, SEC_SOURCE, type SecFiling, secCompany, secJson, secSubmissions, secText } from "./sec.js";
import { isoDayOf } from "./util.js";
import { xmlBlocks, xmlNumber, xmlValue } from "./xml.js";

/** Form 4 transaction codes (the common ones). */
export const FORM4_CODES: Record<string, string> = {
  P: "open-market purchase",
  S: "open-market sale",
  A: "grant or award",
  M: "option exercise",
  F: "tax withholding",
  G: "gift",
  D: "disposition to the issuer",
  C: "conversion",
  X: "derivative exercise",
  J: "other",
  W: "will or inheritance",
};

export interface InsiderOwner {
  cik: string;
  name: string;
  title: string;
}

export interface InsiderTransaction {
  date: string;
  code: string;
  shares: number;
  price?: number;
  /** True when acquired (A), false when disposed (D). */
  acquired: boolean;
  sharesAfter?: number;
  direct: boolean;
}

export interface Form4 {
  issuerCik?: string;
  symbol?: string;
  periodOfReport?: string;
  owners: InsiderOwner[];
  transactions: InsiderTransaction[];
  /** The filer ticked the Rule 10b5-1 plan box. */
  plan10b51: boolean;
}

const truthy = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";

/** A Form 4 ownershipDocument → owners and non-derivative transactions. */
export function parseForm4(xml: string): Form4 {
  const owners: InsiderOwner[] = xmlBlocks(xml, "reportingOwner").map((o) => {
    const rel = xmlBlocks(o, "reportingOwnerRelationship")[0] ?? "";
    const roles = [
      xmlValue(rel, "officerTitle"),
      truthy(xmlValue(rel, "isDirector")) ? "Director" : undefined,
      truthy(xmlValue(rel, "isTenPercentOwner")) ? "10% owner" : undefined,
      truthy(xmlValue(rel, "isOther")) ? (xmlValue(rel, "otherText") ?? "other") : undefined,
    ].filter(Boolean);
    return { cik: xmlValue(o, "rptOwnerCik") ?? "", name: xmlValue(o, "rptOwnerName") ?? "", title: roles.join(", ") };
  });
  const transactions: InsiderTransaction[] = [];
  for (const t of xmlBlocks(xml, "nonDerivativeTransaction")) {
    const date = xmlValue(t, "transactionDate", "value")?.slice(0, 10);
    const code = xmlValue(t, "transactionCoding", "transactionCode");
    const shares = xmlNumber(t, "transactionAmounts", "transactionShares", "value");
    if (!date || !code || shares === undefined) continue;
    const price = xmlNumber(t, "transactionAmounts", "transactionPricePerShare", "value");
    const after = xmlNumber(t, "postTransactionAmounts", "sharesOwnedFollowingTransaction", "value");
    transactions.push({
      date,
      code,
      shares,
      ...(price !== undefined && price > 0 ? { price } : {}),
      acquired: xmlValue(t, "transactionAcquiredDisposedCode", "value") !== "D",
      ...(after !== undefined ? { sharesAfter: after } : {}),
      direct: xmlValue(t, "ownershipNature", "directOrIndirectOwnership", "value") !== "I",
    });
  }
  return {
    issuerCik: xmlValue(xml, "issuer", "issuerCik"),
    symbol: xmlValue(xml, "issuer", "issuerTradingSymbol"),
    periodOfReport: xmlValue(xml, "periodOfReport"),
    owners,
    transactions,
    plan10b51: truthy(xmlValue(xml, "aff10b5One")),
  };
}

export interface InsiderSummary {
  windowDays: number;
  buyShares: number;
  buyValue: number;
  sellShares: number;
  sellValue: number;
  /** Open-market purchases minus open-market sales, in USD. */
  netValue: number;
  /** Distinct insiders with an open-market purchase in the last 30 days. */
  buyers30d: number;
  clusterBuy: boolean;
}

/** Open-market activity (P and S only) over `windowDays` before `now`; a cluster is ≥3 distinct buyers in 30 days. */
export function summarizeInsiders(filings: Array<Pick<Form4, "owners" | "transactions">>, now: Date, windowDays = 90): InsiderSummary {
  const since = isoDayOf(new Date(now.getTime() - windowDays * 86_400_000));
  const since30 = isoDayOf(new Date(now.getTime() - 30 * 86_400_000));
  const s = { buyShares: 0, buyValue: 0, sellShares: 0, sellValue: 0 };
  const buyers = new Set<string>();
  for (const f of filings) {
    for (const t of f.transactions) {
      if (t.date < since) continue;
      const value = t.shares * (t.price ?? 0);
      if (t.code === "P") {
        s.buyShares += t.shares;
        s.buyValue += value;
        if (t.date >= since30) for (const o of f.owners) buyers.add(o.cik || o.name);
      } else if (t.code === "S") {
        s.sellShares += t.shares;
        s.sellValue += value;
      }
    }
  }
  return { windowDays, ...s, netValue: s.buyValue - s.sellValue, buyers30d: buyers.size, clusterBuy: buyers.size >= 3 };
}

/** The raw ownership XML of a Form 4 filing: the xsl-less primary document, else the first .xml of its index. */
async function form4Xml(cik: number, f: SecFiling): Promise<{ xml: string; url: string }> {
  const base = archiveBase(cik, f.accession);
  const raw = f.primaryDocument.replace(/^xsl[^/]*\//, "");
  if (raw.endsWith(".xml")) {
    try {
      const res = await secText(`${base}/${raw}`);
      if (/<ownershipDocument/.test(res.body)) return { xml: res.body, url: `${base}/${raw}` };
    } catch (e) {
      if (!(e instanceof ProviderError) || e.transient) throw e;
    }
  }
  const index = await secJson<{ directory?: { item?: Array<{ name?: string }> } }>(`${base}/index.json`);
  const name = index.data.directory?.item?.map((i) => i.name ?? "").find((n) => n.endsWith(".xml"));
  if (!name) throw new ProviderError(SEC_SOURCE, `no XML document in filing ${f.accession}`, 404);
  const res = await secText(`${base}/${name}`);
  return { xml: res.body, url: `${base}/${name}` };
}

/**
 * The last `limit` Form 4 filings of an issuer, each transaction a point, plus
 * a summary of open-market buying over 90 days and cluster-buy detection.
 */
export async function secInsiders(tickerOrCik: string, opts: { limit?: number; now?: Date } = {}): Promise<Dataset> {
  const now = opts.now ?? clockNow();
  const co = await secCompany(tickerOrCik);
  const sub = await secSubmissions(co.cik);
  const subject = co.ticker ?? sub.tickers[0] ?? `CIK${co.cik}`;
  const list = sub.filings.filter((f) => f.form === "4" || f.form === "4/A").slice(0, opts.limit ?? 5);
  if (!list.length) throw new ProviderError(SEC_SOURCE, `no Form 4 filings for ${subject} in its recent filings`, 404);
  const points: Point[] = [];
  const parsed: Form4[] = [];
  const notes: string[] = [];
  for (const f of list) {
    let doc: { xml: string; url: string };
    try {
      doc = await form4Xml(co.cik, f);
    } catch (e) {
      if (e instanceof ProviderError && !e.transient) {
        notes.push(`Form 4 ${f.accession} unreadable: ${e.message}`);
        continue;
      }
      throw e;
    }
    const form = parseForm4(doc.xml);
    parsed.push(form);
    const acc = f.accession;
    points.push({
      key: `${subject}.insider.${acc}.owner`,
      label: `${subject} Form 4 filer (filed ${f.filingDate})`,
      value: form.owners.map((o) => `${o.name}${o.title ? ` — ${o.title}` : ""}`).join("; "),
      untrusted: true,
      asOf: f.filingDate,
      url: f.url,
    });
    form.transactions.forEach((t, i) => {
      points.push({
        key: `${subject}.insider.${acc}.${i + 1}`,
        label: `${subject} Form 4 ${t.code} (${FORM4_CODES[t.code] ?? "other"}) on ${t.date}${t.price !== undefined ? ` at ${t.price} USD` : ""}${t.direct ? "" : ", indirect"}${form.plan10b51 ? ", 10b5-1 plan" : ""}`,
        value: t.acquired ? t.shares : -t.shares,
        unit: "shares",
        asOf: t.date,
        url: doc.url,
      });
    });
  }
  const s = summarizeInsiders(parsed, now);
  const today = isoDayOf(now);
  points.push(
    { key: `${subject}.insider.buy90d.value`, label: `${subject} insider open-market purchases (P), 90 days`, value: s.buyValue, unit: "USD", asOf: today },
    { key: `${subject}.insider.sell90d.value`, label: `${subject} insider open-market sales (S), 90 days`, value: s.sellValue, unit: "USD", asOf: today },
    {
      key: `${subject}.insider.net90d.value`,
      label: `${subject} insider net open-market buying, 90 days`,
      value: s.netValue,
      unit: "USD",
      asOf: today,
      formula: "purchases (P) − sales (S), shares × price",
    },
    {
      key: `${subject}.insider.buyers30d.count`,
      label: `${subject} distinct insiders buying on the open market, 30 days`,
      value: s.buyers30d,
      unit: "count",
      asOf: today,
    },
    { key: `${subject}.insider.clusterBuy`, label: `${subject} insider cluster buy (≥3 distinct buyers in 30 days)`, value: s.clusterBuy, asOf: today },
  );
  notes.push(
    `summary over the ${list.length} most recent Form 4 filings only — raise the limit for a fuller window`,
    "share counts are signed: + acquired, − disposed; P = open-market purchase is the buying signal, S/A/M/F are mostly sales and compensation mechanics",
  );
  return {
    kind: "insiders",
    title: `${subject} insider transactions (SEC Form 4)`,
    subject,
    points,
    provenance: { source: SEC_SOURCE, url: sub.url, fetchedAt: sub.fetchedAt, delay: "filing", official: true, asOf: list[0]!.filingDate },
    notes,
  };
}
