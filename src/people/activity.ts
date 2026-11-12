// What a public figure filed lately, and the trades in it, normalized across
// sources. Each source keeps its own delay and precision: a House PTR or an
// OGE 278-T gives value bands up to 45 days after the trade, a Form 4 exact
// shares and prices within two business days, a 13F a quarter's end positions
// up to 45 days later, a 13D/13G a stake's share of the class.
import { clockNow } from "../core/net.js";
import { HOUSE_SOURCE, houseIndex, readHousePtr } from "../providers/fundamentals/house.js";
import { OGE_SOURCE, oge278t, ogeFilings } from "../providers/fundamentals/oge.js";
import { SEC_SOURCE, secSubmissions, secTickerByTitle } from "../providers/fundamentals/sec.js";
import { latest13f } from "../providers/fundamentals/sec-13f.js";
import { sec13dgStakes } from "../providers/fundamentals/sec-13dg.js";
import { FORM4_CODES, secOwnerForm4s } from "../providers/fundamentals/sec-insiders.js";
import { ProviderError } from "../providers/types.js";
import { secRolesOf } from "./resolve.js";
import type { PersonActivity, PersonFiling, PersonRef, PublicTrade, TradeSide } from "./types.js";

export interface ActivityOptions {
  /** Only filings received on or after this day (YYYY-MM-DD). */
  since?: string;
  /** How many filings to read, newest first (per kind of filing for an SEC filer). */
  limit?: number;
  /** Filings listed but not read: already seen. */
  skip?: ReadonlySet<string>;
  /** List the filings without reading any. */
  listOnly?: boolean;
  now?: Date;
}

const PTR_SIDE: Record<string, TradeSide> = { P: "buy", S: "sell", "S (partial)": "sell", E: "exchange" };
const FORM4_SIDE: Record<string, TradeSide> = { P: "buy", S: "sell" };

const wanted = (o: ActivityOptions, id: string) => !o.listOnly && !o.skip?.has(id);

async function houseActivity(ref: PersonRef, o: ActivityOptions): Promise<PersonActivity> {
  const now = o.now ?? clockNow();
  const year = now.getUTCFullYear();
  const years = !o.since || o.since < `${year}-01-01` ? [year, year - 1] : [year];
  const listed: Array<{ docId: string; date: string; year: number; url: string }> = [];
  let index: { url: string; fetchedAt: string } | undefined;
  for (const y of years) {
    const idx = await houseIndex(y).catch((e) => {
      if (y === year) throw e;
      return undefined;
    });
    if (!idx) continue;
    index ??= idx;
    for (const f of idx.filings) if (f.filingType === "P" && f.member === ref.id) listed.push({ docId: f.docId, date: f.date, year: f.year, url: f.pdfUrl });
  }
  const recent = listed
    .filter((f) => !o.since || f.date >= o.since)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, o.limit ?? 5);
  const filings: PersonFiling[] = [];
  for (const f of recent) {
    const base = { id: f.docId, source: "house" as const, form: "House PTR", filed: f.date, url: f.url };
    if (!wanted(o, f.docId)) {
      filings.push({ ...base, trades: [], read: false });
      continue;
    }
    const ptr = await readHousePtr(f.docId, f.year);
    filings.push({
      ...base,
      read: true,
      trades: ptr.rows.map((r) => ({
        asset: r.ticker ?? "asset without a ticker",
        ...(r.ticker ? { ticker: r.ticker } : {}),
        side: PTR_SIDE[r.type] ?? "other",
        code: r.type,
        date: r.date,
        ...(r.amountLow !== undefined ? { amountLow: r.amountLow } : {}),
        ...(r.amountHigh !== undefined ? { amountHigh: r.amountHigh } : {}),
      })),
      ...(ptr.rows.length ? {} : { note: `rows not readable from the PDF (${ptr.reason ?? "no row recognized"}) — open it; a handwritten PTR has no text` }),
    });
  }
  return {
    ref,
    filings,
    notes: [
      "a House PTR is due within 45 days of the trade (often later); amounts are the form's value bands",
      "rows are read from the PDF's text, best effort (pdftotext reads more of them) — check against the linked filing",
    ],
    provenance: { source: HOUSE_SOURCE, url: index?.url ?? "", fetchedAt: index?.fetchedAt ?? now.toISOString() },
  };
}

