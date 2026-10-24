// The French regime for a resident individual (foyer fiscal).
//
// - Securities on an ordinary account (CTO): the gain is the net disposal
//   price minus the weighted average cost (PMP) of the same security held by
//   the household, fees included (CGI art. 150-0 D, BOI-RPPM-PVBMI-20-10-20-40).
//   Net losses carry forward 10 years against securities gains only.
// - Taxed at the PFU — 12.8 % income tax plus the prélèvements sociaux — or,
//   on a household-wide option (2OP), at the progressive scale with the 40 %
//   dividend allowance and the deductible CSG; both are computed and compared.
// - PEA / PEA-PME: nothing is taxed inside; a withdrawal is taxed on its share
//   of the plan's gain — social levies after 5 years, plus the 12.8 % before
//   (and the plan closes). AV: same share rule, 7.5 % after 8 years with an
//   allowance, 12.8 % before; social levies at their own rate.
// - Crypto-assets (CGI art. 150 VH bis, form 2086): only disposals for fiat
//   (or goods) are taxable; crypto-to-crypto exchanges are deferred. Gain =
//   net price − total acquisition price × price / portfolio value; exempt
//   when the year's disposals total 305 € or less. Net crypto losses offset
//   only crypto gains of the same year.
// - Dividends from abroad: the treaty withholding (15 % for US shares with a
//   W-8BEN) is a credit against the French income tax on them (2AB), capped at
//   that tax; at a foreign broker the 12.8 % instalment is paid by the
//   taxpayer with form 2778-DIV by the 15th of the next month.
import type { Envelope } from "../core/profile.js";
import type { Transaction } from "../portfolio/ledger.js";
import {
  brokerIsForeign,
  day,
  type EnvelopeRule,
  envelopeOf,
  type Figure,
  type FormLine,
  gross,
  type HarvestCandidate,
  isFiat,
  round2,
  splitPair,
  type TaxEvent,
  type TaxInput,
  TaxRegime,
  type TaxSummary,
  yearOf,
  yearsBetween,
} from "./regime.js";

interface FrState {
  /** Household PMP per security over ordinary accounts. */
  securities: Map<string, { quantity: number; cost: number; firstBuy?: string; currency: string }>;
  transfers: Map<string, number>;
  crypto: { acquisitions: number; fractions: number; holdings: Map<string, number> };
  sheltered: Map<string, { deposits: number; netDeposits: number; opened?: string; type: string }>;
  events: TaxEvent[];
  warnings: string[];
}

const ORDINARY = new Set(["CTO", "TAXABLE", "OTHER"]);
const isFrenchSecurity = (t: Pick<Transaction, "symbol" | "isin">) => (t.isin ? t.isin.startsWith("FR") : /\.PA$/i.test(t.symbol ?? ""));

export class FranceRegime extends TaxRegime {
  readonly id = "fr" as const;
  readonly currency = "EUR";

  constructor(year: number) {
    super("fr", year);
  }

  costBasisMethod(): string {
    return "weighted average cost (PMP) per security across the household's ordinary accounts, buy fees included, sell fees deducted; crypto by the global portfolio formula of art. 150 VH bis";
  }

