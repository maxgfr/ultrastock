// `plan <symbol>`: from a view to an order that respects the investor's limits —
// the Trade Context. The entry, the stop and the targets are absolute prices
// computed from the chart (ATR, support, resistance), the size from the risk
// the profile allows, and the whole order is dry-run through the risk gate, so
// the verdict says whether it could be executed as is.
//
// Verdicts: ready · ready with conditions (warnings to address) · not ready
// (a size of zero, missing data) · reject (the gate blocks it).
import { atr } from "../analytics/indicators.js";
import { supportResistance } from "../analytics/patterns.js";
import { sizePosition } from "../analytics/sizing.js";
import { etfFundDomicile } from "../analyze/etf.js";
import { clockNow } from "../core/net.js";
import { getHistory, resolveSymbol } from "../providers/router.js";
import { gateContextFor } from "./context.js";
import { type GateResult, type Order, riskGate } from "./riskgate.js";

export interface PlanInput {
  symbol: string;
  side?: "buy";
  entry?: number;
  stop?: number;
  targets?: number[];
  account: string;
  venue?: string;
  /** Stop distance in ATRs when no support is near (default 2). */
  atrMultiple?: number;
  /** Reward multiples of the risk for the default targets (default 2R and 3R). */
  rMultiples?: number[];
  now?: Date;
}

export interface TradePlanResult {
  symbol: string;
  name?: string;
  currency: string;
  order: Order;
  entry: number;
  stop: number;
  stopMethod: string;
  targets: number[];
  atr?: number;
  riskPerUnit: number;
  rewardRisk: number[];
  quantity: number;
  notional: number;
  riskAmount?: number;
  riskPct?: number;
  positionPct: number;
  sizingBinding: string;
  sizingReasons: string[];
  gate: GateResult;
  verdict: "ready" | "ready with conditions" | "not ready" | "reject";
  conditions: string[];
  notes: string[];
  equityBase: number;
}

/** Round to a price tick without floating-point residue (365.95, not 365.95000000000005). */
const round = (x: number, step: number) => Number((Math.round(x / step) * step).toFixed(Math.max(0, -Math.floor(Math.log10(step)))));
const tickOf = (p: number) => (p >= 1000 ? 0.5 : p >= 100 ? 0.05 : p >= 10 ? 0.01 : p >= 1 ? 0.001 : 0.0001);

