import Stripe from "stripe";
import type {
  ResolvedConfig,
  GateRequestContext,
  KeyRecord,
  CreditStore,
} from "./types.js";
import { generateKey } from "./keys.js";

let stripeClient: Stripe | null = null;
const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2025-02-24.acacia";

function getStripe(config: ResolvedConfig): Stripe {
  if (config.mode === "test") {
    // In test mode, return a stub that won't be called
    // (createCheckoutUrl returns a fake URL in test mode)
    if (!stripeClient) {
      stripeClient = new Stripe(config.stripe.secretKey || "sk_test_fake", {
        apiVersion: STRIPE_API_VERSION,
      });
    }
    return stripeClient;
  }

  if (!stripeClient) {
    stripeClient = new Stripe(config.stripe.secretKey, {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return stripeClient;
}

export async function createCheckoutUrl(
  config: ResolvedConfig,
  ctx: GateRequestContext,
): Promise<string> {
  if (config.mode === "test") {
    return `https://gate.test/checkout/test_session_${Date.now()}`;
  }

  const stripe = getStripe(config);

  const baseUrl =
    config.baseUrl ||
    `${ctx.headers["x-forwarded-proto"] || "https"}://${ctx.headers["host"]}`;

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: config.credits.currency,
          unit_amount: config.credits.price,
          product_data: {
            name: config.productName,
            description: config.productDescription || undefined,
          },
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}/__gate/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: ctx.url,
    metadata: {
      gate_credits: String(config.credits.amount),
      gate_route: ctx.url,
    },
  };

  // If using Stripe Connect, create a direct charge with application fee
  if (config.stripe.connectId) {
    const feeAmount = Math.round(
      config.credits.price * (config.stripe.applicationFeePercent / 100),
    );
    sessionParams.payment_intent_data = {
      application_fee_amount: feeAmount,
    };
    const session = await stripe.checkout.sessions.create(sessionParams, {
      stripeAccount: config.stripe.connectId,
    });
    return session.url!;
  }

  const session = await stripe.checkout.sessions.create(sessionParams);
  return session.url!;
}

export async function handleCheckoutSuccess(
  sessionId: string,
  config: ResolvedConfig,
  store: CreditStore,
): Promise<{ key: string; record: KeyRecord } | null> {
  if (config.mode === "test") {
    // In test mode, generate a key without Stripe verification
    const key = generateKey("test");
    const record: KeyRecord = {
      key,
      credits: config.credits.amount,
      stripeConnectId: config.stripe.connectId,
      stripeCustomerId: null,
      stripeSessionId: sessionId,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await store.set(key, record);
    // Also store session -> key mapping for idempotency
    await store.set(`session:${sessionId}`, { ...record, key });
    return { key, record };
  }

  // Check if key already generated for this session (idempotency)
  const existing = await store.get(`session:${sessionId}`);
  if (existing) {
    return { key: existing.key, record: existing };
  }

  const stripe = getStripe(config);

  const retrieveParams = config.stripe.connectId
    ? { stripeAccount: config.stripe.connectId }
    : undefined;

  const session = await stripe.checkout.sessions.retrieve(
    sessionId,
    retrieveParams,
  );

  if (session.payment_status !== "paid") {
    return null;
  }

  const credits = parseInt(session.metadata?.gate_credits || "0", 10);
  if (credits <= 0) return null;

  const key = generateKey(config.mode);
  const record: KeyRecord = {
    key,
    credits,
    stripeConnectId: config.stripe.connectId,
    stripeCustomerId:
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id || null,
    stripeSessionId: sessionId,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  await store.set(key, record);
  await store.set(`session:${sessionId}`, { ...record, key });

  return { key, record };
}

export async function handleWebhook(
  body: string | Buffer,
  signature: string,
  config: ResolvedConfig,
  store: CreditStore,
): Promise<{ key: string; record: KeyRecord } | null> {
  if (config.mode === "test") return null;

  const stripe = getStripe(config);
  const event = stripe.webhooks.constructEvent(
    body,
    signature,
    config.stripe.webhookSecret,
  );

  if (event.type !== "checkout.session.completed") return null;

  const session = event.data.object as Stripe.Checkout.Session;
  return handleCheckoutSuccess(session.id, config, store);
}
