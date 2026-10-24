// The risk gate: a deterministic set of rules every order passes before it can
// become a ticket that executes, on paper or for real. It does not judge the
// idea — the analysis did that — it judges the ORDER against the investor's own
// limits (the profile), what they already hold (the book, pending orders
// included), the circuit breaker, the data's freshness and the jurisdiction.
//
// Every check runs and reports PASS, WARN or BLOCK with a reason and a code; one
// BLOCK blocks the order. Orders that only REDUCE risk (selling what is held)
// pass the breaker and the caps: getting out must always be possible.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../engine.js";
import { ruleStatus } from "../core/jurisdiction.js";
import { homeDir } from "../core/paths.js";
import type { Profile } from "../core/profile.js";

export interface Order {
  account: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** Limit price (or the reference price of a market order). */
  price: number;
  orderType: "limit" | "market";
  currency: string;
  /** Protective stop (required for a buy). */
  stop?: number;
  assetKind: "equity" | "etf" | "index" | "crypto" | "fund" | "option" | "prediction";
  /** For ETFs: the fund's domicile country (US-domiciled ETFs are restricted for EU retail). */
  domicile?: string;
  sector?: string;
  venue: string;
}

export interface GateContext {
  profile: Profile;
  /** Total portfolio value in the base currency. */
  equityBase: number;
  /** Cash available in the base currency (all accounts). */
  cashBase: number;
  /** Order currency → base currency rate. */
  fxToBase: number;
  /** Current value in base of the position in this symbol (all accounts). */
  positionValueBase: number;
  /** Units held of this symbol in this account. */
  heldQuantity: number;
  /** Value in base of open positions and pending buys by sector, and crypto in total. */
  sectorValueBase?: number;
  cryptoValueBase: number;
  /** Symbols currently held, plus pending buys. */
  openSymbols: string[];
  /** Pending (approved, not yet filled) buys: value in base per symbol. */
  pendingBuysBase: Record<string, number>;
  ordersToday: number;
  /** Last trade price and when it was observed. */
  lastPrice: number;
  quoteAt: string;
  now: Date;
  /** Oldest acceptable quote for this market, ms (e.g. 15 minutes live, a session for end-of-day data). */
  maxQuoteAgeMs: number;
  breaker: { tripped: boolean; reason?: string; sizeMultiplier: number };
  /** Event risk inside the planned holding period (earnings, a central-bank decision). */
  events?: string[];
}

export type CheckStatus = "pass" | "warn" | "block";
export interface GateCheck {
  code: string;
  status: CheckStatus;
  reason: string;
}

export interface GateResult {
  verdict: "pass" | "block";
  checks: GateCheck[];
  /** Hash of the normalised order: a ticket stays valid only for exactly this order. */
  fingerprint: string;
  riskReducing: boolean;
  notionalBase: number;
}

export function killSwitchPath(): string {
  return join(homeDir(), "KILL");
}

/** The fingerprint of an order: any change to symbol, side, size, price, stop, account or venue makes a new one. */
export function orderFingerprint(o: Order): string {
  return contentHash(
    JSON.stringify([
      o.account,
      o.venue,
      o.symbol,
      o.side,
      Number(o.quantity.toPrecision(12)),
      Number(o.price.toPrecision(12)),
      o.orderType,
      o.stop ?? null,
      o.currency,
    ]),
  ).slice(0, 24);
}

const pct = (x: number) => `${x.toFixed(2)} %`;

