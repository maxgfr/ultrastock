// The US regime for a resident individual (Form 1040).
//
// - Lots per account and security, matched FIFO by default (HIFO / LIFO on
//   request — a standing instruction the broker must hold too); basis includes
//   the buy fee, proceeds are net of the sell fee (Form 8949 columns d/e).
// - Long-term when the asset is held more than one year (sold after the first
//   anniversary of the acquisition), short-term otherwise.
// - Wash sales (§1091, stocks and securities): a loss is disallowed when
//   substantially identical shares are bought within 30 days before or after
//   the sale — in any account, an IRA included (then permanently) — and added
//   to the replacement shares' basis, whose holding period absorbs the sold
//   shares'. Crypto-assets are not covered (verify each year: tax/rules.ts).
// - Netting: short against short, long against long, then across; a net loss
//   deducts up to $3,000 ($1,500 married filing separately) from ordinary
//   income and the rest carries forward keeping its character.
// - Long-term gains and qualified dividends at 0 / 15 / 20 % stacked over the
//   ordinary taxable income; the 3.8 % NIIT above the MAGI thresholds.
// - Crypto-to-crypto trades are disposals at fair value; stablecoins are
//   treated as dollars (their own gains ignored, said so).
import type { Transaction } from "../portfolio/ledger.js";
import {
  addDays,
  day,
  type EnvelopeRule,
  envelopeOf,
  type Figure,
  type FormLine,
  gross,
  type HarvestCandidate,
  isStablecoin,
  round2,
  splitPair,
  type TaxEvent,
  type TaxInput,
  TaxRegime,
  type TaxSummary,
  yearOf,
} from "./regime.js";

interface UsLot {
  id: number;
  account: string;
  symbol: string;
  /** Acquisition date for the holding period (moved back by a wash sale). */
  acquired: string;
  /** The real purchase date (wash-sale window). */
  bought: string;
  quantity: number;
  remaining: number;
  /** Basis per unit, USD, adjustments included. */
  basis: number;
  /** Shares of this lot already used as a wash-sale replacement. */
  replaced: number;
  sheltered: boolean;
  crypto: boolean;
}

const SHELTERED = new Set(["IRA", "ROTH-IRA", "401K"]);
/** Brokers outside the US (their accounts are foreign financial accounts for a US person). */
const NON_US_BROKERS =
  /degiro|trade ?republic|bourso|fortuneo|bourse ?direct|saxo|scalable|xtb|lightyear|trading ?212|revolut|bitpanda|bitstamp|binance(?!\.?us)|bnp|cr[eé]dit|soci[eé]t[eé]|lcl|linxea|bforbank|hello ?bank|freedom ?24/i;

/** Long-term when sold after the first anniversary of the acquisition (IRS Pub. 550). */
export function isLongTerm(acquired: string, sold: string): boolean {
  const [y, m, d] = acquired.slice(0, 10).split("-");
  const anniversary = `${Number(y) + 1}-${m}-${m === "02" && d === "29" ? "28" : d}`;
  return sold.slice(0, 10) > anniversary;
}

export class UsRegime extends TaxRegime {
  readonly id = "us" as const;
  readonly currency = "USD";

  constructor(year: number) {
    super("us", year);
  }

  costBasisMethod(input?: Pick<TaxInput, "lotMethod">): string {
    const m = (input?.lotMethod ?? "fifo").toUpperCase();
    return `${m} lots per account and security (the broker must apply the same standing method), buy fees in the basis, sell fees out of the proceeds; wash sales adjust the replacement lots`;
  }

  /** Every purchase becomes a lot up front, so a later replacement buy can absorb a disallowed loss. */
  private lots(input: TaxInput, history: Transaction[]): { lots: UsLot[]; byTx: Map<Transaction, UsLot> } {
    const lots: UsLot[] = [];
    const byTx = new Map<Transaction, UsLot>();
    for (const t of history) {
      if (t.type !== "buy" && t.type !== "transfer-in") continue;
      const env = envelopeOf(t.account, input.envelopes, t.symbol);
      const crypto = env.type === "CRYPTO";
      if (crypto && isStablecoin(splitPair(t.symbol ?? "", t.currency).base)) continue;
      const q = t.quantity ?? 0;
      const cost = t.price !== undefined ? this.toBase(t, gross(t), input) + this.toBase(t, t.fee ?? 0, input) : 0;
      const lot: UsLot = {
        id: lots.length,
        account: t.account,
        symbol: (t.symbol ?? "").toUpperCase(),
        acquired: day(t.date),
        bought: day(t.date),
        quantity: q,
        remaining: q,
        basis: q ? cost / q : 0,
        replaced: 0,
        sheltered: SHELTERED.has(env.type),
        crypto,
      };
      lots.push(lot);
      byTx.set(t, lot);
    }
    return { lots, byTx };
  }

