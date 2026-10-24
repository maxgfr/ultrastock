// The contract every live venue adapter implements. Adapters are thin: they
// sign and send one request and parse one answer. Everything that decides
// WHETHER an order may go — the risk gate, the out-of-band code, the limits,
// the jurisdiction, the kill switch, the lock, the audit — lives in
// trading/live.ts and trading/transport.ts, never in an adapter.
//
// Rules for adapters:
// - Spot / cash only, LIMIT orders only, no margin, no short, no withdrawal or
//   transfer endpoint is ever implemented.
// - `submit` sends exactly one request with retries: 0. A timeout or a network
//   error is reported as `{ state: "unknown" }`, never retried here: the
//   transport reconciles by clientOrderId before anything else is sent.
// - Every adapter has a native dry run (`preview`): Binance order/test (and the
//   testnet), Kraken validate=true, Coinbase orders/preview, IBKR whatif.
// - Credentials come in as an argument (from trading/secrets.ts) and never
//   appear in an error message, a log line or a return value.

export type Venue = "binance" | "kraken" | "coinbase" | "ibkr" | "kalshi";
export type Environment = "test" | "live";

export interface Credentials {
  key: string;
  secret: string;
  /** Coinbase CDP: the key name ("organizations/…/apiKeys/…"); the secret is the EC private key (PEM). */
  keyName?: string;
  /** Kraken: optional 2FA password on the key. */
  passphrase?: string;
}

export interface LiveOrder {
  /** Venue symbol: BTCUSDT (Binance), XBTEUR (Kraken), BTC-EUR (Coinbase), an IBKR conid as a string. */
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  limitPrice: number;
  /** Ours, unique, sent to the venue so a lost answer can be found again: a UUID (36 chars). */
  clientOrderId: string;
  timeInForce?: "GTC" | "IOC" | "DAY";
}

export type OrderState = "accepted" | "filled" | "partially-filled" | "cancelled" | "rejected" | "unknown";

export interface OrderResult {
  state: OrderState;
  venueOrderId?: string;
  clientOrderId: string;
  filledQuantity?: number;
  averagePrice?: number;
  fee?: number;
  feeCurrency?: string;
  /** The venue's own words on a rejection or an error (credentials removed). */
  message?: string;
  raw?: unknown;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface KeyPermissions {
  canTrade: boolean;
  /** Must be false for ultrastock to go live with the key. */
  canWithdraw: boolean;
  /** How it was established: "apiRestrictions" (Binance), "attested" (the user said so), … */
  source: string;
}

export interface BookTop {
  bid: number;
  ask: number;
  at: string;
}

/** What the adapter's HTTP layer needs; tests pass a mock. */
export type HttpFn = (req: { method: "GET" | "POST" | "DELETE"; url: string; headers?: Record<string, string>; body?: string; timeoutMs: number }) => Promise<{
  status: number;
  body: string;
}>;

export interface BrokerAdapter {
  venue: Venue;
  env: Environment;
  /** Public: the best bid and ask now (the price band is checked against it). */
  bookTop(symbol: string): Promise<BookTop>;
  /** Trading and withdrawal rights of the key, as far as the venue tells. */
  permissions(): Promise<KeyPermissions>;
  balances(): Promise<Balance[]>;
  /** The venue's own validation of the order, nothing placed. */
  preview(o: LiveOrder): Promise<{ ok: boolean; message?: string; raw?: unknown }>;
  /** ONE request, no retry; a timeout → state "unknown". */
  submit(o: LiveOrder): Promise<OrderResult>;
  /** Look an order up by our clientOrderId (reconciliation after "unknown"). */
  query(symbol: string, clientOrderId: string): Promise<OrderResult | undefined>;
  cancel(symbol: string, clientOrderId: string): Promise<OrderResult>;
  openOrders(): Promise<OrderResult[]>;
}