/** Run every rule. */
export function riskGate(o: Order, c: GateContext): GateResult {
  const checks: GateCheck[] = [];
  const add = (code: string, status: CheckStatus, reason: string) => checks.push({ code, status, reason });
  const L = c.profile.limits;
  const K = c.profile.constraints;
  const notionalBase = o.quantity * o.price * c.fxToBase;
  const riskReducing = o.side === "sell" && o.quantity <= c.heldQuantity + 1e-9;

  if (!(o.quantity > 0) || !(o.price > 0)) add("INVALID", "block", "quantity and price must be positive");

  // 1. Switches and the breaker.
  if (existsSync(killSwitchPath()))
    add("KILL_SWITCH", riskReducing ? "warn" : "block", `the kill switch is on (${killSwitchPath()}) — only risk-reducing orders pass`);
  if (c.breaker.tripped)
    add("BREAKER", riskReducing ? "warn" : "block", `circuit breaker tripped: ${c.breaker.reason ?? "loss limit"} — no new risk until it resets`);
  else if (c.breaker.sizeMultiplier < 1 && !riskReducing)
    add("DRAWDOWN_SIZING", "warn", `in drawdown: sizes are cut to ${(c.breaker.sizeMultiplier * 100).toFixed(0)} % of normal`);

  // 2. Data freshness.
  const age = c.now.getTime() - Date.parse(c.quoteAt);
  if (!Number.isFinite(age) || age > c.maxQuoteAgeMs)
    add(
      "STALE_QUOTE",
      "block",
      `the last price is ${Number.isFinite(age) ? `${Math.round(age / 60_000)} min` : "of unknown"} old (limit ${Math.round(c.maxQuoteAgeMs / 60_000)} min) — refresh before ordering`,
    );
  else add("FRESH_QUOTE", "pass", `last price ${Math.round(age / 60_000)} min old`);
  const band = Math.abs(o.price / c.lastPrice - 1) * 100;
  if (o.orderType === "market") add("MARKET_ORDER", "warn", "a market order accepts any price: prefer a limit inside the spread");
  if (band > 10) add("PRICE_BAND", "block", `the order price is ${pct(band)} away from the last price ${c.lastPrice}: a typo?`);
  else if (band > 2) add("PRICE_BAND", "warn", `the order price is ${pct(band)} away from the last price ${c.lastPrice}`);

  // 3. Jurisdiction and the investor's constraints.
  const j = c.profile.jurisdiction;
  if (o.assetKind === "etf" && o.domicile === "US" && ruleStatus(j, "us-domiciled-etf") === "restricted")
    add("PRIIPS", "block", `a US-domiciled ETF has no PRIIPs KID: not sold to retail investors in ${j} — use its UCITS equivalent`);
  if (o.assetKind === "prediction" && ruleStatus(j, o.venue) !== "allowed")
    add("JURISDICTION", "block", `${o.venue} is ${ruleStatus(j, o.venue)} for residents of ${j}`);
  if (o.assetKind === "crypto" && !K.allowCrypto) add("NO_CRYPTO", "block", "the profile excludes crypto-assets");
  if (o.assetKind === "option" && !K.allowOptions) add("NO_OPTIONS", "block", "the profile does not allow options");
  if (o.assetKind === "prediction" && !K.allowPredictionMarkets) add("NO_PREDICTION", "block", "the profile does not allow prediction markets");
  if (o.side === "sell" && !riskReducing && !K.allowShort)
    add("NO_SHORT", "block", `selling ${o.quantity} while holding ${c.heldQuantity}: short selling is not allowed`);
  const excl = K.exclusions.map((e) => e.toLowerCase());
  if (excl.some((e) => e === o.symbol.toLowerCase() || (o.sector && e === o.sector.toLowerCase())))
    add("EXCLUDED", "block", `${o.symbol}${o.sector ? ` (${o.sector})` : ""} is on the profile's exclusion list`);

  if (!riskReducing && o.side === "buy") {
    // 4. Risk per trade: a buy needs a stop, and the loss to the stop is capped.
    if (o.stop === undefined) add("NO_STOP", "block", "no protective stop: a position without a stop has no defined risk");
    else if (o.stop >= o.price) add("STOP_SIDE", "block", `the stop ${o.stop} is not below the entry ${o.price}`);
    else {
      const risk = o.quantity * (o.price - o.stop) * c.fxToBase;
      const riskPct = (risk / c.equityBase) * 100;
      const allowed = L.riskPerTradePct * c.breaker.sizeMultiplier;
      add(
        "RISK_PER_TRADE",
        riskPct > allowed + 1e-9 ? "block" : "pass",
        `loss to the stop ${risk.toFixed(2)} = ${pct(riskPct)} of the portfolio (limit ${pct(allowed)})`,
      );
    }
    // 5. Concentration, pending buys included.
    const pending = c.pendingBuysBase[o.symbol] ?? 0;
    const posPct = ((c.positionValueBase + pending + notionalBase) / c.equityBase) * 100;
    add(
      "POSITION_PCT",
      posPct > L.maxPositionPct + 1e-9 ? "block" : "pass",
      `position after the order ${pct(posPct)} of the portfolio (limit ${pct(L.maxPositionPct)})`,
    );
    if (c.sectorValueBase !== undefined && o.sector) {
      const secPct = ((c.sectorValueBase + notionalBase) / c.equityBase) * 100;
      add("SECTOR_PCT", secPct > L.maxSectorPct + 1e-9 ? "block" : "pass", `${o.sector} after the order ${pct(secPct)} (limit ${pct(L.maxSectorPct)})`);
    }
    if (o.assetKind === "crypto") {
      const cPct = ((c.cryptoValueBase + notionalBase) / c.equityBase) * 100;
      add("CRYPTO_PCT", cPct > L.maxCryptoPct + 1e-9 ? "block" : "pass", `crypto after the order ${pct(cPct)} (limit ${pct(L.maxCryptoPct)})`);
    }
    const isNew = !c.openSymbols.includes(o.symbol);
    const count = c.openSymbols.length + (isNew ? 1 : 0);
    add("MAX_POSITIONS", count > L.maxOpenPositions ? "block" : "pass", `${count} open position(s) after the order (limit ${L.maxOpenPositions})`);
    // 6. Cash: no leverage unless allowed, and the buffer stays.
    const cashAfter = c.cashBase - notionalBase - Object.values(c.pendingBuysBase).reduce((a, b) => a + b, 0);
    if (cashAfter < 0 && !K.allowLeverage) add("NO_LEVERAGE", "block", `the order needs ${(-cashAfter).toFixed(2)} more cash than is available: no margin`);
    const buffer = (L.cashBufferPct / 100) * c.equityBase;
    if (cashAfter >= 0 && cashAfter < buffer)
      add("CASH_BUFFER", "block", `cash after the order ${cashAfter.toFixed(2)} would fall below the ${pct(L.cashBufferPct)} buffer (${buffer.toFixed(2)})`);
  }
  // 7. Frequency (risk-reducing orders still count, but are not blocked).
  if (c.ordersToday >= L.maxOrdersPerDay)
    add("FREQUENCY", riskReducing ? "warn" : "block", `${c.ordersToday} order(s) already today (limit ${L.maxOrdersPerDay}) — overtrading`);
  // 8. Events inside the holding period.
  for (const e of c.events ?? []) add("EVENT_RISK", "warn", e);

  return { verdict: checks.some((x) => x.status === "block") ? "block" : "pass", checks, fingerprint: orderFingerprint(o), riskReducing, notionalBase };
}