  /** Replay; returns the year's events and the open lots at the year's end (or at `until`). */
  replay(input: TaxInput, until?: string): { events: TaxEvent[]; open: UsLot[]; warnings: string[]; lots: UsLot[] } {
    const history = this.history(input).filter((t) => !until || day(t.date) <= until);
    const { lots, byTx } = this.lots(input, history);
    const events: TaxEvent[] = [];
    const warnings: string[] = [];
    const active = new Set<UsLot>();
    const method = input.lotMethod ?? "fifo";
    const washCrypto = this.param<string>("washSale.crypto") !== "not applied";
    const window = this.param("washSale.windowDays");
    const inYear = (t: Transaction) => yearOf(t.date) === input.year;
    let stableNoted = false;
    for (const t of history) {
      const env = envelopeOf(t.account, input.envelopes, t.symbol);
      const sym = (t.symbol ?? "").toUpperCase();
      const base = { date: day(t.date), account: t.account, envelope: env.type, symbol: t.symbol, notes: [] as string[] };
      const lot = byTx.get(t);
      if (lot) {
        active.add(lot);
        continue;
      }
      if (t.type === "split") {
        for (const l of active)
          if (l.symbol === sym && l.account === t.account) {
            const r = t.quantity ?? 1;
            l.remaining *= r;
            l.quantity *= r;
            l.replaced *= r;
            l.basis /= r;
          }
        continue;
      }
      if (t.type === "sell" || t.type === "transfer-out") {
        if (env.type === "CRYPTO" && isStablecoin(splitPair(sym, t.currency).base)) {
          if (!stableNoted) warnings.push("stablecoins are treated as dollars: their (small) gains and losses are ignored");
          stableNoted = true;
          continue;
        }
        const pool = [...active].filter((l) => l.symbol === sym && l.account === t.account && l.remaining > 1e-12);
        pool.sort(
          (a, b) =>
            (method === "hifo" ? b.basis - a.basis : method === "lifo" ? b.bought.localeCompare(a.bought) : a.bought.localeCompare(b.bought)) || a.id - b.id,
        );
        let left = t.quantity ?? 0;
        const proceedsTotal = t.type === "sell" ? this.toBase(t, gross(t), input) - this.toBase(t, t.fee ?? 0, input) : 0;
        const perUnit = t.quantity ? proceedsTotal / t.quantity : 0;
        const consumed: Array<{ lot: UsLot; qty: number }> = [];
        for (const l of pool) {
          if (left <= 1e-12) break;
          const q = Math.min(left, l.remaining);
          l.remaining -= q;
          left -= q;
          consumed.push({ lot: l, qty: q });
        }
        if (left > 1e-9)
          warnings.push(
            `${sym} (${t.account}) disposed ${t.quantity} on ${day(t.date)} with ${round2((t.quantity ?? 0) - left)} in recorded lots: the rest has no basis`,
          );
        if (t.type === "transfer-out" || SHELTERED.has(env.type)) continue;
        if (left > 1e-9)
          consumed.push({
            lot: {
              id: -1,
              account: t.account,
              symbol: sym,
              acquired: day(t.date),
              bought: day(t.date),
              quantity: left,
              remaining: 0,
              basis: 0,
              replaced: 0,
              sheltered: false,
              crypto: env.type === "CRYPTO",
            },
            qty: left,
          });
        for (const { lot: l, qty } of consumed) {
          const proceeds = perUnit * qty;
          const cost = l.basis * qty;
          let gain = proceeds - cost;
          let disallowed = 0;
          const notes: string[] = [];
          if (gain < 0 && (!l.crypto || washCrypto)) {
            // Replacement shares bought within ±30 days (any account), not the shares sold, not already used.
            const from = addDays(day(t.date), -window);
            const to = addDays(day(t.date), window);
            const soldIds = new Set(consumed.map((c) => c.lot.id));
            let need = qty;
            for (const r of lots) {
              if (need <= 1e-12) break;
              if (r.symbol !== sym || soldIds.has(r.id) || r.bought < from || r.bought > to || r.id === l.id) continue;
              const avail = r.quantity - r.replaced;
              if (avail <= 1e-12) continue;
              const q = Math.min(need, avail);
              const loss = (-gain * q) / qty;
              disallowed += loss;
              r.replaced += q;
              need -= q;
              if (r.sheltered)
                notes.push(`wash sale against a purchase in ${r.account} (${r.bought}): the ${round2(loss)} $ loss is lost for good (IRA replacement)`);
              else {
                // The basis grows by the loss; the holding period starts earlier by the sold shares' holding time.
                r.basis += loss / r.quantity;
                const held = Date.parse(`${day(t.date)}T00:00:00Z`) - Date.parse(`${l.acquired}T00:00:00Z`);
                r.acquired = new Date(Date.parse(`${r.acquired}T00:00:00Z`) - held).toISOString().slice(0, 10);
                notes.push(`wash sale: ${round2(loss)} $ added to the basis of ${round2(q)} share(s) bought ${r.bought} in ${r.account}`);
              }
            }
            gain += disallowed;
          }
          const term = isLongTerm(l.acquired, day(t.date)) ? "long" : "short";
          if (l.id === -1) notes.push("no recorded lot: basis 0 — import the purchase");
          if (inYear(t))
            events.push({
              ...base,
              kind: l.crypto ? "crypto-disposal" : "securities-disposal",
              quantity: round2(qty * 1e6) / 1e6,
              proceeds: round2(proceeds),
              cost: round2(cost),
              gain: round2(gain),
              term,
              acquired: l.acquired,
              washSaleDisallowed: disallowed ? round2(disallowed) : undefined,
              formula: `${round2(proceeds)} − ${round2(cost)}${disallowed ? ` + wash-sale ${round2(disallowed)}` : ""}`,
              lines: {
                a: `${round2(qty * 1e6) / 1e6} ${sym}`,
                b: l.acquired,
                c: day(t.date),
                d: round2(proceeds),
                e: round2(cost),
                f: disallowed ? "W" : "",
                g: disallowed ? round2(disallowed) : 0,
                h: round2(gain),
              },
              notes,
            });
        }
        continue;
      }
      if (SHELTERED.has(env.type)) continue;
      if ((t.type === "dividend" || t.type === "interest") && inYear(t)) {
        const amount = this.toBase(t, t.amount ?? 0, input);
        const notes: string[] = [];
        let qualified: boolean | undefined;
        if (t.type === "dividend") {
          // Held more than 60 days around the payment (the ex-date is not in the ledger: an approximation).
          const held = [...active].filter((l) => l.symbol === sym && l.account === t.account);
          const need = this.param("qualifiedDividend.holdingDays");
          qualified = held.some((l) => Date.parse(day(t.date)) - Date.parse(l.acquired) > need * 86_400_000);
          notes.push(
            qualified
              ? "likely qualified (held > 60 days) — the 1099-DIV box 1b decides"
              : "likely NOT qualified (held ≤ 60 days) — the 1099-DIV box 1b decides",
          );
        }
        events.push({
          ...base,
          kind: t.type,
          amount: round2(amount),
          lines: { qualified: String(qualified ?? false), foreignSource: String(!/^US/.test(t.isin ?? "US") || /\.[A-Z]{1,3}$/.test(sym)) },
          notes,
        });
      } else if (t.type === "tax" && t.symbol && inYear(t)) {
        events.push({
          ...base,
          kind: "withholding",
          amount: round2(Math.abs(this.toBase(t, t.amount ?? 0, input))),
          notes: ["foreign tax withheld: a foreign tax credit (Form 1116, or directly on Schedule 3 up to $300 / $600 joint)"],
        });
      }
    }
    return { events, open: [...active].filter((l) => l.remaining > 1e-12), warnings, lots };
  }

