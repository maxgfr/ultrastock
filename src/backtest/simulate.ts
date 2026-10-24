// The single-instrument simulator: one position at a time, long or short,
// driven by signal arrays computed on CLOSED bars.
//
// The fills are where backtests usually lie, so each rule is stated:
//   - A signal is decided at bar i's close and filled at bar i+1's OPEN
//     (market: plus slippage, taker fee). The source filled at bar i's own
//     close — the price the signal was computed from — which no order can get.
//   - A limit entry rests for one bar at `limitOffsetPct` from the signal close,
//     fills when the next bar trades through it (at the open if the bar opens
//     beyond it), pays the maker fee and no slippage; unfilled, it is cancelled.
//   - A stop that the bar GAPS through fills at the bar's open, the worse
//     price; one touched intrabar fills at the stop less slippage (taker). The
//     source filled at the stop price even when the market opened far below it.
//   - A take-profit is a resting limit: at the target (maker), or at the open
//     when the bar opens beyond it.
//   - Stop and target both inside one bar: the stop is assumed hit first.
//   - The trailing stop for bar t trails the extreme of bars up to t−1 (the
//     source used bar t's own high, which may come after its low).
//   - Fees: market orders pay taker, limit orders maker (the source charged
//     every entry the maker fee).
// Leverage > 1 is a perpetual: a liquidation price from the margin (0.5 %
// maintenance), funding charged at each settlement inside a bar held to its
// close (long pays a positive rate, short receives it). The breaker stops new
// entries once equity is `maxDrawdownPct` under its peak, for good.
import type { ExecutionRules, RiskRules, Signals } from "./strategy.js";
import type { Bar } from "../providers/types.js";

export interface Costs {
  /** Percent numbers: 0.1 = 0.1 %. */
  makerPct: number;
  takerPct: number;
  slippagePct: number;
}

export interface FundingEvent {
  /** Settlement time, ms since the epoch. */
  time: number;
  /** Rate per settlement as a fraction (0.0001 = 0.01 %). */
  rate: number;
}

export interface SimConfig {
  capital: number;
  costs: Costs;
  leverage?: number;
  allowShort?: boolean;
  /** Liquidate at the maintenance margin (perpetuals with leverage > 1). */
  liquidation?: boolean;
  maintenanceMarginPct?: number;
  risk?: RiskRules;
  execution?: ExecutionRules;
  funding?: readonly FundingEvent[];
  /** ATR series aligned with the bars, for risk.atrStop. */
  atr?: ReadonlyArray<number | undefined>;
  /** Simulate bars [start, end) only, starting flat and closing what is open at end − 1. */
  start?: number;
  end?: number;
}

export type ExitReason = "signal" | "stop" | "atr-stop" | "trail" | "target" | "time" | "liquidation" | "end";

export interface Trade {
  side: "long" | "short";
  signalIndex: number;
  entryIndex: number;
  entryDate: string;
  entryPrice: number;
  entryOrder: "market" | "limit";
  exitIndex: number;
  exitDate: string;
  exitPrice: number;
  exitReason: ExitReason;
  qty: number;
  notional: number;
  fees: number;
  funding: number;
  slippage: number;
  /** Net of fees and funding, in money. */
  pnl: number;
  /** Net P&L over the equity committed at entry, %. */
  returnPct: number;
  /** Net P&L over the money at risk to the initial stop (undefined without a stop). */
  r?: number;
  bars: number;
  /** Worst and best excursion from the entry price while held, %. */
  maePct: number;
  mfePct: number;
}

export interface EquityPoint {
  date: string;
  equity: number;
  /** Signed exposure: notional / equity (−1 short at 1×, 0 flat). */
  exposure: number;
}

export interface SimResult {
  trades: Trade[];
  /** One point per simulated bar, at its close. */
  equity: EquityPoint[];
  /** Per-bar simple returns of the equity (first one against the starting capital). */
  returns: number[];
  start: number;
  end: number;
  fees: number;
  funding: number;
  liquidations: number;
  breakerTrippedAt?: string;
  /** Limit entries that did not fill. */
  unfilledLimits: number;
}

