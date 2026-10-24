// `portfolio rebalance`, `location`, `lookthrough` and `income`: what the
// book's own lines say once the targets, the envelopes, the funds' holdings
// and the dividends are read against them.
import { rebalance } from "../../analytics/portfolio.js";
import type { Dataset } from "../../core/datasets.js";
import type { EnvelopeType } from "../../core/profile.js";
import { mapLimit } from "../../engine.js";
import { nasdaqDividends } from "../../providers/fundamentals/nasdaq-analyst.js";
import { amundiHoldings, amundiPeaFlag } from "../../providers/funds/amundi.js";
import { compositionDataset, type FundComposition } from "../../providers/funds/common.js";
import { ISHARES_PRODUCTS, isharesHoldings } from "../../providers/funds/ishares.js";
import { nportHoldings } from "../../providers/funds/nport.js";
import { resolveYahoo, yahooChart } from "../../providers/markets/yahoo.js";
import { getQuote, resolveSymbol } from "../../providers/router.js";
import { envelopeOf, type Holding, type MarkedBook, referenceRates } from "./book.js";
import type { Findings } from "./findings.js";
import { incomeFigures, ledgerDividends, trailingPerShare } from "./income.js";
import { bestEnvelope, LOCATION_RULES, PEA_CEILING, peaDeposits } from "./location.js";
import { orderFor, sellTaxNote } from "./rebalance.js";

const DAY = 86_400_000;
const pct = (x: number) => Number((x * 100).toFixed(6));
const money = (x: number) => Number(x.toFixed(2));

// ─── rebalance ─────────────────────────────────────────────────────────────

export interface RebalanceOptions {
  targets: Record<string, number>;
  bandPct?: number;
  relBand?: number;
  contribution?: number;
}

