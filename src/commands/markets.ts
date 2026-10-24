// Market data commands beyond prices: option chains, crypto market structure,
// prediction markets, and a cross-venue snapshot.
import { ruleStatus } from "../core/jurisdiction.js";
import { loadProfile } from "../core/profile.js";
import { argInt, argValue, type CommandArgs, jsonLine, UsageError } from "../engine.js";
import { binanceFuturesPositioning } from "../providers/crypto/binance-futures.js";
import { coingeckoCoin, coingeckoGlobal, coingeckoMarkets, coingeckoSearch } from "../providers/crypto/coingecko.js";
import { coinmetricsAssetMetrics } from "../providers/crypto/coinmetrics.js";
import { llamaChains, llamaFees, llamaProtocol, llamaStablecoins, llamaYields } from "../providers/crypto/defillama.js";
import { dexSearchPairs } from "../providers/crypto/dexscreener.js";
import { mempoolNetwork } from "../providers/crypto/mempool.js";
import { solanaTokenConcentration } from "../providers/crypto/solana.js";
import { tradingviewSnapshot } from "../providers/markets/tradingview.js";
import { cboeOptions } from "../providers/options/cboe.js";
import { deribitDvol, deribitOptions } from "../providers/options/deribit.js";
import { kalshiEvents, kalshiMarket, kalshiMarkets, kalshiOrderbook } from "../providers/prediction/kalshi.js";
import { manifoldMarket, manifoldSearch } from "../providers/prediction/manifold.js";
import { polymarketBook, polymarketMarkets } from "../providers/prediction/polymarket.js";
import type { Dataset } from "../core/datasets.js";
import { ProviderError } from "../providers/types.js";
import { gateContextFor } from "../trading/context.js";
import { type Order, riskGate } from "../trading/riskgate.js";
import { createTicket, recordCheck } from "../trading/tickets.js";
import { emitDatasets } from "./emit.js";

const DERIBIT = new Set(["BTC", "ETH", "BTCUSDT", "ETHUSDT", "BTC-USD", "ETH-USD"]);

export async function optionsCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0]?.toUpperCase();
  if (!sym) throw new UsageError("usage: ultrastock options <symbol> [--expiries <n>] [--out <dir>] — US listings from CBOE, BTC/ETH from Deribit");
  const maxExpiries = argInt(args, "expiries", { min: 1, max: 40 }) ?? 8;
  const out: Dataset[] = [];
  if (DERIBIT.has(sym)) {
    const cur = sym.slice(0, 3);
    out.push((await deribitOptions(cur, { maxExpiries })).dataset, (await deribitDvol(cur, 90)).dataset);
  } else out.push((await cboeOptions(sym, { maxExpiries })).dataset);
  emitDatasets(args, out, asJson);
}

export async function cryptoCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [sub, target] = args.positional;
  const limit = argInt(args, "limit", { min: 1, max: 250 });
  let ds: Dataset[];
  switch (sub) {
    case "global":
      ds = [await coingeckoGlobal()];
      break;
    case "top":
      ds = [await coingeckoMarkets({ limit: limit ?? 20 })];
      break;
    case "coin":
      if (!target) throw new UsageError("usage: ultrastock crypto coin <coingecko-id|query>");
      ds = [await coingeckoCoin(target).catch(async (e) => (e instanceof ProviderError && e.status === 404 ? coingeckoSearch(target) : Promise.reject(e)))];
      break;
    case "derivatives":
      if (!target) throw new UsageError("usage: ultrastock crypto derivatives <BTC|ETH|SOL…>");
      ds = await binanceFuturesPositioning(target);
      break;
    case "defi":
      ds = [target ? await llamaProtocol(target) : await llamaChains(limit ?? 20)];
      break;
    case "yields":
      ds = [await llamaYields({ symbol: target, limit: limit ?? 20 })];
      break;
    case "stables":
      ds = [await llamaStablecoins(limit ?? 15)];
      break;
    case "fees":
      ds = [await llamaFees({ chain: target, limit: limit ?? 20 })];
      break;
    case "onchain": {
      const asset = (target ?? "btc").toLowerCase();
      ds = [await coinmetricsAssetMetrics(asset), ...(asset === "btc" ? await mempoolNetwork() : [])];
      break;
    }
    case "dex":
      if (!target) throw new UsageError("usage: ultrastock crypto dex <token or pair query>");
      ds = [await dexSearchPairs(target, { limit: limit ?? 10 })];
      break;
    case "holders":
      if (!target) throw new UsageError("usage: ultrastock crypto holders <solana-mint-address>");
      ds = [await solanaTokenConcentration(target)];
      break;
    default:
      throw new UsageError(
        "usage: ultrastock crypto global|top|coin <id>|derivatives <coin>|defi [protocol]|yields [symbol]|stables|fees [chain]|onchain [btc|eth]|dex <query>|holders <mint>",
      );
  }
  emitDatasets(args, ds, asJson);
}

