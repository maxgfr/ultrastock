// A small RFC 4180 reader: quoted fields, doubled quotes, CRLF, a BOM, and the
// `;` delimiter European exchanges (Euronext) and French brokers export with.
// No dependency, because the bundle has none.

/** Split CSV text into rows of raw string cells. */
export function parseCsvText(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sep = delimiter ?? sniffDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** The delimiter of the first line that has one: `;`, tab or `,`. */
function sniffDelimiter(text: string): string {
  for (const line of text.split(/\r?\n/, 8)) {
    const counts = [";", "\t", ","].map((d) => [d, line.split(d).length - 1] as const).filter(([, n]) => n > 0);
    if (counts.length) return counts.sort((a, b) => b[1] - a[1])[0]![0];
  }
  return ",";
}

/** Rows as objects keyed by the header row (`headerRow` is 0-based). */
export function csvRecords(text: string, opts: { delimiter?: string; headerRow?: number } = {}): Record<string, string>[] {
  const rows = parseCsvText(text, opts.delimiter);
  const at = opts.headerRow ?? 0;
  const header = rows[at];
  if (!header) return [];
  return rows.slice(at + 1).map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/**
 * A number as an exchange or a broker writes it: "1,234.5", "1 234,5",
 * "$210.96", "-0.07%", "39,539,690". Undefined for blanks and dashes.
 */
export function parseLooseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  let s = raw.replace(/[\s  $€£%]/g, "").trim();
  if (!s || s === "-" || s === "—" || /^n\/?a$/i.test(s)) return undefined;
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma > -1 && dot > -1) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma > -1) s = /,\d{3}(?!\d)/.test(s) && !/,\d{1,2}$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
