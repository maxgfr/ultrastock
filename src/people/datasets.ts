// A person's activity and positions as datasets: every figure a point to cite.
// Names, assets and descriptions are external text and travel as untrusted
// values, never inside a label; a label says only what the number is.
import type { Dataset, Point } from "../core/datasets.js";
import { sanitizeExternalText } from "../core/untrusted.js";
import { latest13f } from "../providers/fundamentals/sec-13f.js";
import type { PersonActivity, PersonFiling, PersonRef, PublicTrade } from "./types.js";
import { refString } from "./types.js";

/** The subject key of a person: "PEOPLE.sec.CIK1067983", "PEOPLE.house.hon-nancy-pelosi". */
export function personSubject(ref: Pick<PersonRef, "source" | "id">): string {
  const slug =
    ref.source === "sec"
      ? `CIK${ref.id}`
      : ref.id
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60);
  return `PEOPLE.${ref.source}.${slug}`;
}

const fileKey = (f: PersonFiling) => f.id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24);

const SIDE_WORD = { buy: "buy", sell: "sale", exchange: "exchange", other: "other" } as const;

/** "NVDA — NVIDIA CORP", or the one of them there is. */
const assetText = (t: Pick<PublicTrade, "ticker" | "asset">) => (t.ticker && t.ticker !== t.asset ? `${t.ticker} — ${t.asset}` : (t.ticker ?? t.asset));

function tradePoints(subject: string, f: PersonFiling, t: PublicTrade, i: number): Point[] {
  const k = `${subject}.${fileKey(f)}.${i + 1}`;
  const what = `${subject} ${f.form} filed ${f.filed}, row ${i + 1}: ${SIDE_WORD[t.side]}${t.code ? ` [${t.code}]` : ""} on ${t.date ?? "a date that did not read"}${t.indirect ? ", held indirectly" : ""}`;
  const asOf = t.date ?? f.filed;
  const pts: Point[] = [{ key: `${k}.asset`, label: `${what}, asset`, value: assetText(t), untrusted: true, asOf, url: f.url }];
  if (t.amountLow !== undefined) pts.push({ key: `${k}.amountLow`, label: `${what}, value band low`, value: t.amountLow, unit: "USD", asOf });
  if (t.amountHigh !== undefined) pts.push({ key: `${k}.amountHigh`, label: `${what}, value band high`, value: t.amountHigh, unit: "USD", asOf });
  if (t.shares !== undefined) pts.push({ key: `${k}.shares`, label: `${what}, shares (+ acquired, − disposed)`, value: t.shares, unit: "shares", asOf });
  if (t.price !== undefined) pts.push({ key: `${k}.price`, label: `${what}, price per share`, value: t.price, unit: "USD", asOf });
  if (t.sharesAfter !== undefined) pts.push({ key: `${k}.sharesAfter`, label: `${what}, shares held after`, value: t.sharesAfter, unit: "shares", asOf });
  if (t.percent !== undefined) pts.push({ key: `${k}.percent`, label: `${what}, share of the class`, value: t.percent, unit: "%", asOf });
  return pts;
}

/** The activity as one dataset: the filings, their counts, and the newest `limit` trades. */
export function activityDataset(a: PersonActivity, opts: { limit?: number } = {}): Dataset {
  const subject = personSubject(a.ref);
  const limit = opts.limit ?? 30;
  const points: Point[] = [
    { key: `${subject}.name`, label: `${subject} name as the source records it`, value: a.ref.name, untrusted: true },
    { key: `${subject}.ref`, label: `${subject} reference to follow or show this filer`, value: refString(a.ref), untrusted: true },
  ];
  if (a.ref.role) points.push({ key: `${subject}.role`, label: `${subject} role as the source records it`, value: a.ref.role, untrusted: true });
  let shown = 0;
  let hidden = 0;
  const counts = { buy: 0, sell: 0 };
  for (const f of a.filings) {
    const fk = `${subject}.${fileKey(f)}`;
    points.push({
      key: `${fk}.trades`,
      label: `${subject} ${f.form} filed ${f.filed}: transactions ${f.read ? "read" : "not read (listed only)"}`,
      value: f.trades.length,
      unit: "count",
      asOf: f.filed,
      url: f.url,
    });
    if (f.unread)
      points.push({
        key: `${fk}.unread`,
        label: `${subject} ${f.form} filed ${f.filed}: rows that did not read`,
        value: f.unread,
        unit: "count",
        asOf: f.filed,
      });
    f.trades.forEach((t, i) => {
      if (t.side === "buy") counts.buy++;
      if (t.side === "sell") counts.sell++;
      if (shown >= limit) {
        hidden++;
        return;
      }
      shown++;
      points.push(...tradePoints(subject, f, t, i));
    });
  }
  const newest = a.filings[0]?.filed;
  points.push(
    { key: `${subject}.buys.count`, label: `${subject} buys in the filings read`, value: counts.buy, unit: "count", ...(newest ? { asOf: newest } : {}) },
    { key: `${subject}.sells.count`, label: `${subject} sales in the filings read`, value: counts.sell, unit: "count", ...(newest ? { asOf: newest } : {}) },
  );
  const notes = [...a.notes];
  for (const f of a.filings) if (f.note) notes.push(`${f.form} filed ${f.filed}: ${f.note}`);
  if (hidden) notes.push(`${hidden} more transactions not shown — raise --limit, or open the filings`);
  if (!a.filings.length) notes.push("no filing in the window — widen --since or raise --filings");
  return {
    kind: "people",
    title: `${subject} disclosed trades (${a.filings.length} filings)`,
    subject,
    points,
    provenance: { ...a.provenance, delay: "filing", official: true, ...(newest ? { asOf: newest } : {}) },
    notes,
  };
}

