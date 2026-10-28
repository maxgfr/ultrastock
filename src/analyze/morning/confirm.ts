// Is a results date the brief read from a data feed (TradingView, Nasdaq/Zacks
// — unofficial) the one the issuer announces? The brief writes a `research
// --focus calendar` worklist per flagged name; once the pages are in the run
// (the host's web search, or --research-with), each date is looked for in
// them, as any page writes it:
//
//   confirmed     an issuer's page (its own domain) states the date
//   press-only    only pages off the issuer's domain state it
//   differs       the issuer's page dates its next results otherwise
//   unconfirmed   none of the pages read states it
//   not-searched  no page read yet
//
// A confirmation is registered as derived evidence over the feed's date and
// the page, so an answer can cite it; the issuer's other date, likewise.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { datesIn, extractDates, holdsDate, isoOf } from "../../core/dates.js";
import { EvidenceStore, readDocText } from "../../core/evidence.js";
import { researchFiles } from "../../research/dossier.js";

export interface DateToConfirm {
  symbol: string;
  kind: "earnings";
  date: string;
  /** The evidence key of the feed's date. */
  key: string;
  source: string;
  /** The research tag of the name's worklist in the run. */
  tag: string;
}

export type ConfirmStatus = "confirmed" | "press-only" | "differs" | "unconfirmed" | "not-searched";

export interface Confirmation extends DateToConfirm {
  status: ConfirmStatus;
  /** Pages read for the name. */
  sources: number;
  /** The pages that state the date (issuer's first). */
  stating: Array<{ id: string; host: string; official: boolean }>;
  /** The issuer's own next results date, when it is another. */
  issuerDate?: { date: string; id: string; host: string };
  /** The derived evidence key that records the outcome. */
  derivedKey?: string;
}

interface IndexEntry {
  id: string;
  url: string;
  host: string;
  official: boolean;
}

/** Results-like words on a line of a calendar page. */
const RESULTS_LINE = /r[ée]sultats?|results?|earnings|chiffre d'affaires|revenues?|sales|ventes|trading update|publication/i;
/** Lines after a date that still label it. */
const NEAR_LINES = 3;

/** Look for each date in the name's pages, and register what was found. */
export function confirmDates(dir: string, items: readonly DateToConfirm[], today: string): Confirmation[] {
  const store = EvidenceStore.load(dir);
  const out: Confirmation[] = [];
  if (!store) return items.map((i) => ({ ...i, status: "not-searched", sources: 0, stating: [] }));
  for (const it of items) {
    const path = join(dir, researchFiles(it.tag).index);
    const entries = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as IndexEntry[]) : [];
    if (!entries.length) {
      out.push({ ...it, status: "not-searched", sources: 0, stating: [] });
      continue;
    }
    const want = extractDates(it.date)[0]!;
    const stating: Confirmation["stating"] = [];
    let issuerDate: Confirmation["issuerDate"];
    for (const e of entries) {
      const item = store.get(e.id);
      const text = item ? readDocText(dir, item) : undefined;
      if (!text) continue;
      if (holdsDate(datesIn(text), want)) stating.push({ id: e.id, host: e.host, official: e.official });
      if (!e.official) continue;
      // The issuer's next results date: the earliest date ahead with results words on its line or the next few
      // (a calendar page often puts the date and its label on lines of their own).
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const near = lines.slice(Math.max(0, i - 1), i + NEAR_LINES + 1).join(" ");
        if (!RESULTS_LINE.test(near)) continue;
        for (const d of extractDates(lines[i]!)) {
          const iso = isoOf(d);
          if (iso && iso >= today && (!issuerDate || iso < issuerDate.date)) issuerDate = { date: iso, id: e.id, host: e.host };
        }
      }
    }
    stating.sort((a, b) => Number(b.official) - Number(a.official));
    const byIssuer = stating.some((s) => s.official);
    const status: ConfirmStatus = byIssuer
      ? "confirmed"
      : issuerDate && issuerDate.date !== it.date
        ? "differs"
        : stating.length
          ? "press-only"
          : "unconfirmed";
    const c: Confirmation = { ...it, status, sources: entries.length, stating, ...(status === "differs" && issuerDate ? { issuerDate } : {}) };
    const feed = store.byKey(it.key);
    if (feed && (status === "confirmed" || status === "press-only")) {
      const k = `MORNING.confirm.${it.symbol}.${it.date}`;
      if (!store.byKey(k)) {
        store.addDerived(
          k,
          `${it.symbol} ${it.kind} date ${it.date} stated by ${status === "confirmed" ? "the issuer's own page" : "a page off the issuer's domain"} (${stating[0]!.host})`,
          it.date,
          undefined,
          [feed.id, ...stating.slice(0, 3).map((s) => s.id)],
          "the feed's date looked for in the page's text, in any usual form",
        );
      }
      c.derivedKey = k;
    } else if (feed && status === "differs" && issuerDate) {
      const k = `MORNING.confirm.${it.symbol}.issuerDate`;
      if (!store.byKey(k))
        store.addDerived(
          k,
          `${it.symbol} next results date as the issuer's page (${issuerDate.host}) writes it — the feed says ${it.date}`,
          issuerDate.date,
          undefined,
          [issuerDate.id, feed.id],
          "the earliest date ahead on a results line of the issuer's page",
        );
      c.derivedKey = k;
    }
    out.push(c);
  }
  store.save();
  return out;
}
