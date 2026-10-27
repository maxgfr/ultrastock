// `valuation <symbol>`: what the business is, what it earns, and what the price
// assumes — from filings first. Every input and every output is an [E#]:
// statements (SEC XBRL or ESEF, gaps filled by crible), the price, the
// risk-free rate and the beta; then quality, the three accounting scores,
// multiples, a three-scenario DCF, the growth the price implies, and the
// margin of safety. Assumptions (equity risk premium, terminal growth,
// scenario weights) are parameters, printed, never hidden.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { annualizedVol } from "../analytics/indicators.js";
import { relativeTo, simpleReturns } from "../analytics/performance.js";
import { altmanZ, beneishM, capm, dcf, multiples, piotroski, qualityMetrics, reverseDcf, type Score, scenarioValue } from "../analytics/fundamentals.js";
import { fillGaps, growthOf, periodsFromCrible, periodsFromFilingEvidence, type SourcedPeriod } from "../analytics/statements.js";
import { registerDatasets } from "../core/datasets.js";
import { EvidenceStore, formatEvidence } from "../core/evidence.js";
import { clockNow } from "../core/net.js";
import { writeArtifact } from "../engine.js";
import { cribleCompany } from "../providers/external/crible.js";
import { esefFundamentals } from "../providers/fundamentals/esef.js";
import { secFundamentals } from "../providers/fundamentals/sec.js";
import { ecbYieldCurve } from "../providers/macro/ecb.js";
import { treasuryCurve } from "../providers/macro/treasury.js";
import { referenceRates } from "./portfolio/book.js";
import { getHistory, getQuote, resolveSymbol } from "../providers/router.js";

export interface ValuationOptions {
  /** Equity risk premium for CAPM (default 5 %). */
  erp?: number;
  terminalGrowth?: number;
  /** Explicit DCF years (default 5). */
  years?: number;
  now?: Date;
  /**
   * An already-open register to write into (the caller saves nothing itself):
   * several valuations then run one after the other on one run without a
   * last-writer-wins on evidence.json. Default: open the register at `dir`.
   */
  store?: EvidenceStore;
  /** Where the write-up goes, relative to `dir` (default VALUATION.md). */
  artifact?: string;
}

export interface ValuationResult {
  dir: string;
  symbol: string;
  currency: string;
  evidence: number;
  piotroski?: number;
  altman?: string;
  beneish?: string;
  fairValue?: number;
  marginOfSafety?: number;
  impliedGrowth?: number;
  notes: string[];
}

const clip = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The currency a crible period reports in (`reporting_currency`), when crible knows it. */
export function reportingCurrencyOf(period: Record<string, unknown>): string | undefined {
  const r = period.reporting_currency;
  return typeof r === "string" && /^[A-Z]{3}$/.test(r.trim().toUpperCase()) ? r.trim().toUpperCase() : undefined;
}