  /** Replay every transaction up to the year's end; events of `input.year` only. */
  replay(input: TaxInput): FrState {
    const st: FrState = {
      securities: new Map(),
      transfers: new Map(),
      crypto: { acquisitions: 0, fractions: 0, holdings: new Map() },
      sheltered: new Map(),
      events: [],
      warnings: [],
    };
    const guessed = new Set<string>();
    const inYear = (t: Transaction) => yearOf(t.date) === input.year;
    const pfuIr = this.param("pfu.ir");
    const ps = this.param("ps.capital");
    for (const t of this.history(input)) {
      const env = envelopeOf(t.account, input.envelopes, t.symbol);
      if (env.guessed && !guessed.has(t.account)) {
        guessed.add(t.account);
        st.warnings.push(
          `account "${t.account}" is not in the profile's envelopes: treated as ${env.type} — add it with \`ultrastock profile set\` if that is wrong`,
        );
      }
      const base = { date: day(t.date), account: t.account, envelope: env.type, symbol: t.symbol, notes: [] as string[] };
      const fee = this.toBase(t, t.fee ?? 0, input);

      if (env.type === "CRYPTO") {
        this.crypto(t, st, input, base, fee, inYear(t));
        continue;
      }
      if (env.type === "PEA" || env.type === "PEA-PME" || env.type === "AV" || env.type === "PER") {
        const s = st.sheltered.get(t.account) ?? { deposits: 0, netDeposits: 0, opened: env.envelope?.openedAt, type: env.type };
        st.sheltered.set(t.account, s);
        if (t.type === "deposit" || t.type === "transfer-in") {
          const v = Math.abs(this.toBase(t, t.amount ?? gross(t), input));
          s.deposits += v;
          s.netDeposits += v;
          s.opened ??= day(t.date);
        } else if (t.type === "sell" && inYear(t)) {
          st.events.push({
            ...base,
            kind: "sheltered-disposal",
            quantity: t.quantity,
            proceeds: round2(this.toBase(t, gross(t), input) - fee),
            notes: [`inside the ${env.type}: not taxed`],
          });
        } else if (t.type === "withdrawal") {
          this.shelteredWithdrawal(t, s, st, input, base, inYear(t), env.envelope);
        }
        continue;
      }
      if (!ORDINARY.has(env.type)) {
        st.warnings.push(`${t.account}: a ${env.type} is a US envelope — ignored by the French regime`);
        continue;
      }
      const sym = t.symbol ?? "";
      const pos = st.securities.get(sym) ?? { quantity: 0, cost: 0, currency: t.currency };
      if (t.type === "buy") {
        pos.cost += this.toBase(t, gross(t), input) + fee;
        pos.quantity += t.quantity ?? 0;
        pos.firstBuy ??= day(t.date);
        st.securities.set(sym, pos);
      } else if (t.type === "sell") {
        const q = t.quantity ?? 0;
        if (pos.quantity <= 1e-12) {
          st.warnings.push(`${sym} sold on ${day(t.date)} with no recorded purchase: the cost is unknown — import the history first`);
          continue;
        }
        const qty = Math.min(q, pos.quantity);
        if (q > pos.quantity + 1e-9) st.warnings.push(`${sym} sold ${q} on ${day(t.date)} but only ${pos.quantity} recorded: the excess has no cost`);
        const pmp = pos.cost / pos.quantity;
        const cost = pmp * qty;
        const proceeds = this.toBase(t, gross(t), input) - fee;
        pos.cost -= cost;
        pos.quantity -= qty;
        if (inYear(t))
          st.events.push({
            ...base,
            kind: "securities-disposal",
            quantity: q,
            proceeds: round2(proceeds),
            cost: round2(cost),
            fees: round2(fee),
            gain: round2(proceeds - cost),
            acquired: pos.firstBuy,
            formula: `(${q} × ${t.price} ${t.currency} − fees ${round2(fee)} €) − PMP ${pmp.toFixed(4)} € × ${qty}`,
            notes:
              pos.firstBuy && pos.firstBuy < "2018-01-01"
                ? ["held since before 2018: the progressive-scale option may allow the holding-period allowance (not computed)"]
                : [],
          });
        if (pos.quantity <= 1e-12) st.securities.delete(sym);
      } else if (t.type === "split") {
        pos.quantity *= t.quantity ?? 1;
        st.securities.set(sym, pos);
      } else if (t.type === "transfer-out") {
        const qty = Math.min(t.quantity ?? 0, pos.quantity);
        const cost = pos.quantity ? (pos.cost / pos.quantity) * qty : 0;
        st.transfers.set(sym, (st.transfers.get(sym) ?? 0) + cost);
        pos.cost -= cost;
        pos.quantity -= qty;
      } else if (t.type === "transfer-in") {
        const carried = st.transfers.get(sym);
        pos.cost += t.price !== undefined ? this.toBase(t, gross(t), input) : (carried ?? 0);
        if (t.price === undefined && carried === undefined)
          st.warnings.push(`${sym} transferred in on ${day(t.date)} without a cost: give the original purchase price`);
        st.transfers.delete(sym);
        pos.quantity += t.quantity ?? 0;
        pos.firstBuy ??= day(t.date);
        st.securities.set(sym, pos);
      } else if ((t.type === "dividend" || t.type === "interest") && inYear(t)) {
        const amount = this.toBase(t, t.amount ?? 0, input);
        const foreign = brokerIsForeign(env.envelope?.broker);
        st.events.push({
          ...base,
          kind: t.type,
          amount: round2(amount),
          notes: [
            ...(isFrenchSecurity(t) ? [] : ["foreign-source income: also on form 2047"]),
            ...(foreign === true
              ? [
                  `paid at a foreign broker: 12.8 % instalment (${round2(amount * pfuIr)} €) and social levies (${round2(amount * ps)} €) to pay with form 2778-DIV by the 15th of the following month`,
                ]
              : []),
          ],
          lines: {
            foreignBroker: foreign === undefined ? "unknown" : String(foreign),
            foreignSource: String(!isFrenchSecurity(t)),
            month: day(t.date).slice(0, 7),
          },
        });
      } else if (t.type === "tax" && t.symbol && inYear(t)) {
        st.events.push({
          ...base,
          kind: "withholding",
          amount: round2(Math.abs(this.toBase(t, t.amount ?? 0, input))),
          notes: isFrenchSecurity(t)
            ? ["French withholding (PFNL / social levies) — credited on the return as 2CK / already paid"]
            : ["foreign withholding: a credit (2AB) up to the French income tax on that dividend"],
          lines: { foreignSource: String(!isFrenchSecurity(t)) },
        });
      }
    }
    return st;
  }