/** Prediction markets, each behind the profile's jurisdiction rule for that venue. */
export async function predictCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const [venue, ...rest] = args.positional;
  const query = rest.join(" ").trim();
  const limit = argInt(args, "limit", { min: 1, max: 100 }) ?? 10;
  const profile = loadProfile();
  if (venue === "polymarket") {
    if (!profile)
      throw new UsageError("Polymarket is blocked in some jurisdictions (France: ANJ). Set yours first: `ultrastock profile init --jurisdiction <CC>`");
    const status = ruleStatus(profile.jurisdiction, "polymarket");
    if (status === "blocked")
      throw new ProviderError(
        "jurisdiction",
        `Polymarket is blocked for residents of ${profile.jurisdiction} (BLOCKED_JURISDICTION) — not read, not paper-traded. See \`ultrastock jurisdiction show\`; Kalshi and Manifold remain available.`,
        403,
      );
    const ds = query.startsWith("book:")
      ? [(await polymarketBook(query.slice(5))).dataset]
      : [(await polymarketMarkets({ limit, ...(query ? { slug: query } : {}), active: true, closed: false })).dataset];
    return emitDatasets(args, ds, asJson);
  }
  if (venue === "order") return predictOrder(args, asJson);
  if (venue === "kalshi") {
    const ds = query.startsWith("book:")
      ? [(await kalshiOrderbook(query.slice(5))).dataset]
      : query.startsWith("market:")
        ? [await kalshiMarket(query.slice(7))]
        : query === "events"
          ? [await kalshiEvents({ status: "open", limit })]
          : [await kalshiMarkets({ status: "open", limit, ...(query ? { seriesTicker: query.toUpperCase() } : {}) })];
    return emitDatasets(args, ds, asJson);
  }
  if (venue === "manifold") {
    const ds = query.startsWith("market:") ? [await manifoldMarket(query.slice(7))] : [await manifoldSearch(query || "recession", { limit })];
    return emitDatasets(args, ds, asJson);
  }
  throw new UsageError(
    "usage: ultrastock predict kalshi [SERIES|events|market:<ticker>|book:<ticker>] | manifold <terms>|market:<id> | polymarket <query>|book:<token>",
  );
}

export async function snapshotCommand(args: CommandArgs, asJson: boolean): Promise<void> {
  const sym = args.positional[0];
  if (!sym) throw new UsageError("usage: ultrastock snapshot <symbol> — a TradingView snapshot (unofficial): ratios, performance, ratings");
  emitDatasets(args, [await tradingviewSnapshot(sym, { market: argValue(args, "market") })], asJson);
}

/**
 * `predict order kalshi <TICKER> yes|no [buy|sell] --contracts N --price P [--account id]`:
 * a paper ticket for a contract, checked by the risk gate (jurisdiction included)
 * and then filled with `paper submit` against Kalshi's live book.
 */
async function predictOrder(args: CommandArgs, asJson: boolean): Promise<void> {
  const [, venue, ticker, outcome, side = "buy"] = args.positional;
  const usage =
    "usage: ultrastock predict order kalshi <TICKER> yes|no [buy|sell] --contracts <n> --price <0-1> [--account <id>] — a paper ticket, checked by the risk gate";
  if (venue !== "kalshi" || !ticker || !/^(yes|no)$/i.test(outcome ?? "") || !/^(buy|sell)$/.test(side)) throw new UsageError(usage);
  const contracts = argInt(args, "contracts", { min: 1, max: 100_000 });
  const price = Number(argValue(args, "price"));
  if (!contracts || !(price > 0 && price < 1)) throw new UsageError(usage);
  const order: Order = {
    account: argValue(args, "account") ?? "kalshi",
    symbol: `KALSHI:${ticker.toUpperCase()}:${outcome!.toUpperCase()}`,
    side: side as "buy" | "sell",
    quantity: contracts,
    price,
    orderType: "limit",
    currency: "USD",
    assetKind: "prediction",
    venue: "paper",
  };
  const t = createTicket(order, { note: "prediction-market contract (paper)" });
  const built = await gateContextFor(order, { book: "paper" });
  const gate = riskGate(order, built.ctx);
  const after = await recordCheck(t.id, gate);
  process.stdout.write(
    asJson
      ? jsonLine({ ticket: after, checks: gate.checks, notes: built.notes })
      : `${[
          `${t.id}: ${after.status} — ${side} ${contracts} ${order.symbol} at ${price} (max ${side === "buy" ? (contracts * price).toFixed(2) : (contracts * (1 - price)).toFixed(2)} USD at risk)`,
          ...gate.checks.filter((c) => c.status !== "pass").map((c) => `  ${c.status.toUpperCase()} ${c.code}: ${c.reason}`),
          ...built.notes.map((n) => `  note: ${n}`),
          after.status === "checked" ? `next: \`ultrastock paper submit ${t.id}\` (paper only)` : "",
        ]
          .filter(Boolean)
          .join("\n")}\n`,
  );
}
