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
  /** Stripe Connect account ID (acct_xxx). If provided, uses direct charges with application fee. */
  connectId?: string;
}

export interface GateConfig {
  credits: GateCredits;
  stripe?: GateStripeConfig;
  /** Credit store. Defaults to MemoryStore. */
  store?: CreditStore;
  /** Behavior when store is unreachable. Default: 'open' */
  failMode?: "open" | "closed";
  /** Base URL for this API. Used for checkout callback URLs. Auto-detected from request if not set. */
  baseUrl?: string;
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
    connectId: string | null;
    applicationFeePercent: number;
  };
  store: CreditStore;
  failMode: "open" | "closed";
  baseUrl: string | null;
  productName: string;
  productDescription: string;
  mode: "live" | "test";
}

// --- Credit Store ---

export interface KeyRecord {
  key: string;
  credits: number;
  stripeConnectId: string | null;
  stripeCustomerId: string | null;
  stripeSessionId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreditStore {
  get(key: string): Promise<KeyRecord | null>;
  set(key: string, record: KeyRecord): Promise<void>;
  /** Atomically decrement credits. Returns new balance, or null if key doesn't exist or has 0 credits. */
  decrement(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}

// --- Request handling ---

export type ClientType = "browser" | "api";

export interface GateResponse402 {
  error: "payment_required" | "credits_exhausted";
  message: string;
  pricing: {
    credits: number;
    price: number;
    currency: string;
    formatted: string;
  };
  checkout_url: string;
}

export interface GateRequestContext {
  apiKey: string | null;
  clientType: ClientType;
  url: string;
  method: string;
  headers: Record<string, string>;
}

// --- Core result ---

export type GateResult =
  | { action: "pass"; keyRecord: KeyRecord }
  | { action: "fail_open" }
  | { action: "redirect"; url: string }
  | { action: "payment_required"; body: GateResponse402; status: 402 }
  | { action: "error"; status: number; message: string };
