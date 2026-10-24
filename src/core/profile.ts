// The investor's profile: who they are for the tools that size, gate and tax
// a decision — residence and tax residence, base currency, horizon, risk
// capacity, experience, envelopes (PEA, CTO, AV…), constraints and limits.
//
// It lives in ULTRASTOCK_HOME/profile.json, never in the skill directory, and
// every change is appended to its history. Limits are where the risk gate
// reads its rules: changing one is recorded; loosening one will require an
// out-of-band confirmation and a cooling-off delay once live trading exists.
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
  history: Array<{ at: string; path: string; from: unknown; to: unknown }>;
}

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

export function loadProfile(): Profile | undefined {
  const path = profilePath();
  if (!existsSync(path)) return undefined;
  const p = JSON.parse(readFileSync(path, "utf8")) as Profile;
  if (p.schema !== PROFILE_SCHEMA) throw new Error(`${path} has profile schema ${p.schema}; this ultrastock reads schema ${PROFILE_SCHEMA}`);
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

/** Set one field, recording the change. Returns the previous value. */
export function setProfileField(p: Profile, path: string, raw: string, now = new Date()): unknown {
  const setter = SETTERS[path];
  if (!setter) throw new Error(`"${path}" is not a profile field you can set — one of: ${SETTABLE_PATHS.join(", ")}`);
  const value = setter(raw);
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

/** Add or replace an envelope (a PEA, a CTO at IBKR, a crypto account at Kraken…). */
export function upsertEnvelope(p: Profile, env: Envelope, now = new Date()): void {
  const i = p.envelopes.findIndex((e) => e.id === env.id);
  const from = i >= 0 ? p.envelopes[i] : undefined;
  if (i >= 0) p.envelopes[i] = env;
  else p.envelopes.push(env);
  p.history.push({ at: now.toISOString(), path: `envelopes.${env.id}`, from, to: env });
  p.updatedAt = now.toISOString();
}
