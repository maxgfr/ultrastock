// Dollar stablecoins are worth what their market says, not their peg. A
// USDT, USDC or FDUSD amount is converted at its live USD price — Kraken's
// <COIN>/USD book, Coinbase's <COIN>-USD as a fallback — times the dollar's
// rate, and a coin trading off its peg is said, and blocks a live order (the
// gate in trading/live.ts).
//
// What stays written here: which tokens are dollar stablecoins — what their
// issuer pegs them to (a definition, not a price) — and the deviation from the
// peg that is called a depeg, PEG_DEVIATION_PCT, an assumption stated with
// every warning. A rate that cannot be read (offline, a fixture replay that
// never recorded it) degrades to a note and the peg; the live gate refuses.
import type { Dataset, Point } from "../core/datasets.js";
import { coinbaseQuote, resolveCoinbase } from "../providers/markets/coinbase.js";
import { krakenQuote, resolveKraken } from "../providers/markets/kraken.js";
import type { QuoteResult } from "../providers/types.js";

/** Tokens whose issuer pegs them to one US dollar. */
export const DOLLAR_STABLECOINS: ReadonlySet<string> = new Set(["USDT", "USDC", "FDUSD", "BUSD"]);
export const isDollarStablecoin = (c: string): boolean => DOLLAR_STABLECOINS.has(c.toUpperCase());

/**
 * Off its 1 USD peg by more than this (%), a stablecoin is called depegged: an assumption — a stable coin's ordinary
 * wobble stays well inside it, a real loss of confidence goes well beyond.
 */
export const PEG_DEVIATION_PCT = 0.5;

export interface PegReading {
  coin: string;
  /** USD per coin, when it could be read. */
  usd?: number;
  /** (usd − 1) × 100. */
  deviationPct?: number;
  depegged?: boolean;
  quote?: QuoteResult;
  /** Why the rate could not be read. */
  unread?: string;
}

/** One stablecoin's live USD price: Kraken first, Coinbase if Kraken has no book or does not answer. */
export async function stablecoinUsd(coin: string): Promise<QuoteResult> {
  const pair = `${coin.toUpperCase()}-USD`;
  const errors: string[] = [];
  try {
    return await krakenQuote(await resolveKraken(pair));
  } catch (e) {
    errors.push(`kraken: ${(e as Error).message}`);
  }
  try {
    return await coinbaseQuote(resolveCoinbase(pair));
  } catch (e) {
    errors.push(`coinbase: ${(e as Error).message}`);
  }
  throw new Error(errors.join("; "));
}

/** Read each coin's peg; never throws — an unread rate is said in `unread`. */
export async function readPegs(coins: readonly string[]): Promise<PegReading[]> {
  const out: PegReading[] = [];
  for (const coin of [...new Set(coins.map((c) => c.toUpperCase()))].filter(isDollarStablecoin)) {
    try {
      const quote = await stablecoinUsd(coin);
      const deviationPct = (quote.price - 1) * 100;
      out.push({ coin, usd: quote.price, deviationPct, depegged: Math.abs(deviationPct) > PEG_DEVIATION_PCT, quote });
    } catch (e) {
      out.push({ coin, unread: (e as Error).message });
    }
  }
  return out;
}

/** What to say about each reading: the rate used, a depeg, or the peg taken unverified. */
export function pegNotes(readings: readonly PegReading[]): string[] {
  return readings.map((r) => {
    if (r.usd === undefined)
      return `${r.coin}'s USD rate could not be read (${r.unread}): ${r.coin} amounts are converted at its 1 USD peg, unverified — a live order in ${r.coin} is refused until it can be read`;
    const at = `${r.usd} USD (${r.quote!.provenance.source} ${r.coin}/USD, ${r.quote!.at})`;
    return r.depegged
      ? `${r.coin} trades at ${at}: ${r.deviationPct!.toFixed(2)} % off its 1 USD peg, beyond the ${PEG_DEVIATION_PCT} % treated as a depeg (an assumption) — amounts in ${r.coin} are converted at that rate, and a live order in it is refused`
      : `${r.coin} amounts converted at its live rate ${at}, ${r.deviationPct!.toFixed(2)} % from its peg`;
  });
}

/** Each reading as a dataset with one `<COIN>.usd` point and the venue's provenance, for an evidence store. */
export function pegDatasets(readings: readonly PegReading[]): Dataset[] {
  return readings
    .filter((r) => r.quote)
    .map((r) => {
      const p = r.quote!.provenance;
      const point: Point = { key: `${r.coin}.usd`, label: `${r.coin} price in US dollars`, value: r.usd!, unit: "USD" };
      return {
        kind: "fx",
        title: `${r.coin} against the US dollar`,
        subject: r.coin,
        points: [point],
        provenance: { ...p, asOf: p.fetchedAt.slice(0, 10) },
        notes: pegNotes([r]),
      };
    });
}
