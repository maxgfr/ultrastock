// Rebalancing to target weights, the pure part: parse the targets, turn the
// band rule's money amounts (src/analytics/portfolio.ts `rebalance`) into
// orders a broker would take — whole shares (fractional units for crypto),
// sells capped at what is held, fees from the paper fee model — and say what
// each sell costs in tax terms. Never places an order.
import { existsSync, readFileSync } from "node:fs";
import { UsageError } from "../../engine.js";
import { feeFor } from "../../trading/paper.js";

/** Targets from a JSON file path or inline JSON: {"CW8.PA": 60, "MC.PA": 10, "CASH": 5} — weights in %. */
export function parseTargets(raw: string): Record<string, number> {
  const text = raw.trim().startsWith("{") ? raw : existsSync(raw) ? readFileSync(raw, "utf8") : undefined;
  if (text === undefined) throw new UsageError(`--targets is a JSON object of weights in % or a path to one, not "${raw}"`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("--targets is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError('--targets is an object like {"CW8.PA":60,"MC.PA":10}');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new UsageError(`--targets: the weight of ${k} must be a number ≥ 0 (in %)`);
    out[k.trim().toUpperCase()] = v;
  }
  const sum = Object.values(out).reduce((s, v) => s + v, 0);
  if (!(sum > 0)) throw new UsageError("--targets: the weights sum to 0");
  if (sum > 100.5) throw new UsageError(`--targets: the weights sum to ${sum} % (over 100 %)`);
  return out;
}

export interface OrderLine {
  symbol: string;
  side: "buy" | "sell";
  /** Units, whole shares except for crypto. */
  units: number;
  price: number;
  currency: string;
  /** Notional and fee in the trade currency, and the notional in base. */
  notional: number;
  fee: number;
  notionalBase: number;
  feeBase: number;
  /** For a sell: the gain realised by the average-cost rule, trade currency. */
  realisedPmp?: number;
  reasons: string[];
}

/**
 * The order for a money amount in base: units = amount ÷ (price × rate),
 * truncated toward zero to whole shares (crypto to 1e-6), a sell capped at
 * `held`. Undefined when the amount buys less than one share.
 */
export function orderFor(a: {
  symbol: string;
  amountBase: number;
  price: number;
  rate: number;
  currency: string;
  market: string;
  held: number;
  averageCost?: number;
}): OrderLine | undefined {
  const crypto = a.market === "crypto";
  const raw = Math.abs(a.amountBase) / (a.price * a.rate);
  let units = crypto ? Math.floor(raw * 1e6) / 1e6 : Math.floor(raw + 1e-9);
  const side = a.amountBase >= 0 ? "buy" : "sell";
  const reasons: string[] = [];
  if (side === "sell" && units > a.held) {
    units = a.held;
    reasons.push(`capped at the ${a.held} units held`);
  }
  if (!(units > 0)) return undefined;
  if (!crypto && raw - units > 1e-9) reasons.push(`${raw.toFixed(3)} units rounded down to whole shares`);
  const notional = units * a.price;
  const fee = feeFor(a.market, units, a.price);
  return {
    symbol: a.symbol,
    side,
    units,
    price: a.price,
    currency: a.currency,
    notional,
    fee,
    notionalBase: notional * a.rate,
    feeBase: fee * a.rate,
    ...(side === "sell" && a.averageCost !== undefined ? { realisedPmp: units * a.price - fee - units * a.averageCost } : {}),
    reasons,
  };
}

/** What a sell costs in tax terms in an envelope — a statement, not a computation (the tax engine is to come). */
export function sellTaxNote(envelope: string): string {
  if (envelope === "PEA" || envelope === "PEA-PME") return "inside the PEA a sell realises nothing taxable: the plan is taxed only on withdrawal";
  if (envelope === "AV" || envelope === "PER") return "inside the wrapper an arbitrage is not taxed; tax applies on withdrawal";
  if (envelope === "CRYPTO") return "crypto → crypto is not taxed in France; a sell to euros realises a taxable capital gain (art. 150 VH bis CGI, flat tax)";
  if (envelope === "CTO" || envelope === "TAXABLE")
    return "in a CTO a sell realises a taxable gain or loss (the French flat tax, PFU, on the net gain) — the tax engine is to come";
  return "the envelope is unknown: whether this sell is taxable depends on it (a CTO realises a taxable gain, a PEA does not)";
}
