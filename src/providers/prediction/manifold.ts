// Manifold Markets — a PLAY-MONEY prediction market — read from its public API,
// keyless (the venue's own API, so official for what it is):
//
//   /v0/search-markets?term=…&limit=…&filter=open|closed|resolved|all
//   /v0/market/<id>                 one market, with its description as plain text
//
// Bets are in MANA, which cannot be cashed out: a probability here is the
// crowd's signal, not a price anyone risked money on, and every dataset says
// so. Questions, answers and resolution criteria are external text (untrusted).
// The published limit is 500 requests a minute per IP; calls are paced under it.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";
import { num } from "./common.js";

const BASE = "https://api.manifold.markets/v0";
export const SOURCE = "manifold";
const PACE = { hostIntervalMs: 150 };
export const PLAY_MONEY_NOTE = "play money (MANA, not redeemable) — a signal, not a market";

export interface ManifoldMarketRaw {
  id: string;
  question?: string;
  url?: string;
  outcomeType?: string;
  probability?: number;
  volume?: number;
  volume24Hours?: number;
  closeTime?: number;
  isResolved?: boolean;
  resolution?: string;
  resolutionProbability?: number;
  uniqueBettorCount?: number;
  textDescription?: string;
  answers?: Array<{ id?: string; text?: string; probability?: number | string; index?: number | string }>;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One market as points under `MANIFOLD.<id>.…`; question, answers and description are untrusted. */
export function manifoldMarketPoints(m: ManifoldMarketRaw): Point[] {
  const p = `MANIFOLD.${m.id}`;
  const s = `Manifold ${m.id}`;
  const out: Point[] = [];
  if (m.question) out.push({ key: `${p}.question`, label: `${s} question`, value: m.question, untrusted: true, ...(m.url ? { url: m.url } : {}) });
  if (m.outcomeType) out.push({ key: `${p}.type`, label: `${s} outcome type`, value: m.outcomeType });
  const prob = num(m.probability);
  if (prob !== undefined) out.push({ key: `${p}.probability`, label: `${s} YES probability`, value: prob * 100, unit: "%" });
  for (const a of m.answers ?? []) {
    const ap = num(a.probability);
    const idx = a.index ?? a.id;
    if (ap === undefined || idx === undefined) continue;
    if (a.text) out.push({ key: `${p}.answer.${idx}.text`, label: `${s} answer ${idx}`, value: a.text, untrusted: true });
    out.push({ key: `${p}.answer.${idx}.probability`, label: `${s} answer ${idx} probability`, value: ap * 100, unit: "%" });
  }
  const v = num(m.volume);
  if (v !== undefined) out.push({ key: `${p}.volume`, label: `${s} volume (lifetime)`, value: v, unit: "MANA" });
  const v24 = num(m.volume24Hours);
  if (v24 !== undefined) out.push({ key: `${p}.volume24h`, label: `${s} volume (24h)`, value: v24, unit: "MANA" });
  const bettors = num(m.uniqueBettorCount);
  if (bettors !== undefined) out.push({ key: `${p}.bettors`, label: `${s} unique bettors`, value: bettors, unit: "count" });
  const close = num(m.closeTime);
  if (close !== undefined) out.push({ key: `${p}.closeDate`, label: `${s} close date`, value: isoDay(close) });
  if (typeof m.isResolved === "boolean") out.push({ key: `${p}.resolved`, label: `${s} resolved`, value: m.isResolved });
  if (m.isResolved && m.resolution) out.push({ key: `${p}.resolution`, label: `${s} resolution`, value: m.resolution });
  const rp = num(m.resolutionProbability);
  if (m.isResolved && rp !== undefined) out.push({ key: `${p}.resolutionProbability`, label: `${s} resolution probability`, value: rp * 100, unit: "%" });
  if (m.textDescription) out.push({ key: `${p}.criteria`, label: `${s} description and resolution criteria`, value: m.textDescription, untrusted: true });
  return out;
}

function failure(status: number, what: string, error?: string): ProviderError {
  if (status === 404) return new ProviderError(SOURCE, `${what}: not found`, 404);
  return new ProviderError(SOURCE, `${what} failed (${status}${error ? `, ${error}` : ""})`, status);
}

const prov = (res: { url: string; fetchedAt: string }) => ({
  source: SOURCE,
  url: res.url,
  fetchedAt: res.fetchedAt,
  delay: "realtime",
  official: true,
  asOf: res.fetchedAt.slice(0, 10),
});

/** Markets matching a search term (`limit` ≤ 100), as one dataset. */
export async function manifoldSearch(term: string, opts: { limit?: number; filter?: "open" | "closed" | "resolved" | "all" } = {}): Promise<Dataset> {
  const params = new URLSearchParams({ term, limit: String(Math.min(Math.max(opts.limit ?? 10, 1), 100)) });
  if (opts.filter) params.set("filter", opts.filter);
  const res = await fetchJson<ManifoldMarketRaw[]>(`${BASE}/search-markets?${params}`, PACE);
  if (!res.ok || !Array.isArray(res.data)) throw failure(res.status, "market search", res.error);
  if (!res.data.length) throw new ProviderError(SOURCE, "no market matches the search", 404);
  const notes = [PLAY_MONEY_NOTE];
  if (res.data.some((m) => m.outcomeType && m.outcomeType !== "BINARY"))
    notes.push("non-binary markets carry no single probability in search results: read them one by one for their answers");
  return {
    kind: "prediction",
    title: "Manifold markets matching a search",
    points: res.data.flatMap(manifoldMarketPoints),
    provenance: prov(res),
    notes,
  };
}

/** One market by id (or slug-less id from a search), with its resolution criteria. */
export async function manifoldMarket(id: string): Promise<Dataset> {
  const res = await fetchJson<ManifoldMarketRaw>(`${BASE}/market/${encodeURIComponent(id)}`, PACE);
  if (!res.ok || !res.data?.id) throw failure(res.status, `market ${id}`, res.error);
  return {
    kind: "prediction",
    title: `Manifold market ${res.data.id}`,
    subject: res.data.id,
    points: manifoldMarketPoints(res.data),
    provenance: prov(res),
    notes: [PLAY_MONEY_NOTE],
  };
}
