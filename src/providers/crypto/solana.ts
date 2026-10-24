// SPL token holder concentration read from the Solana ledger itself, over
// JSON-RPC — keyless on the Solana Foundation's public endpoint:
//
//   POST https://api.mainnet-beta.solana.com
//     getTokenSupply(mint)            total supply, decimals
//     getTokenLargestAccounts(mint)   the 20 largest token accounts
//
// The ledger is the primary record, but an RPC node is neither an exchange nor
// an issuer, and a user-supplied RPC can say anything: marked unofficial. Two
// limits: the public endpoint throttles getTokenLargestAccounts hard (in
// October 2026 it answered "429 Too many requests for a specific RPC call"
// even to a single call), so ULTRASTOCK_SOLANA_RPC may name the user's own RPC
// URL; and the largest *accounts* are not the largest *owners* — an exchange
// hot wallet, a liquidity pool or a vesting program shows up as one "holder".
// JSON-RPC errors arrive inside an HTTP 200: they are mapped to the same
// transient/definitive split as HTTP statuses.
import type { Dataset, Point } from "../../core/datasets.js";
import { fetchJson } from "../../core/net.js";
import { ProviderError } from "../types.js";

export const SOURCE = "solana-rpc";
export const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

function rpcUrl(): string {
  const env = process.env.ULTRASTOCK_SOLANA_RPC;
  return env && /^https:\/\//.test(env) ? env : PUBLIC_RPC;
}

export interface TokenAmount {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString?: string;
}

/** A token amount in whole tokens, exact enough for shares (uiAmount, else amount / 10^decimals). */
export function tokenUnits(a: TokenAmount): number {
  if (typeof a.uiAmount === "number" && Number.isFinite(a.uiAmount)) return a.uiAmount;
  return Number(a.amount) / 10 ** a.decimals;
}

export interface Concentration {
  supply: number;
  accounts: number;
  topN: number;
  /** % of supply held by the N largest accounts. */
  topShare: number;
  /** % of supply held by the single largest account. */
  top1Share: number;
}

/** Share of supply held by the `n` largest accounts. Undefined when supply is not positive. */
export function holderConcentration(largest: readonly TokenAmount[], supply: TokenAmount, n = 10): Concentration | undefined {
  const total = tokenUnits(supply);
  if (!(total > 0)) return undefined;
  const sorted = largest.map(tokenUnits).sort((a, b) => b - a);
  const top = sorted.slice(0, n);
  return {
    supply: total,
    accounts: sorted.length,
    topN: top.length,
    topShare: (top.reduce((s, v) => s + v, 0) / total) * 100,
    top1Share: ((top[0] ?? 0) / total) * 100,
  };
}

/** Map a JSON-RPC answer (HTTP status + body) to its result, or a ProviderError. */
export function rpcResult<T>(method: string, status: number, body: { result?: T; error?: { code?: number; message?: string } } | undefined): T {
  const code = body?.error?.code;
  if (status === 429 || code === 429)
    throw new ProviderError(SOURCE, `${method}: the RPC throttles this call (429) — set ULTRASTOCK_SOLANA_RPC to your own RPC URL`, 429);
  if (body?.error) throw new ProviderError(SOURCE, `${method}: RPC error ${code ?? "?"}`, code !== undefined && code <= -32000 && code > -32100 ? 503 : 400);
  if (status >= 400 || status === 0 || body?.result === undefined) throw new ProviderError(SOURCE, `${method} failed (${status})`, status || 0);
  return body.result;
}

async function rpc<T>(method: string, params: unknown[]): Promise<{ result: T; url: string; fetchedAt: string }> {
  const url = rpcUrl();
  const res = await fetchJson<{ result?: T; error?: { code?: number; message?: string } }>(url, {
    method: "POST",
    json: { jsonrpc: "2.0", id: 1, method, params },
    hostIntervalMs: 500,
  });
  let body = res.data;
  if (!body && res.body)
    try {
      body = JSON.parse(res.body);
    } catch {
      body = undefined;
    }
  return { result: rpcResult<T>(method, res.status, body), url: url === PUBLIC_RPC ? url : "solana-rpc (ULTRASTOCK_SOLANA_RPC)", fetchedAt: res.fetchedAt };
}

/** Concentration as points: top-10 and top-1 shares, supply, accounts seen. */
export function concentrationPoints(mint: string, c: Concentration, asOf: string): Point[] {
  const k = `SOL.${mint.slice(0, 10)}`;
  const t = `SPL token ${mint.slice(0, 8)}…`;
  return [
    {
      key: `${k}.holders.top${c.topN}Share`,
      label: `${t} share of supply in the ${c.topN} largest accounts`,
      value: c.topShare,
      unit: "%",
      asOf,
      formula: `Σ uiAmount(top ${c.topN} accounts) / supply × 100`,
    },
    {
      key: `${k}.holders.top1Share`,
      label: `${t} share of supply in the largest account`,
      value: c.top1Share,
      unit: "%",
      asOf,
      formula: "uiAmount(largest account) / supply × 100",
    },
    { key: `${k}.supply`, label: `${t} total supply`, value: c.supply, unit: "tokens", asOf },
  ];
}

/** Top-10 holder concentration of an SPL token mint. */
export async function solanaTokenConcentration(mint: string, n = 10): Promise<Dataset> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new ProviderError(SOURCE, "not a base58 Solana mint address", 400);
  const supply = await rpc<{ value: TokenAmount }>("getTokenSupply", [mint]);
  const largest = await rpc<{ value: TokenAmount[] }>("getTokenLargestAccounts", [mint]);
  const c = holderConcentration(largest.result.value, supply.result.value, n);
  if (!c) throw new ProviderError(SOURCE, `mint ${mint} reports no supply`, 404);
  const asOf = largest.fetchedAt.slice(0, 10);
  const notes = [
    "largest token ACCOUNTS, not owners: exchange wallets, liquidity pools, vesting and burn accounts each count as one holder",
    `the RPC returns at most 20 accounts; shares are over the ${c.topN} largest of them`,
  ];
  if (c.topShare >= 50) notes.push(`the ${c.topN} largest accounts hold half the supply or more: check who they are before trusting the float`);
  return {
    kind: "crypto-onchain",
    title: `SPL token ${mint.slice(0, 8)}… holder concentration`,
    subject: mint,
    points: concentrationPoints(mint, c, asOf),
    provenance: { source: SOURCE, url: largest.url, fetchedAt: largest.fetchedAt, delay: "realtime", official: false, asOf },
    notes,
  };
}