export async function valuationRun(raw: string, dir: string, opts: ValuationOptions = {}): Promise<ValuationResult> {
  const now = opts.now ?? clockNow();
  const notes: string[] = [];
  const resolved = await resolveSymbol(raw);
  const inst = resolved.instrument;
  const sym = inst.symbol;
  const quoteCcy = inst.currency;
  /** The currency every per-share figure is computed in: the statements' (crible's reporting currency), else the quote's. */
  let ccy = quoteCcy;
  const store = opts.store ?? EvidenceStore.open(dir, { subject: sym, createdAt: now.toISOString() });
  const reg = (ds: Parameters<typeof registerDatasets>[1]) => registerDatasets(store, ds);

  // Price.
  const q = await getQuote(resolved, now);
  let priceId = store.add({ key: `${sym}.quote.price`, label: `${sym} latest price`, value: q.price, unit: quoteCcy, ...q.provenance, asOf: q.at });
  let price = q.price;
  store.save();

  // Statements: the filing, then crible to fill gaps.
  let periods: SourcedPeriod[] = [];
  try {
    const ds =
      inst.market === "us"
        ? await secFundamentals(sym, { years: 5, quarters: 0 })
        : inst.isin
          ? await esefFundamentals(inst.isin, { subject: sym })
          : undefined;
    if (ds) {
      reg([ds]);
      periods = periodsFromFilingEvidence(store.items, sym);
    } else notes.push("no official filing source for this listing: statements come from crible");
  } catch (e) {
    notes.push(`filings unavailable (${(e as Error).message})`);
  }
  let rows: Array<Record<string, unknown>> = [];
  try {
    const c = await cribleCompany(sym);
    rows = Array.isArray(c?.periods) ? (c!.periods as Array<Record<string, unknown>>) : [];
  } catch (e) {
    notes.push(`crible unavailable (${(e as Error).message})`);
  }
  if (rows.length && !periods.length) {
    // Statements from crible alone: in its reporting currency, which may not be the quote's (a Hong Kong
    // line reporting in CNY). Outside the crible try: a missing rate fails the valuation, it never
    // compares a CNY value with an HKD price.
    const rep = reportingCurrencyOf(rows[0]!);
    if (!rep) {
      if (inst.market === "world")
        notes.push(
          `crible gives no reporting currency for ${sym}'s statements: they are taken to be in ${quoteCcy}, the quote's — check the annual report before using the DCF`,
        );
    } else if (rep !== quoteCcy) {
      const fx = await referenceRates([quoteCcy, rep], "EUR");
      const perEur = (c: string) => (c === "EUR" ? 1 : fx.rates[c] ? 1 / fx.rates[c]! : undefined);
      const [a, b] = [perEur(quoteCcy), perEur(rep)];
      if (a === undefined || b === undefined)
        throw new Error(`${sym}: statements in ${rep}, price in ${quoteCcy}, and no ${quoteCcy}/${rep} rate to compare them — not valued`);
      const fxIds = registerDatasets(store, fx.datasets).flatMap((r) =>
        r.items.filter((i) => [quoteCcy, rep].some((c) => i.key === `EUR.fx.${c}`)).map((i) => i.id),
      );
      price = Number(((q.price * b) / a).toPrecision(10));
      priceId = store.addDerived(
        `${sym}.quote.price.${rep}`,
        `${sym} latest price converted to ${rep}, the statements' currency`,
        price,
        rep,
        [priceId, ...fxIds],
        `price (${quoteCcy}) × (${rep} per EUR) / (${quoteCcy} per EUR)`,
      );
      ccy = rep;
      notes.push(
        ...fx.notes,
        `${sym} reports in ${rep} and trades in ${quoteCcy}: the price is converted to ${rep} [${priceId}] and every per-share figure is in ${rep}`,
      );
    }
  }
  if (rows.length) {
    const fetchedAt = now.toISOString();
    const criblePeriods = periodsFromCrible(rows.slice(0, 6), (col, period, value) =>
      store.add({
        key: `${sym}.crible.${col}.${period}`,
        label: `${sym} ${col.replace(/_/g, " ")} (period ending ${period}, crible)`,
        value,
        unit: /shares/.test(col) ? "shares" : ccy,
        source: "crible",
        fetchedAt,
        asOf: period,
        delay: "filing",
        official: false,
      }),
    );
    const before = periods.length;
    periods = fillGaps(periods, criblePeriods);
    const filled = periods.reduce((s, p) => s + p.filled.length, 0);
    if (filled)
      notes.push(
        `${filled} field(s) the filing did not tag were filled from crible (unofficial aggregate)${before ? "" : " — all statements come from crible"}`,
      );
  }
  store.save();
  store.save();
  if (!periods[0]) throw new Error(`no financial statements found for ${sym}`);

  // Discount rate: risk-free (10-year government), beta against a benchmark, CAPM.
  const erp = opts.erp ?? 0.05;
  const g = opts.terminalGrowth ?? 0.02;
  let rf: number | undefined;
  let rfId: string | undefined;
  try {
    const curve = ccy === "USD" ? await treasuryCurve(now) : await ecbYieldCurve(["10Y"]);
    if (ccy !== "USD" && ccy !== "EUR")
      notes.push(
        `no ${ccy} risk-free curve here: the euro area AAA 10-year stands in — ${ccy} cash flows discounted at a euro rate leave out the inflation and country-risk gap, so read the DCF as indicative`,
      );
    // This curve's own 10-year point: a shared register may already hold the other currency's.
    const tenItem = reg([curve])[0]?.items.find((i) => /\.(ust|aaa)\.10Y$/.test(i.key) && typeof i.value === "number");
    if (tenItem) {
      rf = (tenItem.value as number) / 100;
      rfId = tenItem.id;
    }
  } catch (e) {
    notes.push(`risk-free rate unavailable (${(e as Error).message}) — 3 % assumed`);
  }
  rf ??= 0.03;
  const benchSym = inst.market === "us" ? "SPY" : inst.mic === "XPAR" ? "FR0003500008" : "CW8.PA";
  let beta = 1;
  let betaId: string | undefined;
  try {
    const from = new Date(now.getTime() - 729 * 86_400_000);
    const [a, b] = await Promise.all([getHistory(resolved, { from, to: now }), getHistory(await resolveSymbol(benchSym), { from, to: now })]);
    const bm = new Map(b.bars.map((x) => [x.date, x.close]));
    const aligned = a.bars.filter((x) => bm.has(x.date));
    const rel = relativeTo(simpleReturns(aligned.map((x) => x.close)), simpleReturns(aligned.map((x) => bm.get(x.date)!)), 252);
    beta = rel.beta;
    betaId = store.add({
      key: `${sym}.beta.${benchSym}`,
      label: `${sym} beta vs ${benchSym} (2 years, daily)`,
      value: Number(beta.toFixed(4)),
      unit: "x",
      ...a.provenance,
      asOf: aligned[aligned.length - 1]?.date,
      formula: "cov(r, r_bench) / var(r_bench) on aligned daily simple returns",
    });
    store.add({
      key: `${sym}.vol2y`,
      label: `${sym} annualised volatility (2 years)`,
      value: Number(
        (
          (annualizedVol(
            aligned.map((x) => x.close),
            252,
          ) ?? 0) * 100
        ).toFixed(4),
      ),
      unit: "%",
      ...a.provenance,
      asOf: aligned[aligned.length - 1]?.date,
    });
  } catch (e) {
    notes.push(`beta unavailable (${(e as Error).message}) — 1.0 assumed`);
  }

  const out = computeValuation(store, { sym, ccy, price, priceId, periods, rf, rfId, beta, betaId, erp, g, years: opts.years ?? 5, notes });
  const cur = periods[0]!;
  mkdirSync(dir, { recursive: true });
  store.save();
  const lines = [
    `# ${sym}${inst.name ? ` — ${inst.name}` : ""} — valuation`,
    "",
    `Statements: latest fiscal year ending ${cur.period.end}${cur.filled.length ? ` (${cur.filled.length} field(s) from crible)` : ""}. Price ${q.price} ${quoteCcy}${ccy !== quoteCcy ? ` (${price} ${ccy})` : ""} as of ${q.at}. Assumptions: ERP ${(erp * 100).toFixed(1)} %, terminal growth ${(g * 100).toFixed(1)} %, scenario weights 25/50/25.`,
    "",
  ];
  // A shared register holds other symbols too: list this one's figures (and the rate it used).
  const own = (key: string) => key.startsWith(`${sym}.`);
  const section = (title: string, re: RegExp) => {
    const items = store.items.filter((i) => re.test(i.key) && (own(i.key) || i.id === rfId));
    if (items.length)
      lines.push(`## ${title}`, "", ...items.map((i) => `- ${formatEvidence(i)}${i.formula && i.source === "ultrastock" ? ` — ${i.formula}` : ""}`), "");
  };
  section("Scores", new RegExp(`^${sym.replace(/\./g, "\\.")}\\.score\\.`));
  section("Quality", /\.quality\./);
  section("Multiples", /\.mult\./);
  section("Discount rate", /\.(coe|beta\.|vol2y)|\.(ust|aaa)\.10Y$/);
  section("DCF", /\.dcf\./);
  if (notes.length) lines.push("## Notes", "", ...notes.map((n) => `- ${n}`), "");
  const artifact = join(dir, opts.artifact ?? "VALUATION.md");
  mkdirSync(dirname(artifact), { recursive: true });
  writeArtifact(artifact, `${lines.join("\n")}\n`);
  return { dir, symbol: sym, currency: ccy, evidence: store.items.length, ...out, notes };
}

