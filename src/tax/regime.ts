// The tax engine's common shape. A regime reads the ledger (every buy, sell,
// dividend, withholding, deposit and withdrawal, in its own currency) and the
// envelopes from the profile, converts each amount to the regime's currency at
// the transaction's date, and answers four questions: what was realised this
// year (`realize`), what it adds up to and where it goes on the return
// (`annualSummary`), which losses could be harvested now (`harvestCandidates`),
// and what each envelope's rules are (`envelopeRules`).
//
// Each figure says how it was computed (`formula`), every parameter comes from
// tax/rules.ts with its sources, and anything the engine cannot know (the
// value of a PEA on the day of a withdrawal, a crypto portfolio's value at a
// disposal, the household's marginal rate) is an input — missing, it is named
// in `warnings`, never guessed. The result is a preparation aid for the
// return, not the return: the broker's IFU / 1099 is the reference.
import type { Envelope, EnvelopeType } from "../core/profile.js";
import type { Transaction } from "../portfolio/ledger.js";
import { param, type RuleSet, rulesFor, verifyChecklist } from "./rules.js";

/** Units of the regime's currency per one unit of `currency` on `date` (the last fixing at or before it). */
export type Fx = (currency: string, date: string) => number | undefined;

export interface TaxInput {
  year: number;
  transactions: readonly Transaction[];
  envelopes: readonly Envelope[];
  fx: Fx;
  /** Value of an envelope (positions + cash, regime currency) just before a withdrawal, keyed "<account>|<YYYY-MM-DD>". */
  envelopeValues?: Record<string, number>;
  /** FR: value of the whole crypto portfolio (regime currency) just before a taxable disposal on `date`. */
  cryptoValue?: (date: string, tx?: Transaction) => number | undefined;
  /** FR: the household's marginal income-tax rate (TMI), for PFU vs progressive scale. US: the marginal ordinary rate. */
  marginalRate?: number;
  /** US filing status. */
  filingStatus?: "single" | "joint" | "separate" | "head";
  /** US: taxable ordinary income before these gains and dividends — places them in the LTCG brackets, and MAGI for the NIIT. */
  ordinaryIncome?: number;
  /** Losses brought forward: FR by year of origin ({"2024": 1200}); US short- and long-term. */
  carryforward?: { byYear?: Record<string, number>; short?: number; long?: number };
  lotMethod?: "fifo" | "hifo" | "lifo";
  household?: "single" | "couple";
}

export type EventKind =
  | "securities-disposal"
  | "crypto-disposal"
  | "crypto-exchange"
  | "sheltered-disposal"
  | "dividend"
  | "interest"
  | "withholding"
  | "envelope-withdrawal";

export interface TaxEvent {
  kind: EventKind;
  date: string;
  account: string;
  envelope: EnvelopeType;
  symbol?: string;
  quantity?: number;
  /** All amounts in the regime's currency. */
  proceeds?: number;
  cost?: number;
  fees?: number;
  gain?: number;
  /** Dividends, interest, withholdings, withdrawals: the gross amount. */
  amount?: number;
  /** US: holding-period character. */
  term?: "short" | "long";
  acquired?: string;
  /** US: loss disallowed by the wash-sale rule (added to the replacement shares' basis). */
  washSaleDisallowed?: number;
  /** How the gain was computed, with the numbers. */
  formula?: string;
  /** Form lines this event feeds (2086 lines, 8949 columns). */
  lines?: Record<string, number | string>;
  notes: string[];
}

export interface Figure {
  key: string;
  label: string;
  value: number | string;
  unit?: string;
  formula?: string;
}

export interface FormLine {
  form: string;
  box: string;
  label: string;
  value: number | string;
  note?: string;
}

export interface TaxSummary {
  regime: "fr" | "us";
  year: number;
  currency: string;
  /** The parameters' year (differs from `year` when the rules are stale). */
  rulesYear: number;
  figures: Figure[];
  forms: FormLine[];
  /** What to do and by when (2778-DIV, 3916, FBAR…). */
  obligations: string[];
  warnings: string[];
  events: TaxEvent[];
}

export interface HarvestCandidate {
  account: string;
  symbol: string;
  quantity: number;
  price: number;
  cost: number;
  unrealized: number;
  term?: "short" | "long";
  /** Tax this loss would save against the year's realised gains, at the regime's rate. */
  saving?: number;
  formula?: string;
  notes: string[];
}

export interface EnvelopeRule {
  envelope: string;
  rule: string;
}

const FIAT = new Set([
  "EUR",
  "USD",
  "GBP",
  "CHF",
  "JPY",
  "CAD",
  "AUD",
  "NZD",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "HUF",
  "HKD",
  "SGD",
  "CNY",
  "KRW",
  "BRL",
  "MXN",
  "ZAR",
  "TRY",
  "INR",
]);
const STABLES = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP", "PYUSD", "EURC", "EURT"]);
const QUOTES = ["FDUSD", "USDT", "USDC", "BUSD", "TUSD", "EURC", "EUR", "USD", "GBP", "BTC", "ETH", "BNB", "DAI", "TRY", "BRL", "JPY"];

export const isFiat = (c: string) => FIAT.has(c.toUpperCase());
export const isStablecoin = (c: string) => STABLES.has(c.toUpperCase());

/** "BTCUSDT" → {base: "BTC", quote: "USDT"}; "BTC-EUR", "XBTEUR" (Kraken) and a bare "ETH" too. */
export function splitPair(symbol: string, currency?: string): { base: string; quote?: string } {
  const s = symbol.toUpperCase().replace(/[-/_]/g, "");
  const q =
    currency && s.endsWith(currency.toUpperCase()) && s.length > currency.length
      ? currency.toUpperCase()
      : QUOTES.find((x) => s.endsWith(x) && s.length > x.length);
  const base = q ? s.slice(0, -q.length) : s;
  return { base: base === "XBT" ? "BTC" : base === "XDG" ? "DOGE" : base, quote: q };
}