  private crypto(t: Transaction, st: FrState, input: TaxInput, base: Omit<TaxEvent, "kind">, fee: number, inYear: boolean): void {
    const c = st.crypto;
    const { base: asset } = splitPair(t.symbol ?? t.currency, t.currency);
    if (t.type === "buy") {
      c.holdings.set(asset, (c.holdings.get(asset) ?? 0) + (t.quantity ?? 0));
      if (isFiat(t.currency)) c.acquisitions += this.toBase(t, gross(t), input) + fee;
      else if (inYear)
        st.events.push({
          ...base,
          kind: "crypto-exchange",
          quantity: t.quantity,
          notes: [`bought with ${t.currency}: an exchange between crypto-assets, deferred (no tax, acquisition price unchanged)`],
        });
      return;
    }
    if (t.type === "sell") {
      c.holdings.set(asset, (c.holdings.get(asset) ?? 0) - (t.quantity ?? 0));
      if (!isFiat(t.currency)) {
        if (inYear)
          st.events.push({
            ...base,
            kind: "crypto-exchange",
            quantity: t.quantity,
            notes: [`sold for ${t.currency}: an exchange between crypto-assets, deferred`],
          });
        return;
      }
      const price = this.toBase(t, gross(t), input);
      const net = price - fee;
      const value = input.cryptoValue?.(day(t.date), t);
      const acquisitionNet = c.acquisitions - c.fractions;
      if (value === undefined || value <= 0) {
        if (inYear) {
          st.warnings.push(
            `crypto disposal on ${day(t.date)}: the portfolio's total value at that moment is unknown — the gain cannot be computed (give it, or let the command value the holdings)`,
          );
          st.events.push({
            ...base,
            kind: "crypto-disposal",
            quantity: t.quantity,
            proceeds: round2(net),
            fees: round2(fee),
            lines: {
              "211": day(t.date),
              "213": round2(price),
              "214": round2(fee),
              "215": round2(net),
              "217": round2(price),
              "218": round2(net),
              "220": round2(c.acquisitions),
              "221": round2(c.fractions),
              "223": round2(acquisitionNet),
            },
            notes: ["gain unknown: portfolio value missing"],
          });
        }
        return;
      }
      const v = Math.max(value, price);
      const fraction = (acquisitionNet * price) / v;
      const gain = net - fraction;
      if (inYear)
        st.events.push({
          ...base,
          kind: "crypto-disposal",
          quantity: t.quantity,
          proceeds: round2(net),
          cost: round2(fraction),
          fees: round2(fee),
          gain: round2(gain),
          formula: `${round2(net)} − ${round2(acquisitionNet)} × ${round2(price)} / ${round2(v)}`,
          lines: {
            "211": day(t.date),
            "212": round2(v),
            "213": round2(price),
            "214": round2(fee),
            "215": round2(net),
            "217": round2(price),
            "218": round2(net),
            "220": round2(c.acquisitions),
            "221": round2(c.fractions),
            "223": round2(acquisitionNet),
            "224": round2(gain),
          },
          notes: value < price ? ["the portfolio value given is below the disposal price: raised to the price"] : [],
        });
      c.fractions += fraction;
      return;
    }
    if (t.type === "transfer-in" && inYear)
      st.warnings.push(
        `${t.symbol ?? asset} transferred in on ${day(t.date)}: a transfer between your own wallets changes nothing, but a crypto bought elsewhere must be in the ledger as a buy with its euro price`,
      );
    if (t.type === "transfer-in") c.holdings.set(asset, (c.holdings.get(asset) ?? 0) + (t.quantity ?? 0));
    if (t.type === "transfer-out") c.holdings.set(asset, (c.holdings.get(asset) ?? 0) - (t.quantity ?? 0));
    if ((t.type === "interest" || t.type === "dividend") && inYear)
      st.warnings.push(
        `${t.symbol ?? asset} reward on ${day(t.date)} (staking, lending, airdrop): no settled doctrine — commonly kept at a zero acquisition price and taxed when sold; professional-scale activity is BNC`,
      );
  }

