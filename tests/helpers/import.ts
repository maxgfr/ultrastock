import { readFileSync } from "node:fs";
import type { ImportTx } from "../../src/portfolio/import/index.js";
import { buildBook, type Transaction, transactionId } from "../../src/portfolio/ledger.js";

/** A synthetic statement sample from tests/fixtures/import/. */
export const sample = (name: string): string => readFileSync(new URL(`../fixtures/import/${name}`, import.meta.url), "utf8");

/** Replay parsed transactions the way the ledger would (throws on a sell beyond holdings). */
export const replay = (txs: readonly ImportTx[]) => buildBook(txs.map((t) => ({ ...t, id: transactionId(t) }) as Transaction));

export const bySymbol = (txs: readonly ImportTx[], symbol: string) => txs.filter((t) => t.symbol === symbol);