/**
 * What the person holds, as far as the filings say: a 13F's positions, the
 * shares a Form 4 left, a 13D/13G's stake. A PTR or a 278-T reports trades,
 * not holdings: for those, the net of the trades read, per asset, in value
 * bands — the latest annual report is where holdings are listed.
 */
export async function positionsDataset(a: PersonActivity, opts: { top?: number } = {}): Promise<Dataset> {
  const subject = personSubject(a.ref);
  const points: Point[] = [];
  const notes: string[] = [];
  const top = opts.top ?? 15;
  let asOf: string | undefined;
  if (a.ref.source === "sec") {
    if (a.ref.roles?.includes("13f")) {
      const q = await latest13f(Number(a.ref.id));
      if (q) {
        asOf = q.period;
        const total = q.holdings.reduce((s, h) => s + h.value, 0);
        q.holdings.slice(0, top).forEach((h, i) => {
          const k = `${subject}.13f.${h.cusip}${h.putCall ? `.${h.putCall.toLowerCase()}` : ""}`;
          const what = `${subject} 13F position #${i + 1} (CUSIP ${h.cusip}${h.putCall ? ` ${h.putCall}` : ""}) at ${q.period}`;
          points.push(
            { key: `${k}.issuer`, label: `${what}, issuer`, value: `${h.issuer} — ${h.titleOfClass}`, untrusted: true, asOf: q.period, url: q.url },
            { key: `${k}.value`, label: `${what}, value`, value: h.value, unit: "USD", asOf: q.period },
            {
              key: `${k}.weight`,
              label: `${what}, weight`,
              value: total ? (h.value / total) * 100 : 0,
              unit: "%",
              asOf: q.period,
              formula: "value / total reported value",
            },
            { key: `${k}.shares`, label: `${what}, shares`, value: h.shares, unit: "shares", asOf: q.period },
          );
        });
        notes.push(`13F positions at the quarter ended ${q.period} (long US equities and listed options only), filed ${q.filing.filingDate}`);
      }
    }
    // Form 4: the newest report per issuer and ownership (direct / indirect) says what is held after it.
    const held = new Map<string, { t: PublicTrade; f: PersonFiling }>();
    for (const f of a.filings.filter((x) => x.form.startsWith("Form 4")))
      for (const t of f.trades) {
        const key = `${t.ticker ?? t.asset}|${t.indirect ? "I" : "D"}`;
        if (t.sharesAfter !== undefined && !held.has(key)) held.set(key, { t, f });
      }
    for (const { t, f } of held.values()) {
      const k = `${subject}.form4.${(t.ticker ?? fileKey(f)).replace(/[^A-Za-z0-9-]/g, "")}.${t.indirect ? "indirect" : "direct"}`;
      const what = `${subject} shares held ${t.indirect ? "indirectly" : "directly"} after the Form 4 filed ${f.filed}`;
      points.push(
        { key: `${k}.asset`, label: `${what}, issuer`, value: assetText(t), untrusted: true, asOf: t.date ?? f.filed, url: f.url },
        { key: `${k}.shares`, label: `${what}, shares`, value: t.sharesAfter!, unit: "shares", asOf: t.date ?? f.filed },
      );
    }
    if (held.size) notes.push("Form 4 holdings are the shares owned after each issuer's latest reported trade among the filings read");
    const stakes = new Map<string, { t: PublicTrade; f: PersonFiling }>();
    for (const f of a.filings.filter((x) => x.form.startsWith("Schedule 13")))
      for (const t of f.trades) if (!stakes.has(t.asset)) stakes.set(t.asset, { t, f });
    let n = 0;
    for (const { t, f } of stakes.values()) {
      const k = `${subject}.stake.${++n}`;
      const what = `${subject} stake reported in the ${f.form} filed ${f.filed}`;
      points.push({ key: `${k}.issuer`, label: `${what}, issuer`, value: t.asset, untrusted: true, asOf: t.date ?? f.filed, url: f.url });
      if (t.percent !== undefined)
        points.push({ key: `${k}.percent`, label: `${what}, share of the class`, value: t.percent, unit: "%", asOf: t.date ?? f.filed });
      if (t.sharesAfter !== undefined)
        points.push({ key: `${k}.shares`, label: `${what}, shares beneficially owned`, value: t.sharesAfter, unit: "shares", asOf: t.date ?? f.filed });
    }
    if (stakes.size) notes.push("13D/13G stakes: the latest schedule per issuer among those read; a stake under 5% is no longer reported");
  } else {
    // Net flow per asset over the filings read, in value bands.
    const flow = new Map<
      string,
      { asset: string; buys: number; sells: number; inLow: number; inHigh: number; outLow: number; outHigh: number; openIn: boolean; openOut: boolean }
    >();
    for (const f of a.filings)
      f.trades.forEach((t, i) => {
        if (t.side !== "buy" && t.side !== "sell") return;
        // An asset without a ticker is only known by its row: two of them are not the same asset.
        const key = t.ticker ?? (f.source === "oge" ? t.asset : `${f.id}#${i}`);
        const r = flow.get(key) ?? { asset: assetText(t), buys: 0, sells: 0, inLow: 0, inHigh: 0, outLow: 0, outHigh: 0, openIn: false, openOut: false };
        if (t.amountHigh === undefined) r[t.side === "buy" ? "openIn" : "openOut"] = true;
        if (t.side === "buy") {
          r.buys++;
          r.inLow += t.amountLow ?? 0;
          r.inHigh += t.amountHigh ?? t.amountLow ?? 0;
        } else {
          r.sells++;
          r.outLow += t.amountLow ?? 0;
          r.outHigh += t.amountHigh ?? t.amountLow ?? 0;
        }
        flow.set(key, r);
      });
    const rows = [...flow.values()].sort((x, y) => y.inHigh + y.outHigh - (x.inHigh + x.outHigh)).slice(0, top);
    asOf = a.filings[0]?.filed;
    const since = a.filings[a.filings.length - 1]?.filed;
    rows.forEach((r, i) => {
      const k = `${subject}.flow.${i + 1}`;
      const what = `${subject} trades read in filings ${since ?? "?"} → ${asOf ?? "?"}, asset #${i + 1}`;
      points.push(
        { key: `${k}.asset`, label: `${what}`, value: r.asset, untrusted: true, ...(asOf ? { asOf } : {}) },
        { key: `${k}.buys`, label: `${what}, buys`, value: r.buys, unit: "count", ...(asOf ? { asOf } : {}) },
        { key: `${k}.sells`, label: `${what}, sales`, value: r.sells, unit: "count", ...(asOf ? { asOf } : {}) },
        { key: `${k}.boughtLow`, label: `${what}, bought, sum of band lows`, value: r.inLow, unit: "USD", ...(asOf ? { asOf } : {}) },
        {
          key: `${k}.boughtHigh`,
          label: `${what}, bought, sum of band highs${r.openIn ? " (a band without a top counted at its low)" : ""}`,
          value: r.inHigh,
          unit: "USD",
          ...(asOf ? { asOf } : {}),
        },
        { key: `${k}.soldLow`, label: `${what}, sold, sum of band lows`, value: r.outLow, unit: "USD", ...(asOf ? { asOf } : {}) },
        {
          key: `${k}.soldHigh`,
          label: `${what}, sold, sum of band highs${r.openOut ? " (a band without a top counted at its low)" : ""}`,
          value: r.outHigh,
          unit: "USD",
          ...(asOf ? { asOf } : {}),
        },
      );
    });
    notes.push(
      a.ref.source === "house"
        ? "a PTR lists trades, not holdings: this is the net of the trades read, in value bands — holdings are in the member's annual Financial Disclosure report"
        : "a 278-T lists trades, not holdings: this is the net of the trades read, in value bands — holdings are in the filer's annual OGE 278e",
    );
  }
  if (!points.length) notes.push("no position could be derived from the filings read");
  return {
    kind: "people-positions",
    title: `${subject} positions as disclosed`,
    subject,
    points,
    provenance: { ...a.provenance, delay: "filing", official: true, ...(asOf ? { asOf } : {}) },
    notes,
  };
}