interface Open {
  side: 1 | -1;
  signalIndex: number;
  entryIndex: number;
  entryPrice: number;
  entryOrder: "market" | "limit";
  qty: number;
  notional: number;
  margin: number;
  fees: number;
  funding: number;
  slippage: number;
  stopLoss?: number;
  atrStop?: number;
  takeProfit?: number;
  /** Extreme reached through the previous bar (peak for a long, trough for a short). */
  extreme: number;
  low: number;
  high: number;
  initialRisk?: number;
  equityAtEntry: number;
}

type Pending = { kind: "entry"; side: 1 | -1; signalIndex: number; reference: number } | { kind: "exit"; reason: ExitReason };

const barTime = (b: Bar) => Date.parse(b.date.length === 10 ? `${b.date}T00:00:00Z` : b.date);

export function simulate(bars: readonly Bar[], signals: Signals, cfg: SimConfig): SimResult {
  const start = Math.max(0, cfg.start ?? 0);
  const end = Math.min(bars.length, cfg.end ?? bars.length);
  const L = Math.max(1, cfg.leverage ?? 1);
  const maker = cfg.costs.makerPct / 100;
  const taker = cfg.costs.takerPct / 100;
  const slip = cfg.costs.slippagePct / 100;
  const risk = cfg.risk ?? {};
  const limitEntry = cfg.execution?.entry === "limit";
  const limitOff = (cfg.execution?.limitOffsetPct ?? 0.5) / 100;
  const mm = (cfg.maintenanceMarginPct ?? 0.5) / 100;
  const funding = cfg.funding ?? [];
  const barMs = bars.length > 1 ? barTime(bars[1]!) - barTime(bars[0]!) : 86_400_000;

  let cash = cfg.capital;
  let pos: Open | undefined;
  let pending: Pending | undefined;
  let peakEquity = cfg.capital;
  let breaker = false;
  let breakerAt: string | undefined;
  let fundIdx = 0;
  let totalFees = 0;
  let totalFunding = 0;
  let liquidations = 0;
  let unfilled = 0;
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const returns: number[] = [];

  const close = (t: number, rawPrice: number, reason: ExitReason, order: "market" | "limit") => {
    const p = pos!;
    const fill = order === "market" ? rawPrice * (1 - p.side * slip) : rawPrice;
    const fee = order === "market" ? p.qty * fill * taker : p.qty * fill * maker;
    let gross = p.side * p.qty * (fill - p.entryPrice);
    let exitFee = fee;
    if (reason === "liquidation") {
      // The exchange keeps what is left of the margin: the position loses all of it.
      gross = -(p.margin - p.funding);
      exitFee = 0;
    }
    cash += gross - exitFee;
    totalFees += exitFee;
    const fees = p.fees + exitFee;
    const pnl = gross - exitFee - p.fees - p.funding;
    const bar = bars[t]!;
    trades.push({
      side: p.side === 1 ? "long" : "short",
      signalIndex: p.signalIndex,
      entryIndex: p.entryIndex,
      entryDate: bars[p.entryIndex]!.date,
      entryPrice: p.entryPrice,
      entryOrder: p.entryOrder,
      exitIndex: t,
      exitDate: bar.date,
      exitPrice: reason === "liquidation" ? rawPrice : fill,
      exitReason: reason,
      qty: p.qty,
      notional: p.notional,
      fees,
      funding: p.funding,
      slippage: p.slippage + (order === "market" ? p.qty * Math.abs(fill - rawPrice) : 0),
      pnl,
      returnPct: (pnl / p.equityAtEntry) * 100,
      r: p.initialRisk ? pnl / p.initialRisk : undefined,
      bars: t - p.entryIndex,
      maePct: (p.side === 1 ? p.low / p.entryPrice - 1 : 1 - p.high / p.entryPrice) * 100,
      mfePct: (p.side === 1 ? p.high / p.entryPrice - 1 : 1 - p.low / p.entryPrice) * 100,
    });
    if (reason === "liquidation") liquidations++;
    pos = undefined;
  };

  const open = (t: number, side: 1 | -1, signalIndex: number, reference: number, fill: number, order: "market" | "limit", rawPrice: number) => {
    const fee = order === "market" ? taker : maker;
    const stopDist: number[] = [];
    const sl = risk.stopLossPct !== undefined ? risk.stopLossPct / 100 : undefined;
    const atrV = risk.atrStop ? cfg.atr?.[signalIndex] : undefined;
    const atrDist = atrV !== undefined && risk.atrStop ? (risk.atrStop.multiplier * atrV) / reference : undefined;
    if (sl !== undefined) stopDist.push(sl);
    if (atrDist !== undefined) stopDist.push(atrDist);
    const nearest = stopDist.length ? Math.min(...stopDist) : undefined;
    // Largest position the equity can carry with its fee; risk sizing shrinks it so the stop loses riskPerTradePct.
    const maxNotional = (cash * L) / (1 + L * fee);
    const notional =
      risk.riskPerTradePct !== undefined && nearest !== undefined && nearest > 0
        ? Math.min(maxNotional, (cash * risk.riskPerTradePct) / 100 / nearest)
        : maxNotional;
    if (notional <= 0) return;
    const qty = notional / fill;
    const entryFee = notional * fee;
    cash -= entryFee;
    totalFees += entryFee;
    const stopLoss = sl !== undefined ? fill * (1 - side * sl) : undefined;
    const atrStop = atrV !== undefined && risk.atrStop ? fill - side * risk.atrStop.multiplier * atrV : undefined;
    const levels = [stopLoss, atrStop].filter((x): x is number => x !== undefined);
    const initialStop = levels.length ? (side === 1 ? Math.max(...levels) : Math.min(...levels)) : undefined;
    pos = {
      side,
      signalIndex,
      entryIndex: t,
      entryPrice: fill,
      entryOrder: order,
      qty,
      notional,
      margin: notional / L,
      fees: entryFee,
      funding: 0,
      slippage: qty * Math.abs(fill - rawPrice),
      stopLoss,
      atrStop,
      takeProfit: risk.takeProfitPct !== undefined ? fill * (1 + (side * risk.takeProfitPct) / 100) : undefined,
      extreme: fill,
      low: fill,
      high: fill,
      initialRisk: initialStop !== undefined ? qty * Math.abs(fill - initialStop) : undefined,
      equityAtEntry: cash + entryFee,
    };
  };

  /** The binding stop for the bar and which rule it is. */
  const stopLevel = (p: Open): { price: number; reason: ExitReason } | undefined => {
    const cands: Array<{ price: number; reason: ExitReason }> = [];
    if (p.stopLoss !== undefined) cands.push({ price: p.stopLoss, reason: "stop" });
    if (p.atrStop !== undefined) cands.push({ price: p.atrStop, reason: "atr-stop" });
    if (risk.trailingStopPct !== undefined) cands.push({ price: p.extreme * (1 - (p.side * risk.trailingStopPct) / 100), reason: "trail" });
    if (!cands.length) return undefined;
    return cands.reduce((a, b) => (p.side === 1 ? (b.price > a.price ? b : a) : b.price < a.price ? b : a));
  };

  const liqPrice = (p: Open) =>
    p.side === 1 ? (p.qty * p.entryPrice - p.margin + p.funding) / (p.qty * (1 - mm)) : (p.margin + p.qty * p.entryPrice - p.funding) / (p.qty * (1 + mm));

  for (let t = start; t < end; t++) {
    const bar = bars[t]!;
    const prior = pos !== undefined; // a position carried into this bar (not opened at its open)

    // 1. The order decided at the previous close, at this bar's open.
    if (pending?.kind === "exit" && pos) close(t, bar.open, pending.reason, "market");
    else if (pending?.kind === "entry" && !pos) {
      const { side, signalIndex, reference } = pending;
      if (!limitEntry) open(t, side, signalIndex, reference, bar.open * (1 + side * slip), "market", bar.open);
      else {
        const limit = reference * (1 - side * limitOff);
        const touched = side === 1 ? bar.low <= limit : bar.high >= limit;
        if (touched) {
          const fill = side === 1 ? Math.min(bar.open, limit) : Math.max(bar.open, limit);
          open(t, side, signalIndex, reference, fill, "limit", fill);
        } else unfilled++;
      }
    }
    pending = undefined;

    // 2. Intrabar: liquidation, stops, target — gaps first, then the bar's range, stop before target.
    if (pos) {
      const p = pos;
      const s = stopLevel(p);
      const liq = cfg.liquidation && L > 1 ? liqPrice(p) : undefined;
      const beyond = (price: number, level: number) => (p.side === 1 ? price <= level : price >= level);
      const reached = (level: number) => (p.side === 1 ? bar.low <= level : bar.high >= level);
      const tpReached = (level: number) => (p.side === 1 ? bar.high >= level : bar.low <= level);
      if (prior && liq !== undefined && beyond(bar.open, liq)) close(t, bar.open, "liquidation", "market");
      else if (prior && s && beyond(bar.open, s.price)) close(t, bar.open, s.reason, "market");
      else if (prior && p.takeProfit !== undefined && tpReached(p.takeProfit) && (p.side === 1 ? bar.open >= p.takeProfit : bar.open <= p.takeProfit))
        close(t, bar.open, "target", "limit");
      else if (liq !== undefined && reached(liq) && (!s || beyond(s.price, liq))) close(t, liq, "liquidation", "market");
      else if (s && reached(s.price)) close(t, s.price, s.reason, "market");
      else if (p.takeProfit !== undefined && tpReached(p.takeProfit)) close(t, p.takeProfit, "target", "limit");
    }

    // 3. Track the excursions; funding at each settlement inside the bar while held to its close.
    if (pos) {
      pos.low = Math.min(pos.low, bar.low);
      pos.high = Math.max(pos.high, bar.high);
      pos.extreme = pos.side === 1 ? Math.max(pos.extreme, bar.high) : Math.min(pos.extreme, bar.low);
    }
    const t0 = barTime(bar);
    while (fundIdx < funding.length && funding[fundIdx]!.time < t0) fundIdx++;
    while (fundIdx < funding.length && funding[fundIdx]!.time < t0 + barMs) {
      if (pos) {
        const pay = pos.side * funding[fundIdx]!.rate * pos.qty * bar.close;
        pos.funding += pay;
        cash -= pay;
        totalFunding += pay;
      }
      fundIdx++;
    }

    // 4. The last bar closes whatever is open.
    if (t === end - 1 && pos) close(t, bar.close, "end", "market");

    // 5. Mark to market, breaker.
    const eq = pos ? cash + pos.side * pos.qty * (bar.close - pos.entryPrice) : cash;
    const prev = equity.length ? equity[equity.length - 1]!.equity : cfg.capital;
    equity.push({ date: bar.date, equity: eq, exposure: pos && eq > 0 ? (pos.side * pos.qty * bar.close) / eq : 0 });
    returns.push(prev > 0 ? eq / prev - 1 : 0);
    peakEquity = Math.max(peakEquity, eq);
    if (!breaker && risk.maxDrawdownPct !== undefined && peakEquity > 0 && (peakEquity - eq) / peakEquity >= risk.maxDrawdownPct / 100) {
      breaker = true;
      breakerAt = bar.date;
    }

    // 6. Signals at this close, acted on at the next open (none on the last bar).
    if (t >= end - 1) continue;
    if (pos) {
      const held = t - pos.entryIndex + 1;
      if (pos.side === 1 && signals.sell[t]) pending = { kind: "exit", reason: "signal" };
      else if (pos.side === -1 && signals.cover[t]) pending = { kind: "exit", reason: "signal" };
      else if (risk.timeStopBars !== undefined && held >= risk.timeStopBars) pending = { kind: "exit", reason: "time" };
    } else if (!breaker && eq > 0) {
      if (signals.buy[t]) pending = { kind: "entry", side: 1, signalIndex: t, reference: bar.close };
      else if (cfg.allowShort && signals.short[t]) pending = { kind: "entry", side: -1, signalIndex: t, reference: bar.close };
    }
  }
  return { trades, equity, returns, start, end, fees: totalFees, funding: totalFunding, liquidations, breakerTrippedAt: breakerAt, unfilledLimits: unfilled };
}
