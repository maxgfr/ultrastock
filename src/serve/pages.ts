// The dashboard's pages: server-rendered, self-contained HTML in the visual
// language of `report` (its CSS, `esc`, `markdownToHtml`, `priceSvg`) — no
// script, no external asset. Every value from the user's state or a source
// goes through `esc`; a sign is always written out, so a loss never relies on
// colour alone to read as one.
import { formatNumber } from "../core/evidence.js";
import { CSS, esc, markdownToHtml, priceSvg } from "../report/html.js";
import {
  ANALYSES,
  type AnalysisName,
  type AnalysisView,
  type BookName,
  BOOKS,
  type Hint,
  type JournalView,
  type LedgerView,
  type PortfolioView,
  type SourceRow,
  type TicketsView,
  type WatchView,
} from "./views.js";

const DASHBOARD_CSS = `:root{--pos:#1f6f3a;--neg:#a8261b}@media (prefers-color-scheme:dark){:root{--pos:#7fcf97;--neg:#f2998f}}
main{max-width:1180px}table{display:table}.wrap{overflow-x:auto}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pos{color:var(--pos)}.neg{color:var(--neg)}header .meta{margin-top:-.6rem}
nav ul{list-style:none;display:flex;flex-wrap:wrap;gap:.3rem 1.1rem;padding:0;margin:0}nav{border-bottom:1px solid var(--rule);padding:.6rem 16px}nav a[aria-current=page]{font-weight:700;text-decoration:none;color:var(--fg)}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.75rem;margin:1rem 0}.kpi div{background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:.6rem .8rem}
.kpi dt{color:var(--muted);font-size:.85rem}.kpi dd{margin:0;font-size:1.25rem;font-variant-numeric:tabular-nums}
.hint{background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:.2rem 1rem}.flag{font-weight:600}
form.filter{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:end;margin:1rem 0}form.filter label{display:flex;flex-direction:column;font-size:.9rem;color:var(--muted)}
select,button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--rule);border-radius:4px;padding:.25rem .5rem}`;

// ─── formatting ────────────────────────────────────────────────────────────

const MINUS = "−";
/** A number with fixed decimals and thousands separators; a true minus sign. */
export function fmt(n: number | undefined, decimals = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "n/a";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return n < 0 && Number(s.replace(/,/g, "")) !== 0 ? `${MINUS}${s}` : s;
}
/** A gain or a loss: the sign always written, the colour only a second cue. */
function signed(n: number | undefined, decimals = 2, unit = ""): string {
  if (n === undefined || !Number.isFinite(n)) return "n/a";
  const s = fmt(n, decimals);
  const zero = !/[1-9]/.test(s);
  const text = `${zero || s.startsWith(MINUS) ? "" : "+"}${s}${unit}`;
  return zero ? esc(text) : `<span class="${n < 0 ? "neg" : "pos"}">${esc(text)}</span>`;
}
const value = (v: number | string | boolean) => (typeof v === "number" ? formatNumber(v) : String(v));
const opt = (s: string | undefined) => esc(s ?? "");
const num = (html: string) => `<td class="num">${html}</td>`;
const cell = (s: string | undefined) => `<td>${opt(s)}</td>`;
const time = (iso: string) =>
  `<time datetime="${esc(iso)}">${esc(
    iso
      .replace("T", " ")
      .replace(/\.\d+Z$/, " UTC")
      .replace(/Z$/, " UTC"),
  )}</time>`;