  realize(input: TaxInput): TaxEvent[] {
    return this.replay(input).events;
  }

  annualSummary(input: TaxInput): TaxSummary {
    const r = this.replay(input);
    const ev = r.events;
    const warnings = [...r.warnings];
    if (this.stale) warnings.unshift(this.stale);
    const figures: Figure[] = [];
    const forms: FormLine[] = [];
    const obligations: string[] = [];
    const fig = (key: string, label: string, value: number | string, formula?: string, unit = "USD") =>
      figures.push({ key: `TAX.US.${input.year}.${key}`, label, value, unit, formula });
    const sum = (xs: TaxEvent[], f: (e: TaxEvent) => number | undefined) => round2(xs.reduce((a, e) => a + (f(e) ?? 0), 0));
    const disp = ev.filter((e) => e.kind === "securities-disposal" || e.kind === "crypto-disposal");
    const st = disp.filter((e) => e.term === "short");
    const lt = disp.filter((e) => e.term === "long");
    const stNet = sum(st, (e) => e.gain);
    const ltNet = sum(lt, (e) => e.gain);
    const wash = sum(disp, (e) => e.washSaleDisallowed);
    fig("shortTerm.net", "net short-term gain (Form 8949 Part I)", stNet);
    fig("longTerm.net", "net long-term gain (Form 8949 Part II)", ltNet);
    if (wash) fig("washSale.disallowed", "losses disallowed by wash sales (code W)", wash);
    const cfS = Math.abs(input.carryforward?.short ?? 0);
    const cfL = Math.abs(input.carryforward?.long ?? 0);
    const s = round2(stNet - cfS);
    const l = round2(ltNet - cfL);
    if (cfS || cfL) fig("carryforward.in", "capital loss carryforward used (short, long)", `${cfS}, ${cfL}`, undefined, "");
    const total = round2(s + l);
    fig("capital.net", "net capital gain or loss (Schedule D line 16)", total, `(${stNet} − ${cfS}) + (${ltNet} − ${cfL})`);
    const limit = this.param(input.filingStatus === "separate" ? "capitalLoss.separateLimit" : "capitalLoss.ordinaryLimit");
    let deductible = 0;
    let carryS = 0;
    let carryL = 0;
    // The taxable long-term part: net long-term gain beyond any net short-term loss.
    let ltTaxable = 0;
    let stTaxable = 0;
    if (total < 0) {
      deductible = Math.min(-total, limit);
      // Short-term losses absorb the deduction first.
      let rem = deductible;
      const sLoss = Math.max(0, -s) - Math.max(0, l);
      const lLoss = Math.max(0, -l) - Math.max(0, s);
      const useS = Math.min(rem, Math.max(0, sLoss));
      rem -= useS;
      carryS = round2(Math.max(0, sLoss) - useS);
      carryL = round2(Math.max(0, lLoss) - Math.min(rem, Math.max(0, lLoss)));
      fig("loss.deductible", `net capital loss deducted from ordinary income (limit ${limit})`, round2(deductible));
      fig("carryforward.out", "capital loss carried to next year (short, long)", `${carryS}, ${carryL}`, undefined, "");
    } else {
      ltTaxable = Math.max(0, Math.min(l, total));
      stTaxable = round2(total - ltTaxable);
    }
    const divs = ev.filter((e) => e.kind === "dividend");
    const qualified = sum(
      divs.filter((e) => e.lines?.qualified === "true"),
      (e) => e.amount,
    );
    const ordinaryDiv = round2(sum(divs, (e) => e.amount) - qualified);
    const interest = sum(
      ev.filter((e) => e.kind === "interest"),
      (e) => e.amount,
    );
    fig("dividends.qualified", "dividends likely qualified", qualified);
    fig("dividends.ordinary", "ordinary dividends (not qualified)", ordinaryDiv);
    if (interest) fig("interest", "interest income", interest);
    // Long-term rates stacked on top of the ordinary income.
    const status = input.filingStatus ?? "single";
    const th = this.param<Record<string, number>>("ltcg.thresholds");
    const prefix = status === "joint" ? "joint" : status === "separate" ? "separate" : status === "head" ? "head" : "single";
    const t0 = th[`${prefix}0`] ?? (status === "separate" ? th.single0 : status === "head" ? undefined : th.single0);
    const t15 = th[`${prefix}15`];
    const preferential = round2(ltTaxable + qualified);
    if (input.ordinaryIncome === undefined) warnings.push("no --income: the 0/15/20 % split of long-term gains and the NIIT need the ordinary taxable income");
    else if (t0 === undefined || t15 === undefined) warnings.push(`no ${status} breakpoints recorded for ${this.rules.year}: verify them (tax verify)`);
    else {
      const ord = input.ordinaryIncome + stTaxable + ordinaryDiv + interest - deductible;
      const at0 = Math.max(0, Math.min(preferential, t0 - ord));
      const at15 = Math.max(0, Math.min(preferential - at0, t15 - Math.max(ord, t0)));
      const at20 = preferential - at0 - at15;
      const ltTax = round2(at15 * 0.15 + at20 * 0.2);
      fig(
        "ltcg.tax",
        "tax on long-term gains and qualified dividends",
        ltTax,
        `${round2(at0)} × 0 + ${round2(at15)} × 15 % + ${round2(at20)} × 20 % over ${round2(ord)} of ordinary income`,
      );
      const nii = Math.max(0, total) + qualified + ordinaryDiv + interest;
      const magi = input.ordinaryIncome + nii - deductible;
      const nt = this.param<Record<string, number>>("niit.thresholds")[status === "head" ? "single" : status] ?? 200_000;
      const niit = round2(Math.max(0, Math.min(nii, magi - nt)) * this.param("niit.rate"));
      fig("niit", "net investment income tax (Form 8960)", niit, `${this.param("niit.rate")} × min(${round2(nii)}, ${round2(magi)} − ${nt})`);
      if (input.marginalRate !== undefined) {
        const stTax = round2((stTaxable + ordinaryDiv + interest - deductible) * input.marginalRate);
        fig("ordinary.tax", `tax on short-term gains, ordinary dividends and interest at ${input.marginalRate * 100} %`, stTax);
        fig("total.estimate", "estimated federal tax on the year's investments", round2(ltTax + niit + stTax));
      } else warnings.push("no --marginal-rate: short-term gains, ordinary dividends and interest are taxed at the ordinary rates — not computed");
    }
    // Forms.
    if (st.length)
      forms.push({
        form: "8949",
        box: "Part I",
        label: "short-term transactions (box A when the broker reported the basis)",
        value: stNet,
        note: "`tax export --format 8949`",
      });
    if (lt.length) forms.push({ form: "8949", box: "Part II", label: "long-term transactions (box D when the broker reported the basis)", value: ltNet });
    if (disp.length) {
      forms.push({ form: "Schedule D", box: "line 7", label: "net short-term", value: stNet });
      forms.push({ form: "Schedule D", box: "line 15", label: "net long-term", value: ltNet });
      forms.push({ form: "Schedule D", box: "line 21", label: "loss deducted", value: round2(deductible) });
    }
    if (ev.some((e) => e.kind === "crypto-disposal"))
      forms.push({ form: "1040", box: "digital assets", label: 'answer "Yes" to the digital-asset question', value: "yes" });
    const wh = sum(
      ev.filter((e) => e.kind === "withholding"),
      (e) => e.amount,
    );
    if (wh)
      forms.push({
        form: wh <= (status === "joint" ? 600 : 300) ? "Schedule 3" : "1116",
        box: "foreign tax credit",
        label: "foreign tax paid on dividends",
        value: wh,
      });
    // Foreign accounts and funds.
    const accounts = [...new Set(input.transactions.filter((t) => yearOf(t.date) <= input.year).map((t) => t.account))];
    const foreign = accounts.filter((a) => {
      const e = envelopeOf(a, input.envelopes);
      return ["PEA", "PEA-PME", "AV", "PER"].includes(e.type) || (e.type !== "CRYPTO" && NON_US_BROKERS.test(e.envelope?.broker ?? ""));
    });
    if (foreign.length)
      obligations.push(
        `FBAR (FinCEN 114, by 15 April, automatic extension to 15 October) if the foreign accounts ${foreign.join(", ")} together exceeded $${this.param("fbar.threshold").toLocaleString("en-US")} at any time; Form 8938 above $${this.param<{ singleEnd: number; singleAny: number }>("f8938.thresholds").singleEnd.toLocaleString("en-US")} at year end / $${this.param<{ singleEnd: number; singleAny: number }>("f8938.thresholds").singleAny.toLocaleString("en-US")} any time (single; doubled joint)`,
      );
    if (accounts.some((a) => envelopeOf(a, input.envelopes).type === "CRYPTO" && NON_US_BROKERS.test(envelopeOf(a, input.envelopes).envelope?.broker ?? "")))
      warnings.push(
        "crypto-only accounts abroad are not reportable on the FBAR for now (FinCEN Notice 2020-2, a rule change was announced) — verify the year's position; Form 8938 may still apply",
      );
    const funds = [
      ...new Set(
        input.transactions
          .filter((t) => t.isin && !t.isin.startsWith("US") && /ETF|UCITS|FUND|SICAV|FCP/i.test(`${t.note ?? ""} ${t.symbol ?? ""}`))
          .map((t) => t.symbol),
      ),
    ];
    if (funds.length)
      warnings.push(
        `non-US funds (${funds.join(", ")}) are PFICs for a US person: Form 8621 each year and punitive default taxation — prefer US-domiciled funds`,
      );
    return { regime: "us", year: input.year, currency: "USD", rulesYear: this.rules.year, figures, forms, obligations, warnings, events: ev };
  }