async function ogeActivity(ref: PersonRef, o: ActivityOptions): Promise<PersonActivity> {
  const idx = await ogeFilings(ref.id);
  const reports = idx.filings.filter((f) => f.name === ref.id && f.kind === "278-T" && (!o.since || f.date >= o.since)).slice(0, o.limit ?? 3);
  const filings: PersonFiling[] = [];
  for (const f of reports) {
    const base = { id: f.id, source: "oge" as const, form: `OGE 278-T${f.amended ? " (amended)" : ""}`, filed: f.date, url: f.url ?? idx.url };
    if (!f.url) {
      filings.push({ ...base, trades: [], read: false, note: "available on request only (OGE Form 201)" });
      continue;
    }
    if (!wanted(o, f.id)) {
      filings.push({ ...base, trades: [], read: false });
      continue;
    }
    const r = await oge278t(f);
    const tickers = new Map<string, string | undefined>();
    for (const row of r.rows) if (!tickers.has(row.description)) tickers.set(row.description, await secTickerByTitle(row.description));
    filings.push({
      ...base,
      read: true,
      unread: r.unread,
      trades: r.rows.map((row) => {
        const ticker = tickers.get(row.description);
        return {
          asset: row.description,
          ...(ticker ? { ticker } : {}),
          side: row.type === "purchase" ? "buy" : row.type === "sale" ? "sell" : "exchange",
          code: row.type,
          ...(row.date ? { date: row.date } : {}),
          ...(row.amountLow !== undefined ? { amountLow: row.amountLow } : {}),
          ...(row.amountHigh !== undefined ? { amountHigh: row.amountHigh } : {}),
        } satisfies PublicTrade;
      }),
      ...(r.rows.length ? {} : { note: `rows not readable from the PDF (${r.reason ?? "no row recognized"}) — install pdftotext (poppler), or open it` }),
    });
  }
  return {
    ref,
    filings,
    notes: [
      "a 278-T is due within 30 days of the filer's notice of a trade and 45 days after it; amounts are the form's value bands",
      "the PDFs are scans read through their OCR layer: a row whose type, date or amount does not read is left out or left blank, never guessed — check against the linked report",
      "tickers are matched to the filed names through EDGAR's ticker list, best effort; bonds and funds keep their name only",
    ],
    provenance: { source: OGE_SOURCE, url: idx.url, fetchedAt: idx.fetchedAt },
  };
}

