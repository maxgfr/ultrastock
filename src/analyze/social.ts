// Retail attention for one instrument: its Reddit rank (ApeWisdom, US
// listings and coins) and its Wikipedia pageviews against their baseline
// (equities with an ISIN or an SEC CIK). Each source is its own dataset; a
// source that fails or does not cover the name leaves a note, never a zero.
import type { Dataset } from "../core/datasets.js";
import { FixtureMiss } from "../core/net.js";
import { secCompany } from "../providers/fundamentals/sec.js";
import { apeTicker, apewisdomBoard, redditDataset, wikipediaAttention } from "../providers/macro/social.js";
import type { Instrument } from "../providers/types.js";

const why = (e: unknown) => (e instanceof FixtureMiss ? "did not answer when the fixture was recorded" : (e as Error).message);

/** The base asset of a crypto instrument (BTC for BTCUSDT or "BTC/USDT"). */
export function cryptoBase(inst: Pick<Instrument, "symbol" | "name">): string {
  return (inst.name?.split("/")[0] ?? inst.symbol.replace(/(USDT|USDC|USD|EUR)$/i, "")).toUpperCase();
}

export async function socialDatasets(inst: Instrument): Promise<{ datasets: Dataset[]; notes: string[] }> {
  const datasets: Dataset[] = [];
  const notes: string[] = [];
  const S = inst.symbol;
  const crypto = inst.market === "crypto";

  const ticker = apeTicker(S, inst.market, crypto ? cryptoBase(inst) : undefined);
  if (!ticker) notes.push(`Reddit attention: ApeWisdom ranks US-listed tickers and coins only, not ${S}`);
  else {
    const filter = crypto ? "all-crypto" : "all-stocks";
    try {
      datasets.push(redditDataset(S, ticker, await apewisdomBoard(filter), filter));
    } catch (e) {
      notes.push(`Reddit attention unavailable: ${why(e)}`);
    }
  }

  if (inst.kind === "equity") {
    try {
      let cik: number | undefined;
      if (inst.market === "us")
        cik = await secCompany(S.split("|")[0]!).then(
          (c) => c.cik,
          () => undefined,
        );
      const w = await wikipediaAttention(S, { isin: inst.isin, cik });
      if (w.dataset) datasets.push(w.dataset);
      if (w.note) notes.push(w.note);
    } catch (e) {
      notes.push(`Wikipedia attention unavailable: ${why(e)}`);
    }
  } else if (!crypto) notes.push(`Wikipedia attention: read for companies only, not a${inst.kind === "etf" ? "n" : ""} ${inst.kind}`);
  return { datasets, notes };
}
