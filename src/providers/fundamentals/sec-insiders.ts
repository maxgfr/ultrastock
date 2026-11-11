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
//
// Two things would inflate it. A Form 4/A restates a form already filed: it
// names that form only by the day it was filed (dateOfOriginalSubmission), not
// by its accession number, and may repeat every line or only the corrected
// ones — so its lines replace the ones they repeat or correct, and nothing
// else. And one filing may carry several reporting persons (a fund, its
// general partner, the partner himself) for the same shares: they are one
// buyer.
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
  /** A Form 4/A: it restates a form filed earlier. */
  amendment: boolean;
  /** For a 4/A, the day the form it amends was filed — all the document says of its original. */
  originalFiled?: string;
}

/** A Form 4 as it is summarised: what it reports, and when it was filed — which is how an amendment finds its original. */
export type FiledForm4 = Pick<Form4, "owners" | "transactions"> &
  Partial<Pick<Form4, "amendment" | "originalFiled">> & {
    /** The day EDGAR received it (YYYY-MM-DD). */
    filed?: string;
    accession?: string;
  };

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
  const originalFiled = xmlValue(xml, "dateOfOriginalSubmission")?.slice(0, 10);
  return {
    issuerCik: xmlValue(xml, "issuer", "issuerCik"),
    symbol: xmlValue(xml, "issuer", "issuerTradingSymbol"),
    periodOfReport: xmlValue(xml, "periodOfReport"),
    owners,
    transactions,
    plan10b51: truthy(xmlValue(xml, "aff10b5One")),
    amendment: /\/A$/i.test(xmlValue(xml, "documentType") ?? ""),
    ...(originalFiled ? { originalFiled } : {}),
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
  /** Distinct insiders with an open-market purchase in the last 30 days; the reporting persons of a joint filing are one. */
  buyers30d: number;
  clusterBuy: boolean;
  /** What was done with each amendment (4/A) among the filings. */
  notes: string[];
}

const ownerKey = (o: InsiderOwner) => o.cik || o.name;

const sameLine = (a: InsiderTransaction, b: InsiderTransaction) =>
  a.date === b.date && a.code === b.code && a.shares === b.shares && a.price === b.price && a.acquired === b.acquired && a.direct === b.direct;

/**
 * The transactions each filing still stands for once amendments are applied,
 * in the order given. A 4/A is matched to the form of the same reporting
 * person filed on the day it names (and to earlier amendments of that form);
 * each of its lines then replaces the line it repeats, else the one line of
 * the same date and code that kept its price (the share count was corrected)
 * or its share count (the price was), or the only line of that date and code.
 * A line that matches nothing is an addition. What cannot be told from the
 * documents is left as filed and said: an original that was not read, a line
 * whose date or code was itself corrected — it reads as an addition and its
 * original stays — and a line that could replace several of its day.
 */
export function netOfAmendments(filings: readonly FiledForm4[]): { transactions: InsiderTransaction[][]; notes: string[] } {
  const live = filings.map((f) => [...f.transactions]);
  const notes: string[] = [];
  const amendments = filings
    .map((_, i) => i)
    .filter((i) => filings[i]!.amendment)
    // Oldest first, in a total order: two amendments filed the same day apply by accession number, never by the order
    // the filings were listed in (EDGAR lists them newest first).
    .sort(
      (a, b) =>
        (filings[a]!.filed ?? "").localeCompare(filings[b]!.filed ?? "") || (filings[a]!.accession ?? "").localeCompare(filings[b]!.accession ?? "") || a - b,
    );
  const applied = new Set<number>();
  for (const i of amendments) {
    const a = filings[i]!;
    applied.add(i);
    if (!a.transactions.length) continue;
    const name = `Form 4/A${a.accession ? ` ${a.accession}` : ""}${a.filed ? ` (filed ${a.filed})` : ""}`;
    if (!a.originalFiled) {
      notes.push(`${name} does not name the form it amends: its lines are counted as filed`);
      continue;
    }
    const persons = new Set(a.owners.map(ownerKey));
    const targets = filings
      .map((_, j) => j)
      .filter((j) => {
        const f = filings[j]!;
        if (j === i || !f.owners.some((o) => persons.has(ownerKey(o)))) return false;
        return f.amendment ? applied.has(j) && f.originalFiled === a.originalFiled : f.filed === a.originalFiled;
      });
    if (!targets.length) {
      notes.push(`${name} amends a form filed ${a.originalFiled} that is not among the filings read: its lines are counted as filed`);
      continue;
    }
    const supersede = (match: (t: InsiderTransaction) => boolean): boolean => {
      for (const j of targets) {
        const k = live[j]!.findIndex(match);
        if (k >= 0) {
          live[j]!.splice(k, 1);
          return true;
        }
      }
      return false;
    };
    // A corrected line replaces the one line of its date and code that kept the other figure: the price when the share
    // count was corrected, the share count when the price was. Never the first by position: a Form 4 often holds
    // several fills of one day.
    let ambiguous = 0;
    const correct = (r: InsiderTransaction): boolean => {
      const cands = targets.flatMap((j) => live[j]!.flatMap((t, k) => (t.date === r.date && t.code === r.code ? [{ j, k, t }] : [])));
      const samePrice = cands.filter((c) => c.t.price === r.price);
      const sameShares = cands.filter((c) => c.t.shares === r.shares);
      const hit = samePrice.length === 1 ? samePrice[0] : sameShares.length === 1 ? sameShares[0] : cands.length === 1 ? cands[0] : undefined;
      if (!hit) {
        if (cands.length > 1) ambiguous++;
        return false;
      }
      live[hit.j]!.splice(hit.k, 1);
      return true;
    };
    // Repeated lines first, so that a corrected line never takes the place of one restated as it was.
    const changed = a.transactions.filter((r) => !supersede((t) => sameLine(t, r)));
    const added = changed.filter((r) => !correct(r));
    const n = a.transactions.length;
    notes.push(
      `${name} amends the form filed ${a.originalFiled}: ${n - added.length} of its ${n} line${n > 1 ? "s" : ""} replace${n - added.length === 1 ? "s" : ""} what that form reported${
        added.length
          ? `, ${added.length} ${added.length > 1 ? "are" : "is"} counted as new (a line whose date or code was corrected cannot be matched to the one it replaces${
              ambiguous ? `; ${ambiguous} could replace several lines of its day, neither price nor share count telling which, and none is picked` : ""
            })`
          : ""
      }`,
    );
  }
  return { transactions: live, notes };
}