async function secActivity(ref: PersonRef, o: ActivityOptions): Promise<PersonActivity> {
  const cik = Number(ref.id);
  const sub = await secSubmissions(cik);
  const roles = ref.roles ?? secRolesOf(sub);
  const filings: PersonFiling[] = [];
  const notes: string[] = [];
  const limit = o.limit ?? 10;
  const listed = (forms: RegExp) => sub.filings.filter((f) => forms.test(f.form) && (!o.since || f.filingDate >= o.since)).slice(0, limit);

  if (roles.includes("13f")) {
    const [f] = listed(/^13F-HR$/);
    if (f && !wanted(o, f.accession))
      filings.push({ id: f.accession, source: "sec", form: "13F-HR", filed: f.filingDate, url: f.url, trades: [], read: false });
    else if (f) {
      const q = await latest13f(cik);
      if (q) {
        const trades: PublicTrade[] = (q.diffs ?? [])
          .filter((d) => d.change !== "unchanged")
          .map((d) => ({
            asset: `${d.holding.issuer}${d.holding.putCall ? ` (${d.holding.putCall})` : ""}`,
            side: d.change === "new" || d.change === "added" ? "buy" : "sell",
            code: d.change,
            date: q.period,
            shares: Math.abs(d.sharesChange),
            sharesAfter: d.holding.shares,
          }));
        filings.push({
          id: q.filing.accession,
          source: "sec",
          form: "13F-HR",
          filed: q.filing.filingDate,
          url: q.url,
          trades,
          read: true,
          ...(q.diffs ? {} : { note: "no previous 13F-HR to compare: no change shown" }),
        });
        notes.push(
          `13F-HR for the quarter ended ${q.period}: positions at the quarter's end, filed up to 45 days later; changes are against the previous 13F-HR`,
        );
      }
    }
  }

  if (roles.includes("form4")) {
    if (o.listOnly)
      for (const f of listed(/^4(\/A)?$/))
        filings.push({ id: f.accession, source: "sec", form: `Form ${f.form}`, filed: f.filingDate, url: f.url, trades: [], read: false });
    else {
      const got = await secOwnerForm4s(cik, { limit, since: o.since, skip: o.skip });
      notes.push(...got.notes);
      for (const form of got.forms) {
        const base = { id: form.accession, source: "sec" as const, form: form.amendment ? "Form 4/A" : "Form 4", filed: form.filed, url: form.url };
        if (o.skip?.has(form.accession)) {
          filings.push({ ...base, trades: [], read: false });
          continue;
        }
        filings.push({
          ...base,
          read: true,
          trades: form.transactions.map((t) => ({
            asset: form.issuerName ?? form.symbol ?? `CIK ${form.issuerCik ?? "?"}`,
            ...(form.symbol ? { ticker: form.symbol.toUpperCase() } : {}),
            side: FORM4_SIDE[t.code] ?? "other",
            code: `${t.code} (${FORM4_CODES[t.code] ?? "other"})`,
            date: t.date,
            shares: t.acquired ? t.shares : -t.shares,
            ...(t.price !== undefined ? { price: t.price } : {}),
            ...(t.sharesAfter !== undefined ? { sharesAfter: t.sharesAfter } : {}),
            ...(t.direct ? {} : { indirect: true }),
          })),
        });
      }
      notes.push(
        "Form 4 within two business days of the trade: exact shares and prices; P (open-market purchase) and S (sale) are the trades, A/M/F/G are compensation, exercises, tax and gifts",
      );
    }
  }

  if (roles.includes("13dg")) {
    if (o.listOnly)
      for (const f of listed(/^SCHEDULE 13[DG](\/A)?$/))
        filings.push({
          id: f.accession,
          source: "sec",
          form: f.form.replace("SCHEDULE", "Schedule"),
          filed: f.filingDate,
          url: f.url,
          trades: [],
          read: false,
        });
    else {
      const got = await sec13dgStakes(cik, { limit, since: o.since, skip: o.skip });
      notes.push(...got.notes);
      // Oldest first, so each stake is compared with the one before it in the same issuer.
      const last = new Map<string, number | undefined>();
      const rows = [...got.stakes].reverse().map((s) => {
        const key = s.cusip ?? s.issuerName;
        const before = last.get(key);
        last.set(key, s.percent);
        const side: TradeSide =
          before === undefined || s.percent === undefined
            ? s.amendment
              ? "other"
              : "buy"
            : s.percent > before
              ? "buy"
              : s.percent < before
                ? "sell"
                : "other";
        return { s, side };
      });
      for (const { s, side } of rows.reverse()) {
        const base = { id: s.accession, source: "sec" as const, form: `Schedule ${s.schedule}${s.amendment ? "/A" : ""}`, filed: s.filed, url: s.url };
        if (o.skip?.has(s.accession)) {
          filings.push({ ...base, trades: [], read: false });
          continue;
        }
        filings.push({
          ...base,
          read: true,
          trades: [
            {
              asset: s.issuerName,
              side,
              code: s.amendment ? "amended stake" : "stake above 5%",
              ...(s.eventDate ? { date: s.eventDate } : {}),
              ...(s.shares !== undefined ? { sharesAfter: s.shares } : {}),
              ...(s.percent !== undefined ? { percent: s.percent } : {}),
            },
          ],
        });
      }
      notes.push(
        "Schedules 13D/13G report a stake above 5% of a class (13D within 5 business days of the event, 13G later); the side compares the stake with the one filed before it",
      );
    }
  }

  if (!roles.length) throw new ProviderError(SEC_SOURCE, `CIK ${cik} files no 13F, Form 4 as owner or Schedule 13D/13G in its recent filings`, 404);
  filings.sort((a, b) => b.filed.localeCompare(a.filed) || a.id.localeCompare(b.id));
  return { ref: { ...ref, roles }, filings, notes, provenance: { source: SEC_SOURCE, url: sub.url, fetchedAt: sub.fetchedAt } };
}

/** A person's recent filings, newest first, each with the trades read from it. */
export async function personActivity(ref: PersonRef, opts: ActivityOptions = {}): Promise<PersonActivity> {
  if (ref.source === "house") return houseActivity(ref, opts);
  if (ref.source === "oge") return ogeActivity(ref, opts);
  return secActivity(ref, opts);
}