  harvestCandidates(input: TaxInput, prices: Readonly<Record<string, number>>, asOf: string): HarvestCandidate[] {
    const r = this.replay(input, asOf);
    const realized = r.events.filter((e) => e.kind === "securities-disposal" || e.kind === "crypto-disposal").reduce((a, e) => a + (e.gain ?? 0), 0);
    const window = this.param("washSale.windowDays");
    const out: HarvestCandidate[] = [];
    for (const l of r.open) {
      if (l.sheltered) continue;
      const px = prices[l.symbol];
      if (px === undefined) continue;
      const unrealized = (px - l.basis) * l.remaining;
      if (unrealized >= 0) continue;
      const term = isLongTerm(l.acquired, asOf) ? "long" : "short";
      const recent = r.lots.filter((x) => x.symbol === l.symbol && x.id !== l.id && x.bought > addDays(asOf, -window));
      const rate = input.marginalRate ?? (term === "short" ? 0.24 : 0.15);
      const offset = Math.min(-unrealized, Math.max(0, realized) + this.param("capitalLoss.ordinaryLimit"));
      out.push({
        account: l.account,
        symbol: l.symbol,
        quantity: l.remaining,
        price: px,
        cost: round2(l.basis * l.remaining),
        unrealized: round2(unrealized),
        term,
        saving: round2(offset * rate),
        formula: `min(${round2(-unrealized)}, gains ${round2(Math.max(0, realized))} + ${this.param("capitalLoss.ordinaryLimit")}) × ${rate}${input.marginalRate === undefined ? " (assumed rate: pass --marginal-rate)" : ""}`,
        notes: [
          `lot bought ${l.bought}${l.acquired !== l.bought ? ` (holding period from ${l.acquired})` : ""}`,
          recent.length
            ? `WASH-SALE RISK: ${l.symbol} was bought on ${recent.map((x) => `${x.bought} (${x.account})`).join(", ")} within the last ${window} days`
            : "",
          l.crypto
            ? "crypto: no wash-sale rule applied (verify the year's law)"
            : `do not buy ${l.symbol} or a substantially identical security (in any account, IRA included) before ${addDays(asOf, window + 1)}`,
        ].filter(Boolean),
      });
    }
    return out.sort((a, b) => a.unrealized - b.unrealized);
  }