function table(caption: string, head: string[], rows: string[], numeric: readonly number[] = []): string {
  const th = head.map((h, i) => `<th scope="col"${numeric.includes(i) ? ' class="num"' : ""}>${esc(h)}</th>`).join("");
  return `<div class="wrap"><table><caption class="meta">${esc(caption)}</caption><thead><tr>${th}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

// ─── layout ────────────────────────────────────────────────────────────────

export type PageId = "portfolio" | `analysis/${AnalysisName}` | "ledger" | "journal" | "watch" | "tickets";

const NAV: Array<{ id: PageId; path: string; label: string }> = [
  { id: "portfolio", path: "/", label: "Portfolio" },
  ...ANALYSES.map((a) => ({
    id: `analysis/${a}` as PageId,
    path: `/analysis/${a}`,
    label: a === "lookthrough" ? "Look-through" : `${a[0]!.toUpperCase()}${a.slice(1)}`,
  })),
  { id: "ledger", path: "/ledger", label: "Ledger" },
  { id: "journal", path: "/journal", label: "Journal" },
  { id: "watch", path: "/watch", label: "Watch" },
  { id: "tickets", path: "/tickets", label: "Tickets" },
];

const href = (path: string, book: BookName) => esc(`${path}?book=${book}`);

/** The page frame: title, navigation (each link keeps the book), the book switch, the "as of" line, the footer. */
export function layout(o: { title: string; page: PageId | undefined; book: BookName; asOf?: string; meta?: string; body: string }): string {
  const path = NAV.find((n) => n.id === o.page)?.path ?? "/";
  const links = NAV.map((n) => `<li><a href="${href(n.path, o.book)}"${n.id === o.page ? ' aria-current="page"' : ""}>${esc(n.label)}</a></li>`).join("");
  const books = BOOKS.map((b) => (b === o.book ? `<strong aria-current="true">${b}</strong>` : `<a href="${href(path, b)}">${b}</a>`)).join(" · ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(o.title)} — ultrastock</title><style>${CSS}
${DASHBOARD_CSS}</style></head>
<body><nav aria-label="Dashboard"><ul>${links}<li class="meta">Book: ${books}</li></ul></nav>
<main>
<header><h1>${esc(o.title)}</h1><p class="meta">${o.asOf ? `As of ${time(o.asOf)}` : ""}${o.meta ? ` · ${o.meta}` : ""}</p></header>
${o.body}
<footer>ultrastock dashboard — read-only: nothing on this page writes to your state. Decision support, not personalised advice from a licensed adviser.</footer>
</main></body></html>
`;
}

/** A page with nothing to show yet: the hint, its command in code. */
export const hintBody = (h: Hint) => `<div class="hint">${markdownToHtml(h.hint)}</div>`;

/** An error: its message only, never a stack. */
export const errorBody = (message: string) => `<div class="hint" role="alert"><p><strong>Could not build this page:</strong> ${esc(message)}</p></div>`;

function sourcesHtml(sources: readonly SourceRow[]): string {
  if (!sources.length) return "";
  return `<h2>Sources</h2>${table(
    "Every input this page read, with its source and delay",
    ["Input", "Source", "As of", "Delay", "Read at"],
    sources.map(
      (s) =>
        `<tr><th scope="row">${esc(s.title)}</th><td>${esc(s.source)}${s.official ? "" : " (unofficial)"}${s.fallbackFrom ? ` — stood in for ${esc(s.fallbackFrom)}` : ""}</td>${cell(s.asOf)}${cell(s.delay)}<td>${time(s.fetchedAt)}</td></tr>`,
    ),
  )}`;
}

