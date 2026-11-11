// Live limits with a ratchet: euros per order and per day, per experience
// tier. Tightening applies at once. Loosening needs an out-of-band code and
// takes effect 24 hours later — time to change one's mind, and no way for an
// instruction slipped into a conversation to raise a limit and use it at once.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLockSync } from "../core/lock.js";
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
  /**
   * Every change. "pending tightened" / "pending dropped": a tightening also cut down (or emptied) a loosening
   * still waiting out its 24 hours — `from` is what was approved, `to` what still waits (or the limits in force).
   */
  history: Array<{ at: string; from: LiveLimits; to: LiveLimits; how: "tightened" | "loosened" | "pending tightened" | "pending dropped" }>;
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
/**
 * Every read-change-write of the stored limits under one lock: a change saved
 * over another process's would erase it — a tightening included.
 */
const limitsLock = <T>(fn: () => T): T => withFileLockSync(`${path()}.lock`, fn);

/** Apply a loosening whose 24 hours are over; true when `s` changed. */
function mature(s: Stored, now: Date): boolean {
  if (!s.pending || now.getTime() < Date.parse(s.pending.effectiveAt)) return false;
  s.history.push({ at: now.toISOString(), from: s.current, to: s.pending.limits, how: "loosened" });
  s.current = s.pending.limits;
  s.pending = undefined;
  return true;
}

/** The limits in force now (a matured loosening is applied), capped by the tier. */
export function effectiveLimits(liveFills: number, now = new Date()): { limits: LiveLimits; tier: string; pending?: Stored["pending"] } {
  const s = limitsLock(() => {
    const s = load();
    if (mature(s, now)) save(s);
    return s;
  });
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

/** `l` with each limit `set` names made no looser than `set` says: the lower amount, the venues in both. */
function tightenedBy(l: LiveLimits, set: Partial<LiveLimits>): LiveLimits {
  const out = { ...l };
  if (set.maxOrder !== undefined) out.maxOrder = Math.min(l.maxOrder, set.maxOrder);
  if (set.maxDaily !== undefined) out.maxDaily = Math.min(l.maxDaily, set.maxDaily);
  if (set.venues) out.venues = l.venues.filter((v) => set.venues!.includes(v));
  if (set.attestedNoWithdraw) out.attestedNoWithdraw = l.attestedNoWithdraw.filter((v) => set.attestedNoWithdraw!.includes(v));
  // A day never holds less than one order.
  out.maxOrder = Math.min(out.maxOrder, out.maxDaily);
  return out;
}

/** A stable binding for the approval code of a loosening. */
export const limitsBinding = (l: LiveLimits) => JSON.stringify([l.maxOrder, l.maxDaily, [...l.venues].sort(), [...l.attestedNoWithdraw].sort()]);

/**
 * Change the limits. `change` holds what the user set; every other field is
 * the limit in force, read under the lock — not one read earlier, which a
 * concurrent change may have tightened since (the request would then read as
 * a loosening). A tightening applies now. A loosening needs `approved` (a
 * verified out-of-band code; as a function, asked about the very limits it
 * would set) and becomes effective after 24 hours.
 */
export function requestLimits(
  change: Partial<LiveLimits>,
  approved: boolean | ((next: LiveLimits) => boolean),
  now = new Date(),
): { applied: boolean; effectiveAt?: string; reason?: string } {
  return limitsLock(() => changeLimits(change, approved, now));
}

function changeLimits(
  change: Partial<LiveLimits>,
  approved: boolean | ((next: LiveLimits) => boolean),
  now: Date,
): { applied: boolean; effectiveAt?: string; reason?: string } {
  const s = load();
  // A loosening whose 24 hours are over is in force: the change is made over it, not over the limits before it.
  const matured = mature(s, now);
  const set = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as Partial<LiveLimits>;
  const next: LiveLimits = { ...s.current, ...set };
  if (!(next.maxOrder >= 0 && next.maxDaily >= next.maxOrder)) {
    if (matured) save(s);
    return { applied: false, reason: "the daily limit must be at least the order limit, both ≥ 0" };
  }
  if (isTightening(s.current, next)) {
    s.history.push({ at: now.toISOString(), from: s.current, to: next, how: "tightened" });
    s.current = next;
    if (s.pending) {
      // A loosening still waiting keeps waiting, cut down by what this change tightens (and only that):
      // `--max-order 249` lowers its order limit too, and leaves the venue it switches on alone.
      const waiting = tightenedBy(s.pending.limits, set);
      if (isTightening(next, waiting)) {
        // Nothing is left of it beyond the limits now in force.
        s.history.push({ at: now.toISOString(), from: s.pending.limits, to: next, how: "pending dropped" });
        s.pending = undefined;
      } else if (limitsBinding(waiting) !== limitsBinding(s.pending.limits)) {
        s.history.push({ at: now.toISOString(), from: s.pending.limits, to: waiting, how: "pending tightened" });
        s.pending = { ...s.pending, limits: waiting };
      }
    }
    save(s);
    return { applied: true };
  }
  if (matured) save(s);
  if (!(typeof approved === "function" ? approved(next) : approved))
    return { applied: false, reason: "loosening a limit needs an approval code (`broker code limits …`) and takes effect 24 hours later" };
  const effectiveAt = new Date(now.getTime() + LOOSEN_DELAY_MS).toISOString();
  s.pending = { limits: next, requestedAt: now.toISOString(), effectiveAt };
  save(s);
  return { applied: false, effectiveAt };
}

export function currentLimits(): LiveLimits {
  return load().current;
}

/**
 * Has live trading ever been switched on? A venue approved by code — in force, waiting out its 24 hours, or
 * switched off since: from the first approval on, the guards the profile holds protect real money, and
 * switching every venue off again (a tightening, no code) must not lift them.
 */
export function liveEverApproved(): boolean {
  const s = load();
  const any = (l?: LiveLimits) => !!l && l.venues.length > 0;
  return any(s.current) || any(s.pending?.limits) || s.history.some((h) => any(h.to) || any(h.from));
}
