// The US regime for a resident individual (Form 1040).
//
// - Lots per account and security, matched FIFO by default (HIFO / LIFO on
//   request — a standing instruction the broker must hold too); basis includes
//   the buy fee, proceeds are net of the sell fee (Form 8949 columns d/e).
// - Long-term when the asset is held more than one year (sold after the first
//   anniversary of the acquisition), short-term otherwise.
// - A transfer between the user's own accounts is not a disposal: a
//   transfer-in without a price takes the lots (basis and acquisition date)
//   that a transfer-out of the same symbol from another account gave up —
//   except out of an IRA into a taxable account: a distribution, valued at its
//   date (Pub. 590-B).
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
  chronological,
  day,
  type EnvelopeRule,
  envelopeOf,
  type Figure,
  type FormLine,
  gross,
  type HarvestCandidate,
  isCryptoTx,
  isFiat,
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
  /** What is held: the symbol of a security, the base asset of a crypto pair (BTCUSD and BTCUSDT both hold BTC). */
  asset: string;
  /** The currency `symbol` is quoted in (USD, EUR, BTC for ETHBTC): what a market price of it is in. */
  currency: string;
  /** Acquisition date for the holding period (moved back by a wash sale). */
  acquired: string;
  /** The real purchase date (wash-sale window). */
  bought: string;
  /** Units of the lot (less those split off into a replacement piece of their own). */
  quantity: number;
  remaining: number;
  /** Basis per unit, USD, adjustments included. */
  basis: number;
  /** Shares of this lot already used as a wash-sale replacement. */
  replaced: number;
  /**
   * Acquired by purchase (§1091(a)): only such shares can be a wash-sale replacement. A transfer-in is shares moving
   * between the user's own accounts (or out of an IRA, a gift…), never a purchase, whatever order the statement lists it in.
   */
  purchase: boolean;
  /** A lot carried from another account: the purchase whose shares it holds (§1223(1): same basis, same holding period). */
  origin?: UsLot;
  sheltered: boolean;
  crypto: boolean;
}

const SHELTERED = new Set(["IRA", "ROTH-IRA", "401K"]);
/**
 * How long shares that left an account wait for the transfer-in that receives them: a move between brokers (ACATS) or
 * wallets takes days, not months — what arrives later is other shares, from outside the ledger. Not a tax parameter.
 */
const TRANSIT_DAYS = 30;
/**
 * The note an importer gives a reward it books as a transfer-in without a price (Kraken "kraken staking reward: …",
 * Binance "binance <operation>: …"), or a hand-written one saying so.
 */
const REWARD_NOTE = /\b(staking|rewards?|airdrops?|interest|income|distribution|rebate|cashback|bonus|mining|launchpool|referral)\b/i;
/** Brokers outside the US (their accounts are foreign financial accounts for a US person). */
const NON_US_BROKERS =
  /degiro|trade ?republic|bourso|fortuneo|bourse ?direct|saxo|scalable|xtb|lightyear|trading ?212|revolut|bitpanda|bitstamp|binance(?!\.?us)|bnp|cr[eé]dit|soci[eé]t[eé]|lcl|linxea|bforbank|hello ?bank|freedom ?24/i;

/** What a row moves: the security, or the crypto-asset whatever the pair a platform quotes it in. */
const assetOf = (t: Transaction, crypto: boolean) => (crypto ? splitPair(t.symbol ?? "", t.currency).base : (t.symbol ?? "").toUpperCase());

/**
 * A crypto row that moves no virtual currency the engine taxes: a stablecoin traded as such (dollars here), or fiat
 * changed into a stablecoin or back on a fiat-base pair (EURUSDT) — a currency exchange, not a disposal of virtual
 * currency (IRS Notice 2014-21); a foreign-currency gain on the euros is §988's, not Form 8949's.
 */
const dollarLike = (t: Transaction, crypto: boolean): boolean => {
  if (!crypto) return false;
  const base = splitPair(t.symbol ?? "", t.currency).base;
  return isStablecoin(base) || (isFiat(base) && (isStablecoin(t.currency) || isFiat(t.currency)));
};

