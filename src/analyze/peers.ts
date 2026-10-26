// A company's peers, from crible: the same industry in the same region (by
// country — crible's own `region` field is no geography), primary listings
// ranked by EUR market cap, foreign lines (ADRs, OTC) of an issuer whose home
// listing is there collapsed, the subject's own group left out. Each peer's
// multiples are points; so are the peer medians and the subject's premium or
// discount to them — the "cheap or dear against whom" a judge needs.
import type { Dataset, Point } from "../core/datasets.js";
import { clockNow } from "../core/net.js";
import { cribleScreen } from "../providers/external/crible.js";
import { medianOf } from "./regime/sectors.js";
import { collapseForeignLines, issuerKey } from "./screen/crible.js";

// Europe as countries (ISO 3166-1 alpha-2): the EU/EEA, the UK and Switzerland.
export const PEER_EUROPE = [
  "AT",
  "BE",
  "BG",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
];

/** The countries a company's peers are drawn from. */
export function peerCountries(country: string): string[] {
  if (country === "US" || country === "CA") return ["US", "CA"];
  if (PEER_EUROPE.includes(country)) return PEER_EUROPE;
  return [country];
}

export const PEER_FIELDS: Array<[field: string, label: string, unit: string]> = [
  ["price_to_earnings_ratio", "P/E", "x"],
  ["price_to_book_ratio", "price / book", "x"],
  ["ev_to_ebitda_ratio", "EV / EBITDA", "x"],
  ["earnings_yield", "earnings yield", "ratio"],
  ["roic", "return on invested capital", "ratio"],
  ["revenue_cagr_3y", "revenue growth (3-year CAGR)", "ratio"],
];

// Multiples outside these bounds are unit or currency mismatches, not peers' prices.
const SANE: Record<string, [number, number]> = {
  price_to_earnings_ratio: [1, 500],
  price_to_book_ratio: [0.05, 200],
  ev_to_ebitda_ratio: [0.5, 300],
  earnings_yield: [-1, 1],
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function saneValue(field: string, v: unknown): number | undefined {
  const x = num(v);
  if (x === undefined) return undefined;
  const b = SANE[field];
  return b && (x < b[0] || x > b[1]) ? undefined : x;
}

/** The peers dataset for one company, or undefined when crible does not know its industry. */
export async function peersDataset(symbol: string, opts: { max?: number } = {}): Promise<Dataset | undefined> {
  const me = (await cribleScreen(`symbol = '${symbol.replace(/'/g, "\\'")}'`, { limit: 1 })).rows[0];
  const industry = typeof me?.industry === "string" ? me.industry : undefined;
  const country = typeof me?.country === "string" ? me.country : undefined;
  if (!me || !industry || !country) return undefined;
  const countries = peerCountries(country);
  const dsl = `industry = '${industry.replace(/'/g, "\\'")}' AND primary_listing = true AND country IN (${countries.map((c) => `'${c}'`).join(", ")})`;
  const screen = await cribleScreen(dsl, { sort: "-cap_eur", limit: 30 });
  const self = typeof me.name === "string" ? issuerKey(me.name) : symbol;
  const rows = collapseForeignLines(screen.rows)
    .rows.filter((r) => r.symbol !== symbol && !(typeof r.name === "string" && issuerKey(r.name) === self))
    .slice(0, opts.max ?? 6);
  const asOf = clockNow().toISOString().slice(0, 10);
  const k = `${symbol}.peers`;
  const points: Point[] = [
    { key: `${k}.industry`, label: `${symbol} industry (crible)`, value: industry, untrusted: true },
    {
      key: `${k}.count`,
      label: `${symbol} peers kept (same industry, ${countries.length > 2 ? "Europe" : countries.join("/")})`,
      value: rows.length,
      unit: "count",
    },
  ];
  rows.forEach((r, i) => {
    const sym = String(r.symbol);
    points.push({
      key: `${k}.${i + 1}.name`,
      label: `${symbol} peer #${i + 1}`,
      value: `${String(r.name ?? sym)} (${sym}, ${String(r.country ?? "?")})`,
      untrusted: true,
    });
    const cap = num(r.cap_eur);
    if (cap !== undefined) points.push({ key: `${k}.${sym}.cap_eur`, label: `${sym} market cap (EUR)`, value: cap, unit: "EUR" });
    for (const [field, label, unit] of PEER_FIELDS) {
      const v = saneValue(field, r[field]);
      if (v !== undefined)
        points.push({ key: `${k}.${sym}.${field}`, label: `${sym} ${label}`, value: v, unit, ...(typeof r.period === "string" ? { asOf: r.period } : {}) });
    }
  });
  for (const [field, label, unit] of PEER_FIELDS) {
    const vals = rows.map((r) => saneValue(field, r[field])).filter((x): x is number => x !== undefined);
    const med = medianOf(vals);
    if (med === undefined || vals.length < 3) continue;
    points.push({
      key: `${k}.median.${field}`,
      label: `${symbol} peers' median ${label} (${vals.length} peers)`,
      value: med,
      unit,
      formula: `median over ${vals.length} peers`,
    });
    const mine = saneValue(field, me[field]);
    if (mine === undefined) continue;
    points.push({
      key: `${k}.self.${field}`,
      label: `${symbol} ${label} (crible)`,
      value: mine,
      unit,
      ...(typeof me.period === "string" ? { asOf: me.period } : {}),
    });
    if (unit === "x" && med > 0)
      points.push({
        key: `${k}.premium.${field}`,
        label: `${symbol} ${label} premium (+) or discount (−) to the peers' median`,
        value: (mine / med - 1) * 100,
        unit: "%",
        formula: `(${label} / peers' median − 1) × 100`,
      });
  }
  return {
    kind: "peers",
    title: `Peers — ${industry} (crible)`,
    subject: symbol,
    points,
    provenance: { source: "crible", fetchedAt: clockNow().toISOString(), official: false, delay: "filing", asOf },
    notes: [
      "peers are crible's primary listings of the same industry, ranked by EUR market cap; their multiples are on each one's latest period",
      ...(screen.total > rows.length ? [`${screen.total} listings match the industry in this region; the ${rows.length} largest issuers are shown`] : []),
    ],
  };
}