  envelopeRules(): EnvelopeRule[] {
    return [
      {
        envelope: "TAXABLE",
        rule: `lots, short-term at ordinary rates, long-term (> ${this.param("longTerm.holdingDays")} days) at 0/15/20 %, NIIT ${this.param("niit.rate") * 100} % above the thresholds, $${this.param("capitalLoss.ordinaryLimit")} of net loss a year against ordinary income`,
      },
      {
        envelope: "IRA",
        rule: "traditional: deductible contributions within limits, growth tax-deferred, withdrawals taxed as ordinary income, 10 % penalty before 59½ (exceptions)",
      },
      { envelope: "ROTH-IRA", rule: "after-tax contributions, qualified withdrawals tax-free after 59½ and 5 years" },
      { envelope: "401K", rule: "employer plan: pre-tax or Roth deferrals within the yearly limit; same exit rules as the IRA kinds" },
      {
        envelope: "CRYPTO",
        rule: "property: every sale, trade or spend is a disposal at fair value; lots per wallet / account since 2025; Form 1099-DA from brokers",
      },
      { envelope: "PEA / AV (foreign)", rule: "not recognised by the IRS: taxable each year as a foreign account, funds inside are PFICs" },
    ];
  }

  withholdingRules(): string[] {
    return [
      "foreign dividends: the source country withholds (France 12.8 % with the treaty form, 25 % without); the US allows a foreign tax credit (Form 1116, or Schedule 3 directly up to $300 / $600 joint)",
      "US dividends to a US person: no withholding unless backup withholding (24 %) when the W-9 is missing",
    ];
  }
}
