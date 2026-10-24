// Bitcoin network state from mempool.space's public REST API — keyless, an
// open-source explorer reading its own Bitcoin nodes (not an exchange or an
// issuer, so marked unofficial):
//
//   /api/v1/fees/recommended         sat/vB for the next block, ~30 min, ~1 h, economy, minimum
//   /api/v1/mining/hashrate/3d       daily average hashrate (H/s) and the current difficulty
//   /api/v1/difficulty-adjustment    progress through the 2016-block epoch and the projected change
//
// The public instance is rate limited (undisclosed, roughly a few requests per
// second): calls are paced, and a 429 is a transient ProviderError.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";

const BASE = "https://mempool.space/api/v1";
export const SOURCE = "mempool.space";
const PACE = { hostIntervalMs: 300 };

export interface MempoolFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

export interface MempoolHashrate {
  hashrates: Array<{ timestamp: number; avgHashrate: number }>;
  currentHashrate: number;
  currentDifficulty: number;
}

export interface MempoolDifficulty {
  progressPercent: number;
  difficultyChange: number;
  estimatedRetargetDate: number;
  remainingBlocks: number;
  previousRetarget: number;
  nextRetargetHeight: number;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function get<T>(path: string): Promise<{ data: T; url: string; fetchedAt: string }> {
  const res = await fetchJson<T>(`${BASE}${path}`, PACE);
  if (!res.ok || res.data === undefined) throw new ProviderError(SOURCE, `${path} failed (${res.status}${res.error ? `, ${res.error}` : ""})`, res.status);
  return { data: res.data, url: res.url, fetchedAt: res.fetchedAt };
}

/** Recommended fee rates as points (sat/vB), true at read time. */
export function feePoints(f: MempoolFees, asOf: string): Point[] {
  const rows: Array<[keyof MempoolFees, string, string]> = [
    ["fastestFee", "fastest", "next block"],
    ["halfHourFee", "halfhour", "~30 minutes"],
    ["hourFee", "hour", "~1 hour"],
    ["economyFee", "economy", "economy"],
    ["minimumFee", "minimum", "minimum relay"],
  ];
  return rows
    .filter(([k]) => Number.isFinite(f[k]))
    .map(([k, key, what]) => ({ key: `BTC.onchain.fee.${key}`, label: `BTC recommended fee (${what})`, value: f[k], unit: "sat/vB", asOf }));
}

/** Hashrate (EH/s) and difficulty points: the latest daily average and the current estimate. */
export function hashratePoints(h: MempoolHashrate): Point[] {
  const last = h.hashrates[h.hashrates.length - 1];
  const out: Point[] = [];
  if (last)
    out.push({
      key: "BTC.onchain.hashrate.daily",
      label: "BTC daily average hashrate",
      value: last.avgHashrate / 1e18,
      unit: "EH/s",
      asOf: isoDay(last.timestamp * 1000),
    });
  if (Number.isFinite(h.currentHashrate))
    out.push({ key: "BTC.onchain.hashrate.current", label: "BTC current hashrate estimate", value: h.currentHashrate / 1e18, unit: "EH/s" });
  if (Number.isFinite(h.currentDifficulty))
    out.push({ key: "BTC.onchain.difficulty", label: "BTC mining difficulty", value: h.currentDifficulty, unit: "index" });
  return out;
}

/** The difficulty epoch: progress, projected and previous change, next retarget. */
export function difficultyPoints(d: MempoolDifficulty): Point[] {
  return [
    { key: "BTC.onchain.epoch.progress", label: "BTC difficulty epoch progress", value: d.progressPercent, unit: "%" },
    { key: "BTC.onchain.epoch.change.projected", label: "BTC projected difficulty change at next retarget", value: d.difficultyChange, unit: "%" },
    { key: "BTC.onchain.epoch.change.previous", label: "BTC difficulty change at previous retarget", value: d.previousRetarget, unit: "%" },
    { key: "BTC.onchain.epoch.remainingBlocks", label: "BTC blocks until next retarget", value: d.remainingBlocks, unit: "count" },
    { key: "BTC.onchain.epoch.retargetDate", label: "BTC estimated next retarget date", value: isoDay(d.estimatedRetargetDate) },
    { key: "BTC.onchain.epoch.retargetHeight", label: "BTC next retarget block height", value: d.nextRetargetHeight, unit: "count" },
  ].filter((p) => typeof p.value === "string" || Number.isFinite(p.value));
}

/** Bitcoin fees, hashrate and the difficulty epoch: three datasets. */
export async function mempoolNetwork(): Promise<Dataset[]> {
  const fees = await get<MempoolFees>("/fees/recommended");
  const hash = await get<MempoolHashrate>("/mining/hashrate/3d");
  const diff = await get<MempoolDifficulty>("/difficulty-adjustment");
  const prov = (r: { url: string; fetchedAt: string }) => ({ source: SOURCE, url: r.url, fetchedAt: r.fetchedAt, delay: "realtime", official: false });
  const day = fees.fetchedAt.slice(0, 10);
  return [
    {
      kind: "crypto-onchain",
      title: "Bitcoin recommended fees",
      subject: "BTC",
      points: feePoints(fees.data, day),
      provenance: { ...prov(fees), asOf: day },
      notes: ["fee estimates from mempool.space's own mempool view; they move block to block"],
    },
    {
      kind: "crypto-onchain",
      title: "Bitcoin hashrate and difficulty",
      subject: "BTC",
      points: hashratePoints(hash.data),
      provenance: { ...prov(hash), asOf: day },
      notes: ["hashrate is estimated from block arrival times, not measured"],
    },
    {
      kind: "crypto-onchain",
      title: "Bitcoin difficulty epoch",
      subject: "BTC",
      points: difficultyPoints(diff.data),
      provenance: { ...prov(diff), asOf: day },
      notes: [],
    },
  ];
}