  private shelteredWithdrawal(
    t: Transaction,
    s: { deposits: number; netDeposits: number; opened?: string; type: string },
    st: FrState,
    input: TaxInput,
    base: Omit<TaxEvent, "kind">,
    inYear: boolean,
    env?: Envelope,
  ): void {
    const w = Math.abs(this.toBase(t, t.amount ?? 0, input));
    const value = input.envelopeValues?.[`${t.account}|${day(t.date)}`];
    const age = s.opened ? yearsBetween(s.opened, day(t.date)) : undefined;
    if (value === undefined || value <= 0) {
      if (inYear) {
        st.warnings.push(
          `${t.account} (${s.type}) withdrawal of ${round2(w)} € on ${day(t.date)}: the envelope's value just before it is needed to split capital from gain — pass --envelope-value ${t.account}:${day(t.date)}=<value>`,
        );
        st.events.push({ ...base, kind: "envelope-withdrawal", amount: round2(w), notes: ["gain share unknown"], lines: { age: age ?? "unknown" } });
      }
      // Without the value the deposits cannot be reduced pro rata; assume capital first.
      s.netDeposits = Math.max(0, s.netDeposits - w);
      return;
    }
    const gainShare = (w * (value - s.netDeposits)) / value;
    const capital = (w * s.netDeposits) / value;
    s.netDeposits -= capital;
    if (!inYear) return;
    const notes: string[] = [];
    if (age === undefined) notes.push("opening date unknown: set the envelope's openedAt in the profile");
    if ((s.type === "PEA" || s.type === "PEA-PME") && age !== undefined && age < this.param("pea.minYears"))
      notes.push(
        `before ${this.param("pea.minYears")} years: the plan closes (except the legal cases — job loss, disability, early retirement, starting a business) and the gain bears 12.8 % on top of the social levies`,
      );
    if (s.type === "PER") notes.push("PER withdrawal: taxation depends on whether the deposits were deducted and on the kind of exit — not computed");
    st.events.push({
      ...base,
      kind: "envelope-withdrawal",
      amount: round2(w),
      gain: round2(gainShare),
      cost: round2(capital),
      formula: `${round2(w)} × (${round2(value)} − ${round2(s.netDeposits + capital)}) / ${round2(value)}`,
      lines: { age: age ?? "unknown", envelopeValue: round2(value), broker: env?.broker ?? "" },
      notes,
    });
  }

  realize(input: TaxInput): TaxEvent[] {
    return this.replay(input).events;
  }