const notesHtml = (notes: readonly string[]) => (notes.length ? `<h2>Notes</h2><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "");

// ─── pages ─────────────────────────────────────────────────────────────────

export function portfolioPage(v: PortfolioView): string {
  const b = esc(v.base);
  const perf = v.performance;
  const br = perf.breaker;
  const kpi = `<dl class="kpi">
<div><dt>Total</dt><dd>${fmt(v.total)} ${b}</dd></div>
<div><dt>Cash</dt><dd>${fmt(v.cash)} ${b}</dd></div>
<div><dt>Invested</dt><dd>${fmt(v.total - v.cash)} ${b}</dd></div>
<div><dt>Money-weighted return (XIRR)</dt><dd>${perf.xirr === undefined ? "n/a" : `${signed(perf.xirr * 100, 2, " %")} a year`}</dd></div>
<div><dt>Circuit breaker</dt><dd>${br.tripped ? `<span class="flag">TRIPPED</span>` : "not tripped"}</dd></div>
</dl>${perf.xirrNotes.length ? `<p class="meta" role="note">XIRR: ${perf.xirrNotes.map(esc).join("; ")}.</p>` : ""}`;
  const positions = v.positions.length
    ? table(
        `Positions, marked to market; P&L against the average cost (PMP, fees included), in ${v.base}`,
        ["Symbol", "Class", "Accounts", "Quantity", "Average cost", "Price", "Day", `Value (${v.base})`, "Weight", `P&L (${v.base})`, "P&L", "Source"],
        v.positions.map(
          (p) =>
            `<tr><th scope="row">${esc(p.symbol)}</th>${cell(p.assetClass)}${cell(p.accounts.join(", "))}${num(esc(formatNumber(p.quantity)))}${num(`${fmt(p.averageCost, 4)} ${esc(p.currency)}`)}${num(p.price === undefined ? "n/a" : `${esc(formatNumber(p.price))} ${esc(p.currency)}`)}${num(signed(p.changePct, 2, " %"))}${num(fmt(p.valueBase))}${num(p.weightPct === undefined ? "n/a" : `${fmt(p.weightPct)} %`)}${num(signed(p.pnlBase))}${num(signed(p.pnlPct, 2, " %"))}<td>${opt(p.source)}${p.delay ? `, ${esc(p.delay)}` : ""}${p.quoteAsOf ? ` (${esc(p.quoteAsOf)})` : ""}</td></tr>`,
        ),
        [3, 4, 5, 6, 7, 8, 9, 10],
      )
    : "<p>No open position.</p>";
  const cash = v.cashByAccount.length
    ? table(
        "Cash by account",
        ["Account", "Currency", "Amount", `In ${v.base}`],
        v.cashByAccount.map((c) => `<tr><th scope="row">${esc(c.account)}</th>${cell(c.currency)}${num(fmt(c.amount))}${num(fmt(c.amountBase))}</tr>`),
        [2, 3],
      )
    : "<p>No cash recorded.</p>";
  const unpriced = v.unpriced.length
    ? `<p class="hint" role="note"><strong>Unpriced lines, left out of the total:</strong> ${v.unpriced.map(esc).join(", ")} (see the notes).</p>`
    : "";
  const currencies = Object.entries(perf.byCurrency);
  const results = currencies.length
    ? table(
        "Realised P&L (average cost) and dividends received, in each position's currency",
        ["Currency", "Realised", "Dividends"],
        currencies.map(([c, x]) => `<tr><th scope="row">${esc(c)}</th>${num(signed(x.realized))}${num(fmt(x.dividends))}</tr>`),
        [1, 2],
      )
    : "";
  const breaker = `<p>Circuit breaker: ${br.tripped ? `<span class="flag">TRIPPED</span> — ${esc(br.reason ?? "")}${br.until ? ` (until ${esc(br.until)})` : ""}` : "not tripped"}; drawdown ${br.drawdownPct === undefined ? "n/a" : `${fmt(br.drawdownPct)} %`}, size multiplier ${esc(String(br.sizeMultiplier))}, losing streak ${esc(String(br.losingStreak))}. Read on the recorded equity curve plus today's value (not recorded).</p>`;
  const h = v.history;
  const history = h.hint
    ? `<p class="meta">${markdownToHtml(h.hint).replace(/^<p>|<\/p>$/g, "")}</p>`
    : `${priceSvg(
        h.points.map((p) => ({ date: p.date, close: p.valueBase })),
        720,
        220,
        `Portfolio value in ${v.base}`,
      )}<p class="meta">${h.points.length} daily snapshot(s) from the local store; change ${signed(h.changePct, 2, " %")} (deposits and withdrawals included), maximum drawdown ${h.maxDrawdownPct === undefined ? "n/a" : `${fmt(h.maxDrawdownPct)} %`}.</p>`;
  return layout({
    title: `${v.book} book`,
    page: "portfolio",
    book: v.book,
    asOf: v.asOf,
    meta: `base currency ${b}`,
    body: `${kpi}${unpriced}<h2>Positions</h2>${positions}<h2>Cash</h2>${cash}<h2>Performance</h2>${results}${breaker}<h2>Value over time</h2>${history}${notesHtml(v.notes)}${sourcesHtml(v.sources)}`,
  });
}

const ANALYSIS_TITLES: Record<AnalysisName, string> = {
  risk: "Risk",
  stress: "Stress tests",
  income: "Income",
  location: "Asset location by envelope",
  lookthrough: "Fund look-through",
};
export const analysisTitle = (a: AnalysisName) => ANALYSIS_TITLES[a];

export function analysisPage(v: AnalysisView): string {
  const sections = v.sections.length
    ? v.sections
        .map(
          (s) =>
            `<h2>${esc(s.section)}</h2>${table(
              s.section,
              ["Figure", "Value", "How"],
              s.figures.map(
                (x) =>
                  `<tr><th scope="row">${esc(x.label)}</th>${num(`${esc(value(x.value))}${x.unit ? ` ${esc(x.unit)}` : ""}`)}<td class="meta">${esc(x.formula)}</td></tr>`,
              ),
              [1],
            )}`,
        )
        .join("\n")
    : "<p>This analysis derived no figure from the book (see the notes).</p>";
  return layout({
    title: `${v.book} book — ${ANALYSIS_TITLES[v.analysis]}`,
    page: `analysis/${v.analysis}`,
    book: v.book,
    asOf: v.asOf,
    meta: `base currency ${esc(v.base)} · the figures of <code>ultrastock portfolio ${v.analysis}</code>, not registered as a run`,
    body: `${sections}${notesHtml(v.notes)}${sourcesHtml(v.sources)}`,
  });
}