/**
 * The crypto-asset a trade is priced in (BTC in ETHBTC): a buy gives it, a sale receives it — a disposal and an
 * acquisition at fair value of their own (IRS Notice 2014-21). Fiat and stablecoins (dollars here) are not.
 */
function cryptoQuote(t: Transaction, crypto: boolean): string | undefined {
  if (!crypto || (t.type !== "buy" && t.type !== "sell")) return undefined;
  const c = t.currency.toUpperCase();
  if (isFiat(c) || isStablecoin(c) || isFiat(splitPair(t.symbol ?? "", c).base)) return undefined;
  return c;
}

/**
 * Long-term when sold after the first anniversary of the acquisition (IRS Pub. 550). The holding period starts the day
 * after the acquisition and is counted in calendar months (Rev. Rul. 66-7): bought on the last day of a month, it is
 * long-term from the first day of the thirteenth month — the anniversary of a last-of-February date is the last day of
 * February a year later (2023-02-28 → 2024-02-29, 2024-02-29 → 2025-02-28).
 */
export function isLongTerm(acquired: string, sold: string): boolean {
  const [y, m, d] = acquired.slice(0, 10).split("-").map(Number) as [number, number, number];
  const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = d === lastDay(y, m) ? lastDay(y + 1, m) : Math.min(d, lastDay(y + 1, m));
  const anniversary = `${y + 1}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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

  /**
   * Every purchase becomes a lot up front, so a later replacement buy can absorb a disallowed loss — the crypto-asset a
   * sale is paid in too (`received`, by sale).
   */
  private lots(input: TaxInput, history: Transaction[]): { lots: UsLot[]; byTx: Map<Transaction, UsLot>; received: Map<Transaction, UsLot> } {
    const lots: UsLot[] = [];
    const byTx = new Map<Transaction, UsLot>();
    const received = new Map<Transaction, UsLot>();
    for (const t of history) {
      const env = envelopeOf(t.account, input.envelopes, t.symbol, t.isin);
      const crypto = isCryptoTx(t, input.envelopes);
      const quote = t.type === "sell" ? cryptoQuote(t, crypto) : undefined;
      if (quote) {
        // What the sale received, net of its fee, at its fair value: the same dollars as the sale's proceeds.
        const q = gross(t) - (t.fee ?? 0);
        const lot: UsLot = {
          id: lots.length,
          account: t.account,
          symbol: quote,
          asset: quote,
          currency: "USD",
          acquired: day(t.date),
          bought: day(t.date),
          quantity: q,
          remaining: q,
          basis: q > 0 ? this.toBase(t, q, input) / q : 0,
          replaced: 0,
          purchase: true,
          sheltered: SHELTERED.has(env.type),
          crypto,
        };
        lots.push(lot);
        received.set(t, lot);
      }
      if (t.type !== "buy" && t.type !== "transfer-in") continue;
      if (dollarLike(t, crypto)) continue;
      const q = t.quantity ?? 0;
      const cost = t.price !== undefined ? this.toBase(t, gross(t), input) + this.toBase(t, t.fee ?? 0, input) : 0;
      const lot: UsLot = {
        id: lots.length,
        account: t.account,
        symbol: (t.symbol ?? "").toUpperCase(),
        asset: assetOf(t, crypto),
        currency: t.currency.toUpperCase(),
        acquired: day(t.date),
        bought: day(t.date),
        quantity: q,
        remaining: q,
        basis: q ? cost / q : 0,
        replaced: 0,
        purchase: t.type === "buy",
        sheltered: SHELTERED.has(env.type),
        crypto,
      };
      lots.push(lot);
      byTx.set(t, lot);
    }
    return { lots, byTx, received };
  }

  /** Replay; returns the year's events and the open lots at the year's end (or at `until`). */
  replay(input: TaxInput, until?: string): { events: TaxEvent[]; open: UsLot[]; warnings: string[]; lots: UsLot[] } {
    const history = this.history(input).filter((t) => !until || day(t.date) <= until);
    // §1091(a): the window of a sale runs 30 days after it, past the year's end. The purchases of those days become
    // lots up front — candidates to replace a December loss, nothing more: they are never replayed into this year.
    const yearEnd = `${input.year}-12-31`;
    const after = until
      ? []
      : chronological(
          input.transactions.filter((t) => t.type === "buy" && day(t.date) > yearEnd && day(t.date) <= addDays(yearEnd, this.param("washSale.windowDays"))),
        );
    const { lots, byTx, received } = this.lots(input, [...history, ...after]);
    const events: TaxEvent[] = [];
    const warnings: string[] = [];
    const active = new Set<UsLot>();
    /** Replacement shares split off a purchase not replayed yet: they enter the book with it. */
    const pieces = new Map<UsLot, UsLot[]>();
    const method = input.lotMethod ?? "fifo";
    const washCrypto = this.param<string>("washSale.crypto") !== "not applied";
    const window = this.param("washSale.windowDays");
    const inYear = (t: Transaction) => yearOf(t.date) === input.year;
    let stableNoted = false;
    // Shares moved between the user's own accounts keep their basis and holding period: what a transfer-out takes from
    // its lots waits here for a transfer-in (without a price) of the same security — or crypto-asset, whichever pair each
    // platform books it under — into another account within TRANSIT_DAYS.
    const inTransit: Array<{ account: string; asset: string; date: string; lot: UsLot; qty: number }> = [];
    let unmatched: UsLot[] = [];
    /** Units of a transfer-in without a price that no transfer-out gave: basis 0 from the transfer date, named. */
    const unpriced: UsLot[] = [];
    /** Rewards booked as a transfer-in without a price: basis 0 from the day received, named. */
    const rewards: UsLot[] = [];
    /** The lots in other accounts that hold shares of a purchase, by purchase: a wash adjustment follows them there. */
    const carriedOf = new Map<UsLot, UsLot[]>();
    const holds = (purchase: UsLot, l: UsLot) => carriedOf.set(purchase, [...(carriedOf.get(purchase) ?? []), l]);
    const carry = (into: UsLot): boolean => {
      let need = into.quantity;
      const pieces: Array<{ from: UsLot; qty: number }> = [];
      for (const s of inTransit) {
        if (need <= 1e-12) break;
        if (s.asset !== into.asset || s.account === into.account || s.qty <= 1e-12 || into.bought > addDays(s.date, TRANSIT_DAYS)) continue;
        const q = Math.min(need, s.qty);
        s.qty -= q;
        need -= q;
        pieces.push({ from: s.lot, qty: q });
      }
      if (!pieces.length) return false;
      const rest = need > 1e-12 ? { ...into, quantity: need, remaining: need } : undefined;
      // The transfer-in as it arrived: the first piece reuses `into` and takes its source's basis and dates, so every
      // other piece starts from this copy, never from the first piece.
      const arrived = { ...into };
      pieces.forEach(({ from, qty }, i) => {
        const piece = i === 0 ? into : { ...arrived, id: lots.length };
        if (from.sheltered && !into.sheltered) {
          // Out of an IRA into a taxable account: a distribution, not a move. The shares take their fair market value on
          // that date as basis and their holding period starts then (IRS Pub. 590-B) — a value the ledger does not hold.
          Object.assign(piece, { quantity: qty, remaining: qty });
          warnings.push(
            `${into.symbol} moved out of ${from.account} (${envelopeOf(from.account, input.envelopes).type}) into ${into.account} on ${arrived.bought}: a distribution, whose basis is the fair market value on that date (IRS Pub. 590-B) — give the transfer-in that value as its price (basis 0 until then)`,
          );
          if (i > 0) lots.push(piece);
          active.add(piece);
          return;
        }
        // The same shares, not a new purchase (never a replacement themselves): they keep the basis, the holding period
        // and whether they already are replacement shares, and a wash sale matched to their purchase later lands here.
        const origin = from.origin ?? from;
        Object.assign(piece, {
          quantity: qty,
          remaining: qty,
          basis: from.basis,
          acquired: from.acquired,
          bought: from.bought,
          replaced: from.replaced >= from.quantity - 1e-12 ? qty : 0,
          origin,
        });
        if (i > 0) lots.push(piece);
        active.add(piece);
        holds(origin, piece);
      });
      if (rest) {
        rest.id = lots.length;
        lots.push(rest);
        active.add(rest);
        unpriced.push(rest);
      }
      return true;
    };
    /**
     * `qty` of `asset` leave the account's lots (by the lot method): a transfer-out puts what it took in transit, a sale
     * (or the crypto-asset given in a trade) books each lot's part on Form 8949 with `proceedsTotal` (USD) pro rata.
     */
    const dispose = (t: Transaction, asset: string, sym: string, qty: number, proceedsTotal: number, crypto: boolean, extra: string[] = []): void => {
      const env = envelopeOf(t.account, input.envelopes, t.symbol, t.isin);
      const base = {
        date: day(t.date),
        account: t.account,
        envelope: env.type,
        symbol: sym === (t.symbol ?? "").toUpperCase() ? t.symbol : sym,
        notes: [] as string[],
      };
      const pool = [...active].filter((l) => l.asset === asset && l.account === t.account && l.remaining > 1e-12);
      pool.sort(
        (a, b) =>
          (method === "hifo" ? b.basis - a.basis : method === "lifo" ? b.bought.localeCompare(a.bought) : a.bought.localeCompare(b.bought)) || a.id - b.id,
      );
      let left = qty;
      const perUnit = qty ? proceedsTotal / qty : 0;
      const consumed: Array<{ lot: UsLot; qty: number }> = [];
      for (const l of pool) {
        if (left <= 1e-12) break;
        const q = Math.min(left, l.remaining);
        l.remaining -= q;
        left -= q;
        consumed.push({ lot: l, qty: q });
      }
      if (left > 1e-9)
        warnings.push(`${sym} (${t.account}) disposed ${qty} on ${day(t.date)} with ${round2(qty - left)} in recorded lots: the rest has no basis`);
      if (t.type === "transfer-out") {
        for (const c of consumed) inTransit.push({ account: t.account, asset, date: day(t.date), lot: c.lot, qty: c.qty });
        // A statement may list the day's transfer-in before its transfer-out: an untouched one of that day still takes it.
        unmatched = unmatched.filter((l) => !(l.bought === day(t.date) && l.remaining === l.quantity && carry(l)));
        return;
      }
      if (SHELTERED.has(env.type)) return;
      if (left > 1e-9)
        consumed.push({
          lot: {
            id: -1,
            account: t.account,
            symbol: sym,
            asset,
            currency: t.currency.toUpperCase(),
            acquired: day(t.date),
            bought: day(t.date),
            quantity: left,
            remaining: 0,
            basis: 0,
            replaced: 0,
            purchase: false,
            sheltered: false,
            crypto,
          },
          qty: left,
        });
      for (const { lot: l, qty } of consumed) {
        const proceeds = perUnit * qty;
        const cost = l.basis * qty;
        let gain = proceeds - cost;
        let disallowed = 0;
        const notes: string[] = [...extra];
        if (gain < 0 && (!l.crypto || washCrypto)) {
          // Replacement shares bought within ±30 days (any account), not the shares sold, not already used — bought: a
          // transfer-in, even one replayed before its transfer-out, acquires nothing. A purchase this same sale dips
          // into still replaces with the shares it keeps (its `remaining`, already net of this sale): only the lot of
          // the loss itself is never its own replacement.
          const from = addDays(day(t.date), -window);
          const to = addDays(day(t.date), window);
          let need = qty;
          const lossPerShare = -gain / qty;
          const held = Date.parse(`${day(t.date)}T00:00:00Z`) - Date.parse(`${l.acquired}T00:00:00Z`);
          // `q` replacement shares of `h` split off into a lot of their own, used up as a replacement; the rest of `h`
          // keeps its basis and date.
          const take = (h: UsLot, q: number): UsLot => {
            if (q >= h.quantity - 1e-12) {
              h.replaced = h.quantity;
              return h;
            }
            const w: UsLot = { ...h, id: lots.length, quantity: q, remaining: Math.min(q, h.remaining), replaced: q };
            h.quantity -= q;
            h.remaining -= w.remaining;
            lots.push(w);
            if (active.has(h)) active.add(w);
            else pieces.set(h, [...(pieces.get(h) ?? []), w]);
            if (w.origin) holds(w.origin, w);
            return w;
          };
          for (const r of lots) {
            if (need <= 1e-12) break;
            if (!r.purchase || r.asset !== asset || r.bought < from || r.bought > to || r.id === l.id) continue;
            // Only replacement shares that still exist can take the loss into their basis: those already sold (or used
            // by an earlier wash sale) are not counted, and the loss they cannot take stays allowed.
            const here = r.replaced >= r.quantity - 1e-12 ? 0 : active.has(r) ? r.remaining : r.quantity;
            const carried = (carriedOf.get(r) ?? []).filter((c) => active.has(c) && c.replaced < c.quantity - 1e-12 && c.remaining > 1e-12);
            const avail = r.sheltered ? r.quantity - r.replaced : here + carried.reduce((a, c) => a + c.remaining, 0);
            if (avail <= 1e-12) continue;
            const q = Math.min(need, avail);
            const loss = lossPerShare * q;
            disallowed += loss;
            need -= q;
            if (r.sheltered) {
              r.replaced += q;
              notes.push(`wash sale against a purchase in ${r.account} (${r.bought}): the ${round2(loss)} $ loss is lost for good (IRA replacement)`);
              continue;
            }
            // §1091(d) and §1223(3): the q replacement shares take the loss in their basis and the sold shares' holding
            // time before their own purchase date — wherever they now are: still in the purchase's account, or moved
            // to another of the user's accounts (the lots carried from it).
            const holders: Array<[UsLot, number]> = [];
            let left = q;
            for (const [h, has] of [[r, here] as const, ...carried.map((c) => [c, c.remaining] as const)]) {
              if (left <= 1e-12) break;
              const n = Math.min(left, has);
              if (n > 1e-12) holders.push([h, n]);
              left -= n;
            }
            for (const [h, n] of holders) {
              const w = take(h, n);
              // Shares carried from r count as r's: r has that many fewer left to be a replacement.
              if (h !== r) r.quantity -= n;
              w.basis += lossPerShare;
              w.acquired = new Date(Date.parse(`${w.bought}T00:00:00Z`) - held).toISOString().slice(0, 10);
              notes.push(
                `wash sale: ${round2(lossPerShare * n)} $ added to the basis of ${round2(n)} share(s) bought ${r.bought} in ${r.account}${h.account !== r.account ? `, now in ${h.account}` : ""}`,
              );
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
    };
    for (const t of history) {
      const env = envelopeOf(t.account, input.envelopes, t.symbol, t.isin);
      const sym = (t.symbol ?? "").toUpperCase();
      const crypto = isCryptoTx(t, input.envelopes);
      const base = { date: day(t.date), account: t.account, envelope: env.type, symbol: t.symbol, notes: [] as string[] };
      const quote = cryptoQuote(t, crypto);
      if (quote && t.type === "buy") {
        const given = gross(t) + (t.fee ?? 0);
        dispose(t, quote, quote, given, this.toBase(t, given, input), true, [
          `${quote} given for ${t.quantity} ${sym}: a disposal at fair value (IRS Notice 2014-21) — the same dollars are the basis of the ${splitPair(sym, quote).base} received`,
        ]);
      }
      const got = received.get(t);
      if (got) active.add(got);
      const lot = byTx.get(t);
      if (lot) {
        active.add(lot);
        for (const w of pieces.get(lot) ?? []) active.add(w);
        if (t.type === "transfer-in" && t.price === undefined) {
          // A reward is new coins, never coins moved from another account: it takes no transfer's basis or date.
          if (REWARD_NOTE.test(t.note ?? "")) rewards.push(lot);
          else if (!carry(lot)) unmatched.push(lot);
        }
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
        if (dollarLike(t, crypto)) {
          if (!stableNoted) warnings.push("stablecoins are treated as dollars: their (small) gains and losses are ignored");
          stableNoted = true;
          continue;
        }
        const proceeds = t.type === "sell" ? this.toBase(t, gross(t), input) - this.toBase(t, t.fee ?? 0, input) : 0;
        dispose(t, assetOf(t, crypto), sym, t.quantity ?? 0, proceeds, crypto);
        continue;
      }
      if (SHELTERED.has(env.type)) continue;
      if ((t.type === "dividend" || t.type === "interest") && inYear(t)) {
        const amount = this.toBase(t, t.amount ?? 0, input);
        const notes: string[] = [];
        let qualified: boolean | undefined;
        if (t.type === "dividend") {
          // Held more than 60 days around the payment (the ex-date is not in the ledger: an approximation).
          // Only what is still held earns the dividend: a lot sold out years ago says nothing of this holding period.
          const held = [...active].filter((l) => l.symbol === sym && l.account === t.account && l.remaining > 1e-12);
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
        // A tax row is the cash it moved: negative when withheld, positive when the broker hands it back.
        const withheld = round2(-this.toBase(t, t.amount ?? 0, input));
        events.push({
          ...base,
          kind: "withholding",
          amount: withheld,
          notes: [
            withheld < 0
              ? "refund of foreign tax withheld earlier (a reversal on the statement): it comes off the tax paid"
              : "foreign tax withheld: a foreign tax credit (Form 1116, or directly on Schedule 3 up to $300 / $600 joint)",
          ],
        });
      }
    }
    for (const l of rewards)
      if (!l.sheltered)
        warnings.push(
          `${l.symbol} transferred into ${l.account} on ${l.bought} without a price is a reward (staking, interest, airdrop): ordinary income at its fair market value when received, which is also its basis, held from that day (Rev. Rul. 2023-14, Notice 2014-21) — basis 0 from that date until you give that value as its price`,
        );
    for (const l of [...unmatched, ...unpriced])
      if (!l.sheltered)
        warnings.push(
          `${l.symbol} transferred into ${l.account} on ${l.bought} without a price: ${round2(l.quantity * 1e6) / 1e6} of it match no transfer-out from another account in the ${TRANSIT_DAYS} days before — basis 0 from that date; give the original cost (or the value received, for a gift or a distribution) as its price`,
        );
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
    if (wh > 0)
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
      const quoted = prices[l.symbol];
      if (quoted === undefined) continue;
      // The price is in the symbol's quote (BTC for ETHBTC, EUR for a Paris listing), the basis in dollars: compared in
      // dollars at the day's rate, else not at all.
      const c = isStablecoin(l.currency) ? (l.currency.startsWith("EUR") ? "EUR" : "USD") : l.currency;
      const toUsd = c === "USD" ? 1 : input.fx(c, asOf);
      if (toUsd === undefined) continue;
      const px = quoted * toUsd;
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
        price: round2(px),
        cost: round2(l.basis * l.remaining),
        unrealized: round2(unrealized),
        term,
        saving: round2(offset * rate),
        formula: `min(${round2(-unrealized)}, gains ${round2(Math.max(0, realized))} + ${this.param("capitalLoss.ordinaryLimit")}) × ${rate}${input.marginalRate === undefined ? " (assumed rate: pass --marginal-rate)" : ""}`,
        notes: [
          `lot bought ${l.bought}${l.acquired !== l.bought ? ` (holding period from ${l.acquired})` : ""}`,
          c !== "USD" ? `priced ${quoted} ${l.currency} = ${round2(px)} $ at the ${asOf} rate` : "",
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