  annualSummary(input: TaxInput): TaxSummary {
    const st = this.replay(input);
    const ev = st.events;
    const warnings = [...st.warnings];
    if (this.stale) warnings.unshift(this.stale);
    const pfuIr = this.param("pfu.ir");
    const ps = this.param("ps.capital");
    const sum = (xs: TaxEvent[], f: (e: TaxEvent) => number | undefined) => round2(xs.reduce((a, e) => a + (f(e) ?? 0), 0));
    const figures: Figure[] = [];
    const forms: FormLine[] = [];
    const obligations: string[] = [];
    const fig = (key: string, label: string, value: number | string, formula?: string, unit = "EUR") =>
      figures.push({ key: `TAX.FR.${input.year}.${key}`, label, value, unit, formula });

    // Securities.
    const sec = ev.filter((e) => e.kind === "securities-disposal");
    const gains = sum(
      sec.filter((e) => (e.gain ?? 0) > 0),
      (e) => e.gain,
    );
    const losses = sum(
      sec.filter((e) => (e.gain ?? 0) < 0),
      (e) => e.gain,
    );
    const net = round2(gains + losses);
    fig("securities.gains", "securities gains realised on ordinary accounts", gains);
    fig("securities.losses", "securities losses realised on ordinary accounts", losses);
    fig("securities.net", "net securities result of the year", net, `${gains} + (${losses})`);
    const cf = Object.entries(input.carryforward?.byYear ?? {})
      .map(([y, v]) => ({ year: Number(y), amount: Math.abs(v) }))
      .filter((x) => x.year < input.year)
      .sort((a, b) => a.year - b.year);
    const maxAge = this.param("losses.carryforwardYears");
    const expired = cf.filter((x) => x.year < input.year - maxAge);
    for (const x of expired) warnings.push(`the ${x.year} loss carryforward (${x.amount} €) is older than ${maxAge} years: lost`);
    let usable = cf.filter((x) => x.year >= input.year - maxAge);
    let imputed = 0;
    let taxableSec = net;
    if (net > 0) {
      for (const x of usable) {
        const take = Math.min(x.amount, taxableSec);
        x.amount -= take;
        imputed += take;
        taxableSec -= take;
      }
    }
    usable = usable.filter((x) => x.amount > 0.005);
    if (net < 0) usable.push({ year: input.year, amount: -net });
    taxableSec = round2(Math.max(0, taxableSec));
    if (cf.length) fig("securities.carryforwardUsed", "prior losses imputed this year", round2(imputed));
    fig("securities.taxable", "net taxable securities gain", taxableSec, net > 0 ? `${net} − ${round2(imputed)}` : "0 (net loss)");
    fig(
      "securities.carryforwardOut",
      "losses carried forward, by year of origin",
      usable.map((x) => `${x.year}: ${round2(x.amount)}`).join(", ") || "none",
      undefined,
      "",
    );
    if (taxableSec > 0) forms.push({ form: "2042-C", box: "3VG", label: "net capital gain on securities", value: taxableSec });
    if (net < 0) forms.push({ form: "2042-C", box: "3VH", label: "net capital loss on securities (carried forward 10 years)", value: round2(-net) });
    if (sec.length)
      forms.push({
        form: "2074",
        box: "—",
        label: "detail of the disposals (needed with losses to carry forward, several brokers, or figures differing from the IFU)",
        value: sec.length,
        note: "`tax export --format 2074` lists them",
      });

    // Dividends and interest.
    const divs = ev.filter((e) => e.kind === "dividend");
    const ints = ev.filter((e) => e.kind === "interest");
    const dividends = sum(divs, (e) => e.amount);
    const interest = sum(ints, (e) => e.amount);
    fig("dividends.gross", "gross dividends on ordinary accounts", dividends);
    fig("interest.gross", "gross interest and other fixed income", interest);
    if (dividends)
      forms.push({
        form: "2042-C",
        box: "2DC",
        label: "dividends eligible for the 40 % allowance",
        value: dividends,
        note: "fund / ETF distributions: only their dividend part is eligible — follow the IFU",
      });
    if (interest) forms.push({ form: "2042-C", box: "2TR", label: "interest and other investment income", value: interest });
    const viaFrench = [...divs, ...ints].filter((e) => e.lines?.foreignBroker === "false");
    const viaForeign = [...divs, ...ints].filter((e) => e.lines?.foreignBroker === "true");
    const viaUnknown = [...divs, ...ints].filter((e) => e.lines?.foreignBroker === "unknown");
    const ck = round2(sum(viaFrench, (e) => e.amount) * pfuIr);
    if (viaFrench.length)
      forms.push({
        form: "2042-C",
        box: "2CK",
        label: "12.8 % instalment already withheld by French paying agents (estimate — the IFU has the exact figure)",
        value: ck,
      });
    const foreignIncome = sum(
      [...divs, ...ints].filter((e) => e.lines?.foreignSource === "true"),
      (e) => e.amount,
    );
    if (foreignIncome) forms.push({ form: "2047", box: "—", label: "foreign-source investment income", value: foreignIncome });
    // Foreign withholding → credit capped at the French income tax on the same income (PFU part).
    const foreignWh = sum(
      ev.filter((e) => e.kind === "withholding" && e.lines?.foreignSource === "true"),
      (e) => e.amount,
    );
    const credit = round2(Math.min(foreignWh, foreignIncome * pfuIr));
    if (foreignWh) {
      fig("withholding.foreign", "foreign tax withheld on dividends", foreignWh);
      fig(
        "withholding.credit",
        "tax credit for the foreign withholding (capped at the French income tax on that income)",
        credit,
        `min(${foreignWh}, ${foreignIncome} × ${pfuIr})`,
      );
      forms.push({ form: "2042-C", box: "2AB", label: "tax credits on foreign income", value: credit });
      if (foreignWh > foreignIncome * this.param("us.dividendWithholdingTreaty") + 0.01)
        warnings.push(
          `foreign withholding (${foreignWh} €) is above the 15 % treaty rate on ${foreignIncome} € of foreign income: file a W-8BEN with the broker, and claim the excess from the source country`,
        );
    }
    if (viaForeign.length) {
      const months = [...new Set(viaForeign.map((e) => String(e.lines?.month)))].sort();
      obligations.push(
        `form 2778-DIV: dividends/interest paid at a foreign broker in ${months.join(", ")} — pay the 12.8 % instalment and the social levies by the 15th of each following month (an exemption request for the instalment is possible below the income thresholds, by 30 November of the previous year)`,
      );
    }
    for (const e of viaUnknown.slice(0, 1))
      warnings.push(`broker of ${e.account} unknown: say whether it is French or foreign (2778-DIV, 3916) in the profile's envelope "broker"`);

    // Crypto.
    const cd = ev.filter((e) => e.kind === "crypto-disposal");
    const totalPrices = sum(cd, (e) => e.proceeds);
    const threshold = this.param("crypto.exemptionThreshold");
    const cryptoNet = sum(cd, (e) => e.gain);
    const cryptoUnknown = cd.some((e) => e.gain === undefined);
    const exempt = cd.length > 0 && totalPrices <= threshold;
    let cryptoTaxable = 0;
    if (cd.length) {
      fig("crypto.disposals", "total crypto disposal prices of the year (net of fees)", totalPrices);
      fig("crypto.net", "net crypto gain or loss (art. 150 VH bis)", cryptoNet);
      if (exempt) fig("crypto.exempt", `crypto gains exempt (disposals ≤ ${threshold} €)`, "yes", undefined, "");
      else {
        cryptoTaxable = Math.max(0, cryptoNet);
        forms.push({
          form: "2086",
          box: "—",
          label: "one column per taxable crypto disposal",
          value: cd.length,
          note: "`tax export --format 2086` fills the lines",
        });
        forms.push(
          cryptoNet >= 0
            ? { form: "2042-C", box: "3AN", label: "net crypto gain", value: cryptoNet }
            : { form: "2042-C", box: "3BN", label: "net crypto loss (not carried forward)", value: round2(-cryptoNet) },
        );
      }
      if (cryptoUnknown) warnings.push("some crypto gains are unknown (portfolio value missing): the crypto totals are incomplete");
    }

    // Envelopes.
    const wd = ev.filter((e) => e.kind === "envelope-withdrawal");
    let envelopeTax = 0;
    const avGains: TaxEvent[] = [];
    for (const e of wd) {
      if (e.gain === undefined || e.gain <= 0) continue;
      if (e.envelope === "PEA" || e.envelope === "PEA-PME") {
        const early = typeof e.lines?.age === "number" && e.lines.age < this.param("pea.minYears");
        const t = e.gain * (ps + (early ? pfuIr : 0));
        envelopeTax += t;
        fig(
          `envelope.${e.account}.${e.date}.tax`,
          `${e.envelope} withdrawal on ${e.date}: tax on its gain share`,
          round2(t),
          `${e.gain} × (${ps}${early ? ` + ${pfuIr}` : ""})`,
        );
      } else if (e.envelope === "AV") avGains.push(e);
    }
    if (avGains.length) {
      const long = avGains.filter((e) => typeof e.lines?.age === "number" && e.lines.age >= this.param("av.minYears"));
      const short = avGains.filter((e) => !long.includes(e));
      const allowance = this.param(input.household === "couple" ? "av.abattement.couple" : "av.abattement.single");
      const longGain = sum(long, (e) => e.gain);
      const shortGain = sum(short, (e) => e.gain);
      const premiums = [...st.sheltered.values()].filter((s) => s.type === "AV").reduce((a, s) => a + s.netDeposits, 0);
      const over = premiums > this.param("av.premiumThreshold") ? (premiums - this.param("av.premiumThreshold")) / premiums : 0;
      const taxedLong = Math.max(0, longGain - allowance);
      const avIr = taxedLong * ((1 - over) * this.param("av.rate8y") + over * pfuIr) + shortGain * pfuIr;
      const avPs = (longGain + shortGain) * this.param("ps.assuranceVie");
      envelopeTax += avIr + avPs;
      fig("av.gains", "assurance-vie gains withdrawn", round2(longGain + shortGain));
      fig(
        "av.tax",
        "assurance-vie income tax and social levies on the withdrawals",
        round2(avIr + avPs),
        `max(0, ${longGain} − ${allowance}) × rate + ${shortGain} × ${pfuIr} + ${round2(longGain + shortGain)} × ${this.param("ps.assuranceVie")}`,
      );
      if (longGain)
        forms.push({
          form: "2042",
          box: "2CH",
          label: "assurance-vie gains from contracts of 8 years or more (for the allowance)",
          value: longGain,
          note: "and 2VV / 2WW split at 150 000 € of premiums — follow the insurer's IFU",
        });
      warnings.push("assurance-vie: the insurer withholds an instalment and the social levies on euro funds yearly — reconcile with its IFU");
    }

    // PFU vs progressive scale (household-wide option).
    const pfuBase = taxableSec + dividends + interest + cryptoTaxable;
    const pfuTax = round2(pfuBase * pfuIr);
    const psTax = round2(pfuBase * ps);
    fig("pfu.incomeTax", "income tax at the PFU (12.8 %)", pfuTax, `${round2(pfuBase)} × ${pfuIr}`);
    fig("ps.total", "social levies on the year's gains and income (ordinary accounts and crypto)", psTax, `${round2(pfuBase)} × ${ps}`);
    let incomeTax = pfuTax - credit;
    if (input.marginalRate !== undefined) {
      const tmi = input.marginalRate;
      const scaleBase = taxableSec + dividends * (1 - this.param("dividend.abattement")) + interest + cryptoTaxable;
      const scaleTax = round2(scaleBase * tmi);
      const csgSaving = round2(pfuBase * this.param("csg.deductible") * tmi);
      fig(
        "scale.incomeTax",
        `income tax at the progressive scale (TMI ${tmi * 100} %)`,
        scaleTax,
        `(${taxableSec} + ${dividends} × 0.6 + ${interest} + ${cryptoTaxable}) × ${tmi}`,
      );
      fig(
        "scale.csgSaving",
        "next year's saving from the deductible CSG under the scale option",
        csgSaving,
        `${round2(pfuBase)} × ${this.param("csg.deductible")} × ${tmi}`,
      );
      const better = scaleTax - csgSaving < pfuTax ? "progressive scale (tick 2OP)" : "PFU (leave 2OP unticked)";
      fig("option.better", "cheaper option for the household", better, `scale ${round2(scaleTax - csgSaving)} vs PFU ${pfuTax}`, "");
      if (scaleTax - csgSaving < pfuTax) incomeTax = scaleTax - credit;
      warnings.push(
        "the 2OP option applies to ALL the household's investment income and gains of the year — compare with the other income in mind (the TMI may change with these amounts)",
      );
    } else warnings.push("no --tmi: only the PFU is computed; the progressive scale pays when the TMI is 0 % or 11 % (pass --tmi to compare)");
    const total = round2(Math.max(0, incomeTax) + psTax + envelopeTax);
    fig(
      "total.estimate",
      "estimated tax on the year's investments (before what was already withheld)",
      total,
      `income tax ${round2(incomeTax)} + social levies ${psTax} + envelopes ${round2(envelopeTax)}`,
    );

    // Foreign accounts.
    const accounts = [...new Set(input.transactions.filter((t) => yearOf(t.date) <= input.year).map((t) => t.account))];
    for (const a of accounts) {
      const env = envelopeOf(a, input.envelopes);
      const foreign = brokerIsForeign(env.envelope?.broker ?? a);
      if (foreign === true)
        obligations.push(
          env.type === "CRYPTO"
            ? `form 3916-bis: declare the crypto account "${a}" (${env.envelope?.broker ?? a}) held abroad — 750 € (1 500 € above 50 000 €) per account not declared`
            : `form 3916: declare the account "${a}" (${env.envelope?.broker ?? a}) opened abroad — 1 500 € per account not declared`,
        );
    }
    return { regime: "fr", year: input.year, currency: "EUR", rulesYear: this.rules.year, figures, forms, obligations, warnings, events: ev };
  }