export interface ValuationContext {
  sym: string;
  ccy: string;
  price: number;
  priceId: string;
  /** Newest first. */
  periods: SourcedPeriod[];
  rf: number;
  rfId?: string;
  beta: number;
  betaId?: string;
  erp: number;
  g: number;
  years: number;
  notes: string[];
}

const COMPONENT_UNITS: Record<string, string> = { eq_offer: "shares" };

/** The computation, on inputs already registered in `store`: scores, quality, multiples, CAPM, DCF. Pure but for writing evidence. */
export function computeValuation(
  store: EvidenceStore,
  ctx: ValuationContext,
): { piotroski?: number; altman?: string; beneish?: string; fairValue?: number; marginOfSafety?: number; impliedGrowth?: number } {
  const { sym, ccy, price, priceId, periods, rf, rfId, beta, betaId, erp, g, notes } = ctx;
  const opts = { years: ctx.years };
  const cur = periods[0]!;
  const prev = periods[1];
  const ids = (sp: SourcedPeriod | undefined, ...fields: Array<keyof SourcedPeriod["ids"]>) => fields.map((f) => sp?.ids[f]).filter((x): x is string => !!x);
  const yr = cur.period.end.slice(0, 4);
  // Scores, each with its components.
  const addScore = (key: string, s: Score, inputs: string[]) => {
    if (!Number.isFinite(s.value)) {
      notes.push(`${s.name}: ${s.verdict} (${s.computed} component(s) computable)`);
      return;
    }
    store.addDerived(`${sym}.score.${key}`, `${sym} ${s.name} (FY${yr})`, s.value, "score", inputs, `${s.name}: ${s.verdict}`);
    store.addDerived(`${sym}.score.${key}.verdict`, `${sym} ${s.name} verdict`, s.verdict, undefined, inputs, s.components.map((c) => c.reason).join("; "));
    for (const c of s.components)
      if (c.value !== undefined)
        store.addDerived(
          `${sym}.score.${key}.${c.id}`,
          `${sym} ${s.name}: ${c.label}`,
          c.value,
          COMPONENT_UNITS[c.id] ?? (c.id === "cfo" ? ccy : "ratio"),
          inputs,
          c.reason,
        );
  };
  const all = (sp?: SourcedPeriod) => (sp ? (Object.values(sp.ids) as string[]) : []);
  const pio = prev ? piotroski(cur.period, prev.period) : undefined;
  if (pio) addScore("piotroski", pio, [...all(cur), ...all(prev)]);
  const shares = cur.period.sharesOutstanding;
  const mcap = shares ? price * shares : undefined;
  const alt = altmanZ(cur.period, mcap, "non-manufacturer");
  addScore("altman", alt, [...all(cur), priceId]);
  const ben = prev ? beneishM(cur.period, prev.period) : undefined;
  if (ben) {
    addScore("beneish", ben, [...all(cur), ...all(prev)]);
    const sgi = ben.components.find((c) => c.id === "sgi")?.value;
    if (sgi !== undefined && sgi > 1.3 && ben.value > -1.78)
      notes.push(
        `Beneish M is pushed up by sales growth alone (SGI ${sgi.toFixed(2)}): a fast grower often trips it — read the other indices before suspecting the accounts`,
      );
  }

  // Quality and multiples.
  const qm = qualityMetrics(cur.period);
  const qLabels: Record<string, [string, string]> = {
    grossMargin: ["gross margin", "ratio"],
    operatingMargin: ["operating margin", "ratio"],
    netMargin: ["net margin", "ratio"],
    fcf: ["free cash flow", ccy],
    fcfMargin: ["FCF margin", "ratio"],
    fcfAfterSbc: ["FCF after share-based compensation", ccy],
    cashConversion: ["FCF / net income", "ratio"],
    roe: ["return on equity", "ratio"],
    roic: ["return on invested capital", "ratio"],
    netDebt: ["net debt", ccy],
    netDebtToEbitda: ["net debt / EBITDA", "x"],
    interestCoverage: ["interest coverage (EBIT / interest)", "x"],
    currentRatio: ["current ratio", "x"],
    accrualRatio: ["Sloan accrual ratio", "ratio"],
    payoutRatio: ["dividend payout ratio", "ratio"],
    dividendCover: ["FCF / dividends", "x"],
  };
  for (const [k, v] of Object.entries(qm))
    if (typeof v === "number" && Number.isFinite(v))
      store.addDerived(`${sym}.quality.${k}`, `${sym} ${qLabels[k]?.[0] ?? k} (FY${yr})`, v, qLabels[k]?.[1], all(cur), k);
  const m = multiples(cur.period, price, { epsGrowthPct: (growthOf(periods, "eps") ?? Number.NaN) * 100 || undefined });
  if (m) {
    const mLabels: Record<string, [string, string]> = {
      marketCap: ["market capitalisation", ccy],
      enterpriseValue: ["enterprise value", ccy],
      pe: ["P/E", "x"],
      pb: ["price / book", "x"],
      ps: ["price / sales", "x"],
      evToEbitda: ["EV / EBITDA", "x"],
      evToEbit: ["EV / EBIT", "x"],
      evToFcf: ["EV / FCF", "x"],
      fcfYield: ["FCF yield", "ratio"],
      earningsYield: ["earnings yield (EBIT / EV)", "ratio"],
      dividendYield: ["dividend yield", "ratio"],
      grahamNumber: ["Graham number", ccy],
      peg: ["PEG", "x"],
    };
    for (const [k, v] of Object.entries(m))
      if (typeof v === "number" && Number.isFinite(v))
        store.addDerived(`${sym}.mult.${k}`, `${sym} ${mLabels[k]?.[0] ?? k} at ${price} ${ccy}`, v, mLabels[k]?.[1], [priceId, ...all(cur)], k);
  }

  const betaUsed = clip(beta, 0.6, 2);
  const coe = capm(rf, betaUsed, erp);
  const coeId = store.addDerived(
    `${sym}.coe`,
    `${sym} cost of equity (CAPM, beta ${betaUsed.toFixed(2)}, ERP ${(erp * 100).toFixed(1)} %)`,
    coe * 100,
    "%",
    [rfId, betaId].filter((x): x is string => !!x),
    `rf + beta × ERP, beta clipped to [0.6, 2], ERP ${erp} (a parameter — Damodaran publishes a monthly implied ERP: verify it)`,
  );

  // Three-scenario DCF on free cash flow to equity, discounted at the cost of equity.
  let fairValue: number | undefined;
  let mos: number | undefined;
  let implied: number | undefined;
  const fcf = qm.fcf;
  if (fcf !== undefined && fcf > 0 && shares && coe > g + 0.01) {
    const hist = growthOf(periods, "revenue", 3) ?? 0.03;
    const base = clip(hist, -0.05, 0.2);
    if (hist !== base)
      notes.push(
        `3-year revenue growth of ${(hist * 100).toFixed(1)} % capped at ${(base * 100).toFixed(1)} % for the base case — the bull case and the reverse DCF show what more growth is worth`,
      );
    const years = opts.years ?? 5;
    const fade = (start: number) => Array.from({ length: years }, (_, i) => start + ((g - start) * i) / years);
    const inputs = [
      ...ids(cur, "operatingCashFlow", "capex", "sharesOutstanding", "revenue"),
      ...ids(periods[3] ?? periods[periods.length - 1], "revenue"),
      coeId,
    ];
    const scen = [
      { name: "bear", probability: 0.25, growth: clip(base / 2 - 0.02, -0.1, 0.1) },
      { name: "base", probability: 0.5, growth: base },
      { name: "bull", probability: 0.25, growth: clip(base * 1.5 + 0.01, -0.05, 0.35) },
    ];
    const values = scen.map((s) => {
      const r = dcf({ baseCashFlow: fcf, growth: fade(s.growth), terminalGrowth: g, discountRate: coe, netDebt: 0, shares, equityBased: true });
      store.addDerived(
        `${sym}.dcf.${s.name}`,
        `${sym} DCF value per share — ${s.name} (start growth ${(s.growth * 100).toFixed(1)} %, fading to ${(g * 100).toFixed(1)} % over ${years} years)`,
        r.perShare,
        ccy,
        inputs,
        `FCF ${fcf} grown, discounted at ${(coe * 100).toFixed(2)} %, terminal ${(g * 100).toFixed(1)} %; terminal value is ${(r.terminalShare * 100).toFixed(0)} % of the total`,
      );
      return { name: s.name, probability: s.probability, perShare: r.perShare, terminalShare: r.terminalShare };
    });
    const sv = scenarioValue(values, price);
    fairValue = sv.expected;
    mos = sv.marginOfSafety;
    store.addDerived(
      `${sym}.dcf.expected`,
      `${sym} probability-weighted DCF value per share (25/50/25)`,
      sv.expected,
      ccy,
      inputs,
      "0.25 × bear + 0.5 × base + 0.25 × bull",
    );
    store.addDerived(
      `${sym}.dcf.marginOfSafety`,
      `${sym} margin of safety at ${price} ${ccy}`,
      sv.marginOfSafety * 100,
      "%",
      [...inputs, priceId],
      "(expected / price − 1) × 100",
    );
    store.addDerived(`${sym}.dcf.bearDownside`, `${sym} downside to the bear value`, sv.downside * 100, "%", [...inputs, priceId], "(bear / price − 1) × 100");
    if ((values[1]?.terminalShare ?? 0) > 0.75)
      notes.push("over 75 % of the DCF value is the terminal value: the result is mostly an assumption about the far future");
    implied = reverseDcf(price, { baseCashFlow: fcf, terminalGrowth: g, discountRate: coe, netDebt: 0, shares, equityBased: true, years });
    if (implied !== undefined)
      store.addDerived(
        `${sym}.dcf.impliedGrowth`,
        `${sym} FCF growth the price implies over ${years} years (reverse DCF)`,
        implied * 100,
        "%",
        [...inputs, priceId],
        "constant growth g such that DCF(g) = price",
      );
  } else
    notes.push(
      fcf !== undefined && fcf <= 0
        ? "free cash flow is not positive: no DCF — value it on assets, a turnaround case or not at all"
        : "DCF skipped: free cash flow, share count or a discount rate above terminal growth is missing",
    );
  return { piotroski: pio?.value, altman: alt.verdict, beneish: ben?.verdict, fairValue, marginOfSafety: mos, impliedGrowth: implied };
}