export async function planTrade(input: PlanInput): Promise<TradePlanResult> {
  const now = input.now ?? clockNow();
  const resolved = await resolveSymbol(input.symbol);
  const inst = resolved.instrument;
  const crypto = inst.market === "crypto";
  const series = await getHistory(resolved, { from: new Date(now.getTime() - 400 * 86_400_000), to: now });
  const bars = series.bars;
  const last = bars[bars.length - 1]!;
  const a = atr(bars, 14)[bars.length - 1];
  const notes: string[] = [...series.notes];
  const entry = input.entry ?? last.close;
  const tick = tickOf(entry);
  let stop = input.stop;
  let stopMethod = "given";
  if (stop === undefined) {
    if (a === undefined) throw new Error("not enough history for an ATR stop: give --stop");
    const atrStop = entry - (input.atrMultiple ?? 2) * a;
    const sr = supportResistance(bars);
    const support = sr?.levels.filter((l) => l.kind === "support" && l.price < entry).sort((x, y) => y.price - x.price)[0];
    // Below the nearest support when it is between 1 and 3 ATR away; else an ATR stop.
    if (support && entry - support.price >= a && entry - support.price <= 3 * a) {
      stop = support.low - 0.25 * a;
      stopMethod = `0.25 ATR below the support at ${support.price.toFixed(4)} (${support.touches} touches)`;
    } else {
      stop = atrStop;
      stopMethod = `${input.atrMultiple ?? 2} ATR(14) below the entry (ATR ${a.toFixed(4)})`;
    }
    stop = round(stop, tick);
  }
  if (!(stop < entry)) throw new Error(`the stop ${stop} must be below the entry ${entry} for a buy`);
  const riskPerUnit = entry - stop;
  const targets = input.targets ?? (input.rMultiples ?? [2, 3]).map((r) => round(entry + r * riskPerUnit, tick));
  const sr = supportResistance(bars);
  const wall = sr?.levels.filter((l) => l.kind === "resistance" && l.price > entry).sort((x, y) => x.price - y.price)[0];
  if (wall && targets[0]! > wall.price)
    notes.push(`resistance at ${wall.price.toFixed(4)} (${wall.touches} touches) stands before the first target ${targets[0]}`);

  // An ETF's domicile decides PRIIPs (a US-domiciled ETF has no KID for EU retail investors).
  const domicile = inst.kind === "etf" ? await etfFundDomicile(inst) : undefined;
  if (domicile) notes.push(`fund domicile ${domicile.code ?? "unknown"} (${domicile.basis})`);
  const draft: Order = {
    account: input.account,
    symbol: inst.symbol,
    side: "buy",
    quantity: 1,
    price: entry,
    orderType: "limit",
    currency: inst.currency,
    stop,
    assetKind: inst.kind === "crypto" ? "crypto" : inst.kind === "etf" ? "etf" : inst.kind === "fund" ? "fund" : "equity",
    venue: input.venue ?? "paper",
    ...(domicile?.code ? { domicile: domicile.code } : {}),
  };
  const built = await gateContextFor(draft, { now });
  notes.push(...built.notes);
  const { ctx } = built;
  const buffer = (ctx.profile.limits.cashBufferPct / 100) * ctx.equityBase;
  const avgVol = bars.slice(-20).reduce((s, b) => s + (b.volume ?? 0), 0) / Math.min(20, bars.length);
  const size = sizePosition({
    equity: ctx.equityBase / ctx.fxToBase,
    entry,
    stop,
    riskPct: ctx.profile.limits.riskPerTradePct * ctx.breaker.sizeMultiplier,
    maxPositionPct: ctx.profile.limits.maxPositionPct,
    cash: Math.max(0, (ctx.cashBase - buffer) / ctx.fxToBase),
    lot: crypto ? 0.00001 : 1,
    fractional: crypto,
    adv: avgVol > 0 ? avgVol : undefined,
    maxAdvPct: 5,
  });
  const order: Order = { ...draft, quantity: size.quantity };
  const gate = size.quantity > 0 ? riskGate(order, ctx) : riskGate({ ...order, quantity: Number.MIN_VALUE }, ctx);
  const blocks = gate.checks.filter((c) => c.status === "block");
  const warns = gate.checks.filter((c) => c.status === "warn");
  const verdict: TradePlanResult["verdict"] = size.quantity === 0 ? "not ready" : blocks.length ? "reject" : warns.length ? "ready with conditions" : "ready";
  return {
    symbol: inst.symbol,
    name: inst.name,
    currency: inst.currency,
    order,
    entry,
    stop,
    stopMethod,
    targets,
    atr: a,
    riskPerUnit,
    rewardRisk: targets.map((t) => (t - entry) / riskPerUnit),
    quantity: size.quantity,
    notional: size.notional,
    riskAmount: size.riskAmount,
    riskPct: size.riskPct,
    positionPct: size.positionPct,
    sizingBinding: size.binding,
    sizingReasons: size.reasons,
    gate,
    verdict,
    conditions: [...blocks.map((b) => `${b.code}: ${b.reason}`), ...warns.map((w) => `${w.code}: ${w.reason}`)],
    notes,
    equityBase: built.equityBase,
  };
}

/** The Trade Context block, as passed between analysis, planning and the journal. */
export function tradeContextMarkdown(p: TradePlanResult): string {
  return [
    `# Trade context — ${p.symbol}${p.name ? ` (${p.name})` : ""}`,
    "",
    `- **Verdict:** ${p.verdict}`,
    `- **Order:** buy ${p.quantity} at a limit of ${p.entry} ${p.currency} (notional ${p.notional.toFixed(2)}, ${p.positionPct.toFixed(2)} % of the portfolio) on ${p.order.venue}, account ${p.order.account}`,
    `- **Stop:** ${p.stop} — ${p.stopMethod}; risk ${p.riskPerUnit.toFixed(4)} per unit${p.riskAmount !== undefined ? `, ${p.riskAmount.toFixed(2)} in total (${p.riskPct!.toFixed(2)} % of the portfolio)` : ""}`,
    `- **Targets:** ${p.targets.map((t, i) => `${t} (${p.rewardRisk[i]!.toFixed(1)}R)`).join(", ")}`,
    `- **Sizing:** bound by ${p.sizingBinding} — ${p.sizingReasons.join("; ")}`,
    "",
    "## Risk gate",
    "",
    ...p.gate.checks.map((c) => `- ${c.status.toUpperCase()} ${c.code}: ${c.reason}`),
    "",
    ...(p.notes.length ? ["## Notes", "", ...p.notes.map((n) => `- ${n}`), ""] : []),
    "Thesis, invalidation and event risk come from the analysis: state them before creating the ticket.",
    "",
  ].join("\n");
}