/** Brokers and platforms established outside France — their accounts are declared on form 3916 / 3916-bis. */
const FOREIGN_BROKERS =
  /ibkr|interactive|degiro|trade ?republic|revolut|etoro|xtb|freedom ?24|lightyear|scalable|saxo|trading ?212|binance|kraken|coinbase|bitpanda|bitstamp|crypto\.com|bybit|okx|kucoin|bitget|gemini|nexo|swissborg|ledger ?(live)?|metamask/i;
const FRENCH_BROKERS =
  /bourso|fortuneo|bourse ?direct|cr[eé]dit ?agricole|bnp|soci[eé]t[eé] ?g[eé]n[eé]rale|\bsg\b|lcl|linxea|yomoni|bforbank|hello ?bank|caisse ?d'?[eé]pargne|banque ?populaire|cic|cr[eé]dit ?mutuel|la ?banque ?postale|axa|binck|easybourse|paymium|coinhouse|meria|deskoin|stack ?sats/i;

/** true = abroad, false = in France, undefined = unknown (asked in the warnings). */
export function brokerIsForeign(broker?: string): boolean | undefined {
  if (!broker) return undefined;
  if (FRENCH_BROKERS.test(broker)) return false;
  if (FOREIGN_BROKERS.test(broker)) return true;
  return undefined;
}

/** The envelope of an account: the profile's, else a guess from the account id and symbol (named in the warnings). */
export function envelopeOf(account: string, envelopes: readonly Envelope[], symbol?: string): { type: EnvelopeType; envelope?: Envelope; guessed: boolean } {
  const e = envelopes.find((x) => x.id === account);
  if (e) return { type: e.type, envelope: e, guessed: false };
  const a = account.toLowerCase();
  if (/^pea-?pme/.test(a)) return { type: "PEA-PME", guessed: true };
  if (/^pea/.test(a)) return { type: "PEA", guessed: true };
  if (/^(av|assurance)/.test(a)) return { type: "AV", guessed: true };
  if (/^per\b/.test(a)) return { type: "PER", guessed: true };
  if (/roth/.test(a)) return { type: "ROTH-IRA", guessed: true };
  if (/ira/.test(a)) return { type: "IRA", guessed: true };
  if (/401k/.test(a)) return { type: "401K", guessed: true };
  if (/binance|kraken|coinbase|bitstamp|bitpanda|ledger|wallet|crypto/.test(a)) return { type: "CRYPTO", guessed: true };
  if (symbol && !symbol.includes(".") && splitPair(symbol).quote && /USDT|USDC|BTC|ETH|FDUSD/.test(splitPair(symbol).quote!))
    return { type: "CRYPTO", guessed: true };
  return { type: "CTO", guessed: true };
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
export const yearOf = (d: string) => Number(d.slice(0, 4));
export const day = (d: string) => d.slice(0, 10);

/** Whole years between two ISO dates (anniversary-exact). */
export function yearsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.slice(0, 10).split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.slice(0, 10).split("-").map(Number) as [number, number, number];
  let y = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) y--;
  return y;
}

export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The gross cash of a trade (quantity × price) in the transaction's currency. */
export const gross = (t: Transaction) => (t.quantity ?? 0) * (t.price ?? 0);

export abstract class TaxRegime {
  readonly rules: RuleSet;
  readonly stale?: string;
  abstract readonly id: "fr" | "us";
  abstract readonly currency: string;

  constructor(regime: "fr" | "us", year: number) {
    const r = rulesFor(regime, year);
    this.rules = r.rules;
    this.stale = r.stale;
  }

  /** The cost-basis rule the regime applies (PMP, FIFO lots…), in words. */
  abstract costBasisMethod(input?: Pick<TaxInput, "lotMethod">): string;
  /** Every taxable (and sheltered, for the record) event of the year. */
  abstract realize(input: TaxInput): TaxEvent[];
  /** The year's totals, the form boxes, the obligations and what is missing. */
  abstract annualSummary(input: TaxInput): TaxSummary;
  /** Open positions under water, with what selling them would save this year. */
  abstract harvestCandidates(input: TaxInput, prices: Readonly<Record<string, number>>, asOf: string): HarvestCandidate[];
  /** Each envelope's rules with this year's parameters. */
  abstract envelopeRules(): EnvelopeRule[];
  /** How dividends paid abroad are withheld and credited. */
  abstract withholdingRules(): string[];

  param<T = number>(key: string): T {
    return param<T>(this.rules, key);
  }

  verifyChecklist() {
    return verifyChecklist(this.id, this.rules.year);
  }

  /** An amount in the regime's currency at the transaction's date (stablecoins at their peg, named in the notes). */
  protected toBase(t: Transaction, amount: number, input: TaxInput): number {
    let c = t.currency.toUpperCase();
    if (isStablecoin(c)) c = c.startsWith("EUR") ? "EUR" : "USD";
    if (c === this.currency) return amount;
    const rate = input.fx(c, day(t.date));
    if (rate === undefined)
      throw new Error(`no ${c}→${this.currency} rate for ${day(t.date)} (transaction ${t.id}) — the tax report needs every amount converted at its date`);
    return amount * rate;
  }

  /** Transactions up to the end of the year, oldest first (stable within a day). */
  protected history(input: TaxInput): Transaction[] {
    return input.transactions
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => yearOf(t.date) <= input.year)
      .sort((a, b) => day(a.t.date).localeCompare(day(b.t.date)) || a.i - b.i)
      .map(({ t }) => t);
  }
}