/** One line for an alert: a new filing and what it holds. External text sanitized. */
export function filingAlertMessage(ref: PersonRef, f: PersonFiling, prefix?: string): string {
  const name = sanitizeExternalText(ref.name, 80);
  const buys = f.trades.filter((t) => t.side === "buy").length;
  const sells = f.trades.filter((t) => t.side === "sell").length;
  const big = [...f.trades].sort((x, y) => (y.amountHigh ?? y.amountLow ?? 0) - (x.amountHigh ?? x.amountLow ?? 0))[0];
  const band = (t: PublicTrade) =>
    t.amountLow !== undefined
      ? ` $${t.amountLow.toLocaleString("en-US")}${t.amountHigh !== undefined ? `–$${t.amountHigh.toLocaleString("en-US")}` : "+"}`
      : "";
  const largest =
    big && (big.amountLow !== undefined || big.amountHigh !== undefined)
      ? `; largest: ${SIDE_WORD[big.side]} ${sanitizeExternalText(big.ticker ?? big.asset, 60)}${band(big)}`
      : "";
  const what = f.read ? `${buys} buy(s), ${sells} sale(s)${largest}` : (f.note ?? "not read");
  return `${prefix ? `${prefix} — ` : ""}${name}: ${f.form} filed ${f.filed} — ${what} ${f.url}`;
}