  harvestCandidates(input: TaxInput, prices: Readonly<Record<string, number>>, asOf: string): HarvestCandidate[] {
    const st = this.replay(input);
    const realized = st.events.filter((e) => e.kind === "securities-disposal").reduce((a, e) => a + (e.gain ?? 0), 0);
    const rate = this.param("pfu.ir") + this.param("ps.capital");
    let room = Math.max(0, realized);
    const out: HarvestCandidate[] = [];
    const rows = [...st.securities.entries()]
      .map(([symbol, p]) => {
        const px = prices[symbol];
        if (px === undefined || p.quantity <= 0) return undefined;
        const fx = p.currency === "EUR" ? 1 : input.fx(p.currency, asOf);
        if (fx === undefined) return undefined;
        const value = px * fx * p.quantity;
        return { symbol, p, px, value, unrealized: value - p.cost };
      })
      .filter((x): x is NonNullable<typeof x> => !!x && x.unrealized < 0)
      .sort((a, b) => a.unrealized - b.unrealized);
    for (const r of rows) {
      const used = Math.min(-r.unrealized, room);
      room -= used;
      out.push({
        account: "ordinary accounts",
        symbol: r.symbol,
        quantity: r.p.quantity,
        price: r.px,
        cost: round2(r.p.cost),
        unrealized: round2(r.unrealized),
        saving: round2(used * rate),
        formula: `min(${round2(-r.unrealized)}, gains left ${round2(room + used)}) × ${round2(rate)}`,
        notes: [
          used < -r.unrealized ? `${round2(-r.unrealized - used)} € of the loss would carry forward 10 years` : "",
          "no wash-sale rule in France: buying back resets the PMP to the new price — a same-day sale and repurchase done only for tax can be challenged as an abuse of law; leave a market interval",
        ].filter(Boolean),
      });
    }
    // Crypto: the global formula realises a loss only when the portfolio is below its net acquisition price.
    const value = input.cryptoValue?.(asOf);
    const acq = st.crypto.acquisitions - st.crypto.fractions;
    if (value !== undefined && value > 0 && value < acq) {
      const cryptoGain = st.events.filter((e) => e.kind === "crypto-disposal").reduce((a, e) => a + (e.gain ?? 0), 0);
      const lossPerEuro = acq / value - 1;
      const toSell = cryptoGain > 0 ? cryptoGain / lossPerEuro : 0;
      out.push({
        account: "crypto portfolio",
        symbol: "ALL",
        quantity: 0,
        price: round2(value),
        cost: round2(acq),
        unrealized: round2(value - acq),
        saving: round2(Math.min(cryptoGain, toSell * lossPerEuro) * rate),
        formula: `each euro sold for fiat realises ${lossPerEuro.toFixed(4)} € of loss (${round2(acq)} / ${round2(value)} − 1)`,
        notes: [
          cryptoGain > 0
            ? `selling ${round2(toSell)} € for fiat offsets this year's ${round2(cryptoGain)} € crypto gain`
            : "no crypto gain this year: a crypto loss is not carried forward and does not offset securities",
        ],
      });
    }
    return out;
  }

