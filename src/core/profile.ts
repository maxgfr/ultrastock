// The investor's profile: who they are for the tools that size, gate and tax
// a decision — residence and tax residence, base currency, horizon, risk
// capacity, experience, envelopes (PEA, CTO, AV…), constraints and limits.
//
// It lives in ULTRASTOCK_HOME/profile.json, never in the skill directory, and
// every change is appended to its history. Limits are where the risk gate
// reads its rules, and the jurisdiction decides which venues may take a real
// order. Once live trading has been switched on for a venue, they ratchet like
// the live limits do (trading/limits.ts): tightening applies at once;
// loosening a limit, lifting a constraint or changing the jurisdiction needs
// an out-of-band code and takes effect 24 hours later — no instruction slipped
// into a conversation can widen the loss limits, or move the investor to
// another country, and use it at once. Before that (paper only), a change
// applies when it is made.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../engine.js";
import { homeDir } from "./paths.js";

export const PROFILE_SCHEMA = 1;

export type Experience = "none" | "basic" | "experienced";
export type EnvelopeType = "PEA" | "PEA-PME" | "CTO" | "AV" | "PER" | "CRYPTO" | "TAXABLE" | "IRA" | "ROTH-IRA" | "401K" | "OTHER";

export interface Envelope {
  id: string;
  type: EnvelopeType;
  broker?: string;
  currency: string;
  openedAt?: string;
}

export interface Limits {
  /** One position at most this % of the portfolio. */
  maxPositionPct: number;
  /** One sector at most this %. */
  maxSectorPct: number;
  /** Crypto at most this % of the portfolio. */
  maxCryptoPct: number;
  /** Cash kept aside, never invested by a ticket. */
  cashBufferPct: number;
  /** Risk taken on one trade (entry to stop), as % of the portfolio. */
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxMonthlyLossPct: number;
  maxOrdersPerDay: number;
  maxOpenPositions: number;
}

export interface Profile {
  schema: number;
  createdAt: string;
  updatedAt: string;
  /** ISO 3166 country of residence: decides what may be bought, where. */
  jurisdiction: string;
  /** ISO country of tax residence: decides which tax regime applies. */
  taxResidence: string;
  baseCurrency: string;
  horizonYears?: number;
  /** 1 (very conservative) … 7 (speculative), from the suitability questionnaire. */
  riskScore?: number;
  riskLabel?: string;
  /** The largest fall of the portfolio the investor says they can live through, in %. */
  lossTolerancePct?: number;
  emergencyFundMonths?: number;
  experience: Record<"stocks" | "etfs" | "crypto" | "options" | "leverage" | "predictionMarkets", Experience>;
  envelopes: Envelope[];
  constraints: {
    allowShort: boolean;
    allowLeverage: boolean;
    allowOptions: boolean;
    allowCrypto: boolean;
    allowPredictionMarkets: boolean;
    /** Tickers, sectors or themes never to buy. */
    exclusions: string[];
  };
  limits: Limits;
  /** Loosenings approved by code and waiting out their 24 hours. */
  pending?: PendingChange[];
  history: Array<{ at: string; path: string; from: unknown; to: unknown }>;
}

export interface PendingChange {
  path: string;
  to: unknown;
  requestedAt: string;
  effectiveAt: string;
}

/** How long an approved loosening waits before it is in force. */
export const PROFILE_LOOSEN_DELAY_MS = 24 * 3_600_000;

/** Conservative defaults: a profile that has not been through suitability yet. */
export function defaultProfile(jurisdiction = "FR", currency = "EUR", now = new Date()): Profile {
  return {
    schema: PROFILE_SCHEMA,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    jurisdiction: jurisdiction.toUpperCase(),
    taxResidence: jurisdiction.toUpperCase(),
    baseCurrency: currency.toUpperCase(),
    experience: { stocks: "none", etfs: "none", crypto: "none", options: "none", leverage: "none", predictionMarkets: "none" },
    envelopes: [],
    constraints: { allowShort: false, allowLeverage: false, allowOptions: false, allowCrypto: true, allowPredictionMarkets: false, exclusions: [] },
    limits: {
      maxPositionPct: 5,
      maxSectorPct: 25,
      maxCryptoPct: 5,
      cashBufferPct: 5,
      riskPerTradePct: 0.5,
      maxDailyLossPct: 2,
      maxWeeklyLossPct: 4,
      maxMonthlyLossPct: 8,
      maxOrdersPerDay: 3,
      maxOpenPositions: 15,
    },
    history: [],
  };
}