/** Everything `portfolio rebalance` registers: drifts, the band rule's amounts, and orders in units with fees. */
export async function rebalanceAnalysis(m: MarkedBook, f: Findings, o: RebalanceOptions) {
  const P = `PORTFOLIO.${m.bookName}.rebalance`;
  const band = o.bandPct ?? 5;
  const rel = o.relBand ?? 0.25;
  const targets: Record<string, number> = {};
  const unknown: string[] = [];
  // New symbols in the targets are resolved and quoted like the holdings.
  const fresh = Object.keys(o.targets).filter((s) => s !== "CASH" && !m.holdings.some((h) => h.symbol === s));
  const quoted = await mapLimit(fresh, 4, async (s) => {
    try {
      const r = await resolveSymbol(s);
      return { r, q: await getQuote(r, m.now) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  const extra: Holding[] = [];
  fresh.forEach((s, i) => {
    const x = quoted[i]!;
    if (!x.r || !x.q) {
      unknown.push(s);
      f.note(`target ${s} left out: ${x.error}`);
      return;
    }
    const key = `${x.r.instrument.symbol}.quote.price`;
    f.input({
      kind: "quote",
      title: `${s} quote`,
      subject: s,
      points: [{ key, label: `${s} latest price`, value: x.q.price, unit: x.q.instrument.currency }],
      provenance: { ...x.q.provenance, asOf: x.q.at.slice(0, 10) },
      notes: x.q.notes,
    });
    extra.push({
      symbol: s,
      currency: x.q.instrument.currency,
      quantity: 0,
      averageCost: 0,
      accounts: [],
      resolved: x.r,
      instrument: x.r.instrument,
      assetClass: x.r.instrument.kind === "index" ? "index" : x.r.instrument.kind,
      isin: x.r.instrument.isin,
      price: x.q.price,
      keys: { quantity: key, price: key },
    });
  });
  const missingCcy = extra.map((h) => h.currency).filter((c) => m.rates[c] === undefined);
  if (missingCcy.length) {
    const fx = await referenceRates(missingCcy, m.base);
    if (fx.dataset) f.input(fx.dataset);
    Object.assign(m.rates, fx.rates);
    Object.assign(m.keys.fx, fx.keys);
  }
  for (const [k, v] of Object.entries(o.targets)) if (!unknown.includes(k)) targets[k] = v;
  const all = [...m.holdings.filter((h) => h.valueBase !== undefined), ...extra];
  const holdings: Record<string, number> = Object.fromEntries(all.map((h) => [h.symbol, h.valueBase ?? 0]));
  if ("CASH" in targets) holdings.CASH = m.cashBase;
  else if (m.cashBase > 0)
    f.note(
      `the ${money(m.cashBase)} ${m.base} of cash is not in the targets, so it is left aside — add "CASH" to the targets, or pass --contribution to invest some`,
    );
  const notTargeted = all.filter((h) => !(h.symbol in targets) && h.valueBase);
  if (notTargeted.length) f.note(`not in the targets, so their target is 0 % (sold if out of band): ${notTargeted.map((h) => h.symbol).join(", ")}`);
  const res = rebalance(holdings, targets, { bandPct: band, relBand: rel, contribution: o.contribution });
  const base = [m.keys.total, ...all.map((h) => h.keys.value ?? h.keys.price).filter((k): k is string => !!k)];
  if (o.contribution) f.note(`a contribution of ${o.contribution} ${m.base} is added to the total and steered to the underweights first`);
  for (const d of res.drift)
    f.derive(
      "drift from target",
      `${P}.${d.asset}.drift`,
      `${d.asset} drift from target (points)`,
      Number(d.drift.toFixed(4)),
      "points",
      base,
      "current weight − target weight, both in % of (holdings in the targets + contribution)",
    );
  const orders: Array<ReturnType<typeof orderFor> & { account?: string; tax?: string }> = [];
  for (const t of res.trades) {
    const k = f.derive(
      "band rule",
      `${P}.${t.asset}.amount`,
      t.asset === "CASH"
        ? `cash ${t.amount >= 0 ? "set aside" : "spent"} to reach the targets (${m.base})`
        : `${t.asset} amount to ${t.amount >= 0 ? "buy" : "sell"} (${m.base})`,
      money(t.amount),
      m.base,
      [...base, `${P}.${t.asset}.drift`],
      `back to target when |drift| > ${band} points or |drift| ÷ target > ${rel * 100} %; new money to the underweights first`,
    );
    if (t.asset === "CASH" || !k) continue;
    const h = all.find((x) => x.symbol === t.asset);
    if (!h?.price || m.rates[h.currency] === undefined) {
      f.note(`${t.asset}: no price or rate — no order computed`);
      continue;
    }
    const main = [...h.accounts].sort((a, b) => b.quantity - a.quantity)[0];
    const order = orderFor({
      symbol: h.symbol,
      amountBase: t.amount,
      price: h.price,
      rate: m.rates[h.currency]!,
      currency: h.currency,
      market: h.instrument?.market ?? "europe",
      held: main?.quantity ?? 0,
      averageCost: main?.averageCost,
    });
    if (!order) {
      f.note(`${t.asset}: ${money(t.amount)} ${m.base} is less than one share — no order`);
      continue;
    }
    const from = [k, h.keys.price!, ...(m.keys.fx[h.currency] ? [m.keys.fx[h.currency]!] : [])];
    const sec = `orders (never placed): ${order.side} ${h.symbol}`;
    f.derive(sec, `${P}.${h.symbol}.side`, `${h.symbol} order side`, order.side, undefined, from, "sign of the amount");
    f.derive(
      sec,
      `${P}.${h.symbol}.units`,
      `${h.symbol} units to ${order.side}`,
      order.units,
      "units",
      from,
      `amount ÷ (price × rate), ${h.instrument?.market === "crypto" ? "to 1e-6 unit" : "rounded down to whole shares"}${order.reasons.length ? `; ${order.reasons.join("; ")}` : ""}`,
    );
    f.derive(
      sec,
      `${P}.${h.symbol}.notional`,
      `${h.symbol} order notional (${m.base})`,
      money(order.notionalBase),
      m.base,
      [`${P}.${h.symbol}.units`, ...from],
      "units × price × rate",
    );
    f.derive(
      sec,
      `${P}.${h.symbol}.fee`,
      `${h.symbol} estimated fee (${m.base})`,
      money(order.feeBase),
      m.base,
      [`${P}.${h.symbol}.units`, ...from],
      `paper fee model for the ${h.instrument?.market ?? "?"} market (src/trading/paper.ts feeFor) × rate`,
    );
    const env = main?.envelope ?? "unknown";
    let tax: string | undefined;
    if (order.side === "sell") {
      tax = sellTaxNote(env);
      if (order.realisedPmp !== undefined)
        f.derive(
          sec,
          `${P}.${h.symbol}.realisedPmp`,
          `${h.symbol} gain realised by the sell, average-cost rule (${h.currency})`,
          money(order.realisedPmp),
          h.currency,
          [`${P}.${h.symbol}.units`, h.keys.price!, `PORTFOLIO.${m.bookName}.${h.symbol}.averageCost`],
          "units × price − fee − units × PMP",
        );
      f.derive(
        sec,
        `${P}.${h.symbol}.tax`,
        `${h.symbol} tax treatment of the sell (${main?.account ?? "?"}, ${env})`,
        tax,
        undefined,
        [`${P}.${h.symbol}.units`],
        "the envelope's rule — no tax amount is computed (the tax engine is to come)",
      );
    }
    const account = main?.account;
    f.derive(
      sec,
      `${P}.${h.symbol}.account`,
      `${h.symbol} account for the order`,
      account ?? "to choose",
      undefined,
      [h.keys.quantity],
      account ? "the account holding the most units" : "not held yet: choose the envelope (see `portfolio location`)",
    );
    if (!main) f.note(`${h.symbol} is not held: choose the envelope for the buy (see \`portfolio location\`)`);
    orders.push({ ...order, account, tax });
  }
  f.note("nothing is ordered: each line is a proposal to check with `plan` and the risk gate");
  return { trades: res.trades, drift: res.drift, orders };
}

// ─── location ──────────────────────────────────────────────────────────────

/** Everything `portfolio location` registers. */
export async function locationAnalysis(m: MarkedBook, f: Findings) {
  const P = `PORTFOLIO.${m.bookName}.location`;
  if (m.profile.jurisdiction !== "FR")
    f.note(`the location rules are written for a French resident; the profile says ${m.profile.jurisdiction} — read them as such`);
  const accounts = [...new Set(m.txs.map((t) => t.account))];
  const envOf = (a: string) => envelopeOf(m.profile, a);
  const available = new Set<EnvelopeType>([
    ...m.profile.envelopes.map((e) => e.type),
    ...accounts.map(envOf).filter((e): e is EnvelopeType => e !== "unknown"),
  ]);
  const inferred = accounts.filter((a) => !m.profile.envelopes.some((e) => e.id === a));
  if (inferred.length)
    f.note(`envelope types read from the account ids (not declared in the profile): ${inferred.map((a) => `${a} → ${envOf(a)}`).join(", ")}`);
  const peaAccounts = new Set(accounts.filter((a) => envOf(a) === "PEA"));
  const depositPoints = [...peaAccounts].map((a) => ({
    key: `PORTFOLIO.${m.bookName}.${a}.deposits`,
    label: `deposits into ${a} (PEA)`,
    value: money(peaDeposits(m.txs, new Set([a]))),
    unit: "EUR",
  }));
  let room = 0;
  if (peaAccounts.size) {
    f.input({
      kind: "ledger",
      title: "deposits into the PEA (ledger)",
      subject: `portfolio:${m.bookName}`,
      points: depositPoints,
      provenance: { source: "ultrastock-ledger", fetchedAt: m.now.toISOString(), official: false, asOf: m.now.toISOString().slice(0, 10) },
      notes: [],
    });
    const deposited = depositPoints.reduce((s, p) => s + p.value, 0);
    room = PEA_CEILING - deposited;
    f.derive(
      "PEA",
      `${P}.pea.room`,
      "room left under the PEA deposit ceiling",
      money(room),
      "EUR",
      depositPoints.map((p) => p.key),
      `${PEA_CEILING} € ceiling − Σ deposits into the PEA (withdrawals do not give room back)`,
    );
  } else f.note("no PEA among the accounts or the profile's envelopes: a PEA would shelter the EU shares and PEA-eligible funds");

  // The issuer's PEA flag for funds (Amundi answers for its own; others: unknown).
  const funds = m.holdings.filter((h) => (h.assetClass === "etf" || h.assetClass === "fund") && h.isin && !h.isin.startsWith("US")).slice(0, 10);
  const flags = await mapLimit(funds, 2, async (h) => amundiPeaFlag(h.isin!).catch(() => undefined));
  const peaFlag = new Map<string, { flag?: boolean; key: string }>();
  funds.forEach((h, i) => {
    const r = flags[i];
    if (!r || r.pea === undefined) return;
    const key = `${h.isin}.issuer.pea`;
    f.input({
      kind: "fund",
      title: `${h.symbol} PEA eligibility per the issuer`,
      subject: h.symbol,
      points: [{ key, label: `${h.symbol} PEA-eligible per Amundi (FUND_PEA)`, value: r.pea }],
      provenance: { source: "amundi", url: r.url, fetchedAt: r.fetchedAt, official: false, asOf: r.fetchedAt.slice(0, 10) },
      notes: [],
    });
    peaFlag.set(h.symbol, { flag: r.pea, key });
  });

  const out: Array<{ symbol: string; rule: string; ideal: string; best?: string; current: string[]; worse: string[]; reason: string }> = [];
  for (const h of m.holdings) {
    const envs = h.accounts.map((a) => a.envelope);
    const r = bestEnvelope(
      { symbol: h.symbol, assetClass: h.assetClass, market: h.instrument?.market, isin: h.isin, peaFlag: peaFlag.get(h.symbol)?.flag, envelopes: envs },
      available,
      peaAccounts.size ? room : 0,
    );
    const from = [
      h.keys.quantity,
      ...(h.isin ? [`${h.symbol}.instrument.isin`] : []),
      `${h.symbol}.instrument.kind`,
      ...(peaFlag.get(h.symbol) ? [peaFlag.get(h.symbol)!.key] : []),
      ...(peaAccounts.size ? [`${P}.pea.room`] : []),
    ];
    const sec = `${h.symbol}`;
    f.derive(
      sec,
      `${P}.${h.symbol}.rule`,
      `${h.symbol} location rule`,
      r.rule.id,
      undefined,
      from,
      `${r.rule.applies}; sources: ${r.rule.sources.map((s) => s.url).join(", ")}`,
    );
    f.derive(sec, `${P}.${h.symbol}.ideal`, `${h.symbol} ideal envelope (French resident)`, r.ideal, undefined, from, r.reason);
    if (r.best) f.derive(sec, `${P}.${h.symbol}.best`, `${h.symbol} best envelope among those held`, r.best, undefined, from, r.reason);
    f.derive(
      sec,
      `${P}.${h.symbol}.current`,
      `${h.symbol} envelope(s) holding it`,
      h.accounts.map((a) => `${a.account}:${a.envelope}`).join(", "),
      undefined,
      [h.keys.quantity],
      "the ledger accounts with an open position",
    );
    f.derive(sec, `${P}.${h.symbol}.misplaced`, `${h.symbol} sits in a worse envelope than one available`, r.worse.length > 0, undefined, from, r.reason);
    out.push({ symbol: h.symbol, rule: r.rule.id, ideal: r.ideal, best: r.best, current: envs, worse: r.worse, reason: r.reason });
  }
  f.note(
    "PEA eligibility is a first pass (ISIN country prefix for shares, the issuer's flag for funds) — confirm with the broker before moving anything; a move between envelopes is a sale and a purchase",
  );
  return { rules: LOCATION_RULES, peaRoom: peaAccounts.size ? room : undefined, holdings: out };
}

// ─── lookthrough ───────────────────────────────────────────────────────────

/** At most this many funds are looked through per run. */
export const LOOKTHROUGH_MAX_FUNDS = 10;

/** The issuer/regulator source for a fund: iShares table → Amundi (EU ISINs) → SEC N-PORT (US listings). */
async function compositionOf(h: Holding): Promise<FundComposition> {
  const isin = h.isin?.toUpperCase();
  const tried: string[] = [];
  if (isin && ISHARES_PRODUCTS[isin]) return isharesHoldings(isin);
  if (isin && /^(LU|FR|IE)/.test(isin))
    try {
      return await amundiHoldings(isin);
    } catch (e) {
      tried.push((e as Error).message);
    }
  if (h.instrument?.market === "us")
    try {
      return await nportHoldings(h.instrument.symbol);
    } catch (e) {
      tried.push((e as Error).message);
    }
  throw new Error(tried.length ? tried.join("; ") : `no keyless holdings source covers ${isin ?? h.symbol} (iShares table, Amundi, SEC N-PORT)`);
}

/** Everything `portfolio lookthrough` registers. */
export async function lookthroughAnalysis(m: MarkedBook, f: Findings) {
  const P = `PORTFOLIO.${m.bookName}.lookthrough`;
  const funds = m.holdings.filter((h) => h.assetClass === "etf" || h.assetClass === "fund");
  if (!funds.length) {
    f.note("no ETF or fund in the book: nothing to look through");
    return { funds: [] as Array<{ symbol: string; source?: string; synthetic?: boolean; unavailable?: string }> };
  }
  const shown = funds.slice(0, LOOKTHROUGH_MAX_FUNDS);
  if (funds.length > shown.length) f.note(`only the first ${LOOKTHROUGH_MAX_FUNDS} funds are looked through`);
  const comps = await mapLimit(shown, 2, async (h) => compositionOf(h).catch((e: Error) => e));
  const out: Array<{ symbol: string; source?: string; synthetic?: boolean; unavailable?: string }> = [];
  shown.forEach((h, i) => {
    const c = comps[i]!;
    if (c instanceof Error) {
      f.note(`${h.symbol}: look-through unavailable — ${c.message}`);
      out.push({ symbol: h.symbol, unavailable: c.message });
      return;
    }
    const ds: Dataset = compositionDataset(h.symbol, c);
    f.input(ds);
    out.push({ symbol: h.symbol, source: c.source, synthetic: c.synthetic });
    if (c.synthetic) {
      f.note(`${h.symbol}: synthetic replication — the issuer's lines are a substitute basket; the exposure is the index`);
      return;
    }
    if (!h.keys.weight) return;
    for (let k = 1; k <= 10; k++) {
      const wk = `${h.symbol}.lt.holding.${k}.weight`;
      const p = ds.points.find((x) => x.key === wk);
      if (!p || typeof p.value !== "number") break;
      f.derive(
        `${h.symbol} — top holdings, share of the portfolio`,
        `${P}.${h.symbol}.holding.${k}`,
        `${h.symbol} holding #${k} as a share of the whole portfolio`,
        Number(((p.value * h.weightPct!) / 100).toFixed(6)),
        "%",
        [wk, `${h.symbol}.lt.holding.${k}.name`, h.keys.weight],
        "weight in the fund × the fund's weight in the portfolio",
      );
    }
    for (const field of ["sector", "country"] as const)
      for (let k = 1; k <= 10; k++) {
        const wk = `${h.symbol}.lt.${field}.${k}.weight`;
        const p = ds.points.find((x) => x.key === wk);
        if (!p || typeof p.value !== "number") break;
        f.derive(
          `${h.symbol} — ${field} breakdown, share of the portfolio`,
          `${P}.${h.symbol}.${field}.${k}`,
          `${h.symbol} ${field} #${k} as a share of the whole portfolio`,
          Number(((p.value * h.weightPct!) / 100).toFixed(6)),
          "%",
          [wk, `${h.symbol}.lt.${field}.${k}.name`, h.keys.weight],
          `weight of the ${field} in the fund × the fund's weight in the portfolio`,
        );
      }
  });
  f.note("security, sector and country names are the issuer's text (fenced as external); fund holdings are as of the date the issuer or the filing states");
  return { funds: out };
}

// ─── income ────────────────────────────────────────────────────────────────

/** Everything `portfolio income` registers. */
export async function incomeAnalysis(m: MarkedBook, f: Findings) {
  const P = `PORTFOLIO.${m.bookName}.income`;
  const day = m.now.toISOString().slice(0, 10);
  const led = ledgerDividends(m.txs, day);
  const ledPoints = [...led.entries()].flatMap(([sym, e]) => [
    {
      key: `PORTFOLIO.${m.bookName}.${sym}.dividends.total`,
      label: `${sym} dividends recorded in the ledger (all time)`,
      value: money(e.total),
      unit: e.currency,
    },
    {
      key: `PORTFOLIO.${m.bookName}.${sym}.dividends.last12m`,
      label: `${sym} dividends recorded in the last 12 months`,
      value: money(e.last12m),
      unit: e.currency,
      formula: `${e.count12m} payments with a date after ${new Date(Date.parse(`${day}T00:00:00Z`) - 365 * DAY).toISOString().slice(0, 10)}`,
    },
  ]);
  if (ledPoints.length)
    f.input({
      kind: "ledger",
      title: `${m.bookName} book — dividends received`,
      subject: `portfolio:${m.bookName}`,
      points: ledPoints,
      provenance: { source: "ultrastock-ledger", fetchedAt: m.now.toISOString(), official: false, asOf: day },
      notes: [],
    });
  else f.note("no dividend recorded in the ledger (`portfolio add dividend` records one)");
  for (const [sym, e] of led) {
    const rate = m.rates[e.currency];
    const k = `PORTFOLIO.${m.bookName}.${sym}.dividends.total`;
    if (rate !== undefined)
      f.derive(
        "received (ledger)",
        `${P}.${sym}.received`,
        `${sym} dividends received, in ${m.base} at today's rate`,
        money(e.total * rate),
        m.base,
        [k, ...(m.keys.fx[e.currency] ? [m.keys.fx[e.currency]!] : [])],
        "Σ ledger dividends × today's rate",
      );
  }

  // Per-share rates: Nasdaq (US shares) else Yahoo's last 12 months of dividends.
  const hs = m.holdings.filter((h) => h.resolved && h.valueBase !== undefined && h.assetClass !== "crypto").slice(0, 30);
  if (m.holdings.some((h) => h.assetClass === "crypto")) f.note("crypto pays no dividend; staking rewards are not covered");
  const rates = await mapLimit(hs, 3, async (h) => {
    const notes: string[] = [];
    if (h.instrument?.market === "us" && h.assetClass === "equity")
      try {
        const ds = await nasdaqDividends(h.instrument.symbol);
        const p = ds.points.find((x) => x.key.endsWith(".div.annual"));
        if (p && typeof p.value === "number") return { ds, rateKey: p.key, rate: p.value, how: "Nasdaq's annualised dividend (indicated)" };
        notes.push("Nasdaq lists no annualised dividend");
      } catch (e) {
        notes.push((e as Error).message);
      }
    try {
      const y = await yahooChart(await resolveYahoo(h.instrument!.symbol), new Date(m.now.getTime() - 372 * DAY), m.now);
      const divs = y.chart.dividends;
      const t = trailingPerShare(divs, day);
      if (!y.actions.points.some((p) => p.key.includes(".action.dividend.")))
        return { notes: [...notes, "Yahoo lists no dividend in the last 12 months"], none: y.actions };
      return {
        ds: y.actions,
        rateKeys: y.actions.points.filter((p) => p.key.includes(".action.dividend.")).map((p) => p.key),
        rate: t.sum,
        how: `Σ of the ${t.count} per-share dividends with an ex-date in the last 12 months (Yahoo)`,
      };
    } catch (e) {
      return { notes: [...notes, (e as Error).message] };
    }
  });
  let forwardTotal = 0;
  let costTotal = 0;
  const forwardKeys: string[] = [];
  const out: Array<{ symbol: string; rate?: number; forwardBase?: number; yieldOnCostPct?: number; source?: string }> = [];
  hs.forEach((h, i) => {
    const r = rates[i]!;
    const fx = m.rates[h.currency];
    if (!("rate" in r) || r.rate === undefined || fx === undefined) {
      const l12 = led.get(h.symbol);
      if (l12 && l12.last12m > 0 && m.rates[l12.currency] !== undefined) {
        const v = l12.last12m * m.rates[l12.currency]!;
        const k = f.derive(
          "forward 12 months (estimate)",
          `${P}.${h.symbol}.forward`,
          `${h.symbol} forward 12-month income estimate (${m.base}) — last 12 months' ledger dividends`,
          money(v),
          m.base,
          [`PORTFOLIO.${m.bookName}.${h.symbol}.dividends.last12m`],
          "the ledger's last 12 months of dividends repeated",
        );
        if (k) forwardKeys.push(k);
        forwardTotal += v;
        costTotal += h.averageCost * h.quantity * (fx ?? 0);
        out.push({ symbol: h.symbol, forwardBase: v, source: "ledger" });
      } else {
        f.note(`${h.symbol}: forward income unavailable (${"notes" in r && r.notes ? r.notes.join("; ") : "no rate"})`);
        out.push({ symbol: h.symbol });
      }
      return;
    }
    f.input(r.ds!);
    const rateFrom = "rateKey" in r && r.rateKey ? [r.rateKey] : (r.rateKeys ?? []);
    const rateKey = f.derive(
      `${h.symbol}`,
      `${P}.${h.symbol}.rate`,
      `${h.symbol} dividend per share, next 12 months (estimate, ${h.currency})`,
      Number(r.rate.toFixed(6)),
      h.currency,
      rateFrom,
      r.how,
    );
    if (!rateKey) return;
    const fig = incomeFigures(h.quantity, r.rate, h.averageCost, h.price);
    const fwdBase = fig.forward * fx;
    const fk = f.derive(
      `${h.symbol}`,
      `${P}.${h.symbol}.forward`,
      `${h.symbol} forward 12-month income estimate (${m.base})`,
      money(fwdBase),
      m.base,
      [rateKey, h.keys.quantity, ...(h.keys.fx ? [h.keys.fx] : [])],
      "units × per-share rate × rate to base",
    );
    if (fk) forwardKeys.push(fk);
    f.derive(
      `${h.symbol}`,
      `${P}.${h.symbol}.yieldOnCost`,
      `${h.symbol} yield on cost`,
      pct(fig.yieldOnCost),
      "%",
      [rateKey, `PORTFOLIO.${m.bookName}.${h.symbol}.averageCost`],
      "per-share rate ÷ average cost (PMP) × 100",
    );
    f.derive(
      `${h.symbol}`,
      `${P}.${h.symbol}.currentYield`,
      `${h.symbol} current yield`,
      pct(fig.currentYield),
      "%",
      [rateKey, h.keys.price!],
      "per-share rate ÷ latest price × 100",
    );
    forwardTotal += fwdBase;
    costTotal += h.averageCost * h.quantity * fx;
    out.push({ symbol: h.symbol, rate: r.rate, forwardBase: fwdBase, yieldOnCostPct: fig.yieldOnCost * 100, source: r.ds!.provenance.source });
  });
  if (forwardKeys.length) {
    const kt = f.derive(
      "portfolio",
      `${P}.forward`,
      `forward 12-month income estimate (${m.base})`,
      money(forwardTotal),
      m.base,
      forwardKeys,
      "Σ of the holdings' estimates",
    );
    if (kt) {
      f.derive(
        "portfolio",
        `${P}.yield`,
        "forward income ÷ portfolio total",
        pct(forwardTotal / m.totalBase),
        "%",
        [kt, m.keys.total],
        "forward income ÷ total × 100 (cash included)",
      );
      if (costTotal > 0)
        f.derive(
          "portfolio",
          `${P}.yieldOnCost`,
          "forward income ÷ cost of the lines with an estimate",
          pct(forwardTotal / costTotal),
          "%",
          [kt, ...hs.map((h) => `PORTFOLIO.${m.bookName}.${h.symbol}.averageCost`)],
          "forward income ÷ Σ units × PMP × today's rate × 100",
        );
    }
  }
  f.note(
    "forward figures repeat the last year's or the indicated rate: dividends get cut, raised and skipped; amounts before withholding and tax; accumulating funds pay none",
  );
  return { holdings: out, forwardBase: forwardTotal };
}