  envelopeRules(): EnvelopeRule[] {
    const ps = (this.param("ps.capital") * 100).toFixed(1);
    return [
      {
        envelope: "CTO",
        rule: `gains at PMP; PFU ${this.param("pfu.ir") * 100} % + social levies ${ps} % (or the scale, option 2OP); losses carried forward ${this.param("losses.carryforwardYears")} years; dividends: 40 % allowance under the scale`,
      },
      {
        envelope: "PEA",
        rule: `EU/EEA shares and eligible UCITS ETFs; deposits up to ${this.param("pea.ceiling")} €; after ${this.param("pea.minYears")} years withdrawals bear only the social levies (${ps} %) on their gain share; before, the plan closes and 12.8 % is added`,
      },
      {
        envelope: "PEA-PME",
        rule: `SMEs and mid-caps; combined deposits with the PEA up to ${this.param("peaPme.ceilingCombined")} €; same withdrawal rules as the PEA`,
      },
      {
        envelope: "AV",
        rule: `gains taxed on withdrawal only: after ${this.param("av.minYears")} years ${this.param("av.rate8y") * 100} % after a ${this.param("av.abattement.single")} € / ${this.param("av.abattement.couple")} € allowance (12.8 % on the part of premiums above ${this.param("av.premiumThreshold")} €), before 12.8 %; social levies ${(this.param("ps.assuranceVie") * 100).toFixed(1)} %`,
      },
      {
        envelope: "PER",
        rule: "deposits deductible within a ceiling; exit taxation depends on the deduction choice and the kind of exit — check before withdrawing",
      },
      {
        envelope: "CRYPTO",
        rule: `art. 150 VH bis: only disposals for fiat or goods are taxed, by the global portfolio formula; exempt if disposals ≤ ${this.param("crypto.exemptionThreshold")} € a year; flat ${this.param("pfu.ir") * 100} % + ${ps} % (or the scale); foreign accounts on form 3916-bis`,
      },
    ];
  }

  withholdingRules(): string[] {
    return [
      `US shares: ${this.param("us.dividendWithholdingTreaty") * 100} % withheld with a W-8BEN (30 % without), credited against the French income tax on the dividend (2AB) up to that tax; the social levies remain due in full`,
      "other countries: the treaty rate is creditable; anything withheld above it must be reclaimed from the source country (e.g. Switzerland 35 % → 15 %, Germany 26.375 % → 15 %)",
      "French broker: the 12.8 % instalment (PFNL) and the social levies are withheld at payment and credited on the return (2CK)",
      "foreign broker: pay them yourself with form 2778-DIV by the 15th of the month after each payment",
    ];
  }
}