export function profilePath(): string {
  return join(homeDir(), "profile.json");
}

/** The profile in force now: a loosening whose 24 hours are over is applied on the way (kept by the next write). */
export function loadProfile(now = new Date()): Profile | undefined {
  const path = profilePath();
  if (!existsSync(path)) return undefined;
  const p = JSON.parse(readFileSync(path, "utf8")) as Profile;
  if (p.schema !== PROFILE_SCHEMA) throw new Error(`${path} has profile schema ${p.schema}; this ultrastock reads schema ${PROFILE_SCHEMA}`);
  const matured = (p.pending ?? []).filter((c) => now.getTime() >= Date.parse(c.effectiveAt));
  if (matured.length) {
    for (const c of matured) write(p, c.path, c.to, now);
    p.pending = (p.pending ?? []).filter((c) => !matured.includes(c));
    if (!p.pending.length) delete p.pending;
  }
  return p;
}

export function saveProfile(p: Profile): string {
  const path = profilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(p, null, 2)}\n`, 0o600);
  return path;
}

/** Settable paths and how their values are read. Anything else is refused. */
const SETTERS: Record<string, (raw: string) => unknown> = {
  jurisdiction: (v) => country(v),
  taxResidence: (v) => country(v),
  baseCurrency: (v) => {
    if (!/^[A-Z]{3}$/i.test(v)) throw new Error(`a currency is three letters (EUR, USD), not "${v}"`);
    return v.toUpperCase();
  },
  horizonYears: (v) => num(v, 0, 80),
  lossTolerancePct: (v) => num(v, 0, 100),
  emergencyFundMonths: (v) => num(v, 0, 120),
  "constraints.allowShort": bool,
  "constraints.allowLeverage": bool,
  "constraints.allowOptions": bool,
  "constraints.allowCrypto": bool,
  "constraints.allowPredictionMarkets": bool,
  "constraints.exclusions": (v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ...Object.fromEntries(["stocks", "etfs", "crypto", "options", "leverage", "predictionMarkets"].map((k) => [`experience.${k}`, experience])),
  "limits.maxPositionPct": (v) => num(v, 0.1, 100),
  "limits.maxSectorPct": (v) => num(v, 1, 100),
  "limits.maxCryptoPct": (v) => num(v, 0, 100),
  "limits.cashBufferPct": (v) => num(v, 0, 100),
  "limits.riskPerTradePct": (v) => num(v, 0.01, 10),
  "limits.maxDailyLossPct": (v) => num(v, 0.1, 50),
  "limits.maxWeeklyLossPct": (v) => num(v, 0.1, 50),
  "limits.maxMonthlyLossPct": (v) => num(v, 0.1, 80),
  "limits.maxOrdersPerDay": (v) => num(v, 0, 100, true),
  "limits.maxOpenPositions": (v) => num(v, 1, 500, true),
};

export const SETTABLE_PATHS = Object.keys(SETTERS);

function country(v: string): string {
  if (!/^[A-Z]{2}$/i.test(v)) throw new Error(`a country is an ISO two-letter code (FR, US, BE), not "${v}"`);
  return v.toUpperCase();
}
function num(v: string, min: number, max: number, integer = false): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    throw new Error(`expected ${integer ? "a whole number" : "a number"} between ${min} and ${max}, not "${v}"`);
  return n;
}
function bool(v: string): boolean {
  if (/^(true|yes|1|oui)$/i.test(v)) return true;
  if (/^(false|no|0|non)$/i.test(v)) return false;
  throw new Error(`expected true or false, not "${v}"`);
}
function experience(v: string): Experience {
  if (v === "none" || v === "basic" || v === "experienced") return v;
  throw new Error(`experience is none, basic or experienced, not "${v}"`);
}

/** The value a settable field would take from what was typed; throws on an unknown field or a value out of range. */
export function parseProfileValue(path: string, raw: string): unknown {
  const setter = SETTERS[path];
  if (!setter) throw new Error(`"${path}" is not a profile field you can set — one of: ${SETTABLE_PATHS.join(", ")}`);
  return setter(raw);
}

/** The value at a dotted path of the profile. */
export function profileValue(p: Profile, path: string): unknown {
  let target: any = p;
  for (const k of path.split(".")) target = target?.[k];
  return target;
}

/** Write a value at a dotted path, recording the change. Returns the previous value. */
function write(p: Profile, path: string, value: unknown, now: Date): unknown {
  const parts = path.split(".");
  let target: any = p;
  for (const k of parts.slice(0, -1)) target = target[k];
  const leaf = parts[parts.length - 1]!;
  const from = target[leaf];
  target[leaf] = value;
  p.history.push({ at: now.toISOString(), path, from, to: value });
  p.updatedAt = now.toISOString();
  return from;
}

/** Set one field now, recording the change. Returns the previous value. */
export function setProfileField(p: Profile, path: string, raw: string, now = new Date()): unknown {
  return write(p, path, parseProfileValue(path, raw), now);
}

/** Limits where a larger number allows more: a bigger position, a deeper loss before the breaker, more orders a day. */
const LOOSER_WHEN_HIGHER = new Set([
  "limits.maxPositionPct",
  "limits.maxSectorPct",
  "limits.maxCryptoPct",
  "limits.riskPerTradePct",
  "limits.maxDailyLossPct",
  "limits.maxWeeklyLossPct",
  "limits.maxMonthlyLossPct",
  "limits.maxOrdersPerDay",
  "limits.maxOpenPositions",
]);

/**
 * Does this change lower a guard? A limit moved the permissive way, a
 * constraint lifted, an exclusion dropped — and any change of jurisdiction or
 * of base currency. Everything else (the horizon, the tax residence, an
 * experience level) guards nothing.
 */
export function loosens(path: string, from: unknown, to: unknown): boolean {
  // The country decides which venues may take a real order; the base currency is the unit of every limit, of the
  // live limits and of the equity curve the breaker reads: changing either, any way, lowers a guard.
  if (path === "jurisdiction" || path === "baseCurrency") return from !== to;
  if (LOOSER_WHEN_HIGHER.has(path)) return Number(to) > Number(from);
  if (path === "limits.cashBufferPct") return Number(to) < Number(from);
  if (path === "constraints.exclusions") {
    const kept = new Set((Array.isArray(to) ? to : []).map((x) => String(x).toLowerCase()));
    return (Array.isArray(from) ? from : []).some((x) => !kept.has(String(x).toLowerCase()));
  }
  if (path.startsWith("constraints.allow")) return from !== true && to === true;
  return false;
}

/** What an approval code for a profile change approves: that field, that value. */
export const profileChangeBinding = (path: string, to: unknown) => `profile|${path}|${JSON.stringify(to)}`;

export interface ChangeOutcome {
  path: string;
  from: unknown;
  to: unknown;
  /** In force now. */
  applied: boolean;
  /** Approved and waiting: in force from this instant. */
  effectiveAt?: string;
  /** Neither: why. */
  reason?: string;
}

/**
 * Change one field under the ratchet. With `ratchet` off (live trading never
 * switched on) every change applies now. With it on, a change that lowers a
 * guard needs `approved` — a verified out-of-band code — and waits 24 hours;
 * a tightening applies now and cancels a loosening of the same field still waiting.
 */
export function requestProfileChange(p: Profile, path: string, to: unknown, opts: { ratchet: boolean; approved?: boolean; now?: Date }): ChangeOutcome {
  const now = opts.now ?? new Date();
  const from = profileValue(p, path);
  if (!opts.ratchet || !loosens(path, from, to)) {
    write(p, path, to, now);
    if (p.pending) {
      p.pending = p.pending.filter((c) => c.path !== path);
      if (!p.pending.length) delete p.pending;
    }
    return { path, from, to, applied: true };
  }
  if (!opts.approved)
    return {
      path,
      from,
      to,
      applied: false,
      reason: "live trading has been switched on: lowering this guard needs an approval code (`profile code …`) and takes effect 24 hours later",
    };
  const effectiveAt = new Date(now.getTime() + PROFILE_LOOSEN_DELAY_MS).toISOString();
  p.pending = [...(p.pending ?? []).filter((c) => c.path !== path), { path, to, requestedAt: now.toISOString(), effectiveAt }];
  p.updatedAt = now.toISOString();
  return { path, from, to, applied: false, effectiveAt };
}

/** Add or replace an envelope (a PEA, a CTO at IBKR, a crypto account at Kraken…). */
export function upsertEnvelope(p: Profile, env: Envelope, now = new Date()): void {
  const i = p.envelopes.findIndex((e) => e.id === env.id);
  const from = i >= 0 ? p.envelopes[i] : undefined;
  if (i >= 0) p.envelopes[i] = env;
  else p.envelopes.push(env);
  p.history.push({ at: now.toISOString(), path: `envelopes.${env.id}`, from, to: env });
  p.updatedAt = now.toISOString();
}