/**
 * Open-market activity (P and S only) over `windowDays` before `now`, amendments applied; a cluster is ≥3 distinct
 * buyers in 30 days, where the persons reporting together on one form are a single buyer.
 */
export function summarizeInsiders(filings: readonly FiledForm4[], now: Date, windowDays = 90): InsiderSummary {
  const since = isoDayOf(new Date(now.getTime() - windowDays * 86_400_000));
  const since30 = isoDayOf(new Date(now.getTime() - 30 * 86_400_000));
  const s = { buyShares: 0, buyValue: 0, sellShares: 0, sellValue: 0 };
  // Persons who report on the same form hold the same shares: one interest, whichever of them files next.
  const group = new Map<string, string>();
  const interestOf = (key: string): string => {
    const up = group.get(key);
    if (up === undefined || up === key) return key;
    const root = interestOf(up);
    group.set(key, root);
    return root;
  };
  for (const f of filings) {
    const [first, ...rest] = f.owners.map(ownerKey);
    if (first !== undefined) for (const k of rest) group.set(interestOf(k), interestOf(first));
  }
  const { transactions, notes } = netOfAmendments(filings);
  const buyers = new Set<string>();
  filings.forEach((f, i) => {
    for (const t of transactions[i]!) {
      if (t.date < since) continue;
      const value = t.shares * (t.price ?? 0);
      if (t.code === "P") {
        s.buyShares += t.shares;
        s.buyValue += value;
        if (t.date >= since30 && f.owners[0]) buyers.add(interestOf(ownerKey(f.owners[0])));
      } else if (t.code === "S") {
        s.sellShares += t.shares;
        s.sellValue += value;
      }
    }
  });
  return { windowDays, ...s, netValue: s.buyValue - s.sellValue, buyers30d: buyers.size, clusterBuy: buyers.size >= 3, notes };
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
  const parsed: FiledForm4[] = [];
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
    const amendment = form.amendment || f.form === "4/A";
    parsed.push({ ...form, amendment, filed: f.filingDate, accession: f.accession });
    const acc = f.accession;
    const formName = amendment ? "Form 4/A" : "Form 4";
    points.push({
      key: `${subject}.insider.${acc}.owner`,
      label: `${subject} ${formName} filer (filed ${f.filingDate}${amendment && form.originalFiled ? `, amends the form filed ${form.originalFiled}` : ""})`,
      value: form.owners.map((o) => `${o.name}${o.title ? ` — ${o.title}` : ""}`).join("; "),
      untrusted: true,
      asOf: f.filingDate,
      url: f.url,
    });
    form.transactions.forEach((t, i) => {
      points.push({
        key: `${subject}.insider.${acc}.${i + 1}`,
        label: `${subject} ${formName} ${t.code} (${FORM4_CODES[t.code] ?? "other"}) on ${t.date}${t.price !== undefined ? ` at ${t.price} USD` : ""}${t.direct ? "" : ", indirect"}${form.plan10b51 ? ", 10b5-1 plan" : ""}`,
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
    ...s.notes,
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
