// Live limits with a ratchet: euros per order and per day, per experience
// tier. Tightening applies at once. Loosening needs an out-of-band code and
// takes effect 24 hours later — time to change one's mind, and no way for an
// instruction slipped into a conversation to raise a limit and use it at once.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../core/paths.js";
import { writeFileAtomic } from "../engine.js";
import type { Venue } from "./brokers/types.js";

export const LOOSEN_DELAY_MS = 24 * 3_600_000;

export interface LiveLimits {
  /** Largest notional of one live order, in the base currency. */
  maxOrder: number;
  /** Largest total notional of live orders in one calendar day (UTC). */
  maxDaily: number;
  /** Venues live trading is switched on for. */
  venues: Venue[];
  /** Venues whose key the user attested has no withdrawal right (venues that cannot be asked). */
  attestedNoWithdraw: Venue[];
}

interface Stored {
  current: LiveLimits;
  pending?: { limits: LiveLimits; requestedAt: string; effectiveAt: string };
  history: Array<{ at: string; from: LiveLimits; to: LiveLimits; how: "tightened" | "loosened" }>;
}

/** Experience tiers by live fills so far: small at first, whatever the profile says. */
export const TIERS = [
  { name: "first steps", minFills: 0, maxOrder: 250, maxDaily: 500 },
  { name: "practised", minFills: 20, maxOrder: 1000, maxDaily: 2500 },
  { name: "experienced", minFills: 100, maxOrder: 5000, maxDaily: 10_000 },
] as const;

export function tierFor(liveFills: number): (typeof TIERS)[number] {
  return [...TIERS].reverse().find((t) => liveFills >= t.minFills) ?? TIERS[0];
}

const path = () => join(homeDir(), "state", "live-limits.json");
const DEFAULT: LiveLimits = { maxOrder: TIERS[0].maxOrder, maxDaily: TIERS[0].maxDaily, venues: [], attestedNoWithdraw: [] };

function load(): Stored {
  if (!existsSync(path())) return { current: { ...DEFAULT }, history: [] };
  return JSON.parse(readFileSync(path(), "utf8")) as Stored;
}
function save(s: Stored): void {
  mkdirSync(join(homeDir(), "state"), { recursive: true });
  writeFileAtomic(path(), `${JSON.stringify(s, null, 2)}\n`, 0o600);
}

/** The limits in force now (a matured loosening is applied), capped by the tier. */
export function effectiveLimits(liveFills: number, now = new Date()): { limits: LiveLimits; tier: string; pending?: Stored["pending"] } {
  const s = load();
  if (s.pending && now.getTime() >= Date.parse(s.pending.effectiveAt)) {
    s.history.push({ at: now.toISOString(), from: s.current, to: s.pending.limits, how: "loosened" });
    s.current = s.pending.limits;
    s.pending = undefined;
    save(s);
  }
  const t = tierFor(liveFills);
  return {
    limits: { ...s.current, maxOrder: Math.min(s.current.maxOrder, t.maxOrder), maxDaily: Math.min(s.current.maxDaily, t.maxDaily) },
    tier: t.name,
    pending: s.pending,
  };
}

/** Is `next` no looser than `cur` in every respect? */
export function isTightening(cur: LiveLimits, next: LiveLimits): boolean {
  return (
    next.maxOrder <= cur.maxOrder &&
    next.maxDaily <= cur.maxDaily &&
    next.venues.every((v) => cur.venues.includes(v)) &&
    next.attestedNoWithdraw.every((v) => cur.attestedNoWithdraw.includes(v))
  );
}

/** A stable binding for the approval code of a loosening. */
export const limitsBinding = (l: LiveLimits) => JSON.stringify([l.maxOrder, l.maxDaily, [...l.venues].sort(), [...l.attestedNoWithdraw].sort()]);

/**
 * Change the limits. A tightening applies now. A loosening needs `approved`
 * (a verified out-of-band code) and becomes effective after 24 hours.
 */
export function requestLimits(next: LiveLimits, approved: boolean, now = new Date()): { applied: boolean; effectiveAt?: string; reason?: string } {
  if (!(next.maxOrder >= 0 && next.maxDaily >= next.maxOrder)) return { applied: false, reason: "the daily limit must be at least the order limit, both ≥ 0" };
  const s = load();
  if (isTightening(s.current, next)) {
    s.history.push({ at: now.toISOString(), from: s.current, to: next, how: "tightened" });
    s.current = next;
    // A pending loosening beyond the new limits is dropped.
    if (s.pending && !isTightening(next, s.pending.limits)) s.pending = undefined;
    save(s);
    return { applied: true };
  }
  if (!approved) return { applied: false, reason: "loosening a limit needs an approval code (`broker code limits …`) and takes effect 24 hours later" };
  const effectiveAt = new Date(now.getTime() + LOOSEN_DELAY_MS).toISOString();
  s.pending = { limits: next, requestedAt: now.toISOString(), effectiveAt };
  save(s);
  return { applied: false, effectiveAt };
}

export function currentLimits(): LiveLimits {
  return load().current;
}