export function ledgerPage(v: LedgerView): string {
  const select = (name: string, label: string, options: string[], current: string | undefined) =>
    `<label>${esc(label)}<select name="${name}"><option value="">all</option>${options.map((o) => `<option value="${esc(o)}"${o === current ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
  const form = `<form class="filter" method="get" action="/ledger"><input type="hidden" name="book" value="${esc(v.book)}">${select("account", "Account", v.accounts, v.filter.account)}${select("symbol", "Symbol", v.symbols, v.filter.symbol)}<button type="submit">Filter</button></form>`;
  const rows = v.transactions.map(
    (t) =>
      `<tr><td>${esc(t.date)}</td><th scope="row">${esc(t.type)}</th>${cell(t.account)}${cell(t.symbol)}${num(t.quantity === undefined ? "" : esc(formatNumber(t.quantity)))}${num(t.price === undefined ? "" : esc(formatNumber(t.price)))}${num(t.amount === undefined ? "" : signed(t.amount))}${num(t.fee === undefined ? "" : fmt(t.fee))}${cell(t.currency)}${cell(t.note)}${cell(t.origin)}</tr>`,
  );
  return layout({
    title: `${v.book} book — ledger`,
    page: "ledger",
    book: v.book,
    asOf: v.asOf,
    meta: `${v.transactions.length} of ${v.count} transaction(s), newest first`,
    body: `${form}${
      rows.length
        ? table(
            "Transactions, newest first",
            ["Date", "Type", "Account", "Symbol", "Quantity", "Price", "Amount", "Fee", "Currency", "Note", "Origin"],
            rows,
            [4, 5, 6, 7],
          )
        : "<p>No transaction.</p>"
    }`,
  });
}

export function journalPage(v: JournalView, book: BookName): string {
  const decisions = v.decisions.length
    ? table(
        "Decisions, newest first",
        ["Decided", "Symbol", "Rating", "Horizon", "Conviction", "Thesis"],
        v.decisions.map(
          (d) =>
            `<tr><td>${esc(d.decidedAt)}</td><th scope="row">${esc(d.symbol)}</th>${cell(d.rating)}${num(`${esc(String(d.horizon))} sessions`)}${num(`${esc(String(d.conviction))}/5`)}${cell(d.thesis)}</tr>`,
        ),
        [3, 4],
      )
    : "<p>No decision recorded (<code>ultrastock decide</code>).</p>";
  const hits = v.hitRates.length
    ? table(
        "Hit rates by rating and horizon",
        ["Rating", "Horizon", "Settled", "Hit rate", "Mean alpha"],
        v.hitRates.map(
          (h) =>
            `<tr><th scope="row">${esc(h.rating)}</th>${num(`${h.horizon} sessions`)}${num(String(h.n))}${num(`${fmt(h.hitRate * 100, 0)} %`)}${num(signed(h.meanAlphaPct, 2, " %"))}</tr>`,
        ),
        [1, 2, 3, 4],
      )
    : "<p>No settled decision yet (<code>ultrastock journal settle</code>).</p>";
  const settlements = v.settlements.length
    ? table(
        "Settlements, newest first",
        ["Symbol", "Rating", "Horizon", "Decided", "Ended", "Return", "Alpha", "Hit"],
        v.settlements.map(
          (s) =>
            `<tr><th scope="row">${esc(s.symbol)}</th>${cell(s.rating)}${num(`${s.horizon} sessions`)}${cell(s.decidedAt.slice(0, 10))}${cell(s.endDate)}${num(signed(s.returnPct, 2, " %"))}${num(signed(s.alphaPct, 2, " %"))}<td>${s.hit === undefined ? "n/a" : s.hit ? "yes" : "no"}</td></tr>`,
        ),
        [2, 5, 6],
      )
    : "";
  const theses = v.theses.length
    ? table(
        "Theses, most recently updated first",
        ["Symbol", "State", "Review by", "Thesis", "Invalidation", "Id"],
        v.theses.map(
          (t) =>
            `<tr><th scope="row">${esc(t.symbol)}</th>${cell(t.state)}<td>${opt(t.reviewBy)}${t.overdue ? ' <span class="flag">OVERDUE</span>' : ""}</td>${cell(t.thesis)}${cell(t.invalidation)}<td><code>${esc(t.id)}</code></td></tr>`,
        ),
      )
    : "<p>No thesis (<code>ultrastock journal thesis add</code>).</p>";
  const lessons = v.lessons.length ? `<ul>${v.lessons.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "<p>No lesson recorded.</p>";
  const overdue = v.theses.filter((t) => t.overdue).length;
  return layout({
    title: "Journal",
    page: "journal",
    book,
    asOf: v.asOf,
    meta: `${v.decisions.length} decision(s), ${v.settlements.length} settlement(s), ${v.theses.length} thesis(es)${overdue ? `, <span class="flag">${overdue} overdue</span>` : ""}`,
    body: `<h2>Decisions</h2>${decisions}<h2>Hit rates</h2>${hits}${settlements ? `<h2>Settlements</h2>${settlements}` : ""}<h2>Theses</h2>${theses}<h2>Lessons</h2>${lessons}`,
  });
}

export function watchPage(v: WatchView, book: BookName): string {
  const list = v.watchlist.length
    ? table(
        "Names followed without holding them",
        ["Symbol", "Note", "Added"],
        v.watchlist.map((w) => `<tr><th scope="row">${esc(w.symbol)}</th>${cell(w.note)}${cell(w.addedAt.slice(0, 10))}</tr>`),
      )
    : "<p>The watchlist is empty (<code>ultrastock watchlist add</code>).</p>";
  const rules = v.rules.length
    ? table(
        "Alert rules — listed here, not evaluated (ultrastock watch run evaluates them)",
        ["Id", "Kind", "Symbol", "Condition", "Message", "Created", "Last fired"],
        v.rules.map(
          (r) =>
            `<tr><th scope="row"><code>${esc(r.id)}</code></th>${cell(r.kind)}${cell(r.symbol)}<td>${r.expr ? `<code>${esc(r.expr)}</code>` : r.kind === "events" ? `next ${esc(String(r.days ?? ""))} days, ≥ ${esc(String(r.minWeight ?? ""))} % of the book` : ""}</td>${cell(r.message)}${cell(r.createdAt.slice(0, 10))}${cell(r.firedAt)}</tr>`,
        ),
      )
    : "<p>No alert rule (<code>ultrastock watch add</code>).</p>";
  return layout({ title: "Watch", page: "watch", book, asOf: v.asOf, body: `<h2>Watchlist</h2>${list}<h2>Alert rules</h2>${rules}` });
}

export function ticketsPage(v: TicketsView, book: BookName): string {
  const tickets = v.tickets.length
    ? table(
        "Tickets, newest first",
        ["Id", "Status", "Side", "Quantity", "Symbol", "Price", "Stop", "Venue", "Account", "Risk check", "Created"],
        v.tickets.map(
          (t) =>
            `<tr><th scope="row"><code>${esc(t.id)}</code></th><td class="flag">${esc(t.status)}</td>${cell(t.order.side)}${num(esc(formatNumber(t.order.quantity)))}${cell(t.order.symbol)}${num(`${esc(formatNumber(t.order.price))} ${esc(t.order.currency)}`)}${num(t.order.stop === undefined ? "" : esc(formatNumber(t.order.stop)))}${cell(t.order.venue)}${cell(t.order.account)}${cell(t.check?.verdict)}${cell(t.createdAt)}</tr>`,
        ),
        [3, 5, 6],
      )
    : "<p>No ticket (<code>ultrastock plan … --ticket</code>).</p>";
  const str = (x: unknown) => (x === undefined || x === null ? "" : typeof x === "string" ? x : JSON.stringify(x));
  const audit = v.audit.length
    ? table(
        `Order audit trail, newest first${v.auditCount > v.audit.length ? ` (the latest ${v.audit.length} of ${v.auditCount} lines)` : ""}`,
        ["At", "Event", "Ticket", "Transition", "Why"],
        v.audit.map(
          (a) =>
            `<tr><td>${esc(str(a.at))}</td><th scope="row">${esc(str(a.event))}</th><td><code>${esc(str(a.id))}</code></td><td>${a.from !== undefined || a.to !== undefined ? `${esc(str(a.from))} → ${esc(str(a.to))}` : ""}</td>${cell(str(a.why ?? a.error ?? a.reason))}</tr>`,
        ),
      )
    : "<p>The audit trail is empty.</p>";
  return layout({ title: "Tickets", page: "tickets", book, asOf: v.asOf, body: `<h2>Tickets</h2>${tickets}<h2>Audit trail</h2>${audit}` });
}
