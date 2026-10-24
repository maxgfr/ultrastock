// A self-contained HTML report of a run: the answer (markdown), every [E#] it
// cites linked to the evidence table with its source, date and delay, and a
// price chart drawn as inline SVG from the run's bars. One file, no script,
// no external asset — it can be mailed, archived or opened offline.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceStore, formatNumber } from "../core/evidence.js";
import type { Bar } from "../providers/types.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline markdown: code, bold, italic, links (http/https only), [E#] citations. */
function inline(text: string): string {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}" rel="noreferrer">${t}</a>`);
  s = s.replace(/\[(E\d+)\]/g, '<a class="cite" href="#$1">[$1]</a>');
  return s;
}

/** Block markdown: headings, paragraphs, lists, tables, quotes, code fences, rules. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (/^```/.test(l)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      flush();
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s1]*$/.test(l)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) {
      flush();
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) body.push(cells(lines[i++]!));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      flush();
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*+]|\d+\.)\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`);
      continue;
    }
    if (!l.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(l.trim());
    i++;
  }
  flush();
  return out.join("\n");
}

/** A closing-price line chart as inline SVG, with the first/last dates and the range. */
export function priceSvg(bars: readonly Bar[], width = 720, height = 220): string {
  if (bars.length < 2) return "";
  const closes = bars.map((b) => b.close);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const pad = 28;
  const x = (i: number) => pad + (i / (bars.length - 1)) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - lo) / (hi - lo || 1)) * (height - 2 * pad);
  const d = closes.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Closing price from ${esc(bars[0]!.date)} to ${esc(bars[bars.length - 1]!.date)}">
<path d="${d}" fill="none" stroke="var(--line)" stroke-width="1.6"/>
<text x="${pad}" y="${height - 6}" class="axis">${esc(bars[0]!.date.slice(0, 10))}</text>
<text x="${width - pad}" y="${height - 6}" class="axis" text-anchor="end">${esc(bars[bars.length - 1]!.date.slice(0, 10))}</text>
<text x="${pad}" y="${pad - 10}" class="axis">high ${formatNumber(hi)} · low ${formatNumber(lo)}</text>
</svg>`;
}

const CSS = `:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--line:#2f5d8a;--rule:#e2dfd7;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a3a29c;--line:#7fb0e0;--rule:#33322f;--card:#1c1c1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px}h1{font-size:1.7rem;line-height:1.2}h2{margin-top:2rem;border-bottom:1px solid var(--rule);padding-bottom:.3rem}
table{border-collapse:collapse;width:100%;font-size:.92rem;margin:1rem 0;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--rule);padding:.4rem .5rem;text-align:left;vertical-align:top}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}pre{background:var(--card);padding:12px;overflow-x:auto;border:1px solid var(--rule)}
a{color:var(--line)}a.cite{text-decoration:none;font-size:.85em}blockquote{margin:1rem 0;padding-left:1rem;border-left:3px solid var(--rule);color:var(--muted)}
svg{width:100%;height:auto;background:var(--card);border:1px solid var(--rule);margin:1rem 0}.axis{fill:var(--muted);font-size:11px}
.meta{color:var(--muted);font-size:.9rem}details{border:1px solid var(--rule);border-radius:6px;padding:.4rem .8rem;margin:.5rem 0}summary{cursor:pointer;font-weight:600}tr:target{background:color-mix(in srgb,var(--line) 15%,transparent)}footer{color:var(--muted);font-size:.85rem;margin-top:3rem}`;

/** The recorded decision, when `decide` accepted one. */
function decisionHtml(runDir: string): string {
  const f = join(runDir, "decision.json");
  if (!existsSync(f)) return "";
  const d = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown> & { plan?: Record<string, unknown> };
  const row = (k: string, v: unknown) => (v === undefined || v === "" ? "" : `<tr><th>${esc(k)}</th><td>${esc(Array.isArray(v) ? v.join("; ") : String(v))}</td></tr>`);
  return `<h2>Decision</h2><table><tbody>${row("rating", d.rating)}${row("horizon", d.horizon)}${row("conviction", d.conviction)}${row("thesis", d.thesis)}${row("falsifiers", d.falsifiers)}${row("risks", d.risks)}${row("portfolio context", d.portfolioContext)}${
    d.plan ? row("plan", `${d.plan.side} at ${d.plan.entry}, stop ${d.plan.stop}, targets ${(d.plan.targets as number[] | undefined)?.join(" / ")}, size ${d.plan.sizePct} %`) : ""
  }${row("decided at", d.decidedAt)}</tbody></table>`;
}

/** The debate's notes (notes/<role>.md), folded. */
function notesHtml(runDir: string): string {
  const dir = join(runDir, "notes");
  if (!existsSync(dir)) return "";
  const order = ["market", "fundamentals", "news", "bull", "bear", "judge", "trader", "risk"];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => (order.indexOf(a.replace(/\.md$/, "")) + 1 || 99) - (order.indexOf(b.replace(/\.md$/, "")) + 1 || 99) || a.localeCompare(b));
  if (!files.length) return "";
  return `<h2>The debate</h2>${files.map((f) => `<details><summary>${esc(f.replace(/\.md$/, ""))}</summary>${markdownToHtml(readFileSync(join(dir, f), "utf8"))}</details>`).join("\n")}`;
}

/** The report for a run: `answer` (markdown) plus the evidence it cites. */
export function renderReport(runDir: string, answerMd: string, opts: { title?: string; generatedAt?: string } = {}): string {
  const store = EvidenceStore.load(runDir);
  if (!store) throw new Error(`${runDir} holds no evidence.json`);
  const cited = new Set([...answerMd.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]!));
  const rows = store.items.filter((i) => cited.has(i.id));
  const barsFile = join(runDir, "bars.json");
  const bars = existsSync(barsFile) ? (JSON.parse(readFileSync(barsFile, "utf8")) as Bar[]) : [];
  const title = opts.title ?? /^#\s+(.+)$/m.exec(answerMd)?.[1] ?? store.subject ?? "ultrastock report";
  const evidenceTable = rows.length
    ? `<h2>Evidence cited</h2><table><thead><tr><th>Id</th><th>What</th><th>Value</th><th>Source</th><th>As of</th></tr></thead><tbody>${rows
        .map(
          (i) =>
            `<tr id="${i.id}"><td>${i.id}</td><td>${esc(i.label)}${i.formula ? `<br><span class="meta">${esc(i.formula)}</span>` : ""}</td><td>${esc(typeof i.value === "number" ? formatNumber(i.value) : String(i.value))}${i.unit ? ` ${esc(i.unit)}` : ""}</td><td>${i.url ? `<a href="${esc(i.url)}" rel="noreferrer">${esc(i.source)}</a>` : esc(i.source)}${i.official ? "" : " (unofficial)"}${i.delay ? `, ${esc(i.delay)}` : ""}</td><td>${esc(i.asOf ?? i.fetchedAt.slice(0, 10))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
${bars.length ? priceSvg(bars) : ""}
${markdownToHtml(answerMd)}
${decisionHtml(runDir)}
${notesHtml(runDir)}
${evidenceTable}
<footer>Generated by ultrastock from the run in ${esc(runDir)}${opts.generatedAt ? ` on ${esc(opts.generatedAt)}` : ""}. Every figure links to its evidence. Decision support, not personalised advice from a licensed adviser.</footer>
</main></body></html>
`;
}
