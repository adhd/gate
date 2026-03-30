// --- Configuration ---

export interface GateCredits {
  /** Number of API calls in a credit pack */
  amount: number;
  /** Price in cents (USD). 500 = $5.00 */
  price: number;
  /** Currency code. Default: 'usd' */
  currency?: string;
}

export interface GateStripeConfig {
  /** Stripe secret key. Falls back to STRIPE_SECRET_KEY env var. */
  secretKey?: string;
  /** Stripe webhook signing secret. Falls back to STRIPE_WEBHOOK_SECRET env var. */
  webhookSecret?: string;
}

export interface GateCryptoConfig {
  /** Wallet address to receive USDC payments (0x + 40 hex chars) */
  address: string;
  /** Price per API call in USD (e.g. 0.005 for half a cent) */
  pricePerCall: number;
  /** Supported networks. Default: ['base']. Options: 'base', 'base-sepolia' */
  networks?: string[];
  /** x402 facilitator URL. Default: 'https://x402.org/facilitator' */
  facilitatorUrl?: string;
  /** Secret key for MPP HMAC challenges (32+ bytes). Falls back to GATE_MPP_SECRET env var. */
  mppSecret?: string;
  /** USDC contract address override. Default: looked up by network. */
  asset?: string;
}

export interface GateConfig {
  credits: GateCredits;
  stripe?: GateStripeConfig;
  crypto?: GateCryptoConfig;
  /** Credit store. Defaults to MemoryStore. */
  store?: CreditStore;
  /** Behavior when store is unreachable. Default: 'open' */
  failMode?: "open" | "closed";
  /** Base URL for this API (required in live mode). Used for checkout callback URLs. */
  baseUrl?: string;
  /** Path prefix for gate routes. Default: '/__gate'. Must match where you mount the routes. */
  routePrefix?: string;
  /** Name shown on Stripe Checkout page. Default: 'API Access' */
  productName?: string;
  /** Description shown on Stripe Checkout page. */
  productDescription?: string;
}

// --- Resolved config (after defaults applied) ---

export interface ResolvedConfig {
  credits: Required<GateCredits>;
  stripe: {
    secretKey: string;
    webhookSecret: string;
  };
  crypto: {
    address: string;
    pricePerCallUsd: number;
    amountSmallestUnit: string;
    networks: string[];
    facilitatorUrl: string;
    mppSecret: string;
    asset: string;
    assetDecimals: number;
  } | null;
  store: CreditStore;
  failMode: "open" | "closed";
  baseUrl: string | null;
  routePrefix: string;
  productName: string;
  productDescription: string;
  mode: "live" | "test";
}

// --- Credit Store ---

export interface KeyRecord {
  key: string;
  credits: number;
  stripeCustomerId: string | null;
  stripeSessionId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type DecrementResult =
  | { status: "ok"; remaining: number }
  | { status: "not_found" }
  | { status: "exhausted" };

export interface CreditStore {
  get(key: string): Promise<KeyRecord | null>;
  set(key: string, record: KeyRecord): Promise<void>;
  /** Atomically decrement credits by the given amount (default 1). */
  decrement(key: string, amount?: number): Promise<DecrementResult>;
  delete(key: string): Promise<void>;
}

// --- Request handling ---

export type ClientType = "browser" | "api";

export interface GateResponse402 {
  error: "payment_required" | "credits_exhausted";
  message: string;
  payment: {
    type: "checkout";
    provider: "stripe";
    purchase_url: string;
    pricing: {
      amount: number;
      currency: string;
      credits: number;
      formatted: string;
    };
  };
  key?: {
    id: string;
    credits_remaining: number;
  };
  crypto?: {
    protocols: string[];
    address: string;
    network: string;
    asset: string;
    amount: string;
    amountFormatted: string;
  };
  /** Only present in test mode. A ready-to-use test API key. */
  test_key?: string;
}

export interface GateMiddlewareOptions {
  /** Credit cost for this route. Default: 1. */
  cost?: number;
}

export interface GateRequestContext {
  apiKey: string | null;
  clientType: ClientType | null;
  url: string;
  method: string;
  headers: Record<string, string>;
}

// --- Core result ---

export type GateResult =
  | { action: "pass"; key: string; remaining: number }
  | {
      action: "pass_crypto";
      payer: string;
      protocol: "x402" | "mpp";
      txHash?: string;
    }
  | { action: "fail_open" }
  | { action: "redirect"; url: string }
  | { action: "payment_required"; body: GateResponse402; status: 402 }
  | { action: "error"; status: 401 | 402 | 503; message: string };
